import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { RepositoryRequestSchema, type ManagedWorkspace, type RepositoryOperation, type RepositoryRequest, type RepositoryResponse, type WorkspaceSource } from '@hapi/protocol'
import { MachinePathPolicy } from '@/api/machinePathPolicy'
import { git, gitProcessStopped, WorkspaceError, workspaceProblem, type GitOptions } from '../workspaces/git'
import { exportRepository, repositoryReadEnvironment } from './export'
import type { RepositoryCache } from './cache'
import type { WorkspaceManager } from '../workspaces/manager'
import { verifyRepositorySnapshot } from './verify'

const fail = (code: string, message: string, hint?: string): never => { throw new WorkspaceError(code, message, hint) }
/** Durable machine repository receipts; artifacts owns their network delivery. */
export class RepositoryManager {
    readonly root: string
    private readonly jobs = new Map<string, Promise<void>>()
    private readonly locks = new Map<string, Promise<void>>()
    private readonly shutdown = new AbortController()
    constructor(private readonly options: { home: string; pathPolicy: MachinePathPolicy;
        resolveSource: (cwd: string, baseRef: string, options?: GitOptions, readDirty?: boolean) => Promise<WorkspaceSource>; gitTimeoutMs?: number; cache?: RepositoryCache;
        repositoryWorkspaces?: (commonDir: string) => ManagedWorkspace[];
        withSealedResult?: WorkspaceManager['withSealedResult'];
        withRepositoryLock?: <T>(key: string, action: () => Promise<T>) => Promise<T> }) {
        mkdirSync(options.home, { recursive: true, mode: 0o700 })
        this.root = join(realpathSync(options.home), 'workspaces', 'exports')
    }
    private directory(id: string, action?: RepositoryOperation['request']['action']) {
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
            } else if (record.request.action === 'export-result') {
                if (!this.options.withSealedResult) return fail('repository_results_unavailable', 'Runner result export is not configured.')
                const request = record.request, data = join(this.directory(request.operationId), 'data')
                await this.options.withSealedResult(request.environmentId, request.roundId, gitOptions, async (source, result) => {
                    const snapshot = await exportRepository({ source, manifestId: request.operationId,
                        directory: data, pathPolicy: this.options.pathPolicy, gitOptions })
                    const verified = await verifyRepositorySnapshot(snapshot, data, gitOptions)
                    for (const [ancestor, head] of [[result.baseCommit, result.startHead], [result.startHead, result.resultHead]]) {
                        if ((await git(verified, ['merge-base', '--is-ancestor', ancestor!, head!], { ...gitOptions, allowFailure: true })).exitCode !== 0) {
                            return fail('repository_result_history', 'Result bundle does not contain the sealed baseline/start/result ancestry.')
                        }
                    }
                    // Only these owned files survive; neither source alternates nor verification stores are deliverables.
                    await rm(join(data, 'scratch'), { recursive: true, force: true })
                    await rm(join(data, 'verify'), { recursive: true, force: true })
                    record.snapshot = snapshot; record.sealed = { source, result, verifiedAt: Date.now() }
                    this.save(record)
                })
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
                const complete = record.request.action === 'import' ? record.imported
                    : record.request.action === 'export-result' ? record.snapshot && record.sealed : record.snapshot
                record.process = undefined; record.status = complete ? 'succeeded' : 'failed'
                record.error = record.status === 'succeeded' ? undefined : { code: `repository_${record.request.action}_interrupted`, message: 'Repository operation stopped without a complete receipt.', hint: 'Inspect the source and create a new request using the original fixed commit; this operation will not rerun.' }
            }
            record.updatedAt = Date.now(); this.save(record)
        }
        return record
    }
    private async release(request: Extract<RepositoryRequest, { action: 'release' }>) {
        const record = this.inspect(request.operationId)
        if (this.jobs.has(request.operationId) || !['succeeded', 'failed'].includes(record.status)) return fail('repository_operation_pending', 'Wait for export to stop before releasing its candidates.')
        if (record.request.action === 'import') {
            if (request.names) return fail('repository_release_names_invalid', 'An import must be released as a whole.')
            if (!this.options.cache || !this.options.withRepositoryLock || !this.options.repositoryWorkspaces) return fail('repository_release_unavailable', 'Runner cache retention checks are unavailable.')
            if (record.process && !gitProcessStopped(record.process)) return fail('repository_process_unknown', 'Previous repository subprocess has not been confirmed stopped.')
            record.process = undefined
            const cache = this.options.cache, commonDir = cache.commonDir(record.request.snapshot)
            return this.options.withRepositoryLock(commonDir, async () => {
                const data = join(this.directory(request.operationId, 'import'), 'data'), retired = join(data, 'released-cache')
                if (record.retention === 'releasing' && (existsSync(retired) || record.cache?.retained === false)) {
                    await rm(data, { recursive: true, force: true })
                    record.cache = { retained: false, directory: join(commonDir, '..') }
                    record.retention = 'released'; record.updatedAt = Date.now(); this.save(record); return record
                }
                const imports = join(this.root, '..', 'imports')
                const receipts = existsSync(imports) ? readdirSync(imports).map(id => this.read(id)) : []
                const options: GitOptions = { timeoutMs: this.options.gitTimeoutMs, signal: this.shutdown.signal,
                    process: child => { record.process = child; record.updatedAt = Date.now(); this.save(record) } }
                record.cache = await cache.release(record, receipts, this.options.repositoryWorkspaces!(commonDir), retired, options,
                    () => { record.retention = 'releasing'; record.updatedAt = Date.now(); this.save(record) })
                record.updatedAt = Date.now(); this.save(record)
                await rm(data, { recursive: true, force: true })
                record.retention = 'released'; record.updatedAt = Date.now(); this.save(record); return record
            })
        }
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
    async stop() { this.shutdown.abort(); await this.settled(); await Promise.all(this.locks.values()) }
}
