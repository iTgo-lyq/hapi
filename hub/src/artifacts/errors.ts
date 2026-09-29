import type { ArtifactProblem } from '@hapi/protocol'

export class ArtifactError extends Error {
    constructor(readonly status: 400 | 404 | 409 | 410 | 413 | 422 | 500 | 503,
        readonly code: string, message: string, readonly hint?: string) { super(message) }
}
export function artifactProblem(error: unknown): ArtifactProblem {
    return error instanceof ArtifactError ? { code: error.code, message: error.message, hint: error.hint }
        : { code: 'artifact_io_failed', message: 'File storage operation failed.', hint: 'Check available disk space and the Hub data directory permissions; retry the same request ID.' }
}
