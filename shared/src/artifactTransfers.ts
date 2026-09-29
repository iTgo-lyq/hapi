import { z } from 'zod'
import { ArtifactNameSchema, type ArtifactProblem } from './artifacts'

export const PreparedFilesSchema = z.strictObject({ operationId: z.string().uuid() })
export type PreparedFiles = z.infer<typeof PreparedFilesSchema>
export const MaterializedInputSchema = z.strictObject({
    artifactId: z.string().uuid(), name: ArtifactNameSchema,
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export const ArtifactTransferRequestSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('materialize'), operationId: z.string().uuid(),
        files: z.array(MaterializedInputSchema).min(1).max(100).refine(files => new Set(files.map(file => file.name)).size === files.length, 'Duplicate input names') }),
    z.strictObject({ action: z.literal('inspect'), operationId: z.string().uuid() }),
    z.strictObject({ action: z.literal('release'), operationId: z.string().uuid() }),
])
export type ArtifactTransferRequest = z.infer<typeof ArtifactTransferRequestSchema>
export type MaterializeRequest = Extract<ArtifactTransferRequest, { action: 'materialize' }>
export type MaterializedInput = z.infer<typeof MaterializedInputSchema> & { path: string }
export type ArtifactTransfer = {
    version: 1; request: MaterializeRequest; status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'unknown';
    createdAt: number; updatedAt: number; files: MaterializedInput[]; error?: ArtifactProblem;
    retention: 'retained' | 'releasing' | 'released'; sessions: string[];
}
export type ArtifactTransferResponse = { operation: ArtifactTransfer } | { error: ArtifactProblem }
