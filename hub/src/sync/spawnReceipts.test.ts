import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { MACHINE_CAPABILITIES, type SpawnSessionRequest } from '@hapi/protocol'
import { Store } from '../store'
import { SpawnRequestConflictError } from '../store/spawnReceiptStore'
import { RpcRegistry } from '../socket/rpcRegistry'
import { createMachinesRoutes } from '../web/routes/machines'
import type { WebAppEnv } from '../web/middleware/auth'
import { SyncEngine } from './syncEngine'
import type { RpcGateway } from './rpcGateway'

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })

function setup(path = ':memory:') {
    const store = new Store(path)
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    cleanup.push(() => { engine.stop(); store.close() })
    for (const [id, namespace] of [['machine', 'default'], ['other', 'default'], ['foreign', 'tenant']]) {
        engine.getOrCreateMachine(id!, { host: 'local', platform: 'linux', happyCliVersion: '0.30.7',
            capabilities: [MACHINE_CAPABILITIES.AgentAvailability] }, { status: 'running', capabilities: { mcpToolFilter: true, managedWorkspaces: 1, artifactTransfers: 1 } }, namespace!)
        engine.handleMachineAlive({ machineId: id!, time: Date.now() })
    }
    const gateway = (engine as unknown as { rpcGateway: RpcGateway }).rpcGateway
    return { store, engine, gateway }
}

const request = (): SpawnSessionRequest & { requestId: string } => ({
    requestId: crypto.randomUUID(), directory: '/workspace', agent: 'codex'
})

