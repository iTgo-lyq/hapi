import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { ArtifactPruneSchema, ArtifactReferenceSchema, ArtifactReserveSchema } from '@hapi/protocol'
import { ArtifactError, artifactProblem } from '../../artifacts/errors'
import type { ArtifactService } from '../../artifacts/service'

type Env = { Variables: { namespace: string } }
const paging = z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(50) })
async function json(c: Context<Env>) {
    try { return await c.req.json() }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        throw new ArtifactError(400, 'invalid_artifact_request', 'Expected a JSON request body.')
    }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value)
    if (!result.success) throw new ArtifactError(400, 'invalid_artifact_request', 'Invalid file request.', result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))
    return result.data
}
export function createArtifactRoutes(service: ArtifactService): Hono<Env> {
    const app = new Hono<Env>()
    const controlLimit = bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ error: { code: 'artifact_request_too_large', message: 'File control request exceeds 64 KiB.' } }, 413) })
    app.use('/artifacts/*', async (c, next) => {
        c.header('Cache-Control', 'no-store')
        if (c.req.method === 'PUT' && /\/artifacts\/[^/]+\/content$/.test(c.req.path)) return next()
        return controlLimit(c, next)
    })
    app.onError((error, c) => c.json({ error: artifactProblem(error) }, error instanceof ArtifactError ? error.status : 503))
    app.get('/artifacts/limits', c => c.json({ limits: service.limits, usedBytes: service.store.usage(c.get('namespace')), usage: service.store.usageDetails(c.get('namespace')) }))
    app.get('/artifacts', c => {
        const { offset, limit } = parse(paging, c.req.query())
        const artifacts = service.store.list(c.get('namespace'), offset, limit + 1)
        return c.json({ artifacts: artifacts.slice(0, limit), nextOffset: artifacts.length > limit ? offset + limit : null })
    })
    app.post('/artifacts', async c => c.json({ artifact: service.reserve(c.get('namespace'), parse(ArtifactReserveSchema, await json(c))) }))
    app.post('/artifacts/prune', async c => c.json(await service.prune(c.get('namespace'), parse(ArtifactPruneSchema, await json(c)))))
    app.get('/artifacts/requests/:requestId', async c => {
        const artifact = service.store.byRequest(c.get('namespace'), c.req.param('requestId'))
        return c.json({ artifact: await service.inspect(c.get('namespace'), artifact.id) })
    })
    app.get('/artifacts/:id', async c => c.json({ artifact: await service.inspect(c.get('namespace'), c.req.param('id')) }))
    app.put('/artifacts/:id/content', async c => {
        const artifact = service.store.get(c.get('namespace'), c.req.param('id'))
        const declared = c.req.header('content-length')
        if (declared !== undefined && Number(declared) !== artifact.size) throw new ArtifactError(422, 'artifact_size_mismatch', 'Content-Length differs from the file reservation.')
        if (artifact.size > service.limits.maxFileBytes) throw new ArtifactError(413, 'artifact_too_large', 'File exceeds the current Hub file limit.')
        return c.json({ artifact: await service.upload(c.get('namespace'), artifact.id, c.req.raw.body, c.req.raw.signal) })
    })
    app.get('/artifacts/:id/content', async c => {
        const { artifact, body } = await service.content(c.get('namespace'), c.req.param('id'))
        const filename = encodeURIComponent(artifact.filename).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)
        return new Response(body, { headers: {
            'content-type': 'application/octet-stream', 'content-length': String(artifact.size),
            'content-disposition': `attachment; filename="download"; filename*=UTF-8''${filename}`,
            'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'x-artifact-sha256': artifact.sha256,
        } })
    })
    app.get('/artifacts/:id/references', c => c.json({ references: service.store.references(c.get('namespace'), c.req.param('id')) }))
    app.put('/artifacts/:id/references/:reference', async c => {
        const reference = parse(ArtifactReferenceSchema, await json(c))
        if (reference.reference !== c.req.param('reference')) throw new ArtifactError(400, 'invalid_artifact_request', 'Reference path and body must agree.')
        return c.json({ artifact: service.store.pin(c.get('namespace'), c.req.param('id'), reference) })
    })
    app.delete('/artifacts/:id/references/:reference', c => {
        service.store.unpin(c.get('namespace'), c.req.param('id'), c.req.param('reference'))
        return c.json({ released: true })
    })
    app.delete('/artifacts/:id', async c => c.json({ artifact: await service.remove(c.get('namespace'), c.req.param('id')) }))
    return app
}
