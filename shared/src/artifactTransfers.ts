import { z } from 'zod'
import { ArtifactNameSchema, ArtifactReferenceSchema, type Artifact, type ArtifactProblem } from './artifacts'

export const PreparedFilesSchema = z.strictObject({ operationId: z.string().uuid() })
export type PreparedFiles = z.infer<typeof PreparedFilesSchema>
export const MaterializedInputSchema = z.strictObject({
    artifactId: z.string().uuid(), name: ArtifactNameSchema,
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
export const ArtifactOutputSchema = z.strictObject({
    name: ArtifactNameSchema,
    relativePath: z.string().min(1).max(4096).refine(path => !/[\x00-\x1f\x7f\\]/.test(path)
        && !path.startsWith('/') && !/^[A-Za-z]:/.test(path)
        && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Use a file path relative to the workspace'),
})
export const ArtifactOutputsSchema = z.array(ArtifactOutputSchema).min(1).max(100)
    .refine(files => new Set(files.map(file => file.name)).size === files.length, 'Duplicate output names')
export const ArtifactTransferRequestSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('materialize'), operationId: z.string().uuid(),
        files: z.array(MaterializedInputSchema).min(1).max(100).refine(files => new Set(files.map(file => file.name)).size === files.length, 'Duplicate input names') }),
    z.strictObject({ action: z.literal('capture'), operationId: z.string().uuid(), cwd: z.string().min(1), files: ArtifactOutputsSchema }),
    z.strictObject({ action: z.literal('deliver'), operationId: z.string().uuid(), captureOperationId: z.string().uuid(),
        files: z.array(z.strictObject({ name: ArtifactNameSchema, requestId: z.string().uuid(), reference: ArtifactReferenceSchema }))
            .min(1).max(100).refine(files => new Set(files.map(file => file.name)).size === files.length, 'Duplicate delivery names') }),
    z.strictObject({ action: z.literal('inspect'), operationId: z.string().uuid() }),
    z.strictObject({ action: z.literal('release'), operationId: z.string().uuid(), names: z.array(ArtifactNameSchema).min(1).max(100).optional() }),
])
export type ArtifactTransferRequest = z.infer<typeof ArtifactTransferRequestSchema>
export type MaterializeRequest = Extract<ArtifactTransferRequest, { action: 'materialize' }>
export type CaptureRequest = Extract<ArtifactTransferRequest, { action: 'capture' }>
export type DeliverRequest = Extract<ArtifactTransferRequest, { action: 'deliver' }>
export type ArtifactOutput = z.infer<typeof ArtifactOutputSchema>
export type CapturedArtifact = ArtifactOutput & ({ status: 'captured'; size: number; sha256: string; capturedAt: number; path: string; retention: 'retained' | 'released' }
    | { status: 'failed'; error: ArtifactProblem })
export type ArtifactDelivery = { name: string } & ({ status: 'available'; artifact: Artifact } | { status: 'failed'; error: ArtifactProblem })
export type ArtifactMutation = MaterializeRequest | CaptureRequest | DeliverRequest
export type MaterializedInput = z.infer<typeof MaterializedInputSchema> & { path: string }
export type ArtifactTransfer = {
    version: 1; request: ArtifactMutation; status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'unknown';
    createdAt: number; updatedAt: number; files: MaterializedInput[]; error?: ArtifactProblem;
    candidates?: CapturedArtifact[]; deliveries?: ArtifactDelivery[];
    retention: 'retained' | 'releasing' | 'released'; sessions: string[];
}
export type ArtifactTransferResponse = { operation: ArtifactTransfer } | { error: ArtifactProblem }
