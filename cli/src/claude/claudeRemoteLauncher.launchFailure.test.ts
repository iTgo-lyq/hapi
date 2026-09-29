import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { Session } from './session';
import type { EnhancedMode } from './loop';

// claudeRemote() wraps the actual Claude Agent SDK subprocess spawn (the
// external-process boundary for this launcher) -- mock it the same way
// cursorLegacyRemoteLauncher.test.ts mocks `spawn`, rather than mocking any
// internal collaborator.
const claudeRemoteMock = vi.fn();

vi.mock('./claudeRemote', () => ({
    claudeRemote: (opts: unknown) => claudeRemoteMock(opts)
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

type RpcHandler = (params: unknown) => Promise<unknown> | unknown;

function makeClient() {
    const handlers = new Map<string, RpcHandler>();
    let agentState: Record<string, unknown> = {};
    return {
        handlers,
        rpcHandlerManager: {
            registerHandler: vi.fn((method: string, handler: RpcHandler) => {
                handlers.set(method, handler);
            })
        },
        updateMetadata: vi.fn(),
        updateAgentState: vi.fn((handler: (state: any) => any) => {
            agentState = handler(agentState);
        }),
        sendSessionEvent: vi.fn(),
        sendClaudeSessionMessage: vi.fn(),
        notePendingHubPromptEcho: vi.fn(),
        discardPendingHubPromptEcho: vi.fn(),
        discardPendingHubPromptEchoText: vi.fn(),
        sendAgentMessage: vi.fn(),
        getMetadata: () => ({ disabledMcpServers: ['runweft'] }),
        keepAlive: vi.fn(),
        emitMessagesConsumed: vi.fn()
    };
}

function makeSession(queue: MessageQueue2<EnhancedMode>, client: ReturnType<typeof makeClient>): Session {
    return new Session({
        api: {} as never,
        client: client as never,
        path: '/tmp/project',
        logPath: '/tmp/log',
        sessionId: null,
        mcpServers: {},
        messageQueue: queue,
        onModeChange: vi.fn(),
        mode: 'remote',
        startedBy: 'runner',
        startingMode: 'remote',
        hookSettingsPath: '/tmp/hooks.json'
    });
}

// Fires the RPC handler registered for `switch` (mirrors a UI-triggered
// switch-to-local request). ClaudeRemoteLauncher.requestExit() sets
// `exitReason` synchronously before awaiting the abort, so calling this
// without awaiting it lets a test deterministically terminate the launcher's
// respawn loop from inside a claudeRemote() mock implementation.
function triggerSwitch(client: ReturnType<typeof makeClient>): void {
    const handler = client.handlers.get(RPC_METHODS.Switch);
    void handler?.(undefined);
}

describe('claudeRemoteLauncher launch-failure recovery', () => {
    beforeEach(() => {
        claudeRemoteMock.mockReset();
        process.stdin.isTTY = false;
        process.stdout.isTTY = false;
        process.env.CLAUDE_REMOTE_RESPAWN_BACKOFF_MS = '0';
    });

    afterEach(() => {
        delete process.env.CLAUDE_REMOTE_RESPAWN_BACKOFF_MS;
    });

    it('sends the result carrier before compact completion and ready', async () => {
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
        queue.push('/compact', { permissionMode: 'default' });

        const client = makeClient();
        const session = makeSession(queue, client);
        const wireOrder: string[] = [];

        client.sendClaudeSessionMessage.mockImplementation((logMessage: any) => {
            if (logMessage.type === 'system' && logMessage.subtype === 'turn_duration') {
                wireOrder.push('result');
            }
        });
        client.sendSessionEvent.mockImplementation((event: any) => {
            if (event?.type === 'message' && event.message === 'Compaction completed') {
                wireOrder.push('completion');
            }
            if (event?.type === 'ready') {
                wireOrder.push('ready');
            }
        });

        claudeRemoteMock.mockImplementation(async (opts: any) => {
            const input = await opts.nextMessage();
            expect(input?.message).toBe('/compact');
            opts.onMessage({
                type: 'result',
                subtype: 'success',
                num_turns: 1,
                total_cost_usd: 0,
                duration_ms: 1,
                duration_api_ms: 1,
                is_error: false,
                session_id: 's-1'
            });
            await opts.onReady('Compaction completed');
            triggerSwitch(client);
        });

        const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
        await claudeRemoteLauncher(session);

        expect(wireOrder).toEqual(['result', 'completion', 'ready']);
    });

    it.each([false, true])('does not replay a consumed batch after an ambiguous exit (partial reply: %s)', async partial => {
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
        queue.push('first', { permissionMode: 'default' }, 'input-1');
        queue.push('second', { permissionMode: 'default' }, 'input-2');
        const client = makeClient();
        const session = makeSession(queue, client);
        let calls = 0;
        claudeRemoteMock.mockImplementation(async (opts: any) => {
            if (++calls === 1) {
                const input = await opts.nextMessage();
                if (partial) opts.onMessage({ type: 'assistant', user_message_uuid: input.uuid,
                    message: { role: 'assistant', content: [{ type: 'text', text: 'Partial output' }] } });
                throw new Error('Process died after stdin may have been written');
            }
            expect(session.queue.size()).toBe(0);
            triggerSwitch(client);
        });
        const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
        await claudeRemoteLauncher(session);
        expect(calls).toBe(2); // Second wrapper loop waits for NEW input; old batch is absent.
        const events = client.sendSessionEvent.mock.calls.map(([event]) => event).filter(e => e.type === 'execution');
        expect(events.filter(e => e.phase === 'submitted')).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({ phase: 'unknown', inputLocalIds: ['input-1', 'input-2'] });
        expect(client.discardPendingHubPromptEcho).toHaveBeenCalledWith('input-1');
    });

    it('targets the current batch, rejects a stale UUID, and records controlled interruption', async () => {
        const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
        queue.push('slow', { permissionMode: 'default' }, 'input-1');
        const client = makeClient();
        const session = makeSession(queue, client);
        let requested: Promise<unknown> | undefined;
        let calls = 0;
        claudeRemoteMock.mockImplementation(async (opts: any) => {
            if (++calls > 1) { triggerSwitch(client); return; }
            const input = await opts.nextMessage();
            const interrupt = client.handlers.get(RPC_METHODS.InterruptExecution)!;
            expect(await interrupt({ inputLocalId: 'input-1', executionId: 'stale' })).toMatchObject({ status: 'target_mismatch' });
            expect(opts.signal.aborted).toBe(false);
            requested = Promise.resolve(interrupt({ inputLocalId: 'input-1', executionId: input.uuid }));
            expect(opts.signal.aborted).toBe(true);
        });
        const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
        await claudeRemoteLauncher(session);
        expect(await requested).toMatchObject({ status: 'requested', inputLocalIds: ['input-1'] });
        expect(client.sendSessionEvent.mock.calls.some(([event]) => event.type === 'execution' && event.phase === 'interrupted')).toBe(true);
        expect(client.sendSessionEvent.mock.calls.some(([event]) => event.type === 'execution' && event.phase === 'unknown')).toBe(false);
        expect(await client.handlers.get(RPC_METHODS.InterruptExecution)!({ inputLocalId: 'input-1', executionId: 'late' })).toMatchObject({ status: 'not_running' });
    });
});
