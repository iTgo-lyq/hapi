import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { Artifact, ArtifactLimits, ArtifactReserve, ArtifactPrune, ArtifactPruneResult } from '@hapi/protocol'
import type { ArtifactStore } from '../store/artifactStore'
import { ArtifactError, artifactProblem } from './errors'

function missing(error: unknown) { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }

async function opened(path: string, expected: Artifact): Promise<FileHandle> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size !== expected.size) throw new ArtifactError(422, 'artifact_content_mismatch', 'Stored file has an unexpected type or size.')
        return file
    } catch (error) { await file.close(); throw error }
}

/** Bytes are owned by this Hub. No session, runtime, or task state belongs here. */
export class ArtifactService {
    private readonly active = new Set<string>()
    constructor(readonly store: ArtifactStore, readonly root: string, readonly limits: ArtifactLimits, readonly idleMs = 60_000) {}
    private file(namespace: string, id: string) {
        return join(this.root, createHash('sha256').update(namespace).digest('hex'), id)
    }
    reserve(namespace: string, request: ArtifactReserve) { return this.store.reserve(namespace, request, this.limits) }
    private async exclusive<T>(id: string, action: () => Promise<T>) {
        if (this.active.has(id)) throw new ArtifactError(409, 'artifact_busy', 'A file operation is still running.', 'Inspect the same object before retrying; do not create a replacement object.')
        this.active.add(id)
        try { return await action() } finally { this.active.delete(id) }
    }
    private async reconcile(artifact: Artifact): Promise<Artifact> {
        if (artifact.state !== 'reserved') return artifact
        let file: FileHandle
        try { file = await opened(this.file(artifact.namespace, artifact.id), artifact) }
        catch (error) { if (missing(error)) return artifact; throw error }
        try {
            const hash = createHash('sha256')
            const buffer = Buffer.allocUnsafe(256 * 1024)
            let read = 0
            while (true) {
                const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
                if (!bytesRead) break
                read += bytesRead; hash.update(buffer.subarray(0, bytesRead))
                if (read > artifact.size) throw new ArtifactError(422, 'artifact_content_mismatch', 'Stored file grew during publication recovery.')
            }
            if (read !== artifact.size || hash.digest('hex') !== artifact.sha256) throw new ArtifactError(422, 'artifact_content_mismatch', 'Stored file checksum does not match its reservation.')
            await file.sync()
            const directory = await open(dirname(this.file(artifact.namespace, artifact.id)), constants.O_RDONLY)
            try { await directory.sync() } finally { await directory.close() }
            return this.store.publish(artifact.namespace, artifact.id)
        } finally { await file.close() }
    }
    async inspect(namespace: string, id: string): Promise<Artifact> {
        const artifact = this.store.get(namespace, id)
        if (this.active.has(id) || artifact.state !== 'reserved') return artifact
        return this.exclusive(id, () => this.reconcile(artifact))
    }
    async upload(namespace: string, id: string, body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): Promise<Artifact> {
        // Resolve access before touching an object lock or a filesystem path.
        this.store.get(namespace, id)
        return this.exclusive(id, async () => {
            const artifact = await this.reconcile(this.store.get(namespace, id))
            if (artifact.state === 'available') { await body?.cancel(); return artifact }
            if (artifact.state !== 'reserved') throw new ArtifactError(410, 'artifact_deleted', 'File object was deleted; this request ID cannot be reused.')
            const path = this.file(namespace, id), temporary = `${path}.part`
            await mkdir(dirname(path), { recursive: true, mode: 0o700 })
            const reader = body?.getReader()
            let file: FileHandle | undefined, timer: ReturnType<typeof setTimeout> | undefined
            let idleExpired = false, count = 0
            const hash = createHash('sha256')
            const cancel = () => { void reader?.cancel().catch(() => {}) }
            signal?.addEventListener('abort', cancel, { once: true })
            try {
                signal?.throwIfAborted()
                file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
                while (reader) {
                    timer = setTimeout(() => { idleExpired = true; cancel() }, this.idleMs)
                    const next = await reader.read()
                    clearTimeout(timer)
                    signal?.throwIfAborted()
                    if (idleExpired) throw new ArtifactError(409, 'artifact_transfer_idle', 'Upload stopped making progress.', 'Retry the same request ID to upload the file again.')
                    if (next.done) break
                    count += next.value.byteLength
                    if (count > artifact.size) throw new ArtifactError(422, 'artifact_size_mismatch', 'Upload exceeds its declared byte count.')
                    hash.update(next.value)
                    let offset = 0
                    while (offset < next.value.byteLength) offset += (await file.write(next.value, offset)).bytesWritten
                }
                if (count !== artifact.size || hash.digest('hex') !== artifact.sha256) throw new ArtifactError(422, 'artifact_checksum_mismatch', 'Upload size or SHA-256 does not match the reservation.', 'Inspect the source file; retry the original content using the same request ID.')
                await file.sync(); await file.close(); file = undefined
                await rename(temporary, path)
                const directory = await open(dirname(path), constants.O_RDONLY)
                try { await directory.sync() } finally { await directory.close() }
                return this.store.publish(namespace, id)
            } catch (error) {
                this.store.fail(namespace, id, artifactProblem(error))
                throw error
            } finally {
                clearTimeout(timer)
                signal?.removeEventListener('abort', cancel)
                await file?.close()
                await reader?.cancel().catch(() => {})
                reader?.releaseLock()
                await rm(temporary, { force: true })
            }
        })
    }
    async content(namespace: string, id: string): Promise<{ artifact: Artifact; body: ReadableStream<Uint8Array> }> {
        const artifact = await this.inspect(namespace, id)
        if (artifact.state !== 'available') throw new ArtifactError(artifact.state === 'reserved' ? 409 : 410,
            artifact.state === 'reserved' ? 'artifact_not_available' : 'artifact_deleted', 'File content is not available for download.')
        let file: FileHandle
        try { file = await opened(this.file(namespace, id), artifact) }
        catch (error) {
            if (missing(error)) throw new ArtifactError(503, 'artifact_content_missing', 'Published file bytes are missing.', 'Restore the Hub files together with their database backup; a session restart cannot recover this file.')
            throw error
        }
        const stream = file.createReadStream({ autoClose: true })
        // Node and Bun declare different BYOB overloads for this same web stream.
        return { artifact, body: Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array> }
    }
    async prune(namespace: string, request: ArtifactPrune): Promise<ArtifactPruneResult> {
        const checkedAt = Date.now()
        const rows = this.store.pruneCandidates(namespace, this.limits, checkedAt, request.after ?? '', request.limit + 1)
        const page = rows.slice(0, request.limit)
        const result: ArtifactPruneResult = { applied: request.apply, checkedAt, candidates: [], deleted: [], failures: [],
            nextCursor: rows.length > request.limit ? page.at(-1)!.id : null, usedBytes: this.store.usage(namespace) }
        for (const row of page) {
            try {
                await this.exclusive(row.id, async () => {
                    // A recovered publication gets its actual publication time before age is checked.
                    const current = await this.reconcile(this.store.get(namespace, row.id))
                    const eligible = current.state === 'deleting'
                        || (current.state === 'available' && current.publishedAt! <= checkedAt - this.limits.unreferencedDays * 86400000)
                        || (current.state === 'reserved' && current.createdAt <= checkedAt - this.limits.pendingHours * 3600000)
                    if (!eligible) throw new ArtifactError(409, 'artifact_not_expired', 'File is no longer eligible for expiry cleanup.')
                    if (this.store.references(namespace, row.id).length) throw new ArtifactError(409, 'artifact_referenced', 'File acquired a retention reference after cleanup selection.')
                    result.candidates.push(current)
                    if (request.apply) result.deleted.push(await this.deleteBytes(namespace, row.id))
                })
            } catch (error) { result.failures.push({ id: row.id, error: artifactProblem(error) }) }
        }
        result.usedBytes = this.store.usage(namespace)
        return result
    }
    private async deleteBytes(namespace: string, id: string): Promise<Artifact> {
        // This transaction rechecks references and prevents a new pin while bytes are removed.
        const artifact = this.store.beginDelete(namespace, id)
        if (artifact.state === 'deleted') return artifact
        const path = this.file(namespace, id)
        await rm(path, { force: true }); await rm(`${path}.part`, { force: true })
        return this.store.deleted(namespace, id)
    }
    async remove(namespace: string, id: string): Promise<Artifact> {
        this.store.get(namespace, id)
        return this.exclusive(id, () => this.deleteBytes(namespace, id))
    }
}
