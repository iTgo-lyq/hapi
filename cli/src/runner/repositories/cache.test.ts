import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ManagedWorkspace, RepositoryImportRequest, RepositoryOperation, WorkspaceSource } from '@hapi/protocol'
import { MachinePathPolicy } from '@/api/machinePathPolicy'
import { WorkspaceManager } from '../workspaces/manager'
import { RepositoryCache } from './cache'
import { RepositoryManager } from './manager'

const roots: string[] = [], repositories: RepositoryManager[] = [], workspaces: WorkspaceManager[] = []
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }
function git(cwd: string, ...args: string[]) { return execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function init(path: string, format = 'sha1') {
    mkdirSync(path, { recursive: true }); git(path, 'init', '-q', `--object-format=${format}`)
    git(path, 'config', 'user.name', 'Cache Test'); git(path, 'config', 'user.email', 'test@example.invalid'); git(path, 'config', 'commit.gpgsign', 'false')
    return path
}
function commit(path: string) { git(path, 'add', '-A'); git(path, 'commit', '-qm', 'baseline'); return git(path, 'rev-parse', 'HEAD') }
function machine(home: string, machineId: string) {
    const pathPolicy = new MachinePathPolicy(), cache = new RepositoryCache({ home, machineId, scope: 'test-namespace', pathPolicy })
    const workspace = new WorkspaceManager({ home, machineId, pathPolicy, snapshots: cache, assertStopped: async () => { throw new Error('No execution was started') } })
    const manager = new RepositoryManager({ home, pathPolicy, cache, resolveSource: (...args) => workspace.resolveSource(...args),
        withRepositoryLock: (key, action) => workspace.withRepositoryLock(key, action) })
    repositories.push(manager); workspaces.push(workspace)
    return { manager, workspace, cache }
}
function fixture(format = 'sha1') {
    const parent = resolve(import.meta.dirname, '../../../../../.dev-smoke'); mkdirSync(parent, { recursive: true })
    const root = mkdtempSync(join(parent, 'cache-unit-')); roots.push(root)
    const repo = init(join(root, 'source/project'), format); mkdirSync(join(repo, 'app')); writeFileSync(join(repo, 'app/note'), 'baseline'); commit(repo)
    return { root, repo, source: machine(join(root, 'source-home'), 'source'), target: machine(join(root, 'target-home'), 'target') }
}
async function inspect(manager: RepositoryManager, operationId: string) {
    const result = await manager.request({ action: 'inspect', operationId }); if ('error' in result) throw new Error(result.error.message)
    return result.operation
}
async function exported(f: ReturnType<typeof fixture>) {
    const source = await f.source.workspace.resolveSource(join(f.repo, 'app'), 'HEAD')
    const operationId = randomUUID(); await f.source.manager.request({ action: 'export', operationId, source }); await f.source.manager.settled()
    const result = await inspect(f.source.manager, operationId); expect(result.status, JSON.stringify(result.error)).toBe('succeeded')
    renameSync(join(f.root, 'source'), join(f.root, 'source-offline'))
    const request: RepositoryImportRequest = { action: 'import', operationId: randomUUID(), snapshot: result.snapshot!, files: result.snapshot!.files.map(file => ({ name: file.name, path: join(result.directory, file.name) })) }
    return { request, origin: source, exported: result }
}
async function imported(target: ReturnType<typeof machine>, request: RepositoryImportRequest) {
    await target.manager.request(request); await target.manager.settled(); return inspect(target.manager, request.operationId)
}
async function prepare(target: ReturnType<typeof machine>, source: WorkspaceSource, previous?: ManagedWorkspace) {
    const environmentId = previous?.environmentId ?? randomUUID(), preparationId = randomUUID(), roundId = randomUUID()
    const expectedHead = previous ? Object.values(previous.results).at(-1)!.resultHead : source.baseCommit
    await target.workspace.request({ action: 'prepare', source, environmentId, preparationId, roundId, expectedHead })
    await target.workspace.settled()
    const response = await target.workspace.request({ action: 'inspect', environmentId }); if (!('workspace' in response)) throw new Error('missing workspace')
    return { workspace: response.workspace, reference: { environmentId, preparationId }, roundId, operation: response.workspace.operations[`prepare:${preparationId}`]! }
}
afterEach(async () => {
    for (const manager of repositories.splice(0)) await manager.stop()
    for (const manager of workspaces.splice(0)) await manager.stop()
    vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('repository cache import and worktree preparation', () => {
    it.each(['sha1', 'sha256'])('imports %s offline into a shared bare cache and resumes a sealed result', async format => {
        const f = fixture(format), transfer = await exported(f), result = await imported(f.target, transfer.request)
        expect(result.status, JSON.stringify(result.error)).toBe('succeeded'); expect(existsSync(result.directory)).toBe(false)
        const source = { ...result.imported!.source, relativePath: transfer.origin.relativePath }
        const [a, b] = await Promise.all([prepare(f.target, source), prepare(f.target, source)])
        for (const item of [a, b]) {
            expect(item.operation.status, JSON.stringify(item.operation.error)).toBe('succeeded')
            expect(readFileSync(join(item.workspace.cwd, 'note'), 'utf8')).toBe('baseline')
            await f.target.workspace.validatePrepared(item.reference, item.workspace.cwd)
        }
        expect(a.workspace.branch).not.toBe(b.workspace.branch)
        expect(git(a.workspace.checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir')).toBe(source.commonDir)
        expect(git(b.workspace.checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir')).toBe(source.commonDir)
        writeFileSync(join(a.workspace.cwd, 'note'), 'retained result')
        await f.target.workspace.request({ action: 'finalize', ...a.reference, roundId: a.roundId, attemptId: randomUUID() }); await f.target.workspace.settled()
        const sealed = await f.target.workspace.inspect(a.workspace.environmentId)
        expect(sealed.results[a.roundId]?.resultHead).not.toBe(source.baseCommit)
        const next = await prepare(f.target, source, sealed); expect(next.operation.status, JSON.stringify(next.operation.error)).toBe('succeeded')
        expect(next.workspace.preparations[next.reference.preparationId]!.startHead).toBe(sealed.results[a.roundId]!.resultHead)
        expect(readFileSync(join(next.workspace.cwd, 'note'), 'utf8')).toBe('retained result')
        const restarted = machine(join(f.root, 'target-home'), 'target')
        expect((await restarted.manager.request(transfer.request))).toEqual({ operation: result })
        await restarted.workspace.validatePrepared(next.reference, next.workspace.cwd)
        await f.source.manager.request({ action: 'release', operationId: transfer.exported.request.operationId })
        await restarted.workspace.validatePrepared(b.reference, b.workspace.cwd)
        const forged = { ...source }; delete forged.snapshot
        expect((await prepare(f.target, forged)).operation.error?.code).toBe('repository_snapshot_required')
        expect((await prepare(f.target, { ...source, snapshot: { ...source.snapshot!, manifestId: randomUUID() } })).operation.error?.code).toBe('repository_import_unavailable')
        await expect(f.target.manager.request({ action: 'release', operationId: transfer.request.operationId })).rejects.toMatchObject({ code: 'repository_cache_retained' })
    }, 30_000)

    it('hydrates nested modules with repeated names and LFS without source URLs, and rejects launch drift', async () => {
        vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null'); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
        const f = fixture(), leaf = init(join(f.root, 'source/leaf')), middle = init(join(f.root, 'source/middle'))
        git(leaf, 'lfs', 'install', '--local'); writeFileSync(join(leaf, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
        const content = Buffer.from('nested binary\0'.repeat(1000)), oid = createHash('sha256').update(content).digest('hex')
        writeFileSync(join(leaf, 'asset.bin'), content); commit(leaf)
        writeFileSync(join(middle, 'note'), 'middle'); commit(middle)
        git(middle, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'repeated', leaf, 'nested module'); commit(middle)
        git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'repeated', middle, 'vendor/lib'); commit(f.repo)
        git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive')
        const child = join(f.repo, 'vendor/lib/nested module'), common = git(child, 'rev-parse', '--path-format=absolute', '--git-common-dir')
        const entity = join(common, 'lfs/objects', oid.slice(0, 2), oid.slice(2, 4), oid); mkdirSync(dirname(entity), { recursive: true }); writeFileSync(entity, content)
        const transfer = await exported(f), result = await imported(f.target, transfer.request)
        expect(result.status, JSON.stringify(result.error)).toBe('succeeded')
        let prepared = await prepare(f.target, result.imported!.source)
        expect(prepared.operation.status, JSON.stringify(prepared.operation.error)).toBe('succeeded')
        writeFileSync(join(prepared.workspace.checkout, 'app/note'), 'root change with initialized modules')
        await f.target.workspace.request({ action: 'finalize', ...prepared.reference, roundId: prepared.roundId, attemptId: randomUUID() }); await f.target.workspace.settled()
        const sealed = await f.target.workspace.inspect(prepared.reference.environmentId); expect(sealed.results[prepared.roundId]).toBeDefined()
        prepared = await prepare(f.target, result.imported!.source, sealed); expect(prepared.operation.status, JSON.stringify(prepared.operation.error)).toBe('succeeded')
        const nested = join(prepared.workspace.checkout, 'vendor/lib/nested module')
        expect(readFileSync(join(nested, 'asset.bin'))).toEqual(content)
        await f.target.workspace.validatePrepared(prepared.reference, prepared.workspace.cwd)
        writeFileSync(join(nested, 'asset.bin'), git(nested, 'show', 'HEAD:asset.bin') + '\n')
        await expect(f.target.cache.hydrate(prepared.workspace.source, prepared.workspace.checkout, {}, true)).rejects.toMatchObject({ code: 'workspace_lfs_unready' })
        const start = vi.fn(); await expect(f.target.workspace.launch(prepared.reference, prepared.workspace.cwd, randomUUID(), start)).rejects.toThrow(); expect(start).not.toHaveBeenCalled()
        git(nested, 'lfs', 'checkout'); await f.target.workspace.validatePrepared(prepared.reference, prepared.workspace.cwd)
        git(nested, 'config', 'user.name', 'Test'); git(nested, 'config', 'user.email', 'test@example.invalid'); writeFileSync(join(nested, 'extra'), 'drift'); commit(nested)
        await expect(f.target.workspace.validatePrepared(prepared.reference, prepared.workspace.cwd)).rejects.toThrow()
        git(sourceCache(result), 'update-ref', result.imported!.source.baseRef, git(sourceCache(result), 'rev-parse', `${result.imported!.source.baseRef}~1`))
        await expect(inspect(f.target.manager, transfer.request.operationId)).rejects.toMatchObject({ code: 'repository_ref_conflict' })
    }, 30_000)

    it('rejects byte corruption, incremental bundles despite a warm cache, and inaccurate manifests', async () => {
        const f = fixture(); writeFileSync(join(f.repo, 'app/note'), 'second'); commit(f.repo)
        const transfer = await exported(f), result = await imported(f.target, transfer.request)
        expect(result.status, JSON.stringify(result.error)).toBe('succeeded')
        const file = transfer.request.files[0]!, original = readFileSync(file.path)
        writeFileSync(file.path, 'truncated')
        const corrupt = await imported(f.target, { ...transfer.request, operationId: randomUUID() }); expect(corrupt.error?.code).toBe('repository_file_mismatch')
        writeFileSync(file.path, original)
        const offline = join(f.root, 'source-offline/project'), ref = transfer.request.snapshot.repositories[0]!.bundleRef
        git(offline, 'update-ref', ref, transfer.request.snapshot.baseCommit); git(offline, 'bundle', 'create', file.path, ref, '^HEAD~1')
        const snapshot = structuredClone(transfer.request.snapshot), bytes = readFileSync(file.path)
        snapshot.files[0]!.size = bytes.length; snapshot.files[0]!.sha256 = createHash('sha256').update(bytes).digest('hex')
        const incremental = await imported(f.target, { ...transfer.request, operationId: randomUUID(), snapshot })
        expect(incremental.status).toBe('failed'); expect(incremental.error?.hint).toContain('prerequisite')
        writeFileSync(file.path, original)
        const wrong = structuredClone(transfer.request.snapshot); wrong.repositories[0]!.commit = 'a'.repeat(40)
        expect((await imported(f.target, { ...transfer.request, operationId: randomUUID(), snapshot: wrong })).error?.code).toBe('repository_manifest_invalid')
        expect((await inspect(f.target.manager, transfer.request.operationId)).status).toBe('succeeded')
    }, 30_000)

    it('keeps changed LFS entities across rounds without global LFS configuration or network fallback', async () => {
        vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null'); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
        const f = fixture(); git(f.repo, 'lfs', 'install', '--local')
        writeFileSync(join(f.repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
        writeFileSync(join(f.repo, 'asset.bin'), 'original entity'); commit(f.repo)
        const transfer = await exported(f)
        const [a, b] = await Promise.all([imported(f.target, transfer.request), imported(f.target, { ...transfer.request, operationId: randomUUID() })])
        expect(a.status, JSON.stringify(a.error)).toBe('succeeded'); expect(b.status, JSON.stringify(b.error)).toBe('succeeded')
        expect(a.imported!.source.commonDir).toBe(b.imported!.source.commonDir)
        const first = await prepare(f.target, a.imported!.source); expect(first.operation.status, JSON.stringify(first.operation.error)).toBe('succeeded')
        const changed = Buffer.from('second round binary\0'.repeat(500)); writeFileSync(join(first.workspace.checkout, 'asset.bin'), changed)
        await f.target.workspace.request({ action: 'finalize', ...first.reference, roundId: first.roundId, attemptId: randomUUID() }); await f.target.workspace.settled()
        const sealed = await f.target.workspace.inspect(first.reference.environmentId); expect(sealed.results[first.roundId]).toBeDefined()
        const second = await prepare(f.target, a.imported!.source, sealed)
        expect(second.operation.status, JSON.stringify(second.operation.error)).toBe('succeeded')
        expect(readFileSync(join(second.workspace.checkout, 'asset.bin'))).toEqual(changed)
        await f.target.workspace.validatePrepared(second.reference, second.workspace.cwd)
        const original = a.snapshot!.lfs[0]!, cache = a.imported!.source.commonDir
        writeFileSync(join(cache, 'lfs/objects', original.oid.slice(0, 2), original.oid.slice(2, 4), original.oid), 'broken entity')
        const broken = await prepare(f.target, b.imported!.source)
        expect(broken.operation.status).toBe('failed'); expect(broken.operation.error?.code).toBe('workspace_lfs_unready')
    }, 30_000)

    it('reconciles an interrupted import without repeating it or losing its failure receipt', async () => {
        const f = fixture(), transfer = await exported(f), operationId = transfer.request.operationId
        const directory = join(f.root, 'target-home/workspaces/imports', operationId); mkdirSync(directory, { recursive: true })
        const receipt: RepositoryOperation = { version: 1, request: transfer.request, directory: join(directory, 'data/files'),
            status: 'running', createdAt: Date.now(), updatedAt: Date.now(), retention: 'retained', releasedFiles: [] }
        writeFileSync(join(directory, 'operation.json'), JSON.stringify(receipt))
        const restarted = machine(join(f.root, 'target-home'), 'target')
        const stopped = await inspect(restarted.manager, operationId)
        expect(stopped.status).toBe('failed'); expect(stopped.error?.code).toBe('repository_import_interrupted')
        expect(await restarted.manager.request(transfer.request)).toEqual({ operation: stopped })
        expect(existsSync(restarted.cache.commonDir(transfer.request.snapshot))).toBe(false)
    })
})

function sourceCache(result: RepositoryOperation) { return result.imported!.source.commonDir }
