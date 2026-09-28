import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@/claude/sdk/types'

const spawnMock = vi.fn()
const killProcessMock = vi.fn(async (child: any) => {
    child.killed = true
    child.stdout.end()
    child.emit('close', 0)
    return true
})

vi.mock('node:child_process', () => ({
    ...require('node:child_process'),
    spawn: spawnMock
}))

vi.mock('@/claude/utils/claudeCheckSession', () => ({
    claudeCheckSession: () => true
}))

vi.mock('@/modules/watcher/awaitFileExist', () => ({
    awaitFileExist: async () => true
}))

vi.mock('@/utils/process', () => ({
    isProcessAlive: () => false,
    isWindows: () => false,
    killProcess: async () => true,
    killProcessByChildProcess: killProcessMock
}))

vi.mock('@/utils/bunRuntime', () => ({
    withBunRuntimeEnv: (env: NodeJS.ProcessEnv) => env
}))

function createFakeChild() {
    const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough
        stdout: PassThrough
        stderr: PassThrough
        killed: boolean
    }

    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    return child
}

afterEach(() => {
    vi.clearAllMocks()
    delete process.env.HAPI_CLAUDE_PATH
})

describe('claudeRemote/query real seam', () => {
    it('closes the native process before reporting a tool-controlled stop', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'
        const { claudeRemote } = await import('./claudeRemote')
        const running = claudeRemote({ sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/tmp/hook.json',
            canCallTool: async () => ({ behavior: 'deny', message: 'denied' }),
            nextMessage: async () => ({ message: 'task', uuid: 'input', mode: { permissionMode: 'default' } }),
            onReady: () => {}, isAborted: id => id === 'denied-tool', onSessionFound: () => {}, onMessage: () => {} })
        child.stdout.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'denied-tool', content: 'denied', is_error: true }
        ] } }) + '\n')
        expect(await running).toBe('controlled-stop')
        expect(child.killed).toBe(true)
        expect(killProcessMock).toHaveBeenCalledWith(child)
    })

    it('passes batch UUIDs to stdin and ignores autonomous or stale results when advancing the input queue', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'
        const { claudeRemote } = await import('./claudeRemote')
        const sent: any[] = []
        child.stdin.on('data', data => { for (const line of String(data).trim().split('\n')) sent.push(JSON.parse(line)) })
        const nextMessage = vi.fn().mockResolvedValueOnce({ message: 'A', uuid: 'input-a', mode: { permissionMode: 'default' } })
            .mockResolvedValueOnce({ message: 'B', uuid: 'input-b', mode: { permissionMode: 'default' } })
            .mockResolvedValue(null)
        const onReady = vi.fn()
        const running = claudeRemote({ sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/tmp/hook.json',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }), nextMessage, onReady,
            isAborted: () => false, onSessionFound: () => {}, onMessage: () => {} })
        const result = (id: string) => child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: id }) + '\n')
        await vi.waitFor(() => expect(sent[0]?.uuid).toBe('input-a'))
        result('autonomous')
        await new Promise(resolve => setTimeout(resolve, 10))
        expect(onReady).not.toHaveBeenCalled()
        expect(nextMessage).toHaveBeenCalledTimes(1)
        result('input-a')
        await vi.waitFor(() => expect(sent[1]?.uuid).toBe('input-b'))
        result('input-a')
        await new Promise(resolve => setTimeout(resolve, 10))
        expect(onReady).toHaveBeenCalledTimes(1)
        expect(nextMessage).toHaveBeenCalledTimes(2)
        result('input-b')
        await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(2))
        child.stdout.end(); child.emit('close', 0)
        await running
    })

    it('propagates scheduled nextMessage failures through real query prompt plumbing', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'
        const { claudeRemote } = await import('./claudeRemote')

        const received: SDKMessage[] = []
        let nextCallCount = 0

        const runPromise = claudeRemote({
            sessionId: 'session-1',
            path: process.cwd(),
            mcpServers: {},
            claudeEnvVars: {},
            claudeArgs: [],
            allowedTools: [],
            hookSettingsPath: '/tmp/hook.json',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            nextMessage: async () => {
                nextCallCount += 1
                if (nextCallCount === 1) {
                    return { message: 'A', mode: { permissionMode: 'default' } }
                }
                throw new Error('next message failed')
            },
            onReady: () => {},
            isAborted: () => false,
            onSessionFound: () => {},
            onMessage: (message) => {
                received.push(message)
            },
            onCompletionEvent: () => {},
            onSessionReset: () => {}
        })

        child.stdout.write(JSON.stringify({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'A_1' }]
            }
        }) + '\n')
        child.stdout.write(JSON.stringify({
            type: 'result',
            subtype: 'success',
            num_turns: 1,
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            session_id: 's-1'
        }) + '\n')

        await expect(runPromise).rejects.toThrow('next message failed')
        expect(received.map((message) => message.type)).toEqual(['assistant', 'result'])
    }, 15_000)
})
