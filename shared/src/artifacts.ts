import { z } from 'zod'

export const ArtifactNameSchema = z.string().min(1).refine(value =>
    new TextEncoder().encode(value).length <= 240 && !/[\x00-\x1f\x7f/\\]/.test(value)
    && value !== '.' && value !== '..', 'Use a single filename of at most 240 UTF-8 bytes')
export const ArtifactReferenceSchema = z.strictObject({
    reference: z.string().min(1).max(512), purpose: z.string().min(1).max(64),
})
export const ArtifactReserveSchema = z.strictObject({
    requestId: z.string().uuid(), filename: ArtifactNameSchema,
    mimeType: z.string().min(1).max(255).regex(/^[\x20-\x7e]+$/).default('application/octet-stream'),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), reference: ArtifactReferenceSchema.optional(),
})
export const ArtifactLimitsSchema = z.strictObject({
    maxFileBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    namespaceQuotaBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    unreferencedDays: z.number().int().positive(), pendingHours: z.number().int().positive(),
})
export const ARTIFACT_DEFAULT_LIMITS = {
    maxFileBytes: 512 * 1024 * 1024, namespaceQuotaBytes: 10 * 1024 * 1024 * 1024,
    unreferencedDays: 7, pendingHours: 24,
} satisfies z.infer<typeof ArtifactLimitsSchema>
export type ArtifactLimits = z.infer<typeof ArtifactLimitsSchema>
export type ArtifactReserve = z.infer<typeof ArtifactReserveSchema>
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema> & { createdAt: number }
export type ArtifactProblem = { code: string; message: string; hint?: string }
export const ArtifactSchema = z.object({
    id: z.string().uuid(), namespace: z.string(), requestId: z.string().uuid(), filename: ArtifactNameSchema, mimeType: z.string(),
    size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['reserved', 'available', 'deleting', 'deleted']),
    createdAt: z.number(), publishedAt: z.number().nullable(), deletedAt: z.number().nullable(),
    error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }).nullable(),
})
export type Artifact = z.infer<typeof ArtifactSchema>
