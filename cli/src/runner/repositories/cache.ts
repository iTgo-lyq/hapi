import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { RepositorySnapshotSchema, type RepositoryImport, type RepositoryImportRequest, type RepositoryOperation,
    type RepositorySnapshot, type WorkspaceSource } from '@hapi/protocol'
import type { MachinePathPolicy } from '@/api/machinePathPolicy'
import { captureFile } from '../artifacts/outputs'
import { git, output, type GitOptions } from '../workspaces/git'
import { fail, lfsFiles, logical, modules } from './assets'
import { repositoryReadEnvironment } from './export'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const same = isDeepStrictEqual
const ref = (snapshot: RepositorySnapshot) => `refs/hapi/snapshots/${snapshot.manifestId}`
const lfsPath = (repository: string, oid: string) => join(repository, 'lfs/objects', oid.slice(0, 2), oid.slice(2, 4), oid)
async function checkBytes(path: string, sha256: string, size: number) {
    const digest = createHash('sha256'); let length = 0
    for await (const chunk of createReadStream(path)) { digest.update(chunk); length += Buffer.byteLength(chunk) }
    if (length !== size || digest.digest('hex') !== sha256) return fail('repository_file_mismatch', 'Repository bytes do not match the manifest.', path)
}

/** Owned repository assets only. Worktree and execution lifecycles stay in WorkspaceManager. */
export class RepositoryCache {
    readonly root: string
    constructor(private readonly options: { home: string; machineId: string; scope: string; pathPolicy: MachinePathPolicy }) {
        mkdirSync(options.home, { recursive: true, mode: 0o700 })
        this.root = join(realpathSync(options.home), 'workspaces')
    }
    private location(snapshot: RepositorySnapshot) {
        return join(this.root, 'repositories', hash(JSON.stringify([this.options.scope, snapshot.sourceMachineId, snapshot.repositoryId])))
    }
    private mapping(snapshot: RepositorySnapshot): RepositoryImport['repositories'] {
        return snapshot.repositories.map(repo => ({ path: repo.path, directory: join(this.location(snapshot), repo.path ? `${hash(repo.path)}.git` : 'root.git'), ref: ref(snapshot) }))
    }
    commonDir(snapshot: RepositorySnapshot) { return join(this.location(snapshot), 'root.git') }
    private async owned(path: string) {
        if (!await this.options.pathPolicy.allowsSpawn(path)) return fail('outside_workspace_roots', 'Repository cache is outside configured Runner roots.', path)
        if (realpathSync(path) !== path) return fail('repository_ownership_changed', 'Repository cache path was replaced.', path)
    }
    private manifest(snapshot: RepositorySnapshot) {
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
    private async tree(snapshot: RepositorySnapshot, path: string, cwd: string, commit: string, options: GitOptions) {
        const expected = snapshot.repositories.filter(repo => repo.module?.parent === path)
            .map(repo => ({ name: repo.module!.name, path: repo.module!.path, commit: repo.commit })).sort((a, b) => a.path.localeCompare(b.path))
        const actual = (await modules(cwd, commit, options)).sort((a, b) => a.path.localeCompare(b.path))
        if (!same(expected, actual)) return fail('repository_gitlink_mismatch', 'Gitlinks or submodule definitions do not match the snapshot.', path)
    }
    async import(request: RepositoryImportRequest, data: string, options: GitOptions,
        lock: <T>(key: string, action: () => Promise<T>) => Promise<T>): Promise<RepositoryImport> {
        const snapshot = request.snapshot; this.manifest(snapshot)
        const files = new Map(request.files.map(file => [file.name, file.path]))
        if (files.size !== request.files.length || files.size !== snapshot.files.length || snapshot.files.some(file => !files.has(file.name))) return fail('repository_manifest_invalid', 'Import files must exactly match the manifest.')
        const opts = { ...options, env: { ...options.env, ...repositoryReadEnvironment, GIT_LFS_SKIP_SMUDGE: '1' } }
        await mkdir(join(data, 'files'), { recursive: true, mode: 0o700 })
        for (const file of snapshot.files) {
            const path = files.get(file.name)!
            if (!isAbsolute(path) || !await this.options.pathPolicy.allowsBrowse(path)) return fail('outside_workspace_roots', 'Import files require allowed absolute paths.')
            const fixed = await captureFile(dirname(path), { name: file.name, relativePath: path.slice(dirname(path).length + 1) }, join(data, 'files', file.name), options.signal ?? new AbortController().signal)
            if (fixed.size !== file.size || fixed.sha256 !== file.sha256) return fail('repository_file_mismatch', 'Downloaded file does not match the manifest.', file.name)
        }
        // Always verify in independent empty stores, before consulting an existing shared cache.
        for (const [index, repo] of snapshot.repositories.entries()) {
            const verify = join(data, 'verify', String(index)), bundle = join(data, 'files', repo.file)
            await mkdir(verify, { recursive: true, mode: 0o700 })
            await git(verify, ['init', '--bare', `--object-format=${repo.objectFormat}`], opts)
            const heads = (await output(verify, ['bundle', 'list-heads', bundle], opts)).split('\n')
            if (!same(heads, [`${repo.commit} ${repo.bundleRef}`])) return fail('repository_bundle_refs', 'Bundle must contain exactly the declared commit and ref.', repo.path)
            await git(verify, ['bundle', 'verify', bundle], opts)
            await git(verify, ['fetch', '--no-tags', '--no-write-fetch-head', bundle, `${repo.bundleRef}:${ref(snapshot)}`], { ...opts, env: { ...opts.env, GIT_ALLOW_PROTOCOL: 'file' } })
            if (await output(verify, ['rev-parse', `${ref(snapshot)}^{commit}`], opts) !== repo.commit) return fail('repository_bundle_commit', 'Imported commit differs from the manifest.')
            await git(verify, ['fsck', '--full', '--no-reflogs', repo.commit], opts)
            await this.tree(snapshot, repo.path, verify, repo.commit, opts)
            const actual = (await lfsFiles(verify, repo.commit, opts)).map(file => ({ path: file.name, oid: file.oid, size: file.size })).sort((a, b) => a.path.localeCompare(b.path))
            const expected = snapshot.lfs.filter(file => file.repository === repo.path).map(file => ({ path: file.path, oid: file.oid, size: file.size })).sort((a, b) => a.path.localeCompare(b.path))
            if (!same(actual, expected)) return fail('repository_lfs_mismatch', 'Committed LFS pointers differ from the manifest.', repo.path)
        }
        return lock(this.commonDir(snapshot), async () => {
            const location = this.location(snapshot), owner = { scope: hash(this.options.scope), sourceMachineId: snapshot.sourceMachineId, repositoryId: snapshot.repositoryId }
            if (!existsSync(location)) {
                await mkdir(location, { recursive: true, mode: 0o700 }); await this.owned(location)
                writeFileSync(join(location, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
            }
            await this.owned(location)
            if (!same(JSON.parse(readFileSync(join(location, 'owner.json'), 'utf8')), owner)) return fail('repository_ownership_changed', 'Cache belongs to a different source or authentication scope.')
            const repositories = this.mapping(snapshot)
            for (const [index, repo] of snapshot.repositories.entries()) {
                const target = repositories[index]!.directory
                if (!existsSync(target)) {
                    await mkdir(target, { mode: 0o700 }); await this.owned(target)
                    await git(target, ['init', '--bare', `--object-format=${repo.objectFormat}`], opts)
                    // Submodule registrations belong to a checkout, not all consumers of this cache.
                    await git(target, ['config', 'extensions.worktreeConfig', 'true'], opts)
                    await git(target, ['config', '--worktree', 'core.bare', 'true'], opts)
                    await git(target, ['config', '--unset', 'core.bare'], opts)
                }
                await this.owned(target)
                if (await output(target, ['rev-parse', '--is-bare-repository'], opts) !== 'true' || await output(target, ['rev-parse', '--show-object-format'], opts) !== repo.objectFormat) return fail('repository_cache_invalid', 'Cache format or repository type changed.')
                const existing = await git(target, ['rev-parse', '--verify', ref(snapshot)], { ...opts, allowFailure: true })
                if (existing.exitCode === 0 && existing.stdout.trim() !== repo.commit) return fail('repository_ref_conflict', 'Snapshot ref has a different commit.')
                await git(target, ['fetch', '--no-tags', '--no-write-fetch-head', join(data, 'files', repo.file), `${repo.bundleRef}:${ref(snapshot)}`], { ...opts, env: { ...opts.env, GIT_ALLOW_PROTOCOL: 'file' } })
                const head = await git(target, ['rev-parse', '--verify', 'refs/heads/cache-base'], { ...opts, allowFailure: true })
                if (head.exitCode !== 0) await git(target, ['update-ref', 'refs/heads/cache-base', repo.commit, '0'.repeat(repo.commit.length)], opts)
                await git(target, ['symbolic-ref', 'HEAD', 'refs/heads/cache-base'], opts)
                if (snapshot.lfs.some(file => file.repository === repo.path)) {
                    await git(target, ['lfs', 'install', '--local', '--skip-repo', '--skip-smudge'], opts)
                    await git(target, ['config', 'lfs.storage', join(target, 'lfs')], opts)
                }
                for (const file of snapshot.lfs.filter(file => file.repository === repo.path)) {
                    const destination = lfsPath(target, file.oid)
                    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
                    await captureFile(join(data, 'files'), { name: file.file, relativePath: file.file }, destination, options.signal ?? new AbortController().signal)
                }
            }
            const commonDir = this.commonDir(snapshot)
            const source: WorkspaceSource = { machineId: this.options.machineId,
                repositoryId: hash(JSON.stringify([this.options.machineId, commonDir, snapshot.objectFormat])),
                sourcePath: commonDir, repositoryRoot: commonDir, commonDir, relativePath: '', baseRef: ref(snapshot),
                baseCommit: snapshot.baseCommit, objectFormat: snapshot.objectFormat, dirty: false,
                snapshot: { importOperationId: request.operationId, manifestId: snapshot.manifestId } }
            await rm(data, { recursive: true, force: true })
            return { source, repositories }
        })
    }
    async validateSource(source: WorkspaceSource) {
        if (!source.snapshot || !/^[a-f0-9-]{36}$/i.test(source.snapshot.importOperationId)) return fail('repository_snapshot_required', 'Cache sources require a saved import receipt.')
        const directory = join(this.root, 'imports', source.snapshot.importOperationId); await this.owned(directory)
        const receipt = JSON.parse(readFileSync(join(directory, 'operation.json'), 'utf8')) as RepositoryOperation
        if (receipt.version !== 1 || receipt.request.action !== 'import' || receipt.request.operationId !== source.snapshot.importOperationId
            || receipt.directory !== join(directory, 'data/files') || receipt.status !== 'succeeded' || receipt.retention !== 'retained'
            || !receipt.imported || receipt.request.snapshot.manifestId !== source.snapshot.manifestId) return fail('repository_import_unavailable', 'Snapshot has no retained successful import receipt.')
        const snapshot = receipt.request.snapshot; this.manifest(snapshot)
        if (!same(receipt.imported.repositories, this.mapping(snapshot)) || !same({ ...source, relativePath: '' }, receipt.imported.source)) return fail('repository_source_changed', 'Workspace source does not match the imported snapshot.')
        logical(source.relativePath, true)
        for (const [index, repo] of snapshot.repositories.entries()) {
            const mapping = receipt.imported.repositories[index]!; await this.owned(mapping.directory)
            if (await output(mapping.directory, ['rev-parse', '--verify', `${mapping.ref}^{commit}`], { env: repositoryReadEnvironment }) !== repo.commit) return fail('repository_ref_conflict', 'Retained snapshot ref changed.')
        }
        if (source.relativePath && await output(source.commonDir, ['cat-file', '-t', `${source.baseCommit}:${source.relativePath}`], { env: repositoryReadEnvironment }) !== 'tree') return fail('workspace_cwd_missing', 'Source subdirectory is absent from the snapshot.')
        return { snapshot, imported: receipt.imported }
    }
    async hydrate(source: WorkspaceSource, checkout: string, options: GitOptions, verifyOnly = false) {
        const { snapshot, imported } = await this.validateSource(source)
        const opts = { ...options, env: { ...options.env, ...repositoryReadEnvironment, GIT_LFS_SKIP_SMUDGE: '1' } }
        for (const [index, repo] of snapshot.repositories.entries()) {
            const cwd = resolve(checkout, repo.path), cache = imported.repositories[index]!.directory
            if (repo.module && !verifyOnly) {
                const parent = resolve(checkout, repo.module.parent)
                await git(parent, ['config', '--worktree', `submodule.${repo.module.name}.url`, cache], opts)
                await git(parent, ['config', '--worktree', `submodule.${repo.module.name}.active`, 'true'], opts)
                await git(parent, ['-c', `submodule.${repo.module.name}.url=${cache}`, '-c', `submodule.${repo.module.name}.active=true`,
                    'submodule', 'update', '--init', '--checkout', '--no-fetch', '--', repo.module.path], { ...opts, env: { ...opts.env, GIT_ALLOW_PROTOCOL: 'file' } })
            }
            if (realpathSync(cwd) !== cwd) return fail('repository_ownership_changed', 'Snapshot checkout path was replaced.', repo.path)
            const head = await output(cwd, ['rev-parse', 'HEAD'], opts)
            if (repo.module && head !== repo.commit) return fail('repository_gitlink_mismatch', 'Submodule checkout differs from its snapshot.', repo.path)
            await this.tree(snapshot, repo.path, cwd, head, opts)
            const files = await lfsFiles(cwd, undefined, opts)
            if (!files.length) continue
            if (!verifyOnly) {
                // New LFS objects from a sealed round stay in the worktree's own object store.
                const common = realpathSync(await output(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], opts))
                await git(cwd, ['lfs', 'install', '--local', '--skip-repo', '--skip-smudge'], opts)
                await git(cwd, ['config', 'lfs.storage', join(common, 'lfs')], opts)
                for (const file of files) {
                    const destination = lfsPath(common, file.oid), stored = lfsPath(cache, file.oid)
                    if (destination !== stored && existsSync(stored)) {
                        await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
                        await captureFile(dirname(stored), { name: file.oid, relativePath: file.oid }, destination, options.signal ?? new AbortController().signal)
                    }
                }
                await git(cwd, ['lfs', 'checkout'], opts)
            }
            for (const file of await lfsFiles(cwd, undefined, opts)) {
                if (!file.checkout || !file.downloaded) return fail('workspace_lfs_unready', 'LFS content is not materialized locally.', `${repo.path}/${file.name}`)
                if (!verifyOnly) await checkBytes(join(cwd, file.name), file.oid, file.size)
            }
        }
    }
}
