import { randomUUID } from 'node:crypto';
import type { ExecutionObservation } from '@hapi/protocol';
import type { SDKMessage } from './sdk/types';

export function nativeInputIds(message: SDKMessage): string[] {
    if (message.parent_tool_use_id) return [];
    const values = [message.user_message_uuid,
        ...(Array.isArray(message.user_message_uuids) ? message.user_message_uuids : [])];
    if (message.type === 'command_lifecycle') values.push(message.command_uuid);
    return [...new Set(values.filter((value): value is string => typeof value === 'string'))];
}

/** Correlates one native stdin batch, without interpreting output text or idle time. */
export class ClaudeExecution {
    current: { id: string; inputLocalIds: string[]; nativeSessionId?: string } | null = null;
    private emitted = new Set<string>();

    constructor(private readonly send: (event: ExecutionObservation, id: string) => void) {}

    begin(inputLocalIds: string[], nativeSessionId?: string): string {
        if (this.current) this.end('unknown', 'transport', { reason: 'input_replaced_without_native_result' });
        this.current = { id: randomUUID(), inputLocalIds, nativeSessionId };
        this.emitted.clear();
        this.emit('submitted', 'transport');
        return this.current.id;
    }

    private emit(phase: ExecutionObservation['phase'], source: ExecutionObservation['source'], nativeResult?: Record<string, unknown>): void {
        const current = this.current;
        const key = phase === 'unknown' ? `${phase}:${source}:${nativeResult?.uuid ?? nativeResult?.reason ?? 'result'}` : phase;
        if (!current || !current.inputLocalIds.length || this.emitted.has(key)) return;
        this.emitted.add(key);
        this.send({ type: 'execution', version: 1, runtime: 'claude', executionId: current.id,
            inputLocalIds: current.inputLocalIds, phase, source, nativeSessionId: current.nativeSessionId,
            ...(nativeResult ? { nativeResult } : {})
        }, `claude:execution:${current.id}:${key}`);
    }

    observe(message: SDKMessage): void {
        if (!this.current || message.parent_tool_use_id) return;
        if (typeof message.session_id === 'string') this.current.nativeSessionId = message.session_id;
        const ids = nativeInputIds(message);
        if (!ids.includes(this.current.id)) {
            if (message.type === 'result' && ids.length === 0) {
                this.emit('unknown', 'native', { reason: 'native_input_correlation_missing', subtype: message.subtype });
            }
            return;
        }
        if (message.type === 'assistant' || message.type === 'result'
            || (message.type === 'command_lifecycle' && message.state === 'started')) this.emit('accepted', 'native');
        if (message.type !== 'result') return;
        const knownSubtype = ['success', 'error_max_turns', 'error_during_execution'].includes(String(message.subtype));
        const phase = message.subtype === 'success' && message.is_error === false ? 'completed'
            : knownSubtype && message.is_error === true ? 'failed' : 'unknown';
        this.end(phase, 'native', Object.fromEntries([
            'uuid', 'subtype', 'is_error', 'result', 'errors', 'num_turns', 'duration_ms',
            'terminal_reason', 'stop_reason', 'user_message_uuid', 'user_message_uuids'
        ].filter(key => message[key] !== undefined).map(key => [key, message[key]])));
    }

    end(phase: ExecutionObservation['phase'], source: ExecutionObservation['source'], result?: Record<string, unknown>): void {
        this.emit(phase, source, result);
        this.current = null;
    }
}
