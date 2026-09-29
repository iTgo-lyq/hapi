import { z } from 'zod'
import { ArtifactNameSchema } from './artifacts'
import { WorkspaceSourceSchema, type WorkspaceProblem } from './workspaces'

const id = z.string().uuid()
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const RepositoryPathSchema = z.string().max(4096).refine(value => value === '' ||
    !/[\x00-\x1f\x7f\\]/.test(value) && !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Use a repository-relative path')
const format = z.enum(['sha1', 'sha256'])
export const RepositoryFileSchema = z.strictObject({
    name: ArtifactNameSchema, kind: z.enum(['bundle', 'lfs']), sha256: digest,
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
export const RepositorySnapshotSchema = z.strictObject({
    version: z.literal(1), manifestId: id, sourceMachineId: z.string().min(1), repositoryId: z.string().min(1),
    baseCommit: sha, objectFormat: format,
    repositories: z.array(z.strictObject({ path: RepositoryPathSchema, commit: sha, objectFormat: format,
        bundleRef: z.string().startsWith('refs/heads/'), file: ArtifactNameSchema,
        module: z.strictObject({ parent: RepositoryPathSchema, path: RepositoryPathSchema, name: RepositoryPathSchema }).optional(),
    })).min(1),
    lfs: z.array(z.strictObject({ repository: RepositoryPathSchema, path: RepositoryPathSchema,
        oid: digest, size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), file: ArtifactNameSchema })),
    files: z.array(RepositoryFileSchema).min(1),
})
export type RepositorySnapshot = z.infer<typeof RepositorySnapshotSchema>
export type RepositoryFile = z.infer<typeof RepositoryFileSchema>
export const RepositoryRequestSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('export'), operationId: id, source: WorkspaceSourceSchema }),
    z.strictObject({ action: z.literal('inspect'), operationId: id }),
    z.strictObject({ action: z.literal('release'), operationId: id, names: z.array(ArtifactNameSchema).min(1).optional() }),
])
export type RepositoryRequest = z.infer<typeof RepositoryRequestSchema>
export type RepositoryExportRequest = Extract<RepositoryRequest, { action: 'export' }>
export type RepositoryOperation = {
    version: 1; request: RepositoryExportRequest; directory: string;
    status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'unknown';
    retention: 'retained' | 'releasing' | 'released'; releasedFiles: string[];
    createdAt: number; updatedAt: number; snapshot?: RepositorySnapshot; error?: WorkspaceProblem;
    process?: { pid: number; marker: string | null };
}
export type RepositoryResponse = { operation: RepositoryOperation } | { error: WorkspaceProblem }
