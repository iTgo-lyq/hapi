import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { WorkspaceManager } from './manager'
import { MachinePathPolicy } from '@/api/machinePathPolicy'
import type { ManagedWorkspace, WorkspaceRequest } from '@hapi/protocol'

const roots: string[] = []
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
function git(path: string, ...args: string[]) { return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', env }).trim() }
function fixture(options: { gitTimeoutMs?: number } = {}) {
    const parent = resolve(import.meta.dirname, '../../../../../.dev-smoke'); mkdirSync(parent, { recursive: true })
    const root = mkdtempSync(join(parent, 'workspace-unit-')); roots.push(root)
    const repo = join(root, 'repo'); mkdirSync(repo); git(repo, 'init', '-q')
    git(repo, 'config', 'user.name', 'Workspace Test'); git(repo, 'config', 'user.email', 'test@example.invalid')
    git(repo, 'config', 'commit.gpgsign', 'false')
    mkdirSync(join(repo, 'app')); writeFileSync(join(repo, 'app/file.txt'), 'base\n'); writeFileSync(join(repo, '.gitignore'), 'deps/\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
    const stopped = new Set<string>()
    const manager = new WorkspaceManager({ home: join(root, 'hapi'), machineId: 'machine', pathPolicy: new MachinePathPolicy(),
        ...options, assertStopped: async id => { if (!stopped.has(id)) throw new Error('execution is not confirmed stopped') } })
    return { root, repo, manager, stopped }
}
async function prepare(f: ReturnType<typeof fixture>, overrides: Partial<Extract<WorkspaceRequest, { action: 'prepare' }>> = {}) {
    const source = await f.manager.resolveSource(join(f.repo, 'app'), 'HEAD')
    const request = { action: 'prepare' as const, source, expectedHead: source.baseCommit,
        environmentId: randomUUID(), preparationId: randomUUID(), roundId: randomUUID(), inputs: [], ...overrides }
    const accepted = await f.manager.request(request)
    expect('operation' in accepted && accepted.operation?.status).toBe('accepted')
    await f.manager.settled()
    return { request, workspace: await f.manager.inspect(request.environmentId) }
}
async function started(f: ReturnType<typeof fixture>, workspace: ManagedWorkspace, preparationId: string) {
    const sessionId = randomUUID()
    await f.manager.launch({ environmentId: workspace.environmentId, preparationId }, workspace.cwd, sessionId,
        async () => ({ type: 'success', sessionId }))
    f.stopped.add(sessionId)
    return sessionId
}
const finalRequest = (request: Awaited<ReturnType<typeof prepare>>['request'], sessionId: string) => ({ action: 'finalize' as const,
    environmentId: request.environmentId, preparationId: request.preparationId, roundId: request.roundId, sessionId, attemptId: randomUUID(), partial: false })
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('machine-owned workspaces', () => {
    it('seals unused or definitively rejected preparations without inventing an execution', async () => {
        const f = fixture(), { request, workspace } = await prepare(f)
        const unused = { action: 'finalize' as const, environmentId: request.environmentId, preparationId: request.preparationId,
            roundId: request.roundId, attemptId: randomUUID(), partial: true }
        await f.manager.request(unused); await f.manager.settled()
        const first = (await f.manager.inspect(request.environmentId)).results[request.roundId]!
        expect(first).toMatchObject({ resultHead: request.expectedHead, fileCount: 0, partial: true })
        expect(first.checkpoint).toBeUndefined()
        await expect(f.manager.validatePrepared(request, workspace.cwd)).rejects.toMatchObject({ code: 'workspace_preparation_expired' })
        const next = { ...request, preparationId: randomUUID(), roundId: randomUUID() }
        await f.manager.request(next); await f.manager.settled()
        await f.manager.launch(next, workspace.cwd, randomUUID(), async () => ({ type: 'error', childStarted: false }))
        await f.manager.request({ ...unused, preparationId: next.preparationId, roundId: next.roundId, attemptId: randomUUID() }); await f.manager.settled()
        expect((await f.manager.inspect(request.environmentId)).results[next.roundId]?.resultHead).toBe(first.resultHead)
        const active = { ...request, preparationId: randomUUID(), roundId: randomUUID() }
        await f.manager.request(active); await f.manager.settled()
        const sessionId = await started(f, await f.manager.inspect(request.environmentId), active.preparationId)
        const missingIdentity = { ...unused, preparationId: active.preparationId, roundId: active.roundId, attemptId: randomUUID() }
        await f.manager.request(missingIdentity); await f.manager.settled()
        const rejected = await f.manager.inspect(request.environmentId)
        expect(rejected.operations[`finalize:${active.roundId}:${missingIdentity.attemptId}`]?.error?.code).toBe('workspace_execution_identity_required')
        expect(rejected.results[active.roundId]).toBeUndefined()
        await f.manager.request(finalRequest(active, sessionId)); await f.manager.settled()
        expect((await f.manager.inspect(request.environmentId)).results[active.roundId]?.resultHead).toBe(first.resultHead)
    })
    it('freezes a committed subdirectory base and checkpoints without changing parent state', async () => {
        const f = fixture(), base = git(f.repo, 'rev-parse', 'HEAD')
        writeFileSync(join(f.repo, 'app/file.txt'), 'parent staged\n'); git(f.repo, 'add', '.')
        writeFileSync(join(f.repo, 'parent-only.txt'), 'untracked\n')
        const parentIndex = git(f.repo, 'write-tree'), parentStatus = git(f.repo, 'status', '--porcelain')
        const { request, workspace } = await prepare(f)
        expect(workspace.operations[`prepare:${request.preparationId}`]?.status).toBe('succeeded')
        expect(readFileSync(join(workspace.cwd, 'file.txt'), 'utf8')).toBe('base\n')
        expect(existsSync(join(workspace.checkout, 'parent-only.txt'))).toBe(false)
        const sessionId = await started(f, workspace, request.preparationId)
        writeFileSync(join(workspace.cwd, 'file.txt'), 'agent change\n'); writeFileSync(join(workspace.checkout, 'bytes.bin'), Buffer.from([0, 255, 1]))
        const finalize = finalRequest(request, sessionId)
        await f.manager.request(finalize); await f.manager.settled()
        const complete = await f.manager.inspect(request.environmentId), result = complete.results[request.roundId]!
        expect(complete.operations[`finalize:${request.roundId}:${finalize.attemptId}`]?.status).toBe('succeeded')
        expect(result.checkpoint).toBe(result.resultHead); expect(result.fileCount).toBe(2)
        expect(git(f.repo, 'rev-parse', result.resultRef)).toBe(result.resultHead)
        expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(base); expect(git(f.repo, 'write-tree')).toBe(parentIndex)
        expect(git(f.repo, 'status', '--porcelain')).toBe(parentStatus)
        expect(git(workspace.checkout, 'show', '-s', '--format=%cn <%ce>', 'HEAD')).toBe('HAPI Checkpoint <checkpoint@hapi.local>')
        expect(git(workspace.checkout, 'show', '-s', '--format=%B', 'HEAD')).toContain(`HAPI-Finalize: ${finalize.attemptId}`)
    })
    it('deduplicates preparation and refuses drift or missing checkout before launching', async () => {
        const f = fixture(), { request, workspace } = await prepare(f)
        const repeated = await f.manager.request(request)
        expect('operation' in repeated && repeated.operation?.status).toBe('succeeded')
        await expect(f.manager.request({ ...request, expectedHead: 'a'.repeat(40) })).rejects.toMatchObject({ code: 'workspace_request_conflict' })
        const reference = { environmentId: request.environmentId, preparationId: request.preparationId }
        writeFileSync(join(workspace.cwd, 'file.txt'), 'drift')
        let launches = 0
        await expect(f.manager.launch(reference, workspace.cwd, randomUUID(), async () => { launches++; return { type: 'success' } })).rejects.toMatchObject({ code: 'workspace_preparation_stale' })
        await rm(workspace.checkout, { recursive: true, force: true })
        await expect(f.manager.launch(reference, workspace.cwd, randomUUID(), async () => { launches++; return { type: 'success' } })).rejects.toMatchObject({ code: 'workspace_missing' })
        expect(launches).toBe(0); expect(existsSync(workspace.checkout)).toBe(false)
    })
    it('retains hook failures, accepts manual repair, and avoids empty next-round checkpoints', async () => {
        const f = fixture(), { request, workspace } = await prepare(f)
        const sessionId = await started(f, workspace, request.preparationId)
        const hook = join(f.repo, '.git/hooks/pre-commit'); writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o700)
        writeFileSync(join(workspace.checkout, 'change.txt'), 'retained')
        const failed = finalRequest(request, sessionId)
        await f.manager.request(failed); await f.manager.settled()
        const retained = await f.manager.inspect(request.environmentId)
        expect(retained.operations[`finalize:${request.roundId}:${failed.attemptId}`]?.status).toBe('failed')
        expect(retained.results[request.roundId]).toBeUndefined(); expect(existsSync(join(workspace.checkout, 'change.txt'))).toBe(true)
        await rm(hook); git(workspace.checkout, 'commit', '-qm', 'manual repair')
        const head = git(workspace.checkout, 'rev-parse', 'HEAD')
        await f.manager.request(finalRequest(request, sessionId)); await f.manager.settled()
        expect((await f.manager.inspect(request.environmentId)).results[request.roundId]?.resultHead).toBe(head)
        const next = { ...request, preparationId: randomUUID(), roundId: randomUUID(), expectedHead: head }
        await f.manager.request(next); await f.manager.settled()
        const nextSession = await started(f, await f.manager.inspect(request.environmentId), next.preparationId)
        await f.manager.request(finalRequest(next, nextSession)); await f.manager.settled()
        const result = (await f.manager.inspect(request.environmentId)).results[next.roundId]!
        expect(result.resultHead).toBe(head); expect(result.checkpoint).toBeUndefined(); expect(result.fileCount).toBe(0)
    })
    it('accepts formatter hooks and preserves earlier agent commits', async () => {
        const f = fixture(), { request, workspace } = await prepare(f)
        const sessionId = await started(f, workspace, request.preparationId)
        writeFileSync(join(workspace.checkout, 'agent.txt'), 'agent'); git(workspace.checkout, 'add', '.'); git(workspace.checkout, 'commit', '-qm', 'agent commit')
        const agentHead = git(workspace.checkout, 'rev-parse', 'HEAD')
        const hook = join(f.repo, '.git/hooks/pre-commit'); writeFileSync(hook, '#!/bin/sh\nprintf "formatted\\n" > formatted.txt\ngit add formatted.txt\n'); chmodSync(hook, 0o700)
        writeFileSync(join(workspace.checkout, 'unfinished.txt'), 'pending')
        await f.manager.request(finalRequest(request, sessionId)); await f.manager.settled()
        const result = (await f.manager.inspect(request.environmentId)).results[request.roundId]!
        expect(git(workspace.checkout, 'rev-parse', `${result.resultHead}^`)).toBe(agentHead)
        expect(git(workspace.checkout, 'show', `${result.resultHead}:formatted.txt`)).toBe('formatted')
    })
    it('rejects ambiguous bases and uncommitted subdirectories', async () => {
        const f = fixture(); git(f.repo, 'branch', 'same'); git(f.repo, 'tag', 'same')
        await expect(f.manager.resolveSource(f.repo, 'same')).rejects.toMatchObject({ code: 'git_ref_ambiguous' })
        mkdirSync(join(f.repo, 'uncommitted'))
        await expect(f.manager.resolveSource(join(f.repo, 'uncommitted'), 'HEAD')).rejects.toThrow()
    })
})


describe('workspace recovery and data retention', () => {
    it('refuses ignored cleanup until explicitly requested, retaining immutable results', async () => {
        const f = fixture(), { request, workspace } = await prepare(f)
        const sessionId = await started(f, workspace, request.preparationId)
        await f.manager.request(finalRequest(request, sessionId)); await f.manager.settled()
        mkdirSync(join(workspace.checkout, 'deps')); writeFileSync(join(workspace.checkout, 'deps/data'), 'retained dependency')
        const remove = { action: 'remove', environmentId: request.environmentId, attemptId: randomUUID(), expectedHead: request.expectedHead }
        await f.manager.request(remove); await f.manager.settled()
        expect((await f.manager.inspect(request.environmentId)).operations[`remove:${remove.attemptId}`]?.error?.code).toBe('workspace_ignored_files')
        expect(existsSync(workspace.checkout)).toBe(true)
        await f.manager.request({ ...remove, attemptId: randomUUID(), discardIgnored: true }); await f.manager.settled()
        expect((await f.manager.inspect(request.environmentId)).status).toBe('removed')
        expect(existsSync(workspace.checkout)).toBe(false)
        expect(git(f.repo, 'rev-parse', `refs/hapi/workspaces/${request.environmentId}/rounds/${request.roundId}`)).toBe(request.expectedHead)
    })
    it('retains index locks and respects failed signing without changing Git policy', async () => {
        const f = fixture(), { request, workspace } = await prepare(f)
        const sessionId = await started(f, workspace, request.preparationId)
        writeFileSync(join(workspace.checkout, 'change.txt'), 'retained')
        const lock = git(workspace.checkout, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock'); writeFileSync(lock, 'owned elsewhere')
        const locked = finalRequest(request, sessionId)
        await f.manager.request(locked); await f.manager.settled()
        expect((await f.manager.inspect(request.environmentId)).operations[`finalize:${request.roundId}:${locked.attemptId}`]?.error?.code).toBe('workspace_git_in_progress')
        expect(readFileSync(lock, 'utf8')).toBe('owned elsewhere'); await rm(lock)
        const signer = join(f.root, 'signer'); writeFileSync(signer, '#!/bin/sh\nexit 1\n'); chmodSync(signer, 0o700)
        git(f.repo, 'config', 'commit.gpgsign', 'true'); git(f.repo, 'config', 'gpg.program', signer)
        const signed = finalRequest(request, sessionId)
        await f.manager.request(signed); await f.manager.settled()
        expect((await f.manager.inspect(request.environmentId)).operations[`finalize:${request.roundId}:${signed.attemptId}`]?.status).toBe('failed')
        expect(git(f.repo, 'config', 'commit.gpgsign')).toBe('true'); expect(git(workspace.checkout, 'rev-parse', 'HEAD')).toBe(request.expectedHead)
    })
    it('accepts slow operations immediately, kills timed-out hooks and permits explicit repair', async () => {
        const f = fixture({ gitTimeoutMs: 400 }), { request, workspace } = await prepare(f)
        const sessionId = await started(f, workspace, request.preparationId)
        const hook = join(f.repo, '.git/hooks/pre-commit')
        writeFileSync(hook, '#!/bin/sh\nsleep 2\nprintf unsafe > late-write\n'); chmodSync(hook, 0o700)
        writeFileSync(join(workspace.checkout, 'change.txt'), 'pending')
        const finish = finalRequest(request, sessionId), before = Date.now()
        await f.manager.request(finish); expect(Date.now() - before).toBeLessThan(200)
        await f.manager.settled()
        const operation = (await f.manager.inspect(request.environmentId)).operations[`finalize:${request.roundId}:${finish.attemptId}`]!
        expect(operation.status).toBe('failed'); expect(operation.error?.code).toBe('git_timeout'); expect(operation.process).toBeUndefined()
        expect(existsSync(join(workspace.checkout, 'late-write'))).toBe(false)
        // Git may leave its own lock after SIGKILL; only this explicit operator repair removes it.
        await rm(git(workspace.checkout, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock'), { force: true }); await rm(hook)
        git(workspace.checkout, 'commit', '-qm', 'manual repair')
        await f.manager.request(finalRequest(request, sessionId)); await f.manager.settled()
        expect((await f.manager.inspect(request.environmentId)).results[request.roundId]).toBeDefined()
    })
    it('recovers a lost checkpoint response without invoking its hook twice', async () => {
        const f = fixture(), { request, workspace } = await prepare(f)
        const sessionId = await started(f, workspace, request.preparationId), finish = finalRequest(request, sessionId)
        const counter = join(f.root, 'hook-count'), hook = join(f.repo, '.git/hooks/pre-commit')
        writeFileSync(hook, `#!/bin/sh\nprintf x >> '${counter}'\n`); chmodSync(hook, 0o700)
        writeFileSync(join(workspace.checkout, 'change.txt'), 'changed')
        await f.manager.request(finish); await f.manager.settled()
        const saved = await f.manager.inspect(request.environmentId), result = saved.results[request.roundId]!
        delete saved.results[request.roundId]
        const operation = saved.operations[`finalize:${request.roundId}:${finish.attemptId}`]!
        operation.status = 'running'; delete operation.checkpoint
        writeFileSync(join(f.root, 'hapi/workspaces/environments', request.environmentId, 'workspace.json'), JSON.stringify(saved))
        const restarted = new WorkspaceManager({ home: join(f.root, 'hapi'), machineId: 'machine', pathPolicy: new MachinePathPolicy(), assertStopped: async () => {} })
        const recovered = await restarted.inspect(request.environmentId)
        expect(recovered.results[request.roundId]?.resultHead).toBe(result.resultHead)
        expect(recovered.operations[operation.id]?.status).toBe('succeeded'); expect(readFileSync(counter, 'utf8')).toBe('x')
    })
    it('makes interrupted but stopped finalization repairable without automatic commit', async () => {
        const f = fixture(), { request, workspace } = await prepare(f)
        const sessionId = await started(f, workspace, request.preparationId), finish = finalRequest(request, sessionId)
        writeFileSync(join(workspace.checkout, 'change.txt'), 'manual repair needed')
        const saved = await f.manager.inspect(request.environmentId), id = `finalize:${request.roundId}:${finish.attemptId}`
        saved.operations[id] = { id, request: finish, status: 'running', expectedHead: request.expectedHead, createdAt: Date.now(), updatedAt: Date.now() }
        writeFileSync(join(f.root, 'hapi/workspaces/environments', request.environmentId, 'workspace.json'), JSON.stringify(saved))
        const restarted = new WorkspaceManager({ home: join(f.root, 'hapi'), machineId: 'machine', pathPolicy: new MachinePathPolicy(), assertStopped: async () => {} })
        expect((await restarted.inspect(request.environmentId)).operations[id]?.status).toBe('failed')
        expect(git(workspace.checkout, 'rev-parse', 'HEAD')).toBe(request.expectedHead)
        await restarted.request(finalRequest(request, sessionId)); await restarted.settled()
        expect((await restarted.inspect(request.environmentId)).results[request.roundId]).toBeDefined()
    })
    it('hydrates local submodules without changing shared config and retains nested ignored files', async () => {
        vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file') // Dedicated fixture transport, not a product override.
        const f = fixture(), module = join(f.root, 'module'); mkdirSync(module); git(module, 'init', '-q')
        git(module, 'config', 'user.name', 'Module'); git(module, 'config', 'user.email', 'module@example.invalid')
        writeFileSync(join(module, 'file.txt'), 'module'); writeFileSync(join(module, '.gitignore'), 'cache/\n')
        git(module, 'add', '.'); git(module, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'module')
        git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', module, 'module'); git(f.repo, 'commit', '-qam', 'submodule')
        const config = readFileSync(join(f.repo, '.git/config'), 'utf8'), { request, workspace } = await prepare(f)
        expect(workspace.operations[`prepare:${request.preparationId}`]?.status).toBe('succeeded')
        expect(readFileSync(join(workspace.checkout, 'module/file.txt'), 'utf8')).toBe('module')
        expect(readFileSync(join(f.repo, '.git/config'), 'utf8')).toBe(config)
        const sessionId = await started(f, workspace, request.preparationId)
        writeFileSync(join(workspace.checkout, 'module/file.txt'), 'nested dirty')
        const failed = finalRequest(request, sessionId); await f.manager.request(failed); await f.manager.settled()
        expect((await f.manager.inspect(request.environmentId)).operations[`finalize:${request.roundId}:${failed.attemptId}`]?.error?.code).toBe('workspace_submodule_dirty')
        git(join(workspace.checkout, 'module'), 'checkout', '--', 'file.txt')
        await f.manager.request(finalRequest(request, sessionId)); await f.manager.settled()
        mkdirSync(join(workspace.checkout, 'module/cache')); writeFileSync(join(workspace.checkout, 'module/cache/data'), 'keep')
        const remove = { action: 'remove', environmentId: request.environmentId, attemptId: randomUUID(), expectedHead: request.expectedHead }
        await f.manager.request(remove); await f.manager.settled()
        expect((await f.manager.inspect(request.environmentId)).operations[`remove:${remove.attemptId}`]?.error?.code).toBe('workspace_ignored_files')
        await f.manager.request({ ...remove, attemptId: randomUUID(), discardIgnored: true }); await f.manager.settled()
        expect((await f.manager.inspect(request.environmentId)).status).toBe('removed')
    })
    it('hydrates LFS objects locally and seals real content rather than pointer placeholders', async () => {
        const f = fixture(); git(f.repo, 'lfs', 'install', '--local')
        writeFileSync(join(f.repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
        const content = Buffer.from([0, 1, 255, 10, 50]); writeFileSync(join(f.repo, 'large.bin'), content)
        git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'lfs')
        const { request, workspace } = await prepare(f)
        expect(workspace.operations[`prepare:${request.preparationId}`]?.status).toBe('succeeded')
        expect(readFileSync(join(workspace.checkout, 'large.bin'))).toEqual(content)
        const sessionId = await started(f, workspace, request.preparationId)
        writeFileSync(join(workspace.checkout, 'large.bin'), Buffer.from([0, 2, 255]))
        await f.manager.request(finalRequest(request, sessionId)); await f.manager.settled()
        expect((await f.manager.inspect(request.environmentId)).results[request.roundId]).toBeDefined()
    })
})


it('keeps verified inputs outside source and detects changes before native launch', async () => {
    const f = fixture(), inputPath = join(f.root, 'context.txt'); writeFileSync(inputPath, 'context')
    const input = { name: '设计 说明.txt', path: inputPath, size: 7, sha256: createHash('sha256').update('context').digest('hex') }
    const { request, workspace } = await prepare(f, { inputs: [input] })
    const copied = workspace.preparations[request.preparationId]!.inputs[0]!
    expect(copied.path.startsWith(workspace.checkout)).toBe(false)
    expect(readFileSync(copied.path, 'utf8')).toBe('context')
    writeFileSync(copied.path, 'changed')
    await expect(f.manager.launch({ environmentId: request.environmentId, preparationId: request.preparationId }, workspace.cwd,
        randomUUID(), async () => { throw new Error('must not launch') })).rejects.toMatchObject({ code: 'workspace_input_mismatch' })
})

it('rejects a newly staged nested repository instead of sealing an incomplete gitlink', async () => {
    const f = fixture(), { request, workspace } = await prepare(f)
    const sessionId = await started(f, workspace, request.preparationId), nested = join(workspace.checkout, 'nested')
    mkdirSync(nested); git(nested, 'init', '-q'); writeFileSync(join(nested, 'file'), 'nested content'); git(nested, 'add', '.')
    git(nested, '-c', 'user.name=Nested', '-c', 'user.email=nested@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'nested')
    const finish = finalRequest(request, sessionId); await f.manager.request(finish); await f.manager.settled()
    const result = await f.manager.inspect(request.environmentId)
    expect(result.operations[`finalize:${request.roundId}:${finish.attemptId}`]?.error?.code).toBe('workspace_submodule_changed')
    expect(result.results[request.roundId]).toBeUndefined(); expect(git(workspace.checkout, 'rev-parse', 'HEAD')).toBe(request.expectedHead)
})

it('uses native relative URL resolution for recursive submodules', async () => {
    vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file')
    const f = fixture()
    for (const name of ['leaf', 'module']) {
        const repo = join(f.root, name); mkdirSync(repo); git(repo, 'init', '-q')
        git(repo, 'config', 'user.name', 'Submodule'); git(repo, 'config', 'user.email', 'submodule@example.invalid'); git(repo, 'config', 'commit.gpgsign', 'false')
        writeFileSync(join(repo, 'file'), name); git(repo, 'add', '.'); git(repo, 'commit', '-qm', name)
    }
    const module = join(f.root, 'module')
    git(module, '-c', 'protocol.file.allow=always', 'submodule', 'add', join(f.root, 'leaf'), 'leaf')
    git(module, 'config', '-f', '.gitmodules', 'submodule.leaf.url', '../leaf'); git(module, 'commit', '-qam', 'relative leaf')
    git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', module, 'module')
    git(f.repo, 'config', '-f', '.gitmodules', 'submodule.module.url', '../module'); git(f.repo, 'commit', '-qam', 'relative module')
    git(f.repo, 'config', '--unset', 'submodule.module.url'); git(f.repo, 'remote', 'add', 'origin', join(f.root, 'origin'))
    const { request, workspace } = await prepare(f)
    expect(workspace.operations[`prepare:${request.preparationId}`]).toMatchObject({ status: 'succeeded' })
    expect(readFileSync(join(workspace.checkout, 'module/leaf/file'), 'utf8')).toBe('leaf')
    expect(git(f.repo, 'config', 'submodule.module.url')).toBe(module)
})
