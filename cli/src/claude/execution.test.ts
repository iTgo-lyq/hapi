import { describe, expect, it, vi } from 'vitest';
import { ClaudeExecution } from './execution';

describe('Claude native execution correlation', () => {
    it('ignores autonomous and sidechain results and retains the matching native failure', () => {
        const send = vi.fn();
        const execution = new ClaudeExecution(send);
        const id = execution.begin(['one', 'two']);
        execution.observe({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: 'autonomous' });
        execution.observe({ type: 'result', subtype: 'success', is_error: false, user_message_uuid: id, parent_tool_use_id: 'child' });
        expect(send).toHaveBeenCalledTimes(1);
        execution.observe({ type: 'command_lifecycle', command_uuid: id, state: 'started', session_id: 'native' });
        execution.observe({ type: 'result', uuid: 'result-id', subtype: 'error_max_turns', is_error: true,
            user_message_uuids: [id], errors: ['maximum turns reached'], result: 'partial' });
        expect(send.mock.calls.map(([e]) => e.phase)).toEqual(['submitted', 'accepted', 'failed']);
        expect(send.mock.lastCall?.[0]).toMatchObject({ inputLocalIds: ['one', 'two'], nativeSessionId: 'native',
            nativeResult: { uuid: 'result-id', subtype: 'error_max_turns', is_error: true, errors: ['maximum turns reached'], result: 'partial' } });
        expect(execution.current).toBeNull();
    });

    it('retains native API failures even when the result subtype is success', () => {
        const send = vi.fn(); const execution = new ClaudeExecution(send);
        const id = execution.begin(['input']);
        execution.observe({ type: 'result', subtype: 'success', is_error: true,
            user_message_uuid: id, terminal_reason: 'api_error', result: 'native API failure' });
        expect(send.mock.lastCall?.[0]).toMatchObject({ phase: 'failed', source: 'native',
            nativeResult: { subtype: 'success', is_error: true, terminal_reason: 'api_error' } });
        expect(execution.current).toBeNull();
    });

    it('does not infer success from output, init, missing correlation or an unfamiliar result subtype', () => {
        const send = vi.fn(); const execution = new ClaudeExecution(send);
        const id = execution.begin(['input']);
        execution.observe({ type: 'system', subtype: 'init', session_id: 'native' });
        execution.observe({ type: 'assistant', user_message_uuid: id });
        execution.observe({ type: 'result', subtype: 'success', is_error: false });
        expect(execution.current?.id).toBe(id);
        expect(send.mock.calls.map(([e]) => e.phase)).toEqual(['submitted', 'accepted', 'unknown']);
        execution.observe({ type: 'result', subtype: 'future_status', is_error: false, user_message_uuid: id });
        expect(send.mock.calls.some(([e]) => e.phase === 'completed')).toBe(false);
        expect(send.mock.lastCall?.[0]).toMatchObject({ phase: 'unknown',
            nativeResult: { subtype: 'future_status', is_error: false, user_message_uuid: id } });
        expect(execution.current).toBeNull();
    });
});
