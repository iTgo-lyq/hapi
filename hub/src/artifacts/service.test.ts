import { afterEach, describe, expect, it } from 'bun:test'
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
    it('validates logical filenames without restricting Chinese or spaces', () => {
        expect(request('a').filename).toBe('需求 brief.txt')
        for (const filename of ['../escape', '..', '.', 'a/b', 'a\\b', 'a\0b', 'a\nb', '中'.repeat(81)]) {
            expect(ArtifactReserveSchema.safeParse({ ...request('a'), filename }).success).toBe(false)
        }
    })
})
