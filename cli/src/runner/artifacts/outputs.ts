import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { ArtifactSchema, type Artifact, type ArtifactOutput, type CapturedArtifact, type DeliverRequest } from '@hapi/protocol'
import { fail, TransferError } from './common'

type Candidate = Extract<CapturedArtifact, { status: 'captured' }>
export async function captureFile(cwd: string, input: ArtifactOutput, destination: string, signal: AbortSignal): Promise<Candidate> {
    const source = await realpath(resolve(cwd, input.relativePath)), child = relative(cwd, source)
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return fail('artifact_path_escape', 'Output resolves outside the workspace.')
    const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const temporary = `${destination}.part`
    let copy: Awaited<ReturnType<typeof open>> | undefined
    try {
        const before = await file.stat()
        if (!before.isFile()) return fail('artifact_not_file', 'Only declared regular files can be captured.')
        copy = await open(temporary, 'wx', 0o600)
        const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024); let size = 0
        while (true) {
            signal.throwIfAborted()
            const { bytesRead } = await file.read(buffer, 0, buffer.length, size)
            if (!bytesRead) break
            size += bytesRead
            if (size > before.size) return fail('artifact_source_changed', 'Output changed while being captured. Collect it again after writes stop.')
            hash.update(buffer.subarray(0, bytesRead))
            let offset = 0
            while (offset < bytesRead) offset += (await copy.write(buffer, offset, bytesRead - offset)).bytesWritten
        }
        const after = await file.stat()
        if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
            return fail('artifact_source_changed', 'Output changed while being captured. Collect it again after writes stop.')
        }
        await copy.sync(); await copy.close(); copy = undefined
        await rename(temporary, destination)
        const directory = await open(dirname(destination), 'r'); try { await directory.sync() } finally { await directory.close() }
        return { ...input, status: 'captured', size, sha256: hash.digest('hex'), capturedAt: Date.now(), path: destination, retention: 'retained' }
    } finally { await file.close(); await copy?.close(); await rm(temporary, { force: true }) }
}

export async function deliverFile(candidate: Candidate, input: DeliverRequest['files'][number], options: {
    url: string; token: string; extraHeaders?: Record<string, string>; idleMs?: number; signal: AbortSignal;
}): Promise<Artifact> {
    const base = `${options.url.replace(/\/$/, '')}/cli/artifacts`, idle = new AbortController()
    const signal = AbortSignal.any([idle.signal, options.signal])
    let timer: ReturnType<typeof setTimeout>, file: Awaited<ReturnType<typeof open>> | undefined
    const tick = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new TransferError('artifact_transfer_idle', 'File upload stopped making progress.')), options.idleMs ?? 60_000) }
    const headers = { ...options.extraHeaders, authorization: `Bearer ${options.token}` }
    async function request(path: string, init: RequestInit = {}) {
        tick()
        const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers }, signal })
        const body = await response.json().catch(() => null) as { artifact?: unknown; error?: { code?: string; message?: string; hint?: string } | string; code?: string } | null
        if (!response.ok) {
            if (response.status === 413) throw new TransferError('artifact_too_large', 'Hub or proxy rejected the upload size.', 'Check the Hub file limit and proxy request body limit.')
            const error = body?.error
            throw new TransferError(typeof error === 'object' && error?.code ? error.code : body?.code ?? 'artifact_upload_rejected',
                typeof error === 'object' && error?.message ? error.message : `Hub rejected file delivery (HTTP ${response.status}).`, typeof error === 'object' ? error?.hint : undefined)
        }
        if (!body) return fail('artifact_response_invalid', 'Hub returned a non-JSON file response. Check the proxy and inspect the original upload request.')
        const object = ArtifactSchema.parse(body.artifact)
        if (object.requestId !== input.requestId || object.filename !== candidate.name || object.size !== candidate.size || object.sha256 !== candidate.sha256) {
            return fail('artifact_delivery_mismatch', 'Hub object does not match the captured candidate.')
        }
        return object
    }
    try {
        const object = await request('', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            requestId: input.requestId, filename: candidate.name, mimeType: 'application/octet-stream', size: candidate.size, sha256: candidate.sha256, reference: input.reference,
        }) })
        if (object.state === 'available') return object // Recovers a lost publish response without reading a newer cwd file.
        if (object.state !== 'reserved') return fail('artifact_deleted', 'The original upload was deleted and cannot be resurrected.')
        if (candidate.retention !== 'retained') return fail('artifact_candidate_released', 'The unuploaded candidate has been released.')
        if (await realpath(candidate.path) !== candidate.path) return fail('artifact_ownership_changed', 'Captured candidate path was replaced.')
        file = await open(candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const stat = await file.stat()
        if (!stat.isFile() || stat.size !== candidate.size) return fail('artifact_candidate_changed', 'Captured candidate is missing or changed.')
        const source = file; let position = 0
        const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
            signal.throwIfAborted()
            const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, candidate.size - position))
            const { bytesRead } = buffer.length ? await source.read(buffer, 0, buffer.length, position) : { bytesRead: 0 }
            if (!bytesRead) return controller.close()
            position += bytesRead; tick(); controller.enqueue(buffer.subarray(0, bytesRead))
        } })
        const published = await request(`/${object.id}/content`, { method: 'PUT', headers: {
            'content-type': 'application/octet-stream', 'content-length': String(candidate.size),
        }, body: stream, duplex: 'half' } as RequestInit)
        if (published.id !== object.id || published.state !== 'available') return fail('artifact_delivery_unconfirmed', 'Hub did not confirm publication. Inspect the original upload request.')
        return published
    } finally { clearTimeout(timer!); await file?.close() }
}
