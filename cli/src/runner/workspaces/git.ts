import { spawn, execFileSync } from 'node:child_process'
import { getProcessStartMarker, isProcessAlive, killProcessByChildProcess } from '@/utils/process'
import type { WorkspaceOperation, WorkspaceProblem } from '@hapi/protocol'

export class WorkspaceError extends Error {
    constructor(readonly code: string, message: string, readonly hint?: string) { super(message) }
    toProblem(): WorkspaceProblem { return { code: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}) } }
}
export function workspaceProblem(error: unknown): WorkspaceProblem {
    return error instanceof WorkspaceError ? error.toProblem() : { code: 'workspace_failed', message: error instanceof Error ? error.message : String(error) }
}
export function gitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env = { ...process.env }
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
        'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE']) delete env[key]
    return { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', ...extra }
}
/** Git owns a separate POSIX process group: a dead root alone does not prove its hook stopped. */
export function gitProcessStopped(record: NonNullable<WorkspaceOperation['process']>): boolean {
    if (process.platform === 'win32') return !isProcessAlive(record.pid)
    try { process.kill(-record.pid, 0) }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
    try {
        const rows = execFileSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 2000 }).trim().split('\n')
        // Reaped processes and zombies cannot write the checkout. Never signal unrelated groups.
        return !rows.some(row => { const [group, state] = row.trim().split(/\s+/); return Number(group) === record.pid && !state?.startsWith('Z') })
    } catch { return false }
}
export type GitOptions = { config?: readonly string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number; allowFailure?: boolean; signal?: AbortSignal;
    process?: (process: WorkspaceOperation['process']) => void }
export async function git(cwd: string, args: string[], options: GitOptions = {}) {
    if (options.signal?.aborted) throw new WorkspaceError('git_interrupted', 'Runner stopped before executing Git.')
    const child = spawn('git', [...(options.config ?? []).flatMap(value => ['-c', value]), ...args], { cwd, env: gitEnvironment(options.env), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    const exited = new Promise<{ exitCode: number; error?: Error }>(resolve => {
        child.once('error', error => resolve({ exitCode: -1, error }))
        child.once('close', code => resolve({ exitCode: code ?? -1 }))
    })
    let stdout = '', stderr = '', reason: 'git_timeout' | 'git_output_limit' | 'git_interrupted' | undefined
    let stopping: Promise<boolean> | undefined
    const record = child.pid ? { pid: child.pid, marker: getProcessStartMarker(child.pid) } : undefined
    const stop = async () => {
        if (!record || gitProcessStopped(record)) return true
        if (isProcessAlive(record.pid) && (!record.marker || getProcessStartMarker(record.pid) !== record.marker)) return false
        if (process.platform === 'win32') {
            return Promise.race([killProcessByChildProcess(child, true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2500))])
        }
        try { process.kill(-record.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false }
        const deadline = Date.now() + 2500
        while (!gitProcessStopped(record) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
        return gitProcessStopped(record)
    }
    let interrupt!: () => void
    const interrupted = new Promise<{ exitCode: number }>(resolve => { interrupt = () => resolve({ exitCode: -1 }) })
    const abort = (cause: typeof reason) => { if (!reason) { reason = cause; stopping = stop(); interrupt() } }
    const onAbort = () => abort('git_interrupted')
    const limit = 16 * 1024 * 1024
    child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > limit) { stdout = stdout.slice(0, limit); abort('git_output_limit') } })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000) })
    const timer = setTimeout(() => abort('git_timeout'), options.timeoutMs ?? 15 * 60_000)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
        try { if (record) options.process?.(record) } catch (error) { await stop(); throw error }
        if (options.signal?.aborted) onAbort()
        const result = await Promise.race([exited, interrupted])
        if (stopping && !await stopping || record && !gitProcessStopped(record)) {
            // Retain ownership on disk; inspection must prove the subprocess group stopped.
            child.unref(); child.stdout.destroy(); child.stderr.destroy()
            throw new WorkspaceError('workspace_process_unknown', 'Git subprocess termination is not confirmed.')
        }
        options.process?.(undefined)
        if (reason) throw new WorkspaceError(reason, reason === 'git_timeout' ? 'Git operation exceeded its time limit.'
            : reason === 'git_output_limit' ? 'Git output exceeded 16 MiB.' : 'Git operation was interrupted by Runner shutdown.',
            'Inspect the retained checkout, complete hooks/signing manually if needed, then explicitly retry the workspace operation.')
        if ('error' in result && result.error) throw new WorkspaceError('git_unavailable', 'Unable to execute Git.', result.error.message)
        if (result.exitCode !== 0 && !options.allowFailure) {
            const hint = stderr.trim().replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@').slice(-2000)
            throw new WorkspaceError('git_failed', `Git ${args.find(arg => !arg.startsWith('-')) ?? 'command'} failed (${result.exitCode}).`, hint || undefined)
        }
        return { stdout, stderr, exitCode: result.exitCode }
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort) }
}
export const output = async (cwd: string, args: string[], options?: GitOptions) => (await git(cwd, args, options)).stdout.trim()
