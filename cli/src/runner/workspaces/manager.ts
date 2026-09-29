import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { copyFile, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { WorkspaceRequestSchema, type ManagedWorkspace, type PreparedWorkspace,
    type WorkspaceOperation, type WorkspacePreparation, type WorkspaceRequest, type WorkspaceResponse,
    type WorkspaceSource } from '@hapi/protocol'
import { MachinePathPolicy } from '@/api/machinePathPolicy'
import { git, gitProcessStopped, output, WorkspaceError, workspaceProblem, type GitOptions } from './git'
import type { RepositoryCache } from '../repositories/cache'

type Prepare = Extract<WorkspaceRequest, { action: 'prepare' }>
type Finalize = Extract<WorkspaceRequest, { action: 'finalize' }>
type Remove = Extract<WorkspaceRequest, { action: 'remove' }>
const checkpointName = 'HAPI Checkpoint'
const checkpointEmail = 'checkpoint@hapi.local'
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
async function fileDigest(path: string) {
    const hash = createHash('sha256'); let size = 0
    for await (const chunk of createReadStream(path)) { hash.update(chunk); size += Buffer.byteLength(chunk) }
    return { sha256: hash.digest('hex'), size }
}
const problem = (code: string, message: string, hint?: string): never => { throw new WorkspaceError(code, message, hint) }

/** Machine-owned Git workspaces. All model execution remains in the existing Runner. */
export class WorkspaceManager {
    readonly root: string
    private readonly records = new Map<string, ManagedWorkspace>()
    private readonly launching = new Set<string>()
    private readonly shutdown = new AbortController()
    private readonly jobs = new Map<string, Promise<void>>()
    private readonly locks = new Map<string, Promise<void>>()
    constructor(private readonly options: { home: string; machineId: string; pathPolicy: MachinePathPolicy;
        assertStopped: (sessionId: string) => Promise<void>; gitTimeoutMs?: number; snapshots?: RepositoryCache }) {
        mkdirSync(options.home, { recursive: true, mode: 0o700 })
        this.root = join(realpathSync(options.home), 'workspaces')
    }
    private directory(id: string) { return join(this.root, 'environments', id) }
    private recordPath(id: string) { return join(this.directory(id), 'workspace.json') }
    private read(id: string): ManagedWorkspace {
        // Validate before using an identifier in a path, including internal callers.
        if (!/^[a-f0-9-]{36}$/i.test(id)) return problem('workspace_id_invalid', 'Invalid workspace identity.')
        const cached = this.records.get(id)
        if (cached) return cached
        const path = this.recordPath(id)
        if (!existsSync(path)) return problem('workspace_not_found', 'Workspace has no ownership record.')
        const value = JSON.parse(readFileSync(path, 'utf8')) as ManagedWorkspace
        if (value.version !== 1 || value.environmentId !== id || value.checkout !== join(this.directory(id), 'checkout')) {
            return problem('workspace_record_invalid', 'Workspace ownership record does not match this installation.')
        }
        this.records.set(id, value)
        return value
    }
    private save(workspace: ManagedWorkspace) {
        const directory = this.directory(workspace.environmentId)
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        if (lstatSync(directory).isSymbolicLink()) return problem('workspace_ownership_unknown', 'Workspace data directory is a symlink.')
        const path = this.recordPath(workspace.environmentId), temporary = `${path}.${randomUUID()}.tmp`
        writeFileSync(temporary, JSON.stringify(workspace), { mode: 0o600, flag: 'wx' })
        renameSync(temporary, path)
        this.records.set(workspace.environmentId, workspace)
    }
    private async serial<T>(key: string, action: () => Promise<T>): Promise<T> {
        const operation = (this.locks.get(key) ?? Promise.resolve()).then(action)
        const busy = operation.then(() => {}, () => {}).finally(() => { if (this.locks.get(key) === busy) this.locks.delete(key) })
        this.locks.set(key, busy)
        return operation
    }
    withRepositoryLock<T>(key: string, action: () => Promise<T>) { return this.serial(key, action) }
    repositoryRecords(commonDir: string): ManagedWorkspace[] {
        const directory = join(this.root, 'environments')
        return existsSync(directory) ? readdirSync(directory).map(id => this.read(id)).filter(workspace => workspace.source.commonDir === commonDir) : []
    }
    private async allowed(path: string) {
        if (!await this.options.pathPolicy.allowsSpawn(path)) return problem('outside_workspace_roots', 'Workspace path is outside the configured Runner roots.', path)
    }
    private gitOptions(workspace?: ManagedWorkspace, operation?: WorkspaceOperation): GitOptions {
        return { timeoutMs: this.options.gitTimeoutMs, signal: this.shutdown.signal,
            ...(workspace && operation ? { process: (child: WorkspaceOperation['process']) => {
                operation.process = child; operation.startedGit = true; operation.updatedAt = Date.now(); this.save(workspace)
            } } : {}) }
    }
    async resolveSource(cwd: string, baseRef: string, options: GitOptions = {}, readDirty = true): Promise<WorkspaceSource> {
        await this.allowed(cwd)
        const sourcePath = realpathSync(cwd)
        if (!statSync(sourcePath).isDirectory()) return problem('workspace_not_directory', 'The source must be an existing directory.')
        const repositoryRoot = realpathSync(await output(sourcePath, ['rev-parse', '--show-toplevel'], options))
        const commonDir = realpathSync(await output(sourcePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'], options))
        const objectFormat = await output(sourcePath, ['rev-parse', '--show-object-format'], options)
        if (!['sha1', 'sha256'].includes(objectFormat)) return problem('git_object_format_unsupported', 'Unsupported Git object format.')
        const parsed = await git(sourcePath, ['-c', 'core.warnAmbiguousRefs=true', 'rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`], options)
        if (/ambiguous/i.test(parsed.stderr)) return problem('git_ref_ambiguous', 'Git reference is ambiguous; use a full ref or commit SHA.')
        const baseCommit = parsed.stdout.trim()
        const relativePath = relative(repositoryRoot, sourcePath).split(sep).join('/')
        if (!inside(repositoryRoot, sourcePath)) return problem('workspace_cwd_outside_repository', 'Source cwd is outside its repository.')
        if (relativePath && await output(repositoryRoot, ['cat-file', '-t', `${baseCommit}:${relativePath}`], options) !== 'tree') {
            return problem('workspace_cwd_missing', 'Source subdirectory is not a directory in the selected commit.')
        }
        const dirty = readDirty && !!await output(sourcePath, ['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=none'], options)
        return { machineId: this.options.machineId, repositoryId: digest(JSON.stringify([this.options.machineId, commonDir, objectFormat])),
            sourcePath, repositoryRoot, commonDir, relativePath, baseRef, baseCommit, objectFormat: objectFormat as 'sha1' | 'sha256', dirty }
    }
    async request(raw: unknown): Promise<WorkspaceResponse> {
        if (this.shutdown.signal.aborted) return problem('workspace_runner_stopping', 'Runner is stopping; inspect the saved operation after reconnecting.')
        const parsed = WorkspaceRequestSchema.safeParse(raw)
        if (!parsed.success) return problem('workspace_request_invalid', 'Invalid workspace operation.', parsed.error.issues.map(item => item.path.join('.') + ': ' + item.message).join('; '))
        const request = parsed.data
        if (request.action === 'resolve') return { source: await this.resolveSource(request.cwd, request.baseRef) }
        if (request.action === 'inspect') return { workspace: await this.inspect(request.environmentId) }
        const key = request.action === 'prepare' ? request.source.commonDir : this.read(request.environmentId).source.commonDir
        // Accept only; never hold the HTTP/RPC call open for clone, LFS or hooks.
        return this.serial(`accept:${request.environmentId}`, async () => {
            if (this.launching.has(request.environmentId)) return problem('workspace_execution_starting', 'A workspace execution is starting.')
            let workspace: ManagedWorkspace
            if (existsSync(this.recordPath(request.environmentId))) workspace = this.read(request.environmentId)
            else {
                if (request.action !== 'prepare') return problem('workspace_not_found', 'Workspace has no ownership record.')
                const directory = this.directory(request.environmentId)
                if (existsSync(directory)) return problem('workspace_ownership_unknown', 'Existing directory has no matching workspace record.', directory)
                await this.allowed(directory)
                const checkout = join(directory, 'checkout')
                workspace = { version: 1, environmentId: request.environmentId, source: request.source, checkout,
                    cwd: resolve(checkout, request.source.relativePath), branch: `hapi-task/${request.environmentId}`, status: 'retained',
                    createdAt: Date.now(), preparations: {}, results: {}, operations: {}, sessions: {} }
                if (!inside(checkout, workspace.cwd)) return problem('workspace_cwd_outside_repository', 'Relative cwd escapes the checkout.')
            }
            const id = request.action === 'prepare' ? `prepare:${request.preparationId}`
                : request.action === 'finalize' ? `finalize:${request.roundId}:${request.attemptId}` : `remove:${request.attemptId}`
            const previous = workspace.operations[id]
            if (previous) {
                if (!same(previous.request, request)) return problem('workspace_request_conflict', 'Operation identity was already used with different arguments.')
                return { workspace: structuredClone(workspace), operation: structuredClone(previous) }
            }
            if (workspace.status !== 'retained') return problem('workspace_not_retained', 'Workspace is being removed or was already removed.')
            if (request.action === 'prepare' && !same(workspace.source, request.source)) return problem('workspace_source_changed', 'Workspace source cannot be replaced.')
            if (Object.values(workspace.operations).some(op => ['accepted', 'running', 'unknown'].includes(op.status))) {
                return problem('workspace_operation_pending', 'A workspace operation still needs reconciliation; inspect the existing operation.')
            }
            const operation: WorkspaceOperation = { id, request, status: 'accepted', createdAt: Date.now(), updatedAt: Date.now() }
            workspace.operations[id] = operation
            if (request.action === 'remove') workspace.status = 'deleting'
            this.save(workspace)
            // Schedule after the short acceptance lock is released. A saved accepted record is observable immediately.
            const job = Promise.resolve().then(() => this.serial(key, () => this.execute(workspace.environmentId, id)))
                .finally(() => this.jobs.delete(`${workspace.environmentId}:${id}`))
            this.jobs.set(`${workspace.environmentId}:${id}`, job)
            void job.catch(() => {}) // execute persists domain errors; storage failures surface on inspect.
            return { workspace: structuredClone(workspace), operation: structuredClone(operation) }
        })
    }
    private async execute(environmentId: string, operationId: string) {
        const workspace = this.read(environmentId), operation = workspace.operations[operationId]!
        operation.status = 'running'; operation.updatedAt = Date.now(); this.save(workspace)
        try {
            await this.idle(workspace)
            if (operation.request.action === 'prepare') await this.prepare(workspace, operation, operation.request)
            else if (operation.request.action === 'finalize') await this.finalize(workspace, operation, operation.request)
            else await this.remove(workspace, operation, operation.request)
            operation.status = 'succeeded'; operation.error = undefined
        } catch (error) {
            operation.error = workspaceProblem(error)
            operation.status = operation.process || operation.error.code.includes('unknown') ? 'unknown' : 'failed'
            if (operation.request.action === 'remove' && operation.status === 'failed') workspace.status = 'retained'
        }
        operation.updatedAt = Date.now(); this.save(workspace)
    }
    private async idle(workspace: ManagedWorkspace) {
        for (const [sessionId, session] of Object.entries(workspace.sessions)) if (!session.rejected) await this.options.assertStopped(sessionId)
    }
    private async source(workspace: ManagedWorkspace) {
        const source = workspace.source
        if (source.snapshot) {
            if (!this.options.snapshots) return problem('repository_import_unavailable', 'Runner repository cache is not configured.')
            await this.options.snapshots.validateSource(source)
        } else if (inside(join(this.root, 'repositories'), source.commonDir)) return problem('repository_snapshot_required', 'Cache sources require a saved import receipt.')
        await this.allowed(source.repositoryRoot); await this.allowed(workspace.checkout)
        if (source.repositoryId !== digest(JSON.stringify([source.machineId, source.commonDir, source.objectFormat]))) return problem('workspace_repository_changed', 'Workspace repository identity does not match its source.')
        if (source.machineId !== this.options.machineId) return problem('workspace_machine_mismatch', 'Workspace source belongs to another machine.')
        const common = realpathSync(await output(source.repositoryRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
        if (common !== source.commonDir) return problem('workspace_repository_changed', 'Source repository common directory changed.')
        if (await output(source.repositoryRoot, ['rev-parse', '--show-object-format']) !== source.objectFormat) return problem('workspace_repository_changed', 'Source repository object format changed.')
        await git(source.repositoryRoot, ['cat-file', '-e', `${source.baseCommit}^{commit}`])
    }
    private async validate(workspace: ManagedWorkspace) {
        await this.source(workspace)
        if (!existsSync(workspace.checkout) || lstatSync(workspace.checkout).isSymbolicLink()) return problem('workspace_missing', 'Prepared checkout is missing or was replaced.', workspace.checkout)
        const checkout = realpathSync(workspace.checkout)
        if (checkout !== workspace.checkout) return problem('workspace_ownership_unknown', 'Checkout path no longer matches its canonical location.')
        const common = realpathSync(await output(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
        const branch = await output(checkout, ['symbolic-ref', '--quiet', 'HEAD'])
        if (common !== workspace.source.commonDir || branch !== `refs/heads/${workspace.branch}`) return problem('workspace_ownership_unknown', 'Checkout repository or branch was changed.')
        const registered = (await git(workspace.source.repositoryRoot, ['worktree', 'list', '--porcelain', '-z'])).stdout.split('\0')
        if (!registered.includes(`worktree ${workspace.checkout}`)) return problem('workspace_ownership_unknown', 'Checkout is not registered in the source repository.')
    }
    private async head(workspace: ManagedWorkspace) { return output(workspace.checkout, ['rev-parse', 'HEAD']) }
    private async clean(workspace: ManagedWorkspace) {
        return !(await git(workspace.checkout, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'])).stdout
    }
    private async pin(workspace: ManagedWorkspace, ref: string, head: string, options?: GitOptions) {
        const existing = await git(workspace.source.repositoryRoot, ['rev-parse', '--verify', ref], { allowFailure: true })
        if (existing.exitCode === 0) {
            if (existing.stdout.trim() !== head) return problem('workspace_ref_conflict', 'An immutable workspace reference has a different value.', ref)
            return
        }
        await git(workspace.source.repositoryRoot, ['update-ref', ref, head, '0'.repeat(head.length)], options)
    }
    private async prepare(workspace: ManagedWorkspace, operation: WorkspaceOperation, request: Prepare) {
        await this.source(workspace)
        const options = this.gitOptions(workspace, operation)
        if (Object.values(workspace.preparations).some(prep => !workspace.results[prep.roundId])) return problem('workspace_round_unsealed', 'Seal the previous prepared round before preparing another execution.')
        const latest = Object.values(workspace.results).sort((a, b) => b.sealedAt - a.sealedAt)[0]
        if (request.expectedHead !== (latest?.resultHead ?? workspace.source.baseCommit)) return problem('workspace_head_mismatch', 'Preparation must start at the last sealed result or original base.')
        await this.pin(workspace, `refs/hapi/workspaces/${workspace.environmentId}/base`, workspace.source.baseCommit, options)
        if (!existsSync(workspace.checkout)) {
            // A later preparation never silently rebuilds a lost environment/history.
            if (Object.keys(workspace.preparations).length) return problem('workspace_missing', 'Retained checkout was removed; create a new delegation.')
            const existing = await git(workspace.source.repositoryRoot, ['show-ref', '--verify', `refs/heads/${workspace.branch}`], { allowFailure: true })
            if (existing.exitCode === 0) return problem('workspace_branch_conflict', 'Task branch exists without its expected checkout.')
            await git(workspace.source.repositoryRoot, ['worktree', 'add', '-b', workspace.branch, workspace.checkout, workspace.source.baseCommit],
                { ...options, env: { GIT_LFS_SKIP_SMUDGE: '1' } })
        }
        await this.validate(workspace)
        if (await this.head(workspace) !== request.expectedHead || !await this.clean(workspace)) return problem('workspace_drift', 'Checkout differs from its recorded starting result.', workspace.checkout)
        await this.hydrate(workspace, options)
        if (workspace.source.snapshot && !await this.clean(workspace)) return problem('workspace_drift', 'Snapshot checkout is not clean after asset preparation.')
        const cwd = realpathSync(workspace.cwd)
        if (!inside(workspace.checkout, cwd) || !statSync(cwd).isDirectory()) return problem('workspace_cwd_missing', 'The prepared working directory is unavailable.')
        const inputs: WorkspacePreparation['inputs'] = []
        for (const input of request.inputs) {
            await this.allowed(input.path)
            const bytes = await fileDigest(input.path)
            if (bytes.size !== input.size || bytes.sha256 !== input.sha256) return problem('workspace_input_mismatch', 'Prepared input hash or length is incorrect.', input.name)
            const directory = join(this.directory(workspace.environmentId), 'inputs', request.preparationId)
            mkdirSync(directory, { recursive: true, mode: 0o700 })
            const target = join(directory, input.name)
            if (existsSync(target)) {
                if ((await fileDigest(target)).sha256 !== input.sha256) return problem('workspace_input_conflict', 'Existing input is different.', input.name)
            } else await copyFile(input.path, target)
            const copied = await fileDigest(target)
            if (copied.size !== input.size || copied.sha256 !== input.sha256) return problem('workspace_input_mismatch', 'Input changed while being copied.', input.name)
            inputs.push({ ...input, path: target })
        }
        workspace.preparations[request.preparationId] = { environmentId: workspace.environmentId, preparationId: request.preparationId,
            roundId: request.roundId, cwd, startHead: request.expectedHead, inputs, readyAt: Date.now() }
    }
    private async hydrate(workspace: ManagedWorkspace, options: GitOptions) {
        if (workspace.source.snapshot) return this.options.snapshots!.hydrate(workspace.source, workspace.checkout, options)
        const cwd = workspace.checkout
        if (existsSync(join(cwd, '.gitmodules'))) {
            const modules = await git(cwd, ['config', '--file', '.gitmodules', '--null', '--get-regexp', '^submodule\\..*\\.path$'], { allowFailure: true })
            if (modules.exitCode > 1) return problem('workspace_submodule_invalid', 'Cannot read submodule configuration.')
            for (const entry of modules.stdout.split('\0').filter(Boolean)) {
                const split = entry.indexOf('\n'), key = entry.slice(0, split).replace(/\.path$/, ''), path = entry.slice(split + 1)
                const configured = await git(cwd, ['config', '--get', `${key}.url`], { allowFailure: true })
                const url = configured.exitCode === 0 ? configured.stdout.trim() : await output(cwd, ['config', '--file', '.gitmodules', '--get', `${key}.url`])
                const args: string[] = []
                // Resolved URLs can be supplied for this command without mutating shared config.
                // Relative URLs retain Git's native remote-relative resolution/init behavior.
                if (!/^\.\.?\//.test(url)) args.push('-c', `${key}.url=${url}`, '-c', `${key}.active=true`)
                args.push('submodule', 'update', '--init', '--recursive')
                const local = resolve(workspace.source.repositoryRoot, path)
                if (inside(workspace.source.repositoryRoot, local) && existsSync(join(local, '.git'))) {
                    const reference = await git(local, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFailure: true })
                    if (reference.exitCode === 0) args.push('--reference', reference.stdout.trim())
                }
                await git(cwd, [...args, '--', path], options)
            }
            const status = await git(cwd, ['submodule', 'status', '--recursive'])
            if (status.stdout.split('\n').some(line => line && !line.startsWith(' '))) return problem('workspace_submodule_unready', 'Submodule does not match its recorded commit.')
        }
        for (const directory of [workspace.checkout, ...await this.submodules(workspace)]) await this.lfs(workspace, options, true, directory)
    }
    private async lfs(workspace: ManagedWorkspace, options: GitOptions, hydrate: boolean, cwd = workspace.checkout) {
        // Attributes may use global includes, so ask Git rather than scanning .gitattributes text.
        const files = (await git(cwd, ['ls-files', '-z'])).stdout.split('\0').filter(Boolean)
        let lfs = false
        for (let offset = 0; offset < files.length; offset += 100) {
            const attrs = await git(cwd, ['check-attr', '-z', 'filter', '--', ...files.slice(offset, offset + 100)])
            const fields = attrs.stdout.split('\0')
            if (fields.some((value, index) => index % 3 === 2 && value === 'lfs')) { lfs = true; break }
        }
        if (!lfs) return
        const inspect = async () => JSON.parse((await git(cwd, ['lfs', 'ls-files', '--json'])).stdout).files as Array<{ name: string; oid: string; size: number; checkout: boolean; downloaded: boolean }>
        if (hydrate) {
            await git(cwd, ['lfs', 'checkout'], options)
            if ((await inspect()).some(file => !file.checkout || !file.downloaded)) {
                await git(cwd, ['lfs', 'pull'], options)
                await git(cwd, ['lfs', 'checkout'], options)
            }
        }
        for (const file of await inspect()) {
            const path = resolve(cwd, file.name)
            if (!inside(cwd, path)) return problem('workspace_lfs_invalid', 'LFS path escapes the checkout.')
            const bytes = await fileDigest(path)
            if (!file.checkout || !file.downloaded || bytes.size !== file.size || bytes.sha256 !== file.oid) return problem('workspace_lfs_unready', 'LFS content is unavailable or does not match its pointer.', file.name)
        }
    }
    private async noGitOperation(workspace: ManagedWorkspace) {
        for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'index.lock']) {
            const path = await output(workspace.checkout, ['rev-parse', '--path-format=absolute', '--git-path', name])
            if (existsSync(path)) return problem('workspace_git_in_progress', 'Resolve the existing Git operation before sealing.', name)
        }
        if ((await git(workspace.checkout, ['ls-files', '-u', '-z'])).stdout) return problem('workspace_conflicts', 'Checkout contains unresolved conflicts.')
    }
    private async submodules(workspace: ManagedWorkspace) {
        if (!existsSync(join(workspace.checkout, '.gitmodules'))) return []
        return (await git(workspace.checkout, ['submodule', 'foreach', '--quiet', '--recursive', 'printf \"%s\\0\" \"$PWD\"'])).stdout.split('\0').filter(Boolean)
    }
    private async checkGitlinks(workspace: ManagedWorkspace, startHead: string, allowUninitialized = false) {
        const tree = (await git(workspace.checkout, ['ls-tree', '-r', '-z', startHead])).stdout.split('\0').filter(line => line.startsWith('160000 ')).map(line => line.replace(' commit ', ' ')).sort()
        const index = (await git(workspace.checkout, ['ls-files', '-s', '-z'])).stdout.split('\0').filter(line => line.startsWith('160000 ')).map(line => line.replace(/ 0\t/, '\t')).sort()
        if (!same(tree, index)) return problem('workspace_submodule_changed', 'New or changed gitlinks need explicit parent-agent handling; no incomplete result was sealed.')
        if (tree.length) {
            const status = await git(workspace.checkout, ['submodule', 'status', '--recursive'])
            if (status.stdout.split('\n').some(line => line && !line.startsWith(' ') && !(allowUninitialized && line.startsWith('-')))) return problem('workspace_submodule_changed', 'Submodule checkout does not match the recorded gitlink.')
            const dirty = await git(workspace.checkout, ['submodule', 'foreach', '--quiet', '--recursive', 'git status --porcelain=v1 --untracked-files=all --ignore-submodules=none'])
            if (dirty.stdout) return problem('workspace_submodule_dirty', 'Commit or resolve submodule changes before sealing the parent workspace.')
        }
    }
    private async finalize(workspace: ManagedWorkspace, operation: WorkspaceOperation, request: Finalize) {
        await this.validate(workspace); await this.noGitOperation(workspace)
        if (request.unchangedHead && (await this.head(workspace) !== request.unchangedHead || !await this.clean(workspace))) {
            return problem('workspace_unrecovered_changes', 'This release requires the unchanged starting commit and a clean checkout; code changes were retained.')
        }
        const preparation = workspace.preparations[request.preparationId]
        if (!preparation || preparation.roundId !== request.roundId) return problem('workspace_preparation_mismatch', 'Result does not belong to the prepared round.')
        if (request.sessionId) {
            if (workspace.sessions[request.sessionId]?.preparationId !== request.preparationId) return problem('workspace_preparation_mismatch', 'Result does not belong to the prepared execution.')
        } else if (Object.values(workspace.sessions).some(session => session.preparationId === request.preparationId && !session.rejected)) {
            return problem('workspace_execution_identity_required', 'This preparation has an execution; provide its session identity and stop it before sealing.')
        }
        const existing = workspace.results[request.roundId]
        if (existing) return
        const options = this.gitOptions(workspace, operation)
        let head = await this.head(workspace)
        operation.expectedHead = head; this.save(workspace)
        if ((await git(workspace.checkout, ['merge-base', '--is-ancestor', preparation.startHead, head], { allowFailure: true })).exitCode !== 0) return problem('workspace_history_changed', 'Result no longer descends from the round starting commit.')
        await this.checkGitlinks(workspace, preparation.startHead)
        if (!await this.clean(workspace)) {
            await git(workspace.checkout, ['add', '-A', '--', '.'], options)
            await this.checkGitlinks(workspace, preparation.startHead)
            const staged = await git(workspace.checkout, ['diff', '--cached', '--quiet'], { allowFailure: true })
            if (staged.exitCode === 1) {
                const message = `HAPI workspace checkpoint\n\nHAPI-Round: ${request.roundId}\nHAPI-Finalize: ${request.attemptId}`
                try {
                    await git(workspace.checkout, ['-c', `user.name=${checkpointName}`, '-c', `user.email=${checkpointEmail}`, 'commit', '-m', message],
                        { ...options, env: { GIT_AUTHOR_NAME: checkpointName, GIT_AUTHOR_EMAIL: checkpointEmail, GIT_COMMITTER_NAME: checkpointName, GIT_COMMITTER_EMAIL: checkpointEmail } })
                } catch (error) {
                    if (operation.process || !await this.checkpointMatches(workspace, operation, request)) throw error
                }
                if (!await this.checkpointMatches(workspace, operation, request)) return problem('workspace_checkpoint_unknown', 'Checkpoint cannot be associated with this operation; inspect the retained checkout.')
                head = await this.head(workspace); operation.checkpoint = head
            } else if (staged.exitCode !== 0) return problem('workspace_index_unreadable', 'Unable to inspect the staged result.')
        }
        await this.seal(workspace, operation, preparation, request, head)
    }
    private async checkpointMatches(workspace: ManagedWorkspace, operation: WorkspaceOperation, request: Finalize) {
        if (!operation.expectedHead) return false
        const fields = (await git(workspace.checkout, ['show', '-s', '--format=%P%x00%cn%x00%ce%x00%B', 'HEAD'])).stdout.split('\0')
        return fields[0] === operation.expectedHead && fields[1] === checkpointName && fields[2] === checkpointEmail
            && fields[3]?.split('\n').includes(`HAPI-Round: ${request.roundId}`) && fields[3]?.split('\n').includes(`HAPI-Finalize: ${request.attemptId}`)
    }
    private async seal(workspace: ManagedWorkspace, operation: WorkspaceOperation, preparation: WorkspacePreparation, request: Finalize, head: string) {
        await this.validate(workspace); await this.noGitOperation(workspace)
        await this.checkGitlinks(workspace, preparation.startHead)
        if (await this.head(workspace) !== head) return problem('workspace_head_changed', 'Git HEAD changed during result sealing.')
        if (!await this.clean(workspace)) return problem('workspace_dirty_after_commit', 'Git hooks left uncommitted changes; repair and retry finishing.', workspace.checkout)
        for (const directory of [workspace.checkout, ...await this.submodules(workspace)]) await this.lfs(workspace, this.gitOptions(workspace, operation), false, directory)
        const ref = `refs/hapi/workspaces/${workspace.environmentId}/rounds/${request.roundId}`
        await this.pin(workspace, ref, head, this.gitOptions(workspace, operation))
        const paths = (await git(workspace.checkout, ['diff', '--name-only', '-z', preparation.startHead, head])).stdout.split('\0').filter(Boolean)
        workspace.results[request.roundId] = { environmentId: workspace.environmentId, roundId: request.roundId,
            baseCommit: workspace.source.baseCommit, startHead: preparation.startHead, resultHead: head, resultRef: ref,
            ...(operation.checkpoint ? { checkpoint: operation.checkpoint } : {}), partial: request.partial,
            fileCount: paths.length, paths: paths.slice(0, 100), sealedAt: Date.now() }
    }
    private async remove(workspace: ManagedWorkspace, operation: WorkspaceOperation, request: Remove) {
        const latest = Object.values(workspace.results).sort((a, b) => b.sealedAt - a.sealedAt)[0]
        if (request.expectedHead !== (latest?.resultHead ?? workspace.source.baseCommit)) return problem('workspace_head_mismatch', 'Removal must reference the last sealed result or base.')
        const baseRef = `refs/hapi/workspaces/${workspace.environmentId}/base`
        if (existsSync(workspace.checkout) && await output(workspace.source.repositoryRoot, ['rev-parse', '--verify', baseRef]) !== workspace.source.baseCommit) return problem('workspace_result_missing', 'Retained base reference is missing or changed.')
        for (const result of Object.values(workspace.results)) {
            if (await output(workspace.source.repositoryRoot, ['rev-parse', '--verify', result.resultRef]) !== result.resultHead) return problem('workspace_result_missing', 'A retained result reference is missing or changed.')
        }
        await this.source(workspace)
        if (existsSync(workspace.checkout)) {
            await this.validate(workspace); await this.noGitOperation(workspace)
            if (await this.head(workspace) !== request.expectedHead || !await this.clean(workspace)) return problem('workspace_dirty', 'Retained checkout has unsealed changes; removal was refused.')
            await this.checkGitlinks(workspace, request.expectedHead, true)
            const ignored: string[] = []
            for (const directory of [workspace.checkout, ...await this.submodules(workspace)]) {
                ignored.push(...(await git(directory, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean).map(path => relative(workspace.checkout, join(directory, path))))
            }
            if (ignored.length && !request.discardIgnored) return problem('workspace_ignored_files', `Checkout contains ${ignored.length} ignored paths.`, `Use explicit discardIgnored to remove dependencies and ignored files. ${ignored.slice(0, 10).join(', ')}`)
            // Git requires --force even for clean initialized submodules. All dirty checks precede this command.
            await git(workspace.source.repositoryRoot, ['worktree', 'remove', '--force', workspace.checkout], this.gitOptions(workspace, operation))
        }
        const branch = await git(workspace.source.repositoryRoot, ['rev-parse', '--verify', `refs/heads/${workspace.branch}`], { allowFailure: true })
        if (branch.exitCode === 0) {
            if (branch.stdout.trim() !== request.expectedHead) return problem('workspace_branch_changed', 'Task branch changed; it was not deleted.')
            await git(workspace.source.repositoryRoot, ['update-ref', '-d', `refs/heads/${workspace.branch}`, request.expectedHead], this.gitOptions(workspace, operation))
        }
        await rm(join(this.directory(workspace.environmentId), 'inputs'), { recursive: true, force: true })
        workspace.status = 'removed'
    }
    async inspect(environmentId: string): Promise<ManagedWorkspace> {
        let workspace = this.read(environmentId)
        const unfinished = Object.values(workspace.operations).filter(op => ['accepted', 'running', 'unknown'].includes(op.status))
        for (const operation of unfinished) {
            if (this.jobs.has(`${environmentId}:${operation.id}`) || this.locks.has(workspace.source.commonDir)) continue
            workspace = await this.serial(workspace.source.commonDir, async () => {
                const current = this.read(environmentId), op = current.operations[operation.id]!
                if (op.process && !gitProcessStopped(op.process)) {
                    op.status = 'unknown'; op.error = { code: 'workspace_process_unknown', message: 'Previous Git subprocess group has not been confirmed stopped.' }
                    this.save(current); return current
                }
                op.process = undefined
                try { await this.idle(current) } catch (error) {
                    op.status = 'unknown'; op.error = workspaceProblem(error); this.save(current); return current
                }
                try {
                    if (op.request.action === 'finalize') {
                        if (current.results[op.request.roundId]) op.status = 'succeeded'
                        else if (await this.checkpointMatches(current, op, op.request)) {
                            op.checkpoint = await this.head(current)
                            await this.seal(current, op, current.preparations[op.request.preparationId]!, op.request, op.checkpoint)
                            op.status = 'succeeded'
                        } else if (op.expectedHead && await this.head(current) === op.expectedHead && await this.clean(current)) {
                            await this.seal(current, op, current.preparations[op.request.preparationId]!, op.request, op.expectedHead)
                            op.status = 'succeeded'
                        } else problem('workspace_interrupted', 'Git stopped without a complete checkpoint; inspect/repair the checkout, then explicitly retry finishing.')
                    } else if (op.request.action === 'prepare' && current.preparations[op.request.preparationId]) op.status = 'succeeded'
                    else if (op.request.action === 'remove' && !existsSync(current.checkout)
                        && !existsSync(join(this.directory(environmentId), 'inputs'))
                        && (await git(current.source.repositoryRoot, ['show-ref', '--verify', `refs/heads/${current.branch}`], { allowFailure: true })).exitCode === 1) {
                        current.status = 'removed'; op.status = 'succeeded'
                    } else problem('workspace_interrupted', 'Git stopped without a complete receipt; inspect the retained environment before explicitly retrying with a new attempt identity.')
                    op.error = undefined
                } catch (error) {
                    op.error = workspaceProblem(error)
                    op.status = op.process || op.error.code.includes('unknown') ? 'unknown' : 'failed'
                    if (op.request.action === 'remove' && op.status === 'failed') current.status = 'retained'
                }
                op.updatedAt = Date.now(); this.save(current); return current
            })
        }
        return structuredClone(workspace)
    }
    async validatePrepared(reference: PreparedWorkspace, directory: string) {
        const workspace = this.read(reference.environmentId), preparation = workspace.preparations[reference.preparationId]
        if (workspace.status !== 'retained' || !preparation || Object.values(workspace.operations).some(op => ['accepted', 'running', 'unknown'].includes(op.status))) return problem('workspace_not_prepared', 'Workspace has no available preparation receipt.')
        if (workspace.results[preparation.roundId]) return problem('workspace_preparation_expired', 'This preparation belongs to an already sealed round.')
        await this.validate(workspace)
        if (realpathSync(directory) !== preparation.cwd || await this.head(workspace) !== preparation.startHead || !await this.clean(workspace)) return problem('workspace_preparation_stale', 'Prepared cwd or Git state changed before launch.')
        if (workspace.source.snapshot) await this.options.snapshots!.hydrate(workspace.source, workspace.checkout, this.gitOptions(), true)
        for (const input of preparation.inputs) {
            const bytes = await fileDigest(input.path)
            if (bytes.size !== input.size || bytes.sha256 !== input.sha256) return problem('workspace_input_mismatch', 'Prepared input changed before launch.', input.name)
        }
        return { workspace, preparation }
    }
    async launch<T extends { type: string; sessionId?: string; childStarted?: boolean }>(reference: PreparedWorkspace, directory: string, sessionId: string, start: () => Promise<T>): Promise<T> {
        const initial = this.read(reference.environmentId)
        return this.serial(initial.source.commonDir, async () => {
            this.launching.add(reference.environmentId)
            try {
                const { workspace, preparation } = await this.validatePrepared(reference, directory)
                await this.idle(workspace)
                workspace.sessions[sessionId] = { preparationId: reference.preparationId, attemptedAt: Date.now() }
                preparation.sessionId = sessionId; this.save(workspace)
                const result = await start()
                if (result.type === 'error' && result.childStarted === false) workspace.sessions[sessionId]!.rejected = true
                if (result.type === 'success' && result.sessionId && result.sessionId !== sessionId) workspace.sessions[result.sessionId] = workspace.sessions[sessionId]!
                this.save(workspace)
                return result
            } finally { this.launching.delete(reference.environmentId) }
        })
    }
    async contains(directory: string) {
        const path = await this.options.pathPolicy.resolveForCheck(directory)
        return inside(join(this.root, 'environments'), path)
    }
    async settled() { await Promise.all(this.jobs.values()) }
    async stop() { this.shutdown.abort(); await this.settled() }
}