describe('durable spawn receipts', () => {
    it('returns one reserved ID for concurrent callers, including while RPC is pending', async () => {
        const { engine, gateway, store } = setup()
        let calls = 0
        let finish!: () => void
        const hold = new Promise<void>(resolve => { finish = resolve })
        gateway.spawnSession = async (...args) => {
            calls++
            expect(args[12]).toBeUndefined() // Must not accidentally reopen a fresh Codex session.
            expect(store.sessions.getSession(args[17]!)?.id).toBe(args[17])
            await hold
            return { type: 'success', sessionId: args[17]! }
        }
        const input = request()
        const first = engine.spawnSessionWithReceipt('default', 'machine', input)
        const repeated = await engine.spawnSessionWithReceipt('default', 'machine', input)
        expect(repeated.response).toBeNull()
        expect(engine.getSpawnReceipt('default', 'machine', input.requestId)).toEqual(repeated)
        finish()
        const completed = await first
        expect(completed.sessionId).toBe(repeated.sessionId)
        expect(completed.response).toEqual({ type: 'success', sessionId: repeated.sessionId })
        expect(await engine.spawnSessionWithReceipt('default', 'machine', { ...input, yolo: false, sessionType: 'simple' })).toEqual(completed)
        expect(calls).toBe(1)
    })

    it('rejects different parameters or machines and isolates namespaces', async () => {
        const { engine, gateway } = setup()
        let calls = 0
        gateway.spawnSession = async (...args) => { calls++; return { type: 'success', sessionId: args[17]! } }
        const input = request()
        const first = await engine.spawnSessionWithReceipt('default', 'machine', input)
        for (const change of [{ directory: '/different' }, { model: 'different' }, { agent: 'claude' as const }]) {
            await expect(engine.spawnSessionWithReceipt('default', 'machine', { ...input, ...change })).rejects.toBeInstanceOf(SpawnRequestConflictError)
        }
        await expect(engine.spawnSessionWithReceipt('default', 'other', input)).rejects.toBeInstanceOf(SpawnRequestConflictError)
        expect(engine.getSpawnReceipt('default', 'other', input.requestId)).toBeNull()
        expect(engine.getSpawnReceipt('tenant', 'machine', input.requestId)).toBeNull()
        const separate = await engine.spawnSessionWithReceipt('tenant', 'foreign', input)
        expect(separate.sessionId).not.toBe(first.sessionId)
        expect(calls).toBe(2)
    })

    it('retains the original rejection after safe stub cleanup and never dispatches again', async () => {
        const { engine, gateway, store } = setup()
        let calls = 0
        gateway.spawnSession = async () => { calls++; return { type: 'error', message: 'No executable', childStarted: false } }
        const input = request()
        const receipt = await engine.spawnSessionWithReceipt('default', 'machine', input)
        expect(store.sessions.getSession(receipt.sessionId)).toBeNull()
        expect(await engine.spawnSessionWithReceipt('default', 'machine', input)).toEqual(receipt)
        expect(calls).toBe(1)
    })

    it('preserves the stub and association after an ambiguous RPC failure', async () => {
        const { engine, gateway, store } = setup()
        gateway.spawnSession = async () => { throw new Error('Lost RPC reply') }
        const input = request()
        const receipt = await engine.spawnSessionWithReceipt('default', 'machine', input)
        expect(receipt.response).toEqual({ type: 'error', message: 'Lost RPC reply' })
        expect(store.sessions.getSession(receipt.sessionId)?.id).toBe(receipt.sessionId)
        expect(engine.getSpawnReceipt('default', 'machine', input.requestId)).toEqual(receipt)
    })

    it('commits receipt and stub together and survives deletion, restart and v26 migration', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'spawn-receipt-'))
        cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
        const path = join(dir, 'hapi.db')
        new Store(path).close()
        const old = new Database(path)
        old.exec('DROP TABLE spawn_receipts; PRAGMA user_version = 26;')
        old.close()
        const { engine, gateway, store } = setup(path)
        gateway.spawnSession = async (...args) => ({ type: 'success', sessionId: args[17]! })
        const input = request()
        const first = await engine.spawnSessionWithReceipt('default', 'machine', input)
        await engine.deleteSession(first.sessionId)
        engine.stop()
        store.close()
        const reopened = setup(path)
        reopened.gateway.spawnSession = async () => { throw new Error('Must not dispatch after restart') }
        expect(await reopened.engine.spawnSessionWithReceipt('default', 'machine', input)).toEqual(first)
        const rollbackId = crypto.randomUUID()
        expect(() => reopened.store.spawnReceipts.reserve('default', rollbackId, 'machine', 'fingerprint', () => {
            reopened.store.sessions.getOrCreateSession('rollback', {}, null, 'default')
            throw new Error('Failure creating reservation')
        })).toThrow('Failure creating reservation')
        expect(reopened.store.spawnReceipts.get('default', rollbackId)).toBeNull()
        expect(reopened.store.sessions.getSessions().some(s => s.tag === 'rollback')).toBe(false)
    })

    it('exposes receipts through existing machine auth and reports conflicts without spawning', async () => {
        const { engine, gateway } = setup()
        let calls = 0
        gateway.spawnSession = async (...args) => { calls++; return { type: 'success', sessionId: args[17]! } }
        const app = new Hono<WebAppEnv>()
        app.use('*', async (c, next) => { c.set('namespace', 'default'); await next() })
        app.route('/api', createMachinesRoutes(() => engine))
        const input = request()
        const post = (machineId: string, data: unknown) => app.request(`/api/machines/${machineId}/spawn`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data)
        })
        expect((await post('machine', { ...input, requestId: 'invalid' })).status).toBe(400)
        const first = await (await post('machine', input)).json()
        const found = await app.request(`/api/machines/machine/spawn-requests/${input.requestId}`)
        expect(await found.json()).toEqual(first)
        expect((await post('machine', { ...input, directory: '/different' })).status).toBe(409)
        expect((await app.request(`/api/machines/foreign/spawn-requests/${input.requestId}`)).status).toBe(403)
        const absent = await app.request(`/api/machines/other/spawn-requests/${input.requestId}`)
        expect(absent.status).toBe(404)
        expect(await absent.json()).toMatchObject({ code: 'spawn_request_not_found' })
        expect(calls).toBe(1)
    })
})

