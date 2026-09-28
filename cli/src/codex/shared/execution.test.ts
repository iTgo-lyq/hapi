import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import { SharedCodexProjection } from './projection';

describe('Codex execution facts', () => {
    it.each(['completed', 'failed', 'interrupted', 'unrecognized'])('retains %s for the native turn and replays stable event IDs', async status => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendSessionEvent: send, sendAgentMessage() {},
            sendUserMessage() {}, updateMetadata() {} } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        const items = ['first', 'steered'].map(id => ({ id, type: 'userMessage', clientUserMessageId: id, content: [] }));
        const turn = { id: 'turn', status, error: status === 'failed' ? { message: 'native failure' } : null, items };
        for (const item of items) await projection.notification('item/started', { threadId: 'thread', turnId: 'turn', item });
        await projection.notification('turn/completed', { threadId: 'thread', turn });
        const original = send.mock.calls;
        expect(original.at(-1)?.[0]).toMatchObject({ phase: status === 'unrecognized' ? 'unknown' : status,
            executionId: 'codex:thread:turn', inputLocalIds: ['first', 'steered'], nativeResult: { status, error: turn.error } });
        projection.reset(); send.mockClear();
        await projection.history({ turns: [turn] });
        expect(send.mock.calls).toEqual(original);
        const child = new SharedCodexProjection(session, 'child', async () => {}, 'thread');
        send.mockClear(); await child.history({ turns: [turn] });
        expect(send).not.toHaveBeenCalled();
    });
});
