import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync, constants } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { ArtifactSchema, ArtifactTransferRequestSchema, PreparedFilesSchema,
    type ArtifactTransfer, type ArtifactTransferResponse, type MaterializeRequest, type MaterializedInput, type PreparedFiles } from '@hapi/protocol'
import type { MachinePathPolicy } from '@/api/machinePathPolicy'

import { captureFile, deliverFile } from './outputs'
import { fail, TransferError, transferProblem } from './common'
export { TransferError, transferProblem } from './common'

/** Durable machine file operations, independent of native sessions and scratch uploads. */
export class ArtifactTransferManager {
    readonly root: string
    private readonly shutdown = new AbortController()
    private readonly jobs = new Map<string, Promise<void>>()
    private readonly deliveries = new Map<string, string>()
    private readonly locks = new Map<string, Promise<void>>()
    constructor(private readonly options: { home: string; url: string; token: string; extraHeaders?: Record<string, string>; pathPolicy: MachinePathPolicy;
        assertStopped: (id: string) => Promise<void>; idleMs?: number }) {
        mkdirSync(options.home, { recursive: true, mode: 0o700 })
        this.root = join(realpathSync(options.home), 'artifact-transfers')
    }
    private directory(id: string) {
        if (!PreparedFilesSchema.safeParse({ operationId: id }).success) return fail('artifact_operation_invalid', 'Invalid file operation identity.')
        return join(this.root, id)
    }
    private read(id: string): ArtifactTransfer {
        const directory = this.directory(id)
        if (!existsSync(join(directory, 'receipt.json'))) return fail('artifact_operation_missing', 'No saved file operation exists.')
        if (realpathSync(directory) !== directory) return fail('artifact_ownership_changed', 'File operation directory was replaced.')
        const record = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8')) as ArtifactTransfer
        if (record.version !== 1 || record.request.operationId !== id || !ArtifactTransferRequestSchema.safeParse(record.request).success) return fail('artifact_receipt_invalid', 'Invalid saved file operation.')
        if (['accepted', 'running'].includes(record.status) && !this.jobs.has(id)) {
            record.status = record.request.action === 'capture' ? 'failed' : 'unknown'
            record.error = { code: 'artifact_transfer_interrupted', message: record.request.action === 'capture'
                ? 'Capture stopped before all files were confirmed. Preserved candidates remain usable; collect missing files with a new operation ID.'
                : 'Runner stopped before confirming the transfer. Retry the same file operation.' }
            this.save(record)
        }
        return record
    }
    private save(record: ArtifactTransfer) {
        const directory = this.directory(record.request.operationId)
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        if (realpathSync(directory) !== directory) return fail('artifact_ownership_changed', 'File operation directory was replaced.')
        const temporary = join(directory, `${randomUUID()}.tmp`)
        const fd = openSync(temporary, 'wx', 0o600)
        try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd) } finally { closeSync(fd) }
        renameSync(temporary, join(directory, 'receipt.json'))
        const dir = openSync(directory, 'r'); try { fsyncSync(dir) } finally { closeSync(dir) }
    }
    private async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
        const result = (this.locks.get(id) ?? Promise.resolve()).then(action)
        const settled = result.then(() => {}, () => {}).finally(() => { if (this.locks.get(id) === settled) this.locks.delete(id) })
        this.locks.set(id, settled); return result
    }
    async request(raw: unknown): Promise<ArtifactTransferResponse> {
        const parsed = ArtifactTransferRequestSchema.safeParse(raw)
        if (!parsed.success) return fail('artifact_request_invalid', 'Invalid file operation or duplicate input names.')
        const request = parsed.data, id = request.operationId
        if (request.action === 'inspect') return { operation: this.read(id) }
        if (this.shutdown.signal.aborted) return fail('artifact_runner_stopping', 'Runner is stopping; inspect after reconnecting.')
        if (request.action === 'deliver' && request.captureOperationId === id) return fail('artifact_request_invalid', 'Delivery and capture require different operation IDs.')
        const accept = async () => {
            if (request.action === 'release') {
                const record = this.read(id)
                if (this.jobs.has(id) || [...this.deliveries.values()].includes(id)) return fail('artifact_operation_pending', 'Wait for file operations before releasing their local files.')
                for (const session of record.sessions) await this.options.assertStopped(session)
                if (request.names && record.request.action !== 'capture') return fail('artifact_request_invalid', 'Selective release requires a capture operation.')
                if (record.retention !== 'released') {
                    if (record.request.action === 'capture') {
                        const names = request.names ?? record.candidates?.map(file => file.name) ?? []
                        if (names.some(name => !record.candidates?.some(file => file.name === name))) return fail('artifact_candidate_missing', 'No captured item has the requested name.')
                        for (const candidate of record.candidates ?? []) if (names.includes(candidate.name) && candidate.status === 'captured') {
                            await rm(this.candidatePath(record, candidate.name), { force: true })
                            candidate.retention = 'released'; record.updatedAt = Date.now(); this.save(record)
                        }
                        if (record.candidates?.some(file => file.status === 'captured' && file.retention === 'retained')) return { operation: record }
                    }
                    record.retention = 'releasing'; this.save(record)
                    await rm(join(this.directory(id), 'inputs'), { recursive: true, force: true })
                    await rm(join(this.directory(id), 'spool'), { recursive: true, force: true })
                    record.retention = 'released'; record.updatedAt = Date.now(); this.save(record)
                }
                return { operation: record }
            }
            let record: ArtifactTransfer
            if (existsSync(join(this.directory(id), 'receipt.json'))) {
                record = this.read(id)
                if (JSON.stringify(record.request) !== JSON.stringify(request)) return fail('artifact_request_conflict', 'This operation ID already has different arguments.')
                if (record.retention !== 'retained' && request.action !== 'capture') return fail('artifact_inputs_released', 'Released files cannot be restored with the same operation ID.')
                if (this.jobs.has(id) || record.status === 'succeeded' || request.action === 'capture') return { operation: record }
                for (const session of record.sessions) await this.options.assertStopped(session)
            } else {
                if (existsSync(this.directory(id))) return fail('artifact_ownership_changed', 'Existing directory has no matching operation receipt.')
                if (!await this.options.pathPolicy.allowsSpawn(this.directory(id))) return fail('outside_workspace_roots', 'File storage is outside configured Runner roots.')
                if (request.action === 'capture') {
                    if (!isAbsolute(request.cwd) || !await this.options.pathPolicy.allowsBrowse(request.cwd)) return fail('outside_workspace_roots', 'Capture requires an allowed absolute workspace directory.')
                }
                record = { version: 1, request, status: 'accepted', retention: 'retained', files: [], sessions: [], createdAt: Date.now(), updatedAt: Date.now() }
                if (request.action === 'capture') record.candidates = request.files.map(file => ({ ...file, status: 'failed',
                    error: { code: 'artifact_capture_interrupted', message: 'This file has not been captured. Collect it again if the operation stops.' } }))
            }
            if (request.action === 'deliver') {
                const capture = this.read(request.captureOperationId)
                if (capture.request.action !== 'capture' || this.jobs.has(request.captureOperationId)) return fail('artifact_capture_pending', 'Delivery requires a finished capture operation.')
                for (const input of request.files) {
                    if (!capture.candidates?.some(file => file.name === input.name && file.status === 'captured')) return fail('artifact_candidate_missing', 'A selected file has no captured candidate. Use a new capture to collect it.')
                }
            }
            record.status = 'accepted'; record.error = undefined; record.updatedAt = Date.now(); this.save(record)
            const accepted = structuredClone(record)
            if (request.action === 'deliver') this.deliveries.set(id, request.captureOperationId)
            const job = Promise.resolve().then(() => this.run(record)).finally(() => { this.jobs.delete(id); this.deliveries.delete(id) })
            this.jobs.set(id, job)
            void job.catch(() => {}) // A lost final receipt remains queryable; never infer success.
            return { operation: accepted }
        }
        if (request.action === 'deliver') {
            const [first, second] = [id, request.captureOperationId].sort()
            return this.serial(first!, () => this.serial(second!, accept))
        }
        return this.serial(id, accept)
    }
    private candidatePath(record: ArtifactTransfer, name: string) {
        const candidate = record.candidates?.find(file => file.name === name)
        const expected = join(this.directory(record.request.operationId), 'spool', createHash('sha256').update(name).digest('hex'))
        if (!candidate || candidate.status !== 'captured' || candidate.path !== expected) return fail('artifact_receipt_invalid', 'Captured path does not belong to this operation.')
        return expected
    }
    private async run(record: ArtifactTransfer) {
        record.status = 'running'; this.save(record)
        try {
            if (record.request.action === 'materialize') await this.materialize(record)
            else if (record.request.action === 'capture') await this.capture(record)
            else await this.deliver(record)
            const errors = [...(record.candidates ?? []), ...(record.deliveries ?? [])].filter(file => file.status === 'failed')
            record.status = errors.length ? 'failed' : 'succeeded'
            record.error = errors.length ? { code: 'artifact_partial_failure', message: 'Some files were not captured or delivered. Inspect individual items.' } : undefined
        } catch (error) { record.status = 'failed'; record.error = transferProblem(error) }
        record.updatedAt = Date.now(); this.save(record)
    }
    private async capture(record: ArtifactTransfer) {
        if (record.request.action !== 'capture') return fail('artifact_request_invalid', 'Capture request required.')
        const cwd = realpathSync(record.request.cwd), directory = join(this.directory(record.request.operationId), 'spool')
        if (!await this.options.pathPolicy.allowsBrowse(cwd)) return fail('outside_workspace_roots', 'Capture workspace is outside Runner roots.')
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        if (realpathSync(directory) !== directory) return fail('artifact_ownership_changed', 'Capture directory was replaced.')
        for (const [index, input] of record.request.files.entries()) {
            this.shutdown.signal.throwIfAborted()
            try { record.candidates![index] = await captureFile(cwd, input, join(directory, createHash('sha256').update(input.name).digest('hex')), this.shutdown.signal) }
            catch (error) { record.candidates![index] = { ...input, status: 'failed', error: error instanceof Error && 'code' in error && error.code === 'ENOENT'
                ? { code: 'artifact_output_missing', message: `Declared output does not exist: ${input.relativePath}` } : transferProblem(error) } }
            record.updatedAt = Date.now(); this.save(record)
        }
    }
    private async deliver(record: ArtifactTransfer) {
        if (record.request.action !== 'deliver') return fail('artifact_request_invalid', 'Delivery request required.')
        const capture = this.read(record.request.captureOperationId)
        record.deliveries = []
        for (const input of record.request.files) {
            this.shutdown.signal.throwIfAborted()
            const candidate = capture.candidates?.find(file => file.name === input.name)
            try {
                if (!candidate || candidate.status !== 'captured') return fail('artifact_candidate_missing', 'No captured candidate exists.')
                this.candidatePath(capture, input.name)
                const artifact = await deliverFile(candidate, input, { ...this.options, signal: this.shutdown.signal })
                record.deliveries.push({ name: input.name, status: 'available', artifact })
            } catch (error) { record.deliveries.push({ name: input.name, status: 'failed', error: transferProblem(error) }) }
            record.updatedAt = Date.now(); this.save(record)
        }
    }
    private async materialize(record: ArtifactTransfer) {
        if (record.request.action !== 'materialize') return fail('artifact_request_invalid', 'Materialize request required.')
        const directory = join(this.directory(record.request.operationId), 'inputs')
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        if (realpathSync(directory) !== directory) return fail('artifact_ownership_changed', 'Input directory was replaced.')
        record.files = []
        for (const input of record.request.files) {
            const path = join(directory, input.name)
            await this.download(input, path)
            record.files.push({ ...input, path }); record.updatedAt = Date.now(); this.save(record)
        }
    }
    private async download(input: MaterializeRequest['files'][number], path: string) {
        const idle = new AbortController(), signal = AbortSignal.any([idle.signal, this.shutdown.signal])
        let timer: ReturnType<typeof setTimeout>
        const tick = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(new TransferError('artifact_transfer_idle', 'File download stopped making progress.')), this.options.idleMs ?? 60_000) }
        tick()
        const temporary = join(dirname(path), `.part-${randomUUID()}`), headers = { ...this.options.extraHeaders, authorization: `Bearer ${this.options.token}` }
        let file: Awaited<ReturnType<typeof open>> | undefined, reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'read' | 'cancel' | 'releaseLock'> | undefined
        try {
            const base = `${this.options.url.replace(/\/$/, '')}/cli/artifacts/${input.artifactId}`
            const response = await fetch(base, { headers, signal })
            if (!response.ok) return fail('artifact_download_rejected', `Hub rejected file inspection (HTTP ${response.status}).`)
            const object = ArtifactSchema.parse((await response.json() as { artifact: unknown }).artifact)
            if (object.id !== input.artifactId || object.state !== 'available' || object.size !== input.size || object.sha256 !== input.sha256) return fail('artifact_input_mismatch', 'Hub object does not match the frozen input.')
            await rm(temporary, { force: true })
            file = await open(temporary, 'wx', 0o600)
            const bytes = await fetch(`${base}/content`, { headers, signal })
            if (!bytes.ok) return fail('artifact_download_rejected', `Hub rejected file download (HTTP ${bytes.status}).`)
            const hash = createHash('sha256'); let size = 0
            reader = bytes.body?.getReader()
            while (reader) {
                const part = await reader.read(); if (part.done) break
                tick(); size += part.value.byteLength
                if (size > input.size) return fail('artifact_input_mismatch', 'Downloaded file exceeds its declared size.')
                hash.update(part.value)
                let offset = 0
                while (offset < part.value.byteLength) offset += (await file.write(part.value, offset)).bytesWritten
            }
            if (size !== input.size || hash.digest('hex') !== input.sha256) return fail('artifact_input_mismatch', 'Downloaded file hash or length is incorrect.')
            await file.sync(); await file.close(); file = undefined
            await rename(temporary, path)
            const parent = await open(join(path, '..'), 'r'); try { await parent.sync() } finally { await parent.close() }
        } finally {
            clearTimeout(timer!); await reader?.cancel().catch(() => {}); reader?.releaseLock()
            await file?.close(); await rm(temporary, { force: true })
        }
    }
    async validatePrepared(reference: PreparedFiles): Promise<MaterializedInput[]> {
        const record = this.read(reference.operationId)
        if (record.request.action !== 'materialize' || record.status !== 'succeeded' || record.retention !== 'retained' || record.files.length !== record.request.files.length) return fail('files_not_prepared', 'Input preparation is missing, incomplete or released.')
        for (const input of record.files) {
            const expected = join(this.directory(reference.operationId), 'inputs', input.name)
            if (input.path !== expected || realpathSync(input.path) !== expected || !lstatSync(input.path).isFile()) return fail('files_not_prepared', 'Prepared input path was replaced.')
            const file = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW)
            try {
                const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(256 * 1024); let size = 0
                while (true) {
                    const { bytesRead } = await file.read(buffer, 0, buffer.length, size); if (!bytesRead) break
                    size += bytesRead; hash.update(buffer.subarray(0, bytesRead))
                    if (size > input.size) break
                }
                if (size !== input.size || hash.digest('hex') !== input.sha256) return fail('files_not_prepared', 'Prepared input hash or length changed before launch.')
            } finally { await file.close() }
        }
        return record.files
    }
    async launch<T extends { type: string; sessionId?: string; childStarted?: boolean }>(reference: PreparedFiles, sessionId: string, start: () => Promise<T>): Promise<T> {
        return this.serial(reference.operationId, async () => {
            await this.validatePrepared(reference)
            const record = this.read(reference.operationId)
            for (const id of record.sessions) await this.options.assertStopped(id)
            record.sessions = [...new Set([...record.sessions, sessionId])]; this.save(record)
            const result = await start()
            if (result.type === 'error' && result.childStarted === false) record.sessions = record.sessions.filter(id => id !== sessionId)
            if (result.type === 'success' && result.sessionId && !record.sessions.includes(result.sessionId)) record.sessions.push(result.sessionId)
            this.save(record); return result
        })
    }
    async settled() { await Promise.all(this.jobs.values()) }
    async stop() { this.shutdown.abort(); await this.settled() }
}
