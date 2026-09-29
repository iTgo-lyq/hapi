import { ARTIFACT_DEFAULT_LIMITS, ArtifactLimitsSchema, type ArtifactLimits } from '@hapi/protocol'

export function loadArtifactLimits(env: NodeJS.ProcessEnv = process.env): ArtifactLimits {
    const value = (key: string, fallback: number) => env[key] === undefined ? fallback : Number(env[key])
    const limits = {
        maxFileBytes: value('HAPI_ARTIFACT_MAX_FILE_BYTES', ARTIFACT_DEFAULT_LIMITS.maxFileBytes),
        namespaceQuotaBytes: value('HAPI_ARTIFACT_NAMESPACE_QUOTA_BYTES', ARTIFACT_DEFAULT_LIMITS.namespaceQuotaBytes),
        unreferencedDays: value('HAPI_ARTIFACT_UNREFERENCED_DAYS', ARTIFACT_DEFAULT_LIMITS.unreferencedDays),
        pendingHours: value('HAPI_ARTIFACT_PENDING_HOURS', ARTIFACT_DEFAULT_LIMITS.pendingHours),
    }
    const result = ArtifactLimitsSchema.safeParse(limits)
    if (!result.success) throw new Error(`Invalid HAPI artifact limits: ${result.error.issues.map(issue => issue.path.join('.')).join(', ')}`)
    return result.data
}
