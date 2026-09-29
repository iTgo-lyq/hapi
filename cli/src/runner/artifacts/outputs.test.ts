import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Artifact, ArtifactReserve, ArtifactTransfer, ArtifactTransferRequest, CaptureRequest, DeliverRequest } from '@hapi/protocol'
import { MachinePathPolicy } from '@/api/machinePathPolicy'
import { ArtifactTransferManager } from './manager'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })
async function fixture() {
    const parent = resolve(import.meta.dirname, '../../../../../.dev-smoke'); mkdirSync(parent, { recursive: true })
    const root = mkdtempSync(join(parent, 'output-transfer-')), cwd = join(root, 'project'), home = join(root, 'hapi')
    mkdirSync(cwd); mkdirSync(home); cleanups.push(() => rm(root, { recursive: true, force: true }))
    const objects = new Map<string, Artifact>(), pins = new Map<string, Set<string>>(), bytes = new Map<string, Buffer>(), puts: string[] = []
    const faults = { quota: '', lost: '', idle: '' }
    const server = createServer(async (req, res) => {
        try {
            if (req.headers.authorization !== 'Bearer fixture:alpha' || req.headers['x-access'] !== 'extra') { res.writeHead(401); res.end(); return }
            res.setHeader('content-type', 'application/json')
            const parts = req.url!.split('/'), data: Buffer[] = []
            for await (const chunk of req) data.push(Buffer.from(chunk))
            if (req.method === 'POST' && req.url === '/cli/artifacts') {
                const input: ArtifactReserve = JSON.parse(Buffer.concat(data).toString())
                if (input.filename === faults.quota) { res.writeHead(409); res.end(JSON.stringify({ error: { code: 'artifact_quota_exceeded', message: 'Fixture quota exhausted' } })); return }
                let object = [...objects.values()].find(object => object.requestId === input.requestId)
                if (!object) {
                    object = { ...input, id: randomUUID(), namespace: 'alpha', state: 'reserved', createdAt: Date.now(), publishedAt: null, deletedAt: null, error: null }
                    objects.set(object.id, object)
                } else if (object.sha256 !== input.sha256 || object.filename !== input.filename) { res.writeHead(409); res.end('{}'); return }
                const references = pins.get(object.id) ?? new Set<string>(); if (input.reference) references.add(input.reference.reference); pins.set(object.id, references)
                res.end(JSON.stringify({ artifact: object })); return
            }
            const object = objects.get(parts[3]!)
            if (!object || parts[4] !== 'content') { res.writeHead(404); res.end('{}'); return }
            const content = Buffer.concat(data); puts.push(object.id)
            if (faults.idle === object.filename) return
            if (content.length !== object.size || createHash('sha256').update(content).digest('hex') !== object.sha256) {
                res.writeHead(409); res.end(JSON.stringify({ error: { code: 'artifact_checksum_mismatch', message: 'Wrong bytes' } })); return
            }
            object.state = 'available'; object.publishedAt = Date.now(); bytes.set(object.id, content)
            if (faults.lost === object.filename) { faults.lost = ''; res.destroy(); return }
            res.end(JSON.stringify({ artifact: object }))
        } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })) }
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) })
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    function create(idleMs = 2000, pathPolicy = new MachinePathPolicy()) {
        const manager = new ArtifactTransferManager({ home, url, token: 'fixture:alpha', extraHeaders: { 'x-access': 'extra' }, pathPolicy,
            assertStopped: async () => {}, idleMs })
        cleanups.push(() => manager.stop()); return manager
    }
    const manager = create()
    async function request(value: ArtifactTransferRequest, target = manager): Promise<ArtifactTransfer> {
        const result = await target.request(value); if ('error' in result) throw new Error(result.error.message); return result.operation
    }
    const inspect = (id: string, target = manager) => request({ action: 'inspect', operationId: id }, target)
    function capture(names: string[]): CaptureRequest {
        return { action: 'capture', operationId: randomUUID(), cwd, files: names.map(relativePath => ({ relativePath, name: relativePath.split('/').at(-1)! })) }
    }
    function delivery(capture: CaptureRequest, names = capture.files.map(file => file.name)): DeliverRequest {
        return { action: 'deliver', operationId: randomUUID(), captureOperationId: capture.operationId,
            files: names.map(name => ({ name, requestId: randomUUID(), reference: { reference: `task:${randomUUID()}`, purpose: 'output' } })) }
    }
    return { root, cwd, home, create, manager, request, inspect, capture, delivery, faults, objects, pins, bytes, puts }
}

