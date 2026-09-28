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
            capabilities: [MACHINE_CAPABILITIES.AgentAvailability] }, null, namespace!)
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
