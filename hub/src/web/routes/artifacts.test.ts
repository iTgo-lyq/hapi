import { afterEach, describe, expect, it } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { ARTIFACT_DEFAULT_LIMITS } from '@hapi/protocol'
import { Store } from '../../store'
import { ArtifactService } from '../../artifacts/service'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { createArtifactRoutes } from './artifacts'

const fixtures: Array<{ root: string; store: Store }> = []
afterEach(async () => { for (const f of fixtures.splice(0)) { f.store.close(); await rm(f.root, { recursive: true, force: true }) } })
async function fixture() {
    const base = resolve(import.meta.dir, '../../../../../.dev-smoke/tests')
    await mkdir(base, { recursive: true })
    const root = await mkdtemp(join(base, 'artifact-http-')), store = new Store(join(root, 'hapi.db'))
    fixtures.push({ root, store })
    const service = new ArtifactService(store.artifacts, join(root, 'artifacts'), ARTIFACT_DEFAULT_LIMITS)
    const secret = new TextEncoder().encode('artifact-route-tests-only-secret')
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', createAuthMiddleware(secret)); app.route('/api', createArtifactRoutes(service))
    const token = async (namespace: string) => new SignJWT({ uid: 1, ns: namespace }).setProtectedHeader({ alg: 'HS256' }).sign(secret)
    const headers = { authorization: `Bearer ${await token('one')}`, 'content-type': 'application/json' }
    return { app, headers, token, service }
}
describe('authenticated artifact HTTP', () => {
    it('round-trips binary data and uses namespace authorization for bytes and references', async () => {
        const { app, headers, token } = await fixture()
        expect((await app.request('/api/artifacts')).status).toBe(401)
        const bytes = Buffer.from('binary\0payload'), requestId = randomUUID()
        const response = await app.request('/api/artifacts', { method: 'POST', headers, body: JSON.stringify({ requestId, filename: '中文 文件.bin',
            size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) })
        expect(response.status).toBe(200)
        const { artifact } = await response.json() as any
        const content = `/api/artifacts/${artifact.id}/content`
        expect((await app.request(content, { headers })).status).toBe(409)
        const upload = await app.request(content, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: bytes })
        expect(upload.status).toBe(200)
        const download = await app.request(content, { headers })
        expect(download.headers.get('content-type')).toBe('application/octet-stream')
        expect(download.headers.get('content-disposition')).toContain("filename*=UTF-8''")
        expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes)
        const other = { authorization: `Bearer ${await token('two')}` }
        expect((await app.request(content, { headers: other })).status).toBe(404)
        expect((await app.request(`/api/artifacts/${artifact.id}/references`, { headers: other })).status).toBe(404)
        const ref = `/api/artifacts/${artifact.id}/references/round%3Aone`
        expect((await app.request(ref, { method: 'PUT', headers, body: JSON.stringify({ reference: 'round:one', purpose: 'input' }) })).status).toBe(200)
        expect((await app.request(`/api/artifacts/${artifact.id}`, { method: 'DELETE', headers })).status).toBe(409)
        expect((await app.request(ref, { method: 'DELETE', headers })).status).toBe(200)
        expect((await app.request(`/api/artifacts/${artifact.id}`, { method: 'DELETE', headers })).status).toBe(200)
        expect((await app.request(content, { headers })).status).toBe(410)
        const receipt = await app.request(`/api/artifacts/requests/${requestId}`, { headers })
        expect((await receipt.json() as any).artifact.state).toBe('deleted')
    })
    it('keeps control bodies small while accepting larger binary streams', async () => {
        const { app, headers, service } = await fixture()
        const oversized = await app.request('/api/artifacts', { method: 'POST', headers, body: JSON.stringify({ oversized: 'x'.repeat(70_000) }) })
        expect(oversized.status).toBe(413)
        const bytes = Buffer.alloc(90_000, 70)
        const artifact = service.reserve('one', { requestId: randomUUID(), filename: 'larger.bin', mimeType: 'application/octet-stream', size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex') })
        expect((await app.request(`/api/artifacts/${artifact.id}/content`, { method: 'PUT', headers, body: bytes })).status).toBe(200)
        const invalid = await app.request(`/api/artifacts/${artifact.id}/content`, { method: 'PUT', headers: { ...headers, 'content-length': '1' }, body: 'x' })
        expect(invalid.status).toBe(422)
        expect((await invalid.json() as any).error.code).toBe('artifact_size_mismatch')
    })
})
