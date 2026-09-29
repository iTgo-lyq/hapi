import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ManagedWorkspace, RepositoryOperation, WorkspaceSource } from '@hapi/protocol'
import { MachinePathPolicy } from '@/api/machinePathPolicy'
import { WorkspaceManager } from '../workspaces/manager'
import { WorkspaceError } from '../workspaces/git'
import { RepositoryManager } from './manager'
import { RepositoryCache } from './cache'

const roots: string[] = [], managers: RepositoryManager[] = [], workspaces: WorkspaceManager[] = []
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }
function git(cwd: string, ...args: string[]) { return execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
function init(path: string, format = 'sha1') {
    mkdirSync(path, { recursive: true }); git(path, 'init', '-q', `--object-format=${format}`)
    git(path, 'config', 'user.name', 'Result Test'); git(path, 'config', 'user.email', 'test@example.invalid'); git(path, 'config', 'commit.gpgsign', 'false')
    return path
}
function commit(path: string) { git(path, 'add', '-A'); git(path, 'commit', '-qm', 'test'); return git(path, 'rev-parse', 'HEAD') }
function machine(home: string, machineId: string, assertStopped = async (_id: string) => {}) {
    const pathPolicy = new MachinePathPolicy(), cache = new RepositoryCache({ home, machineId, scope: 'results-test', pathPolicy })
    const workspace = new WorkspaceManager({ home, machineId, pathPolicy, snapshots: cache, assertStopped })
    const manager = new RepositoryManager({ home, pathPolicy, cache, resolveSource: (...args) => workspace.resolveSource(...args),
        repositoryWorkspaces: dir => workspace.repositoryRecords(dir), withRepositoryLock: (key, action) => workspace.withRepositoryLock(key, action),
        withSealedResult: (id, round, options, action) => workspace.withSealedResult(id, round, options, action) })
    managers.push(manager); workspaces.push(workspace)
    return { home, manager, workspace }
}
function fixture(format = 'sha1') {
    const parent = resolve(import.meta.dirname, '../../../../../.dev-smoke'); mkdirSync(parent, { recursive: true })
    const root = mkdtempSync(join(parent, 'result-unit-')); roots.push(root)
    const repo = init(join(root, 'source/project'), format); mkdirSync(join(repo, 'app')); writeFileSync(join(repo, 'app/note'), 'baseline'); commit(repo)
    return { root, repo, source: machine(join(root, 'source-home'), 'source'), target: machine(join(root, 'target-home'), 'target') }
}
async function inspect(manager: RepositoryManager, operationId: string) {
    const response = await manager.request({ action: 'inspect', operationId }); if ('error' in response) throw new Error(response.error.message)
    return response.operation
}
async function operation(manager: RepositoryManager, request: RepositoryOperation['request']) {
    await manager.request(request); await manager.settled(); return inspect(manager, request.operationId)
}
async function baseline(f: ReturnType<typeof fixture>) {
    const origin = await f.source.workspace.resolveSource(join(f.repo, 'app'), 'HEAD')
    const exported = await operation(f.source.manager, { action: 'export', operationId: randomUUID(), source: origin })
    expect(exported.status, JSON.stringify(exported.error)).toBe('succeeded')
    renameSync(join(f.root, 'source'), join(f.root, 'source-offline'))
    const imported = await operation(f.target.manager, { action: 'import', operationId: randomUUID(), snapshot: exported.snapshot!,
        files: exported.snapshot!.files.map(file => ({ name: file.name, path: join(exported.directory, file.name) })) })
    expect(imported.status, JSON.stringify(imported.error)).toBe('succeeded')
    return { ...imported.imported!.source, relativePath: origin.relativePath }
}
async function prepare(target: ReturnType<typeof machine>, source: WorkspaceSource, previous?: ManagedWorkspace) {
    const environmentId = previous?.environmentId ?? randomUUID(), preparationId = randomUUID(), roundId = randomUUID()
    const expectedHead = previous ? Object.values(previous.results).at(-1)!.resultHead : source.baseCommit
    await target.workspace.request({ action: 'prepare', environmentId, preparationId, roundId, source, expectedHead }); await target.workspace.settled()
    const workspace = await target.workspace.inspect(environmentId)
    expect(workspace.operations[`prepare:${preparationId}`]!.status, JSON.stringify(workspace.operations)).toBe('succeeded')
    return { environmentId, preparationId, roundId, workspace }
}
async function seal(target: ReturnType<typeof machine>, round: Awaited<ReturnType<typeof prepare>>, partial = false, sessionId?: string) {
    const attemptId = randomUUID(); await target.workspace.request({ action: 'finalize', environmentId: round.environmentId,
        preparationId: round.preparationId, roundId: round.roundId, attemptId, partial, ...(sessionId ? { sessionId } : {}) }); await target.workspace.settled()
    const workspace = await target.workspace.inspect(round.environmentId)
    expect(workspace.operations[`finalize:${round.roundId}:${attemptId}`]!.status, JSON.stringify(workspace.operations)).toBe('succeeded')
    return workspace
}
const requestFor = (round: { environmentId: string; roundId: string }) => ({ action: 'export-result' as const,
    operationId: randomUUID(), environmentId: round.environmentId, roundId: round.roundId })
afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.stop()
    for (const workspace of workspaces.splice(0)) await workspace.stop()
    vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each(['sha1', 'sha256'])('captures complete %s results, including an unchanged round, with immutable restart receipts', async format => {
    const f = fixture(format), source = await baseline(f), first = await prepare(f.target, source)
    writeFileSync(join(first.workspace.cwd, 'note'), 'first result')
    const one = await seal(f.target, first, true), request = requestFor(first)
    const exported = await operation(f.target.manager, request)
    expect(exported.status, JSON.stringify(exported.error)).toBe('succeeded')
    expect(exported.sealed!.result).toEqual(one.results[first.roundId]); expect(exported.sealed!.result.partial).toBe(true)
    expect(existsSync(join(exported.directory, '../scratch'))).toBe(false); expect(existsSync(join(exported.directory, '../verify'))).toBe(false)
    const bytes = readFileSync(join(exported.directory, 'repository-0.bundle')), refs = git(source.commonDir, 'show-ref')
    const second = await prepare(f.target, source, one), two = await seal(f.target, second)
    const unchanged = await operation(f.target.manager, requestFor(second))
    expect(unchanged.status, JSON.stringify(unchanged.error)).toBe('succeeded')
    expect(unchanged.sealed!.result.resultHead).toBe(exported.sealed!.result.resultHead); expect(unchanged.sealed!.result.checkpoint).toBeUndefined()
    expect(git(source.commonDir, 'rev-list', '--count', two.results[second.roundId]!.resultHead)).toBe('2')
    const restarted = machine(f.target.home, 'target'); expect(await restarted.manager.request(request)).toEqual({ operation: exported })
    expect(readFileSync(join(exported.directory, 'repository-0.bundle'))).toEqual(bytes)
    expect(git(source.commonDir, 'show-ref')).toContain(refs.split('\n')[0]!)
    await expect(restarted.manager.request({ ...request, roundId: randomUUID() })).rejects.toMatchObject({ code: 'repository_request_conflict' })
    const receiver = machine(join(f.root, 'receiver'), 'receiver')
    renameSync(f.target.home, `${f.target.home}-offline`)
    const imported = await operation(receiver.manager, { action: 'import', operationId: randomUUID(), snapshot: exported.snapshot!,
        files: exported.snapshot!.files.map(file => ({ name: file.name, path: join(`${f.target.home}-offline`, filePath(f.target.home, exported.directory), file.name) })) })
    expect(imported.status, JSON.stringify(imported.error)).toBe('succeeded')
    expect(git(imported.imported!.source.commonDir, 'show', `${exported.snapshot!.baseCommit}:app/note`)).toBe('first result')
}, 30_000)
function filePath(home: string, path: string) { return path.slice(home.length + 1) }

it('captures new binary LFS and recursive module objects without origin URLs or the original task cwd', async () => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null'); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    const f = fixture(), leaf = init(join(f.root, 'source/leaf')), module = init(join(f.root, 'source/module'))
    writeFileSync(join(leaf, 'leaf'), 'leaf'); commit(leaf)
    git(module, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'same', leaf, 'nested'); commit(module)
    git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--name', 'same', module, 'vendor/lib'); commit(f.repo)
    git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive')
    git(f.repo, 'lfs', 'install', '--local'); writeFileSync(join(f.repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
    writeFileSync(join(f.repo, 'asset.bin'), 'original'); commit(f.repo)
    const source = await baseline(f), round = await prepare(f.target, source), bytes = Buffer.from('result\0binary'.repeat(2048))
    writeFileSync(join(round.workspace.checkout, 'asset.bin'), bytes); rmSync(round.workspace.cwd, { recursive: true })
    const sealed = await seal(f.target, round), exported = await operation(f.target.manager, requestFor(round))
    expect(exported.status, JSON.stringify(exported.error)).toBe('succeeded'); expect(exported.sealed!.result).toEqual(sealed.results[round.roundId])
    expect(exported.snapshot!.repositories.map(repo => repo.path)).toEqual(['', 'vendor/lib', 'vendor/lib/nested'])
    expect(exported.snapshot!.lfs[0]!.oid).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(readFileSync(join(exported.directory, exported.snapshot!.lfs[0]!.file))).toEqual(bytes)
    const receiver = machine(join(f.root, 'receiver'), 'receiver')
    const imported = await operation(receiver.manager, { action: 'import', operationId: randomUUID(), snapshot: exported.snapshot!,
        files: exported.snapshot!.files.map(file => ({ name: file.name, path: join(exported.directory, file.name) })) })
    expect(imported.status, JSON.stringify(imported.error)).toBe('succeeded')
    expect(git(source.commonDir, 'rev-list', '--count', 'HEAD')).toBe('3') // Export adds no commit; cache HEAD stays at baseline.
    const moduleGit = git(join(round.workspace.checkout, 'vendor/lib'), 'rev-parse', '--absolute-git-dir')
    renameSync(moduleGit, `${moduleGit}-missing`)
    expect((await operation(f.target.manager, requestFor(round))).status).toBe('failed')
    renameSync(`${moduleGit}-missing`, moduleGit)
    const lfs = join(source.commonDir, 'lfs/objects', exported.snapshot!.lfs[0]!.oid.slice(0, 2), exported.snapshot!.lfs[0]!.oid.slice(2, 4), exported.snapshot!.lfs[0]!.oid)
    rmSync(lfs)
    expect((await operation(f.target.manager, requestFor(round))).error?.code).toBe('repository_lfs_missing')
    expect((await f.target.manager.request({ action: 'release', operationId: exported.request.operationId }) as { operation: RepositoryOperation }).operation.retention).toBe('released')
    expect(existsSync(round.workspace.checkout)).toBe(true)
}, 45_000)

it('refuses unsealed, active, changed-ref and invalid-ancestry results while retaining the checkout', async () => {
    const f = fixture(), source = await baseline(f), round = await prepare(f.target, source), request = requestFor(round)
    expect((await operation(f.target.manager, request)).error?.code).toBe('workspace_result_missing')
    writeFileSync(join(round.workspace.cwd, 'note'), 'result'); const workspace = await seal(f.target, round), result = workspace.results[round.roundId]!
    git(source.commonDir, 'update-ref', result.resultRef, source.baseCommit)
    expect((await operation(f.target.manager, requestFor(round))).error?.code).toBe('workspace_result_missing')
    git(source.commonDir, 'update-ref', result.resultRef, result.resultHead)
    writeFileSync(join(round.workspace.checkout, 'drift'), 'unsealed')
    expect((await operation(f.target.manager, requestFor(round))).error?.code).toBe('workspace_drift'); rmSync(join(round.workspace.checkout, 'drift'))
    const path = join(f.target.home, 'workspaces/environments', round.environmentId, 'workspace.json')
    const record = JSON.parse(readFileSync(path, 'utf8')) as ManagedWorkspace
    const unrelated = git(source.commonDir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit-tree', git(source.commonDir, 'rev-parse', `${source.baseCommit}^{tree}`), '-m', 'unrelated')
    record.preparations[round.preparationId]!.startHead = unrelated; record.results[round.roundId]!.startHead = unrelated; writeFileSync(path, JSON.stringify(record))
    const restarted = machine(f.target.home, 'target')
    expect((await operation(restarted.manager, requestFor(round))).error?.code).toBe('repository_result_history')
    record.preparations[round.preparationId]!.startHead = source.baseCommit; record.results[round.roundId]!.startHead = source.baseCommit
    record.sessions['active-session'] = { preparationId: round.preparationId, attemptedAt: Date.now() }; writeFileSync(path, JSON.stringify(record))
    const active = machine(f.target.home, 'target', async () => { throw new WorkspaceError('workspace_execution_active', 'still running') })
    expect((await operation(active.manager, requestFor(round))).error?.code).toBe('workspace_execution_active')
    expect(existsSync(round.workspace.checkout)).toBe(true)
}, 30_000)

it('holds preparation behind result capture and reconciles interrupted exports without rerunning', async () => {
    const f = fixture(), source = await baseline(f), first = await prepare(f.target, source), sealed = await seal(f.target, first)
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const capture = f.target.workspace.withSealedResult(first.environmentId, first.roundId, {}, async () => { enter(); await held })
    await entered
    const preparationId = randomUUID(), roundId = randomUUID()
    await f.target.workspace.request({ action: 'prepare', environmentId: first.environmentId, preparationId, roundId, source,
        expectedHead: sealed.results[first.roundId]!.resultHead })
    expect((await f.target.workspace.inspect(first.environmentId)).preparations[preparationId]).toBeUndefined()
    release(); await capture; await f.target.workspace.settled()
    expect((await f.target.workspace.inspect(first.environmentId)).preparations[preparationId]).toBeDefined()
    const request = requestFor(first), directory = join(f.target.home, 'workspaces/exports', request.operationId)
    mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'operation.json'), JSON.stringify({ version: 1, request,
        directory: join(directory, 'data/files'), status: 'running', retention: 'retained', releasedFiles: [], createdAt: Date.now(), updatedAt: Date.now() }))
    const restarted = machine(f.target.home, 'target'), stopped = await inspect(restarted.manager, request.operationId)
    expect(stopped.status).toBe('failed'); expect(stopped.error?.code).toBe('repository_export-result_interrupted')
    expect(await restarted.manager.request(request)).toEqual({ operation: stopped }); expect(existsSync(join(directory, 'data'))).toBe(false)
}, 30_000)
