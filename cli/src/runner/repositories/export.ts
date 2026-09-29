import { createHash } from 'node:crypto'
import { createReadStream, existsSync, realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { RepositorySnapshotSchema, type RepositoryFile, type RepositorySnapshot, type WorkspaceSource } from '@hapi/protocol'
import { MachinePathPolicy } from '@/api/machinePathPolicy'
import { captureFile } from '../artifacts/outputs'
import { git, output, type GitOptions } from '../workspaces/git'
import { fail, lfsFiles, modules } from './assets'

const inside = (root: string, path: string) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`) }
export const repositoryReadEnvironment = { GIT_ALLOW_PROTOCOL: '', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
async function digest(path: string): Promise<Pick<RepositoryFile, 'sha256' | 'size'>> {
    const hash = createHash('sha256'); let size = 0
    for await (const chunk of createReadStream(path)) { hash.update(chunk); size += Buffer.byteLength(chunk) }
    return { sha256: hash.digest('hex'), size }
}
/** Read fixed objects only; scratch refs/config never touch the source repository. */
export async function exportRepository(options: {
    source: WorkspaceSource; manifestId: string; directory: string; pathPolicy: MachinePathPolicy; gitOptions: GitOptions;
}): Promise<RepositorySnapshot> {
    const { source, manifestId, directory, pathPolicy } = options
    const gitOptions = { ...options.gitOptions, env: { ...options.gitOptions.env, ...repositoryReadEnvironment } }
    const snapshot: RepositorySnapshot = { version: 1, manifestId, sourceMachineId: source.machineId,
        repositoryId: source.repositoryId, baseCommit: source.baseCommit, objectFormat: source.objectFormat,
        repositories: [], lfs: [], files: [] }
    const files = join(directory, 'files'); await mkdir(files, { recursive: true, mode: 0o700 })
    const seen = new Set<string>()
    const checkedLfs = new Set<string>()
    async function allowed(path: string) {
        if (!await pathPolicy.allowsBrowse(path)) return fail('outside_workspace_roots', 'Repository objects are outside configured Runner roots.', path)
    }
    async function visit(gitDir: string, worktree: string, path: string, commit: string,
        module?: NonNullable<RepositorySnapshot['repositories'][number]['module']>, ancestors: string[] = []) {
        options.gitOptions.signal?.throwIfAborted()
        gitDir = realpathSync(gitDir); await allowed(gitDir)
        const commonDir = realpathSync(await output(gitDir, ['--git-dir', gitDir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], gitOptions))
        await allowed(commonDir)
        const ancestry = `${commonDir}:${commit}`
        if (ancestors.includes(ancestry)) return fail('repository_submodule_cycle', 'Recursive submodule objects form a cycle.', path)
        const run = (args: string[], allowFailure = false) => git(gitDir, ['--git-dir', gitDir, ...args], { ...gitOptions, allowFailure })
        const read = async (args: string[]) => (await run(args)).stdout.trim()
        if (await read(['rev-parse', '--is-shallow-repository']) === 'true') return fail('repository_shallow', 'A complete repository is required for a baseline bundle.', path || source.sourcePath)
        if (await read(['cat-file', '-t', commit]) !== 'commit') return fail('repository_commit_missing', 'The selected object is not a commit.', `${path}: ${commit}`)
        const objectFormat = await read(['rev-parse', '--show-object-format'])
        if (objectFormat !== 'sha1' && objectFormat !== 'sha256') return fail('git_object_format_unsupported', 'Unsupported repository object format.')
        const scratch = join(directory, 'scratch', String(snapshot.repositories.length))
        await mkdir(scratch, { recursive: true, mode: 0o700 })
        await git(scratch, ['init', '--bare', `--object-format=${objectFormat}`], gitOptions)
        const objects = join(commonDir, 'objects')
        if (/[\r\n]/.test(objects)) return fail('repository_path_invalid', 'Git alternates cannot use this source path.', objects)
        await writeFile(join(scratch, 'objects/info/alternates'), objects + '\n', { mode: 0o600 })
        const bundleRef = `refs/heads/hapi-baseline-${manifestId}`
        await git(scratch, ['update-ref', bundleRef, commit], gitOptions)
        const name = `repository-${snapshot.repositories.length}.bundle`
        await git(scratch, ['bundle', 'create', join(files, name), bundleRef], gitOptions)
        snapshot.files.push({ name, kind: 'bundle', ...await digest(join(files, name)) })
        snapshot.repositories.push({ path, commit, objectFormat, bundleRef, file: name, ...(module ? { module } : {}) })

        for (const file of await lfsFiles(scratch, commit, gitOptions)) {
            const fileName = `lfs-${file.oid}`
            if (!checkedLfs.has(file.oid)) {
                const configured = await run(['config', '--path', '--get', 'lfs.storage'], true)
                if (configured.exitCode > 1) return fail('repository_lfs_invalid', 'Cannot read source LFS storage configuration.')
                const storage = configured.exitCode === 0 ? resolve(commonDir, configured.stdout.trim()) : join(commonDir, 'lfs')
                const location = join(storage, 'objects', file.oid.slice(0, 2), file.oid.slice(2, 4), file.oid)
                if (!location || !existsSync(location)) return fail('repository_lfs_missing', 'The source does not contain a required LFS object.', `${path}/${file.name}: ${file.oid}`)
                const original = realpathSync(location); await allowed(original)
                const captured = await captureFile(dirname(original), { name: fileName, relativePath: original.slice(dirname(original).length + 1) }, join(files, fileName), options.gitOptions.signal ?? new AbortController().signal)
                if (captured.sha256 !== file.oid || captured.size !== file.size) return fail('repository_lfs_mismatch', 'LFS bytes do not match the committed pointer.', `${path}/${file.name}`)
                snapshot.files.push({ name: fileName, kind: 'lfs', sha256: captured.sha256, size: captured.size }); checkedLfs.add(file.oid)
            } else if (snapshot.files.find(entry => entry.name === fileName)!.size !== file.size) return fail('repository_lfs_mismatch', 'The same LFS object has conflicting sizes.')
            snapshot.lfs.push({ repository: path, path: file.name, oid: file.oid, size: file.size, file: fileName })
        }

        for (const link of await modules(scratch, commit, gitOptions)) {
            const childPath = path ? `${path}/${link.path}` : link.path
            if (seen.has(childPath)) return fail('repository_submodule_invalid', 'Duplicate recursive submodule path.', childPath)
            seen.add(childPath)
            const checkout = resolve(worktree, link.path)
            if (!inside(worktree, checkout)) return fail('repository_path_invalid', 'Submodule path escapes its source.', childPath)
            let childGit: string | undefined
            if (existsSync(join(checkout, '.git'))) {
                await allowed(realpathSync(checkout))
                childGit = await output(checkout, ['rev-parse', '--absolute-git-dir'], gitOptions)
            } else {
                const stored = resolve(gitDir, 'modules', link.name)
                if (inside(join(gitDir, 'modules'), stored) && existsSync(join(stored, 'config'))) childGit = stored
            }
            if (!childGit) return fail('repository_submodule_missing', 'Initialize the required submodule objects in the source before preparing again.', `${childPath}: ${link.commit}`)
            await visit(childGit, checkout, childPath, link.commit, { parent: path, path: link.path, name: link.name }, [...ancestors, ancestry])
        }
    }
    const gitDir = await output(source.sourcePath, ['rev-parse', '--absolute-git-dir'], gitOptions)
    await visit(gitDir, source.repositoryRoot, '', source.baseCommit)
    return RepositorySnapshotSchema.parse(snapshot)
}
