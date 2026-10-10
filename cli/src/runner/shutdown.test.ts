import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRunnerShutdown, type RunnerCleanup } from './shutdown'

describe('runner shutdown', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    function fixture(overrides: RunnerCleanup = {}) {
        const events: string[] = [], log = vi.fn(), exit = vi.fn()
        const action = (name: string) => async () => { events.push(name) }
        const resources: RunnerCleanup = {
            stopAccepting: () => { events.push('gate') }, stopHeartbeat: () => { events.push('heartbeat') },
            notify: action('notice'), disconnect: () => { events.push('disconnect') },
            stopRepositories: action('repositories'), stopWorkspaces: action('workspaces'), stopArtifacts: action('artifacts'),
            stopControlServer: action('control'), clearState: action('state'), releaseLock: action('lock'), ...overrides,
        }
        return { events, log, exit, shutdown: createRunnerShutdown(resources, log, exit) }
    }

    it('gates synchronously and finishes once for repeated requests', async () => {
        const { shutdown, events, exit } = fixture()
        shutdown.request('os-signal'); shutdown.request('hapi-cli')
        expect(events).toEqual(['gate', 'heartbeat'])
        expect(shutdown.stopping).toBe(true)
        expect(() => shutdown.throwIfStopping()).toThrow('Runner is shutting down')
        expect(await shutdown.wait).toMatchObject({ source: 'os-signal' })
        const first = shutdown.finish()
        expect(shutdown.finish()).toBe(first)
        await vi.advanceTimersByTimeAsync(100); await first
        expect(events).toEqual(['gate', 'heartbeat', 'notice', 'disconnect', 'repositories', 'workspaces', 'artifacts', 'control', 'state', 'lock'])
        expect(exit).toHaveBeenCalledExactlyOnceWith(0)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('a failed remote notice still permits successful local cleanup', async () => {
        const { shutdown, events, exit, log } = fixture({ notify: async () => { throw new Error('ack timeout') } })
        shutdown.request('hapi-cli'); const done = shutdown.finish()
        await vi.advanceTimersByTimeAsync(100); await done
        expect(events).toContain('lock')
        expect(log).toHaveBeenCalledWith(expect.stringContaining('continuing local cleanup'))
        expect(exit).toHaveBeenCalledExactlyOnceWith(0)
    })

    it('aborts all managers together and releases later resources after a manager failure', async () => {
        let resolveRepository!: () => void
        const repository = new Promise<void>(resolve => { resolveRepository = resolve })
        const { shutdown, events, exit } = fixture({
            stopRepositories: () => repository,
            stopWorkspaces: async () => { throw new Error('disk failure') },
            stopArtifacts: async () => { resolveRepository() },
        })
        shutdown.request('hapi-app'); const done = shutdown.finish()
        await vi.advanceTimersByTimeAsync(100); await done
        expect(events).toEqual(['gate', 'heartbeat', 'notice', 'disconnect', 'control', 'state', 'lock'])
        expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    })

    it('keeps cleaning after control and state errors', async () => {
        const { shutdown, events, exit } = fixture({ stopControlServer: async () => { throw new Error() }, clearState: async () => { throw new Error() } })
        shutdown.request('os-signal'); const done = shutdown.finish()
        await vi.advanceTimersByTimeAsync(100); await done
        expect(events.at(-1)).toBe('lock')
        expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    })

    it('startup exceptions clean only acquired resources and exit 1', async () => {
        const lock = vi.fn(async () => {}), exit = vi.fn()
        const shutdown = createRunnerShutdown({ releaseLock: lock }, vi.fn(), exit)
        shutdown.request('exception', 'registration failed'); const done = shutdown.finish()
        await vi.advanceTimersByTimeAsync(100); await done
        expect(lock).toHaveBeenCalledOnce()
        expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    })

    it('reports the stuck stage at the overall deadline and never exits 0 afterward', async () => {
        let finishManager!: () => void
        const { shutdown, exit, log } = fixture({ stopArtifacts: () => new Promise(resolve => { finishManager = resolve }) })
        shutdown.request('os-signal'); const done = shutdown.finish()
        await vi.advanceTimersByTimeAsync(7999)
        expect(exit).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(exit).toHaveBeenCalledExactlyOnceWith(1)
        expect(log).toHaveBeenCalledWith(expect.stringContaining('timed out at artifacts'))
        finishManager(); await done
        expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    })
})
