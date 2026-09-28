import { z } from 'zod'

/** Observations carried by the existing session message stream, not a scheduler state machine. */
export const ExecutionObservationSchema = z.object({
    type: z.literal('execution'),
    version: z.literal(1),
    runtime: z.enum(['codex', 'claude']),
    executionId: z.string().min(1),
    inputLocalIds: z.array(z.string().min(1)).min(1),
    phase: z.enum(['submitted', 'accepted', 'completed', 'failed', 'interrupted', 'unknown']),
    source: z.enum(['native', 'control', 'transport']),
    nativeSessionId: z.string().optional(),
    nativeTurnId: z.string().optional(),
    nativeResult: z.record(z.string(), z.unknown()).optional()
})
export type ExecutionObservation = z.infer<typeof ExecutionObservationSchema>

export const InterruptExecutionRequestSchema = z.object({
    inputLocalId: z.string().min(1),
    executionId: z.string().min(1)
})
export type InterruptExecutionRequest = z.infer<typeof InterruptExecutionRequestSchema>

export const InterruptExecutionResponseSchema = z.object({
    status: z.enum(['requested', 'not_running', 'target_mismatch']),
    executionId: z.string(),
    inputLocalIds: z.array(z.string())
})
export type InterruptExecutionResponse = z.infer<typeof InterruptExecutionResponseSchema>

export function codexExecutionId(threadId: string, turnId: string): string {
    return `codex:${threadId}:${turnId}`
}
