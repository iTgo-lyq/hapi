import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ArtifactReserveSchema, ARTIFACT_DEFAULT_LIMITS } from '@hapi/protocol'
import { Store } from '../store'
import { ArtifactService } from './service'

const fixtures: Array<{ root: string; store: Store }> = []
async function fixture(limit = 1000, idleMs = 60_000) {
    const base = resolve(import.meta.dir, '../../../../.dev-smoke/tests')
    await mkdir(base, { recursive: true })
    const root = await mkdtemp(join(base, 'artifacts-')), store = new Store(join(root, 'hapi.db'))
    fixtures.push({ root, store })
    const service = new ArtifactService(store.artifacts, join(root, 'artifacts'), { ...ARTIFACT_DEFAULT_LIMITS, maxFileBytes: limit, namespaceQuotaBytes: limit }, idleMs)
    return { root, store, service }
}
function request(text: string, filename = '需求 brief.txt') {
    return ArtifactReserveSchema.parse({ requestId: randomUUID(), filename, size: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') })
}
const body = (text: string) => new Blob([text]).stream()
afterEach(async () => {
    for (const { root, store } of fixtures.splice(0)) { store.close(); await rm(root, { recursive: true, force: true }) }
})

describe('Hub persistent artifacts', () => {
    it('publishes without a session, protects references, and preserves immutable receipts and tombstones', async () => {
        const { service, store } = await fixture()
        const input = request('附件 content'), artifact = service.reserve('team/one', input)
        expect(service.reserve('team/one', input).id).toBe(artifact.id)
        expect(() => service.reserve('team/one', { ...input, filename: 'changed' })).toThrow('different file')
        await expect(service.content('team/one', artifact.id)).rejects.toMatchObject({ code: 'artifact_not_available' })
        await expect(service.inspect('other', artifact.id)).rejects.toMatchObject({ code: 'artifact_not_found' })
        const published = await service.upload('team/one', artifact.id, body('附件 content'))
        expect(published.state).toBe('available')
        expect(store.sessions.getSessions()).toHaveLength(0)
        expect(await new Response((await service.content('team/one', artifact.id)).body).text()).toBe('附件 content')
        await service.upload('team/one', artifact.id, body('different bytes cannot overwrite'))
        expect(await new Response((await service.content('team/one', artifact.id)).body).text()).toBe('附件 content')
        service.store.pin('team/one', artifact.id, { reference: 'round:one', purpose: 'input' })
        await expect(service.remove('team/one', artifact.id)).rejects.toMatchObject({ code: 'artifact_referenced' })
        service.store.unpin('team/one', artifact.id, 'round:one')
        expect((await service.remove('team/one', artifact.id)).state).toBe('deleted')
        expect((await service.remove('team/one', artifact.id)).state).toBe('deleted')
        expect(service.store.usage('team/one')).toBe(0)
        expect(service.reserve('team/one', input).state).toBe('deleted')
        await expect(service.content('team/one', artifact.id)).rejects.toMatchObject({ code: 'artifact_deleted' })
        expect(() => service.store.pin('team/one', artifact.id, { reference: 'new', purpose: 'input' })).toThrow('deleted')
    })
    it('reserves quota once, includes pending bytes, and rejects invalid hash or size without publication', async () => {
        const { service } = await fixture(8)
        const input = request('123456'), artifact = service.reserve('n', input)
        expect(service.reserve('n', input).id).toBe(artifact.id)
        expect(() => service.reserve('n', request('abc'))).toThrow('quota')
        expect(() => service.reserve('n', request('123456789'))).toThrow('limit')
        await expect(service.upload('n', artifact.id, body('12345X'))).rejects.toMatchObject({ code: 'artifact_checksum_mismatch' })
        expect((await service.inspect('n', artifact.id)).state).toBe('reserved')
        await expect(service.upload('n', artifact.id, body('1234567'))).rejects.toMatchObject({ code: 'artifact_size_mismatch' })
        expect((await service.upload('n', artifact.id, body('123456'))).state).toBe('available')
        expect(service.store.usage('n')).toBe(6)
    })
    it('retains reservation after disconnect and makes active uploads conflict with deletion', async () => {
        const { service } = await fixture()
        const artifact = service.reserve('n', request('abcdef'))
        let controller!: ReadableStreamDefaultController<Uint8Array>
        const input = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
        const uploading = service.upload('n', artifact.id, input)
        controller.enqueue(Buffer.from('abc'))
        await expect(service.remove('n', artifact.id)).rejects.toMatchObject({ code: 'artifact_busy' })
        controller.error(new Error('connection lost'))
        await expect(uploading).rejects.toThrow('connection lost')
        expect((await service.inspect('n', artifact.id)).state).toBe('reserved')
        await service.upload('n', artifact.id, body('abcdef'))
        expect(await new Response((await service.content('n', artifact.id)).body).text()).toBe('abcdef')
    })
    it('recovers verified bytes left by a lost publication receipt and resumes interrupted deletion', async () => {
        const { service, root } = await fixture()
        const artifact = service.reserve('n', request('persisted'))
        const folder = join(root, 'artifacts', createHash('sha256').update('n').digest('hex'))
        await mkdir(folder, { recursive: true }); await writeFile(join(folder, artifact.id), 'persisted')
        expect((await service.inspect('n', artifact.id)).state).toBe('available')
        service.store.beginDelete('n', artifact.id)
        expect(() => service.store.pin('n', artifact.id, { reference: 'late', purpose: 'result' })).toThrow('deleted')
        expect((await service.remove('n', artifact.id)).state).toBe('deleted')
    })
    it('uses idle time rather than total transfer duration and supports an empty file', async () => {
        const { service } = await fixture(1000, 40)
        const artifact = service.reserve('n', request('abcde'))
        let sent = 0
        const slow = new ReadableStream<Uint8Array>({ async pull(controller) {
            await Bun.sleep(15)
            if (sent === 5) controller.close()
            else controller.enqueue(Buffer.from('abcde'[sent++]!))
        } })
        expect((await service.upload('n', artifact.id, slow)).state).toBe('available')
        const stalled = service.reserve('n', request('stalled'))
        await expect(service.upload('n', stalled.id, new ReadableStream())).rejects.toMatchObject({ code: 'artifact_transfer_idle' })
        const empty = service.reserve('n', request(''))
        expect((await service.upload('n', empty.id, null)).state).toBe('available')
        expect(await new Response((await service.content('n', empty.id)).body).text()).toBe('')
    })
    it('previews expiry without deleting, preserves every reference purpose, and accounts for quota once', async () => {
        const { service, root } = await fixture()
        const files = []
        for (const purpose of [null, 'input', 'output', 'recovery', 'external']) {
            const file = service.reserve('n', request('retained'))
            await service.upload('n', file.id, body('retained'))
            if (purpose) service.store.pin('n', file.id, { reference: `owner:${purpose}`, purpose })
            files.push(file)
        }
        const pending = service.reserve('n', request('pending'))
        const other = service.reserve('other', request('other namespace'))
        const db = new Database(join(root, 'hapi.db'))
        db.query('UPDATE artifacts SET created_at=?,published_at=CASE WHEN published_at IS NULL THEN NULL ELSE ? END')
            .run(Date.now() - 8 * 86400000, Date.now() - 8 * 86400000)
        db.close()
        const recent = service.reserve('n', request('new'))
        const before = service.store.usage('n')
        const preview = await service.prune('n', { apply: false, limit: 100 })
        expect(preview.candidates.map(file => file.id).sort()).toEqual([files[0]!.id, pending.id].sort())
        expect(preview.deleted).toHaveLength(0)
        expect(service.store.usage('n')).toBe(before)
        expect(service.store.usageDetails('n')).toEqual({ reservedBytes: 10, availableBytes: 40, deletingBytes: 0, referencedBytes: 32, objectCount: 7, referencedCount: 4 })
        const done = await service.prune('n', { apply: true, limit: 100 })
        expect(done.failures).toEqual([])
        expect(done.deleted.map(file => file.id).sort()).toEqual(preview.candidates.map(file => file.id).sort())
        expect(done.usedBytes).toBe(before - 15)
        expect(service.store.byRequest('n', files[0]!.requestId).state).toBe('deleted')
        await expect(service.content('n', files[0]!.id)).rejects.toMatchObject({ code: 'artifact_deleted' })
        expect(service.store.get('n', recent.id).state).toBe('reserved')
        expect(service.store.get('other', other.id).state).toBe('reserved')
        expect((await service.prune('n', { apply: true, limit: 100 })).candidates).toHaveLength(0)
    })
    it('rechecks late pins, rejects active uploads, and does not expire a recovered fresh publication', async () => {
        const { service, root } = await fixture()
        const pinned = service.reserve('n', request('published'))
        await service.upload('n', pinned.id, body('published'))
        const active = service.reserve('n', request('uploading'))
        const recovered = service.reserve('n', request('recovered'))
        const db = new Database(join(root, 'hapi.db'))
        db.query('UPDATE artifacts SET created_at=?,published_at=?').run(Date.now() - 8 * 86400000, Date.now() - 8 * 86400000)
        db.close()
        const folder = join(root, 'artifacts', createHash('sha256').update('n').digest('hex'))
        await writeFile(join(folder, recovered.id), 'recovered')
        let writer!: ReadableStreamDefaultController<Uint8Array>
        const uploading = service.upload('n', active.id, new ReadableStream({ start(controller) { writer = controller } }))
        const cleanup = service.prune('n', { apply: true, limit: 100 })
        service.store.pin('n', pinned.id, { reference: 'late', purpose: 'input' })
        const result = await cleanup
        expect(result.deleted).toHaveLength(0)
        expect(result.failures.map(item => item.error.code).sort()).toEqual(['artifact_busy', 'artifact_not_expired', 'artifact_referenced'])
        expect((await service.inspect('n', recovered.id)).state).toBe('available')
        writer.enqueue(Buffer.from('uploading')); writer.close()
        expect((await uploading).state).toBe('available')
    })
    it('uses a stable cursor during deletion and resumes a failed deletion after reopening the service', async () => {
        const { service, root } = await fixture()
        const ids: string[] = []
        for (let index = 0; index < 3; index++) ids.push(service.reserve('n', request('bytes')).id)
        const db = new Database(join(root, 'hapi.db'))
        db.query('UPDATE artifacts SET created_at=?').run(Date.now() - 2 * 86400000); db.close()
        ids.sort()
        const blockedPath = join(root, 'artifacts', createHash('sha256').update('n').digest('hex'), `${ids[0]!}.part`)
        await mkdir(blockedPath, { recursive: true }) // Real filesystem failure after marking deleting.
        const first = await service.prune('n', { apply: true, limit: 1 })
        expect(first.nextCursor).toBe(ids[0]!)
        expect(first.failures[0]?.error.code).toBe('artifact_io_failed')
        expect(service.store.usageDetails('n').deletingBytes).toBe(5)
        const second = await service.prune('n', { apply: true, limit: 1, after: first.nextCursor! })
        expect(second.deleted[0]?.id).toBe(ids[1]!)
        const third = await service.prune('n', { apply: true, limit: 1, after: second.nextCursor! })
        expect(third.deleted[0]?.id).toBe(ids[2]!); expect(third.nextCursor).toBeNull()
        await rm(blockedPath, { recursive: true })
        const reopened = new Store(join(root, 'hapi.db'))
        try {
            const restarted = new ArtifactService(reopened.artifacts, service.root, service.limits)
            const final = await restarted.prune('n', { apply: true, limit: 100 })
            expect(final.deleted[0]?.id).toBe(ids[0]!); expect(final.usedBytes).toBe(0)
        } finally { reopened.close() }
    })
    it('validates logical filenames without restricting Chinese or spaces', () => {
        expect(request('a').filename).toBe('需求 brief.txt')
        for (const filename of ['../escape', '..', '.', 'a/b', 'a\\b', 'a\0b', 'a\nb', '中'.repeat(81)]) {
            expect(ArtifactReserveSchema.safeParse({ ...request('a'), filename }).success).toBe(false)
        }
    })
})