it('persists and forwards MCP filtering and binds it to request identity', async () => {
    const { engine, gateway, store } = setup();
    gateway.spawnSession = async (...args) => {
        expect(args[18]).toEqual(['runweft']);
        expect(store.sessions.getSession(args[17]!)?.metadata).toMatchObject({ disabledMcpServers: ['runweft'] });
        return { type: 'success', sessionId: args[17]! };
    };
    const input = { ...request(), disabledMcpServers: ['runweft'] };
    const receipt = await engine.spawnSessionWithReceipt('default', 'machine', input);
    expect(receipt.response?.type).toBe('success');
    await expect(engine.spawnSessionWithReceipt('default', 'machine', { ...input, disabledMcpServers: [] })).rejects.toBeInstanceOf(SpawnRequestConflictError);
});

it('rejects unsupported runners and runtimes without spawning or retaining a live stub', async () => {
    const { engine, gateway, store } = setup();
    engine.getOrCreateMachine('old', { host: 'host', platform: 'linux', happyCliVersion: 'old' }, null, 'default');
    gateway.spawnSession = async () => { throw new Error('must not dispatch'); };
    for (const [machine, agent] of [['old', 'codex'], ['machine', 'cursor']] as const) {
        const receipt = await engine.spawnSessionWithReceipt('default', machine, { ...request(), agent, disabledMcpServers: ['runweft'] });
        expect(receipt.response).toMatchObject({ type: 'error', childStarted: false });
        expect(store.sessions.getSession(receipt.sessionId)).toBeNull();
    }
});


it('preserves prepared workspace metadata and includes it in durable spawn identity', async () => {
    const { engine, gateway, store } = setup()
    const preparedWorkspace = { environmentId: crypto.randomUUID(), preparationId: crypto.randomUUID() }
    gateway.spawnSession = async (...args) => {
        expect(args[19]).toEqual(preparedWorkspace)
        expect(store.sessions.getSession(args[17]!)?.metadata).toMatchObject({ preparedWorkspace })
        return { type: 'success', sessionId: args[17]! }
    }
    const input = { ...request(), preparedWorkspace }
    expect((await engine.spawnSessionWithReceipt('default', 'machine', input)).response?.type).toBe('success')
    await expect(engine.spawnSessionWithReceipt('default', 'machine', { ...input,
        preparedWorkspace: { ...preparedWorkspace, preparationId: crypto.randomUUID() } })).rejects.toBeInstanceOf(SpawnRequestConflictError)
})

it('keeps workspace operations within the machine namespace and passes the structured request', async () => {
    const { engine, gateway } = setup(), calls: unknown[] = []
    const input = { action: 'inspect' as const, environmentId: crypto.randomUUID() }
    gateway.workspaceOperation = async (machine, operation) => { calls.push([machine, operation]); return { error: { code: 'workspace_not_found', message: 'Not found' } } }
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', 'default'); await next() })
    app.route('/api', createMachinesRoutes(() => engine))
    const post = (machine: string, body: unknown) => app.request(`/api/machines/${machine}/workspaces`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    })
    expect((await post('foreign', input)).status).toBe(403)
    expect((await post('machine', { ...input, environmentId: '../escape' })).status).toBe(400)
    expect(calls).toHaveLength(0)
    const response = await post('machine', input)
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'workspace_not_found' })
    expect(calls).toEqual([['machine', input]])
})

it('rejects an unsupported prepared launch before creating a native child', async () => {
    const { engine, gateway, store } = setup()
    engine.getOrCreateMachine('old', { host: 'host', platform: 'linux', happyCliVersion: 'old' }, null, 'default')
    gateway.spawnSession = async () => { throw new Error('must not dispatch') }
    const receipt = await engine.spawnSessionWithReceipt('default', 'old', { ...request(),
        preparedWorkspace: { environmentId: crypto.randomUUID(), preparationId: crypto.randomUUID() } })
    expect(receipt.response).toMatchObject({ type: 'error', code: 'workspace_not_prepared', childStarted: false })
    expect(store.sessions.getSession(receipt.sessionId)).toBeNull()
})

