import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import type { ArtifactTransfer, MaterializeRequest } from '@hapi/protocol'
import { MachinePathPolicy } from '@/api/machinePathPolicy'
import { ArtifactTransferManager } from './manager'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function fixture() {
    const parent = resolve(import.meta.dirname, '../../../../../.dev-smoke'); mkdirSync(parent, { recursive: true })
    const root = mkdtempSync(join(parent, 'input-transfer-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
    const bytes = Buffer.from('实际 input content\n'), id = randomUUID(), stopped = new Set<string>()
    const object = { id, namespace: 'default', requestId: randomUUID(), filename: '设计 说明.txt', mimeType: 'text/plain', size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), state: 'available', createdAt: Date.now(), publishedAt: Date.now(), deletedAt: null, error: null }
    let mode: 'normal' | 'corrupt' | 'idle' = 'normal', downloads = 0
    const server = createServer((req, res) => {
        if (req.headers.authorization !== 'Bearer fixture' || req.headers['x-access'] !== 'fixture-access') { res.writeHead(401); res.end(); return }
        if (!req.url?.startsWith(`/cli/artifacts/${id}`)) { res.writeHead(404); res.end(); return }
        if (!req.url.endsWith('/content')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ artifact: object })); return }
        downloads++; res.setHeader('content-length', String(bytes.length))
        if (mode === 'idle') { res.write(bytes.subarray(0, 1)); return }
        res.end(mode === 'corrupt' ? Buffer.alloc(bytes.length) : bytes)
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) })
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const create = (idleMs = 1000) => {
        const manager = new ArtifactTransferManager({ home: root, url, token: 'fixture', extraHeaders: { 'x-access': 'fixture-access' }, idleMs, pathPolicy: new MachinePathPolicy(),
            assertStopped: async id => { if (!stopped.has(id)) throw new Error('execution stop unconfirmed') } })
        cleanup.push(() => manager.stop()); return manager
    }
    const manager = create()
    const request: MaterializeRequest = { action: 'materialize', operationId: randomUUID(), files: [{ artifactId: id, name: object.filename, size: object.size, sha256: object.sha256 }] }
    const inspect = async (target = manager): Promise<ArtifactTransfer> => {
        const result = await target.request({ action: 'inspect', operationId: request.operationId }); if ('error' in result) throw new Error(result.error.message); return result.operation
    }
    return { root, manager, create, request, inspect, stopped, bytes, mode: (next: typeof mode) => { mode = next }, downloads: () => downloads }
}
describe('persistent machine inputs', () => {
    it('accepts before downloading, preserves Unicode names, reuses receipts after restart and releases only owned inputs', async () => {
        const f = await fixture()
        expect(await f.manager.request(f.request)).toMatchObject({ operation: { status: 'accepted', files: [] } })
        await f.manager.settled(); const record = await f.inspect()
        expect(record.status).toBe('succeeded'); expect(readFileSync(record.files[0]!.path)).toEqual(f.bytes)
        expect(await f.manager.validatePrepared(f.request)).toEqual(record.files)
        expect((await f.inspect(f.create())).files).toEqual(record.files)
        await f.manager.request(f.request); expect(f.downloads()).toBe(1)
        await expect(f.manager.request({ ...f.request, files: [{ ...f.request.files[0], name: 'other.txt' }] })).rejects.toMatchObject({ code: 'artifact_request_conflict' })
        await f.manager.request({ action: 'release', operationId: f.request.operationId })
        expect((await f.inspect()).retention).toBe('released'); expect(existsSync(record.files[0]!.path)).toBe(false)
        await expect(f.manager.validatePrepared(f.request)).rejects.toMatchObject({ code: 'files_not_prepared' })
        await expect(f.manager.request(f.request)).rejects.toMatchObject({ code: 'artifact_inputs_released' })
    })
    it('does not open the launch gate for corrupt, replaced or symlinked inputs', async () => {
        const f = await fixture(); f.mode('corrupt')
        await f.manager.request(f.request); await f.manager.settled()
        expect(await f.inspect()).toMatchObject({ status: 'failed', error: { code: 'artifact_input_mismatch' } })
        let starts = 0
        const launch = () => f.manager.launch(f.request, randomUUID(), async () => { starts++; return { type: 'success' } })
        await expect(launch()).rejects.toMatchObject({ code: 'files_not_prepared' }); expect(starts).toBe(0)
        f.mode('normal'); await f.manager.request(f.request); await f.manager.settled()
        const path = (await f.inspect()).files[0]!.path
        writeFileSync(path, 'wrong'); await expect(launch()).rejects.toMatchObject({ code: 'files_not_prepared' })
        await rm(path); const outside = join(f.root, 'outside'); writeFileSync(outside, f.bytes); symlinkSync(outside, path)
        await expect(launch()).rejects.toMatchObject({ code: 'files_not_prepared' }); expect(starts).toBe(0)
    })
    it('keeps active-session inputs, permits stopped release and does not retain a rejected launch', async () => {
        const f = await fixture(); await f.manager.request(f.request); await f.manager.settled()
        const rejected = randomUUID()
        await f.manager.launch(f.request, rejected, async () => ({ type: 'error', childStarted: false }))
        expect((await f.inspect()).sessions).toEqual([])
        const sessionId = randomUUID(); await f.manager.launch(f.request, sessionId, async () => ({ type: 'success', sessionId }))
        await expect(f.manager.request({ action: 'release', operationId: f.request.operationId })).rejects.toThrow('stop unconfirmed')
        f.stopped.add(sessionId); await f.manager.request({ action: 'release', operationId: f.request.operationId })
        expect((await f.inspect()).retention).toBe('released')
    })
    it('cancels a stalled stream on stop, persists failure and resumes the same receipt after restart', async () => {
        const f = await fixture(); f.mode('idle'); await f.manager.request(f.request)
        for (let i = 0; i < 100 && !f.downloads(); i++) await new Promise(done => setTimeout(done, 5))
        expect(f.downloads()).toBe(1); await f.manager.stop()
        expect((await f.inspect()).status).toBe('failed')
        f.mode('normal'); const restarted = f.create(); await restarted.request(f.request); await restarted.settled()
        expect((await f.inspect(restarted)).status).toBe('succeeded')
        const path = join(restarted.root, f.request.operationId, 'receipt.json'), record = JSON.parse(readFileSync(path, 'utf8'))
        record.status = 'running'; writeFileSync(path, JSON.stringify(record))
        const recovered = f.create(); expect((await f.inspect(recovered)).status).toBe('unknown')
        await recovered.request(f.request); await recovered.settled(); expect((await f.inspect(recovered)).status).toBe('succeeded')
    })
    it('times out silence and rejects unsafe paths or duplicate names before accepting', async () => {
        const f = await fixture(); f.mode('idle'); const manager = f.create(40)
        await manager.request(f.request); await manager.settled(); expect((await f.inspect(manager)).status).toBe('failed')
        for (const name of ['..', '../escape', 'a/b', 'a\\b']) await expect(manager.request({ ...f.request, operationId: randomUUID(), files: [{ ...f.request.files[0], name }] })).rejects.toMatchObject({ code: 'artifact_request_invalid' })
        await expect(manager.request({ ...f.request, operationId: randomUUID(), files: [f.request.files[0], f.request.files[0]] })).rejects.toMatchObject({ code: 'artifact_request_invalid' })
    })
})
