import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { RepositoryRequestSchema, type RepositoryOperation, type RepositoryRequest, type RepositoryResponse, type WorkspaceSource } from '@hapi/protocol'
import { MachinePathPolicy } from '@/api/machinePathPolicy'
import { gitProcessStopped, WorkspaceError, workspaceProblem, type GitOptions } from '../workspaces/git'
import { exportRepository, repositoryReadEnvironment } from './export'
import type { RepositoryCache } from './cache'

const fail = (code: string, message: string, hint?: string): never => { throw new WorkspaceError(code, message, hint) }
/** Durable machine repository receipts; artifacts owns their network delivery. */
export class RepositoryManager {
    readonly root: string
    private readonly jobs = new Map<string, Promise<void>>()
    private readonly locks = new Map<string, Promise<void>>()
    private readonly shutdown = new AbortController()
    constructor(private readonly options: { home: string; pathPolicy: MachinePathPolicy;
        resolveSource: (cwd: string, baseRef: string, options?: GitOptions, readDirty?: boolean) => Promise<WorkspaceSource>; gitTimeoutMs?: number; cache?: RepositoryCache;
        withRepositoryLock?: <T>(key: string, action: () => Promise<T>) => Promise<T> }) {
        mkdirSync(options.home, { recursive: true, mode: 0o700 })
        this.root = join(realpathSync(options.home), 'workspaces', 'exports')
    }
    private directory(id: string, action?: 'export' | 'import') {
        if (!/^[a-f0-9-]{36}$/i.test(id)) return fail('repository_id_invalid', 'Invalid repository operation ID.')
        const imported = join(this.root, '..', 'imports', id)
        return action === 'import' || !action && existsSync(join(imported, 'operation.json')) ? imported : join(this.root, id)
    }
    private read(id: string): RepositoryOperation {
        const directory = this.directory(id), path = join(directory, 'operation.json')
        if (!existsSync(path)) return fail('repository_operation_missing', 'No repository operation has this ID.')
        if (realpathSync(directory) !== directory) return fail('repository_ownership_changed', 'Repository operation directory was replaced.')
        const record = JSON.parse(readFileSync(path, 'utf8')) as RepositoryOperation
        if (record.version !== 1 || record.request.operationId !== id || record.directory !== join(directory, 'data', 'files')) return fail('repository_record_invalid', 'Repository receipt does not match its owned directory.')
        return record
    }
    private save(record: RepositoryOperation) {
        const directory = this.directory(record.request.operationId, record.request.action)
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        if (realpathSync(directory) !== directory || lstatSync(directory).isSymbolicLink()) return fail('repository_ownership_changed', 'Repository operation directory was replaced.')
        const path = join(directory, 'operation.json'), temporary = `${path}.${randomUUID()}.tmp`
        writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path)
    }
    private async serial<T>(id: string, action: () => Promise<T>) {
        const result = (this.locks.get(id) ?? Promise.resolve()).then(action)
        const done = result.then(() => {}, () => {}).finally(() => { if (this.locks.get(id) === done) this.locks.delete(id) })
        this.locks.set(id, done); return result
    }
    async request(raw: unknown): Promise<RepositoryResponse> {
        if (this.shutdown.signal.aborted) return fail('repository_runner_stopping', 'Runner is stopping; inspect the original operation after reconnecting.')
        const parsed = RepositoryRequestSchema.safeParse(raw)
        if (!parsed.success) return fail('repository_request_invalid', 'Invalid repository operation.', parsed.error.issues.map(item => `${item.path.join('.')}: ${item.message}`).join('; '))
        const request = parsed.data
        return this.serial(request.operationId, async () => {
            if (request.action === 'inspect') {
                const operation = this.inspect(request.operationId)
                if (operation.imported && operation.status === 'succeeded' && operation.retention === 'retained') await this.options.cache!.validateSource(operation.imported.source)
                return { operation }
            }
            if (request.action === 'release') return { operation: await this.release(request) }
            const directory = this.directory(request.operationId, request.action)
            if (existsSync(join(this.directory(request.operationId), 'operation.json'))) {
                const prior = this.inspect(request.operationId)
                if (JSON.stringify(prior.request) !== JSON.stringify(request)) return fail('repository_request_conflict', 'This operation ID already has a different source.')
                return { operation: prior }
            }
            if (existsSync(directory)) return fail('repository_ownership_changed', 'Existing repository operation directory has no matching receipt.')
            if (!await this.options.pathPolicy.allowsSpawn(directory)) return fail('outside_workspace_roots', 'Repository storage is outside configured Runner roots.')
            const record: RepositoryOperation = { version: 1, request, directory: join(directory, 'data', 'files'),
                status: 'accepted', retention: 'retained', releasedFiles: [], createdAt: Date.now(), updatedAt: Date.now() }
            this.save(record)
            const job = Promise.resolve().then(() => this.run(record)).finally(() => this.jobs.delete(request.operationId))
            this.jobs.set(request.operationId, job); void job.catch(() => {})
            return { operation: structuredClone(record) }
        })
    }
    private async run(record: RepositoryOperation) {
        record.status = 'running'; record.updatedAt = Date.now(); this.save(record)
        try {
            const gitOptions: GitOptions = { timeoutMs: this.options.gitTimeoutMs, signal: this.shutdown.signal, env: repositoryReadEnvironment,
                process: process => { record.process = process; record.updatedAt = Date.now(); this.save(record) } }
            if (record.request.action === 'import') {
                if (!this.options.cache || !this.options.withRepositoryLock) return fail('repository_import_unavailable', 'Runner repository import is not configured.')
                record.imported = await this.options.cache.import(record.request, join(this.directory(record.request.operationId, 'import'), 'data'), gitOptions, this.options.withRepositoryLock)
                record.snapshot = record.request.snapshot
            } else {
                const expected = record.request.source
                const actual = await this.options.resolveSource(expected.sourcePath, expected.baseCommit, gitOptions, false)
                for (const key of ['machineId', 'repositoryId', 'repositoryRoot', 'commonDir', 'relativePath', 'baseCommit', 'objectFormat'] as const) {
                    if (expected[key] !== actual[key]) return fail('repository_source_changed', 'The source repository no longer matches its frozen identity.', key)
                }
                record.snapshot = await exportRepository({ source: expected, manifestId: record.request.operationId,
                    directory: join(this.directory(record.request.operationId), 'data'), pathPolicy: this.options.pathPolicy, gitOptions })
            }
            record.status = 'succeeded'; record.error = undefined
        } catch (error) {
            record.error = workspaceProblem(error); record.status = record.process || record.error.code.includes('unknown') ? 'unknown' : 'failed'
        }
        record.updatedAt = Date.now(); this.save(record)
    }
    private inspect(id: string) {
        const record = this.read(id)
        if (!this.jobs.has(id) && ['accepted', 'running', 'unknown'].includes(record.status)) {
            if (record.process && !gitProcessStopped(record.process)) {
                record.status = 'unknown'; record.error = { code: 'repository_process_unknown', message: 'The previous Git subprocess group has not been confirmed stopped.' }
            } else {
                record.process = undefined; record.status = (record.request.action === 'export' ? record.snapshot : record.imported) ? 'succeeded' : 'failed'
                record.error = record.status === 'succeeded' ? undefined : { code: `repository_${record.request.action}_interrupted`, message: 'Repository operation stopped without a complete receipt.', hint: 'Inspect the source and create a new request using the original fixed commit; this operation will not rerun.' }
            }
            record.updatedAt = Date.now(); this.save(record)
        }
        return record
    }
    private async release(request: Extract<RepositoryRequest, { action: 'release' }>) {
        const record = this.inspect(request.operationId)
        if (record.request.action === 'import') return fail('repository_cache_retained', 'Imported caches are retained with their workspaces; candidate release cannot delete them.')
        if (this.jobs.has(request.operationId) || !['succeeded', 'failed'].includes(record.status)) return fail('repository_operation_pending', 'Wait for export to stop before releasing its candidates.')
        if (record.retention === 'released') return record
        const names = record.snapshot?.files.map(file => file.name) ?? []
        if (request.names?.some(name => !names.includes(name))) return fail('repository_file_missing', 'No exported file has the requested name.')
        if (request.names && record.snapshot && record.retention !== 'releasing') {
            if (realpathSync(record.directory) !== record.directory) return fail('repository_ownership_changed', 'Export files directory was replaced.')
            for (const name of request.names) {
                await rm(join(record.directory, name), { force: true })
                if (!record.releasedFiles.includes(name)) record.releasedFiles.push(name)
                record.updatedAt = Date.now(); this.save(record)
            }
            if (names.some(name => !record.releasedFiles.includes(name))) return record
        }
        record.retention = 'releasing'; record.updatedAt = Date.now(); this.save(record)
        await rm(join(this.directory(request.operationId), 'data'), { recursive: true, force: true })
        record.retention = 'released'; record.releasedFiles = names; record.updatedAt = Date.now(); this.save(record)
        return record
    }
    async settled() { await Promise.all(this.jobs.values()) }
    async stop() { this.shutdown.abort(); await this.settled() }
}
