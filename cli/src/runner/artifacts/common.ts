import type { ArtifactProblem } from '@hapi/protocol'

export class TransferError extends Error {
    constructor(readonly code: string, message: string, readonly hint?: string) { super(message) }
}
export const transferProblem = (error: unknown): ArtifactProblem => error instanceof TransferError
    ? { code: error.code, message: error.message, hint: error.hint }
    : { code: 'artifact_transfer_failed', message: error instanceof Error ? error.message : String(error) }
export const fail = (code: string, message: string): never => { throw new TransferError(code, message) }