it('forwards the new preparation on resume and preserves archived state on rejection', async () => {
    const { engine, gateway, store } = setup()
    const preparedWorkspace = { environmentId: crypto.randomUUID(), preparationId: crypto.randomUUID() }
    const session = engine.getOrCreateSession('workspace-resume', {
        path: '/workspace', host: 'local', machineId: 'machine', flavor: 'codex', codexSessionId: crypto.randomUUID(),
        lifecycleState: 'archived', archivedAt: 100, preparedWorkspace,
    }, null, 'default')
    const next = { ...preparedWorkspace, preparationId: crypto.randomUUID() }
    const calls: unknown[] = []
    gateway.spawnSession = async (...args) => {
        calls.push(args[19])
        return { type: 'error', message: 'Prepared workspace is stale', code: 'workspace_not_prepared', childStarted: false }
    }
    expect(await engine.resumeSession(session.id, 'default', { preparedWorkspace: next })).toMatchObject({ type: 'error', code: 'workspace_not_prepared', childStarted: false })
    expect(calls).toEqual([next])
    expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({ lifecycleState: 'archived', preparedWorkspace })
    calls.length = 0
    expect(await engine.resumeSession(session.id, 'default', { preparedWorkspace: { ...next, environmentId: crypto.randomUUID() } })).toMatchObject({ type: 'error', code: 'workspace_not_prepared', childStarted: false })
    expect(calls).toHaveLength(0)
})


it('persists the successful resume preparation and blocks managed clear from bypassing the round', async () => {
    const { engine, gateway, store } = setup()
    const preparedWorkspace = { environmentId: crypto.randomUUID(), preparationId: crypto.randomUUID() }
    const session = engine.getOrCreateSession('workspace-resume-ok', {
        path: '/workspace', host: 'local', machineId: 'machine', flavor: 'codex', codexSessionId: crypto.randomUUID(),
        lifecycleState: 'archived', archivedAt: 100, preparedWorkspace, capabilities: { concurrentClients: true },
    }, null, 'default')
    const next = { ...preparedWorkspace, preparationId: crypto.randomUUID() }
    gateway.spawnSession = async () => ({ type: 'success', sessionId: session.id })
    ;(engine as unknown as { waitForSessionActive: () => Promise<boolean> }).waitForSessionActive = async () => true
    expect(await engine.resumeSession(session.id, 'default', { preparedWorkspace: next })).toEqual({ type: 'success', sessionId: session.id })
    expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({ preparedWorkspace: next })
    gateway.clearConversation = async () => { throw new Error('must not dispatch clear') }
    await expect(engine.clearConversation(session.id, 'default')).rejects.toThrow('Managed workspace rounds')
})


it('keeps Hub-owned preparation through native bootstrap adoption and sparse metadata updates', async () => {
    const { engine, gateway, store } = setup()
    const preparedWorkspace = { environmentId: crypto.randomUUID(), preparationId: crypto.randomUUID() }
    gateway.spawnSession = async (...args) => {
        const adopted = store.sessions.adoptPreallocatedSession(args[17]!, 'native-workspace-tag',
            { host: 'local', path: '/workspace', flavor: 'codex' }, null, 'default')
        expect(adopted.metadata).toMatchObject({ preparedWorkspace })
        const updated = store.sessions.updateSessionMetadata(adopted.id, { lifecycleState: 'archived' }, adopted.metadataVersion, 'default')
        expect(updated.result).toBe('success')
        expect(store.sessions.getSession(adopted.id)?.metadata).toMatchObject({ preparedWorkspace })
        return { type: 'success', sessionId: adopted.id }
    }
    expect((await engine.spawnSessionWithReceipt('default', 'machine', { ...request(), preparedWorkspace })).response?.type).toBe('success')
})


