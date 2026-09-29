import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { type ManagedWorkspace, type RepositoryImport, type RepositoryImportRequest, type RepositoryOperation,
    type RepositorySnapshot, type WorkspaceSource } from '@hapi/protocol'
import type { MachinePathPolicy } from '@/api/machinePathPolicy'
import { captureFile } from '../artifacts/outputs'
import { git, output, type GitOptions } from '../workspaces/git'
import { fail, lfsFiles, logical } from './assets'
import { stageRepositorySnapshot, validateRepositoryManifest, validateRepositoryTree, verifyRepositorySnapshot } from './verify'
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
    async import(request: RepositoryImportRequest, data: string, options: GitOptions,
        lock: <T>(key: string, action: () => Promise<T>) => Promise<T>): Promise<RepositoryImport> {
        const snapshot = request.snapshot; validateRepositoryManifest(snapshot)
        const opts = { ...options, env: { ...options.env, ...repositoryReadEnvironment, GIT_LFS_SKIP_SMUDGE: '1' } }
        await stageRepositorySnapshot(request, data, this.options.pathPolicy, opts)
        await verifyRepositorySnapshot(snapshot, data, opts)
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
        const snapshot = receipt.request.snapshot; validateRepositoryManifest(snapshot)
        if (!same(receipt.imported.repositories, this.mapping(snapshot)) || !same({ ...source, relativePath: '' }, receipt.imported.source)) return fail('repository_source_changed', 'Workspace source does not match the imported snapshot.')
        logical(source.relativePath, true)
        for (const [index, repo] of snapshot.repositories.entries()) {
            const mapping = receipt.imported.repositories[index]!; await this.owned(mapping.directory)
            if (await output(mapping.directory, ['rev-parse', '--verify', `${mapping.ref}^{commit}`], { env: repositoryReadEnvironment }) !== repo.commit) return fail('repository_ref_conflict', 'Retained snapshot ref changed.')
        }
        if (source.relativePath && await output(source.commonDir, ['cat-file', '-t', `${source.baseCommit}:${source.relativePath}`], { env: repositoryReadEnvironment }) !== 'tree') return fail('workspace_cwd_missing', 'Source subdirectory is absent from the snapshot.')
        return { snapshot, imported: receipt.imported }
    }
    async release(record: RepositoryOperation, imports: RepositoryOperation[], workspaces: ManagedWorkspace[], retired: string, options: GitOptions,
        begin: () => void): Promise<NonNullable<RepositoryOperation['cache']>> {
        if (record.request.action !== 'import') return fail('repository_import_required', 'Only imports own repository cache references.')
        const snapshot = record.request.snapshot, directory = this.location(snapshot)
        const pending = (workspace: ManagedWorkspace) => Object.values(workspace.operations).some(op => ['accepted', 'running', 'unknown'].includes(op.status))
        const changed = (workspace: ManagedWorkspace) => Object.values(workspace.results).some(result => result.resultHead !== workspace.source.baseCommit)
        const owned = workspaces.filter(workspace => workspace.source.snapshot?.importOperationId === record.request.operationId)
        for (const workspace of owned) {
            if (workspace.status !== 'removed' || pending(workspace)) return fail('repository_cache_in_use', 'An environment still retains this import.', workspace.environmentId)
            if (changed(workspace)) return fail('repository_results_retained', 'This import protects code results that have not been released.', workspace.environmentId)
        }
        const related = imports.filter(item => item.request.action === 'import' && this.location(item.request.snapshot) === directory)
        const keep = (code: string, message: string, hint?: string) => ({ retained: true, directory, reason: { code, message, ...(hint ? { hint } : {}) } })
        begin()
        if (!existsSync(directory)) return { retained: false, directory }
        await this.owned(directory)
        if (!same(JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8')),
            { scope: hash(this.options.scope), sourceMachineId: snapshot.sourceMachineId, repositoryId: snapshot.repositoryId })) return fail('repository_ownership_changed', 'Cache ownership changed; it was retained.')
        const holders = related.filter(item => item.request.operationId !== record.request.operationId && item.retention !== 'released')
        if (holders.length) return keep('repository_other_imports', `${holders.length} other imports retain the shared cache.`, holders.map(item => item.request.operationId).join(', '))
        if (workspaces.some(workspace => workspace.status !== 'removed' || pending(workspace) || changed(workspace))) return keep('repository_retained_workspaces', 'Other environments or code results still retain this cache.')
        // Public remove intentionally keeps refs. Only unchanged, removed environments can be discarded here.
        const expected = new Map<string, Map<string, Set<string>>>()
        const allow = (repo: string, name: string, commit: string) => {
            if (!expected.has(repo)) expected.set(repo, new Map())
            const refs = expected.get(repo)!; if (!refs.has(name)) refs.set(name, new Set()); refs.get(name)!.add(commit)
        }
        for (const item of related) if (item.request.action === 'import') {
            for (const [index, repo] of this.mapping(item.request.snapshot).entries()) {
                const commit = item.request.snapshot.repositories[index]!.commit
                allow(repo.directory, repo.ref, commit); allow(repo.directory, 'refs/heads/cache-base', commit)
            }
        }
        for (const workspace of workspaces) {
            allow(this.commonDir(snapshot), `refs/hapi/workspaces/${workspace.environmentId}/base`, workspace.source.baseCommit)
            for (const result of Object.values(workspace.results)) allow(this.commonDir(snapshot), result.resultRef, result.resultHead)
        }
        const opts = { ...options, env: { ...options.env, ...repositoryReadEnvironment } }
        for (const name of readdirSync(directory)) {
            if (name === 'owner.json') continue
            const repo = join(directory, name), refs = expected.get(repo)
            if (!refs) return keep('repository_unknown_assets', 'An unrecognized cache entry was retained.', name)
            await this.owned(repo)
            const trees = (await output(repo, ['worktree', 'list', '--porcelain'], opts)).split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9))
            if (trees.some(path => path !== repo)) return keep('repository_external_worktree', 'Git still has a worktree using this cache.', repo)
            for (const line of (await output(repo, ['for-each-ref', '--format=%(refname) %(objectname)'], opts)).split('\n').filter(Boolean)) {
                const [name, commit] = line.split(' ')
                if (!refs.get(name!)?.has(commit!)) return keep('repository_unknown_ref', 'A ref contains unrecognized or unrecovered code; the cache was retained.', line)
            }
        }
        // Move the checked cache out of the shared location atomically. A later import may recreate
        // that location while interrupted deletion resumes only inside this operation's data directory.
        await mkdir(dirname(retired), { recursive: true, mode: 0o700 }); await this.owned(dirname(retired))
        await rename(directory, retired)
        return { retained: false, directory }
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
            await validateRepositoryTree(snapshot, repo.path, cwd, head, opts)
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
