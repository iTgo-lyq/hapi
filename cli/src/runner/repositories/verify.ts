import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual as same } from 'node:util'
import { RepositorySnapshotSchema, type RepositorySnapshot } from '@hapi/protocol'
import { git, output, type GitOptions } from '../workspaces/git'
import { fail, lfsFiles, modules } from './assets'
import { repositoryReadEnvironment } from './export'

const ref = (snapshot: RepositorySnapshot) => `refs/hapi/snapshots/${snapshot.manifestId}`
export function validateRepositoryManifest(snapshot: RepositorySnapshot) {
    RepositorySnapshotSchema.parse(snapshot)
    const root = snapshot.repositories[0]!
    if (root.path !== '' || root.module || root.commit !== snapshot.baseCommit || root.objectFormat !== snapshot.objectFormat) return fail('repository_manifest_invalid', 'Manifest root does not match its baseline.')
    const paths = new Set<string>(), files = new Map(snapshot.files.map(file => [file.name, file])), used = new Set<string>()
    if (files.size !== snapshot.files.length) return fail('repository_manifest_invalid', 'Duplicate manifest files.')
    for (const repo of snapshot.repositories) {
        if (paths.has(repo.path)) return fail('repository_manifest_invalid', 'Duplicate repository path.')
        if (repo.path && (!repo.module || !paths.has(repo.module.parent) || !repo.module.path || !repo.module.name
            || repo.path !== [repo.module.parent, repo.module.path].filter(Boolean).join('/'))) return fail('repository_manifest_invalid', 'Submodule parent must precede its child.')
        paths.add(repo.path)
        if (files.get(repo.file)?.kind !== 'bundle' || used.has(repo.file)) return fail('repository_manifest_invalid', 'A repository needs its own bundle file.')
        used.add(repo.file)
    }
    const pointers = new Set<string>()
    for (const item of snapshot.lfs) {
        const file = files.get(item.file), key = `${item.repository}\0${item.path}`
        if (!paths.has(item.repository) || !item.path || pointers.has(key) || file?.kind !== 'lfs' || file.sha256 !== item.oid || file.size !== item.size) return fail('repository_manifest_invalid', 'LFS descriptor does not match its repository or file.')
        pointers.add(key); used.add(item.file)
    }
    if (used.size !== files.size) return fail('repository_manifest_invalid', 'Manifest contains unreferenced files.')
}
export async function validateRepositoryTree(snapshot: RepositorySnapshot, path: string, cwd: string, commit: string, options: GitOptions) {
    const expected = snapshot.repositories.filter(repo => repo.module?.parent === path)
        .map(repo => ({ name: repo.module!.name, path: repo.module!.path, commit: repo.commit })).sort((a, b) => a.path.localeCompare(b.path))
    const actual = (await modules(cwd, commit, options)).sort((a, b) => a.path.localeCompare(b.path))
    if (!same(expected, actual)) return fail('repository_gitlink_mismatch', 'Gitlinks or submodule definitions do not match the snapshot.', path)
}

/** Verify complete owned files in empty repositories, without source/cache alternates. */
export async function verifyRepositorySnapshot(snapshot: RepositorySnapshot, data: string, options: GitOptions) {
    validateRepositoryManifest(snapshot)
    const opts = { ...options, env: { ...options.env, ...repositoryReadEnvironment, GIT_LFS_SKIP_SMUDGE: '1' } }
    for (const file of snapshot.files) {
        const hash = createHash('sha256'); let size = 0
        for await (const bytes of createReadStream(join(data, 'files', file.name))) { hash.update(bytes); size += Buffer.byteLength(bytes) }
        if (size !== file.size || hash.digest('hex') !== file.sha256) return fail('repository_file_mismatch', 'Repository bytes do not match the manifest.', file.name)
    }
    // Always verify in independent empty stores, before consulting an existing shared cache.
    for (const [index, repo] of snapshot.repositories.entries()) {
        const verify = join(data, 'verify', String(index)), bundle = join(data, 'files', repo.file)
        await mkdir(verify, { recursive: true, mode: 0o700 })
        await git(verify, ['init', '--bare', '--template=', `--object-format=${repo.objectFormat}`], opts)
        const heads = (await output(verify, ['bundle', 'list-heads', bundle], opts)).split('\n')
        if (!same(heads, [`${repo.commit} ${repo.bundleRef}`])) return fail('repository_bundle_refs', 'Bundle must contain exactly the declared commit and ref.', repo.path)
        await git(verify, ['bundle', 'verify', bundle], opts)
        await git(verify, ['-c', 'submodule.recurse=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch', '--no-recurse-submodules', '--no-tags', '--no-write-fetch-head', bundle, `${repo.bundleRef}:${ref(snapshot)}`], { ...opts, env: { ...opts.env, GIT_ALLOW_PROTOCOL: 'file' } })
        if (await output(verify, ['rev-parse', `${ref(snapshot)}^{commit}`], opts) !== repo.commit) return fail('repository_bundle_commit', 'Imported commit differs from the manifest.')
        await git(verify, ['fsck', '--full', '--no-reflogs', repo.commit], opts)
        await validateRepositoryTree(snapshot, repo.path, verify, repo.commit, opts)
        const actual = (await lfsFiles(verify, repo.commit, opts)).map(file => ({ path: file.name, oid: file.oid, size: file.size })).sort((a, b) => a.path.localeCompare(b.path))
        const expected = snapshot.lfs.filter(file => file.repository === repo.path).map(file => ({ path: file.path, oid: file.oid, size: file.size })).sort((a, b) => a.path.localeCompare(b.path))
        if (!same(actual, expected)) return fail('repository_lfs_mismatch', 'Committed LFS pointers differ from the manifest.', repo.path)
    }
    return join(data, 'verify', '0')
}