it('binds prepared files to the request, preserves adoption metadata and forwards resume or explicit clear', async () => {
    const { engine, gateway, store } = setup()
    const preparedFiles = { operationId: crypto.randomUUID() }, input = { ...request(), preparedFiles }
    gateway.spawnSession = async (...args) => {
        expect(args[20]).toEqual(preparedFiles)
        const session = store.sessions.adoptPreallocatedSession(args[17]!, 'files-native', { path: '/workspace', host: 'local', flavor: 'codex' }, null, 'default')
        expect(session.metadata).toMatchObject({ preparedFiles })
        store.sessions.updateSessionMetadata(session.id, { lifecycleState: 'archived', archivedAt: 100, codexSessionId: crypto.randomUUID() }, session.metadataVersion, 'default')
        expect(store.sessions.getSession(session.id)?.metadata).toMatchObject({ preparedFiles })
        return { type: 'success', sessionId: session.id }
    }
    const receipt = await engine.spawnSessionWithReceipt('default', 'machine', input)
    await expect(engine.spawnSessionWithReceipt('default', 'machine', { ...input, preparedFiles: { operationId: crypto.randomUUID() } })).rejects.toBeInstanceOf(SpawnRequestConflictError)
    const next = { operationId: crypto.randomUUID() }, forwarded: unknown[] = []
    gateway.spawnSession = async (...args) => { forwarded.push(args[20]); return { type: 'error', message: 'Inputs are missing', code: 'files_not_prepared', childStarted: false } }
    expect(await engine.resumeSession(receipt.sessionId, 'default', { preparedFiles: next })).toMatchObject({ code: 'files_not_prepared', childStarted: false })
    expect(forwarded).toEqual([next]); expect(store.sessions.getSession(receipt.sessionId)?.metadata).toMatchObject({ preparedFiles })
    gateway.spawnSession = async (...args) => { expect(args[20]).toBeUndefined(); return { type: 'success', sessionId: receipt.sessionId } }
    ;(engine as unknown as { waitForSessionActive: () => Promise<boolean> }).waitForSessionActive = async () => true
    expect(await engine.resumeSession(receipt.sessionId, 'default', { preparedFiles: null })).toMatchObject({ type: 'success' })
    expect((store.sessions.getSession(receipt.sessionId)?.metadata as { preparedFiles?: unknown }).preparedFiles).toBeUndefined()
})

it('rejects file gates on old runners or mixed workspace gates before dispatch', async () => {
    const { engine, gateway, store } = setup()
    engine.getOrCreateMachine('old', { host: 'host', platform: 'linux', happyCliVersion: 'old' }, null, 'default')
    gateway.spawnSession = async () => { throw new Error('must not dispatch') }
    for (const machineId of ['machine', 'old']) {
        const receipt = await engine.spawnSessionWithReceipt('default', machineId, { ...request(), preparedFiles: { operationId: crypto.randomUUID() },
            ...(machineId === 'machine' ? { preparedWorkspace: { environmentId: crypto.randomUUID(), preparationId: crypto.randomUUID() } } : {}) })
        expect(receipt.response).toMatchObject({ type: 'error', code: 'files_not_prepared', childStarted: false })
        expect(store.sessions.getSession(receipt.sessionId)).toBeNull()
    }
})

it('routes machine file operations within namespace and rejects release while an associated execution is active', async () => {
    const { engine, gateway } = setup(), calls: unknown[] = [], operationId = crypto.randomUUID()
    gateway.artifactOperation = async (machine, request) => { calls.push([machine, request]); return { error: { code: 'fixture', message: 'Recorded dispatch' } } }
    const app = new Hono<WebAppEnv>(); app.use('*', async (c, next) => { c.set('namespace', 'default'); await next() }); app.route('/api', createMachinesRoutes(() => engine))
    const post = (machine: string, body: unknown) => app.request(`/api/machines/${machine}/artifacts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await post('foreign', { action: 'inspect', operationId })).status).toBe(403)
    expect((await post('machine', { action: 'inspect', operationId: '../escape' })).status).toBe(400)
    expect(calls).toHaveLength(0)
    expect((await post('machine', { action: 'inspect', operationId })).status).toBe(409)
    expect(calls).toEqual([['machine', { action: 'inspect', operationId }]])
    engine.getOrCreateSession('files-active', { path: '/workspace', host: 'local', machineId: 'machine', flavor: 'codex', preparedFiles: { operationId } }, null, 'default')
    expect(await (await post('machine', { action: 'release', operationId })).json()).toMatchObject({ code: 'artifact_execution_active' })
    expect(calls).toHaveLength(1)
})
