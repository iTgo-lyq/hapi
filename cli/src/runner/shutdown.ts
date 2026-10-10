export const RUNNER_SHUTDOWN_TIMEOUT_MS = 8_000
export const RUNNER_STOP_WAIT_MS = 10_000
export const RUNNER_SHUTDOWN_NOTICE_MS = 500

type ShutdownSource = 'hapi-app' | 'hapi-cli' | 'os-signal' | 'exception'
type ShutdownRequest = { source: ShutdownSource; errorMessage?: string }

/** Resources are registered as startup acquires them; detached sessions are not owned here. */
export type RunnerCleanup = {
    stopAccepting?: () => void
    stopHeartbeat?: () => void
    notify?: (request: ShutdownRequest) => Promise<void>
    disconnect?: () => void
    stopRepositories?: () => Promise<void>
    stopWorkspaces?: () => Promise<void>
    stopArtifacts?: () => Promise<void>
    stopControlServer?: () => Promise<void>
    clearState?: () => Promise<void>
    releaseLock?: () => Promise<void>
}

export function createRunnerShutdown(resources: RunnerCleanup, log: (message: string) => void,
    exit: (code: number) => void = code => process.exit(code)) {
    let request: ShutdownRequest | undefined
    let failed = false, timedOut = false
    let finishPromise: Promise<void> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let phase = 'startup'
    const pending = new Set<string>()
    let resolve!: (request: ShutdownRequest) => void
    const wait = new Promise<ShutdownRequest>(done => { resolve = done })

    const failure = (name: string, error: unknown) => {
        failed = true
        const code = error instanceof Error && 'code' in error ? ` (${String(error.code)})` : ''
        log(`[RUNNER RUN] Cleanup failed at ${name}${code}`)
    }
    const step = async (name: string, action?: () => void | Promise<void>) => {
        if (!action) return
        phase = name; pending.add(name)
        try { await action() } catch (error) { failure(name, error) }
        finally { pending.delete(name) }
    }
    return {
        get stopping() { return request !== undefined },
        wait,
        throwIfStopping() { if (request) throw new Error('Runner is shutting down') },
        request(source: ShutdownSource, errorMessage?: string) {
            failed ||= source === 'exception'
            if (request) return
            request = { source, errorMessage }
            log(`[RUNNER RUN] Requesting shutdown (source: ${source})`)
            timer = setTimeout(() => {
                timedOut = true
                log(`[RUNNER RUN] Shutdown timed out at ${[...pending].join(', ') || phase}; forcing exit with code 1`)
                exit(1)
            }, RUNNER_SHUTDOWN_TIMEOUT_MS)
            // These synchronous gates run before another RPC or heartbeat can begin.
            for (const [name, action] of [['stop accepting', resources.stopAccepting], ['heartbeat', resources.stopHeartbeat]] as const) {
                try { action?.() } catch (error) { failure(name, error) }
            }
            resolve(request)
        },
        finish(): Promise<void> {
            if (finishPromise) return finishPromise
            if (!request) throw new Error('Shutdown has not been requested')
            finishPromise = (async () => {
                log(`[RUNNER RUN] Starting proper cleanup (source: ${request!.source})`)
                phase = 'shutdown notice'
                try { await resources.notify?.(request!) }
                catch { log('[RUNNER RUN] Shutdown notice unavailable; continuing local cleanup') }
                await step('machine connection', resources.disconnect)
                // Abort all three before waiting: their operations can share repository locks.
                await Promise.all([
                    step('repositories', resources.stopRepositories),
                    step('workspaces', resources.stopWorkspaces),
                    step('artifacts', resources.stopArtifacts),
                ])
                await step('control server', resources.stopControlServer)
                await step('state file', resources.clearState)
                await step('runner lock', resources.releaseLock)
                if (timedOut) return
                const code = failed ? 1 : 0
                log(`[RUNNER RUN] ${failed ? 'Cleanup finished with errors' : 'Cleanup completed'}, exiting process (code ${code})`)
                phase = 'log flush'
                await new Promise(done => setTimeout(done, 100))
                if (timedOut) return
                clearTimeout(timer)
                exit(code)
            })()
            return finishPromise
        },
    }
}