describe('captured output delivery', () => {
    it('captures declared files once, reports missing/unsafe files individually and preserves candidates after workspace removal', async () => {
        const f = await fixture(); mkdirSync(join(f.cwd, '目录')); writeFileSync(join(f.cwd, '目录', '报告.txt'), '报告 ORIGINAL')
        writeFileSync(join(f.cwd, 'zero.part'), ''); writeFileSync(join(f.cwd, 'zero'), 'other')
        writeFileSync(join(f.root, 'outside'), 'secret'); symlinkSync(join(f.root, 'outside'), join(f.cwd, 'escape'))
        const capture = f.capture(['目录/报告.txt', 'zero.part', 'zero', 'missing', '目录', 'escape'])
        expect((await f.request(capture)).status).toBe('accepted'); await f.manager.settled()
        const record = await f.inspect(capture.operationId)
        expect(record.status).toBe('failed'); expect(record.candidates?.map(file => file.status)).toEqual(['captured', 'captured', 'captured', 'failed', 'failed', 'failed'])
        expect(record.candidates?.at(-1)).toMatchObject({ error: { code: 'artifact_path_escape' } })
        writeFileSync(join(f.cwd, '目录', '报告.txt'), 'NEW'); writeFileSync(join(f.cwd, 'missing'), 'late file')
        expect((await f.request(capture)).candidates).toEqual(record.candidates)
        const restarted = f.create(); expect((await f.inspect(capture.operationId, restarted)).candidates).toEqual(record.candidates)
        await rm(f.cwd, { recursive: true }); const candidate = record.candidates![0]!
        if (candidate.status !== 'captured') throw new Error('Expected captured file')
        expect(readFileSync(candidate.path, 'utf8')).toBe('报告 ORIGINAL')
        const delivery = f.delivery(capture, ['报告.txt', 'zero.part', 'zero'])
        await f.request(delivery, restarted); await restarted.settled()
        const delivered = await f.inspect(delivery.operationId, restarted); expect(delivered.status).toBe('succeeded')
        expect([...f.bytes.values()].map(value => value.toString())).toEqual(['报告 ORIGINAL', '', 'other'])
        expect([...f.pins.values()].every(value => value.size === 1)).toBe(true)
    })
    it('recovers lost publish responses and partial quota failure from fixed candidates without recapturing cwd', async () => {
        const f = await fixture(); writeFileSync(join(f.cwd, 'one'), 'ONE'); writeFileSync(join(f.cwd, 'two'), 'TWO')
        const capture = f.capture(['one', 'two']); await f.request(capture); await f.manager.settled()
        const delivery = f.delivery(capture); f.faults.lost = 'one'; f.faults.quota = 'two'
        await f.request(delivery); await f.manager.settled()
        expect((await f.inspect(delivery.operationId)).status).toBe('failed'); expect(f.objects.size).toBe(1); expect(f.puts).toHaveLength(1)
        writeFileSync(join(f.cwd, 'one'), 'NEW ONE'); writeFileSync(join(f.cwd, 'two'), 'NEW TWO')
        f.faults.quota = ''; const restarted = f.create(); await f.request(delivery, restarted); await restarted.settled()
        expect((await f.inspect(delivery.operationId, restarted)).status).toBe('succeeded'); expect(f.objects.size).toBe(2); expect(f.puts).toHaveLength(2)
        expect([...f.bytes.values()].map(value => value.toString())).toEqual(['ONE', 'TWO'])
        await expect(f.request({ ...delivery, files: [{ ...delivery.files[0]!, requestId: randomUUID() }] }, restarted)).rejects.toMatchObject({ code: 'artifact_request_conflict' })
    })
    it('releases selected confirmed candidates and refuses release while delivery is running', async () => {
        const f = await fixture(); writeFileSync(join(f.cwd, 'one'), 'ONE'); writeFileSync(join(f.cwd, 'two'), 'TWO')
        const capture = f.capture(['one', 'two']); await f.request(capture); await f.manager.settled()
        const first = f.delivery(capture, ['one']); await f.request(first); await f.manager.settled()
        await f.request({ action: 'release', operationId: capture.operationId, names: ['one'] })
        const released = await f.inspect(capture.operationId)
        expect(released.retention).toBe('retained'); expect(released.candidates?.[0]).toMatchObject({ retention: 'released' }); expect(released.candidates?.[1]).toMatchObject({ retention: 'retained' })
        const retry = { ...first, operationId: randomUUID() }; await f.request(retry); await f.manager.settled()
        expect((await f.inspect(retry.operationId)).status).toBe('succeeded'); expect(f.puts).toHaveLength(1)
        f.faults.idle = 'two'; const pending = f.delivery(capture, ['two']); await f.request(pending)
        await expect(f.request({ action: 'release', operationId: capture.operationId })).rejects.toMatchObject({ code: 'artifact_operation_pending' })
        await f.manager.stop(); expect((await f.inspect(pending.operationId)).status).toBe('failed')
        const restarted = f.create(); f.faults.idle = ''; await f.request(pending, restarted); await restarted.settled()
        expect((await f.inspect(pending.operationId, restarted)).status).toBe('succeeded')
        await f.request({ action: 'release', operationId: capture.operationId }, restarted)
        expect((await f.inspect(capture.operationId, restarted)).retention).toBe('released'); expect(existsSync(join(restarted.root, capture.operationId, 'spool'))).toBe(false)
    })
    it('marks interrupted capture incomplete and never fills its missing slots from later workspace contents', async () => {
        const f = await fixture(); writeFileSync(join(f.cwd, 'one'), 'ONE')
        const capture = f.capture(['one', 'two']); await f.request(capture); await f.manager.settled()
        const record = await f.inspect(capture.operationId); record.status = 'running'
        writeFileSync(join(f.manager.root, capture.operationId, 'receipt.json'), JSON.stringify(record)); writeFileSync(join(f.cwd, 'two'), 'TOO LATE')
        const restarted = f.create(); expect(await f.inspect(capture.operationId, restarted)).toMatchObject({ status: 'failed', error: { code: 'artifact_transfer_interrupted' } })
        expect((await f.request(capture, restarted)).candidates?.map(file => file.status)).toEqual(['captured', 'failed'])
        await expect(f.request(f.delivery(capture), restarted)).rejects.toMatchObject({ code: 'artifact_candidate_missing' })
        const newCapture = { ...capture, operationId: randomUUID() }; await f.request(newCapture, restarted); await restarted.settled()
        expect((await f.inspect(newCapture.operationId, restarted)).status).toBe('succeeded')
    })
    it('rejects traversal, directories as roots outside policy, and forged candidate paths', async () => {
        const f = await fixture()
        for (const path of ['../escape', '/absolute', 'a/../b', 'a\\b', 'C:/file']) {
            await expect(f.request({ ...f.capture(['one']), files: [{ name: 'one', relativePath: path }] })).rejects.toMatchObject({ code: 'artifact_request_invalid' })
        }
        const restricted = f.create(2000, new MachinePathPolicy({ workspaceRoots: [f.home] }))
        await expect(f.request(f.capture(['one']), restricted)).rejects.toMatchObject({ code: 'outside_workspace_roots' })
        writeFileSync(join(f.cwd, 'one'), 'ONE'); const capture = f.capture(['one']); await f.request(capture); await f.manager.settled()
        const record = await f.inspect(capture.operationId), candidate = record.candidates![0]!
        if (candidate.status === 'captured') candidate.path = join(f.cwd, 'one')
        writeFileSync(join(f.manager.root, capture.operationId, 'receipt.json'), JSON.stringify(record))
        await f.request(f.delivery(capture)); await f.manager.settled()
        expect(f.objects.size).toBe(0)
        await expect(f.request({ action: 'release', operationId: capture.operationId })).rejects.toMatchObject({ code: 'artifact_receipt_invalid' })
        expect(readFileSync(join(f.cwd, 'one'), 'utf8')).toBe('ONE')
    })
})
