import { z } from 'zod'
import { ArtifactNameSchema } from './artifacts'
import { WorkspaceSourceSchema, WorkspaceResultSchema, type WorkspaceProblem, type WorkspaceSource, type WorkspaceResult } from './workspaces'

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
const materialFiles = z.array(z.strictObject({ name: ArtifactNameSchema, path: z.string().min(1).max(4096) })).min(1)
export const RepositoryMaterialSchema = z.strictObject({ snapshot: RepositorySnapshotSchema, files: materialFiles })
export type RepositoryMaterial = z.infer<typeof RepositoryMaterialSchema>
export const RepositoryTargetSchema = z.strictObject({ machineId: z.string().min(1), repositoryId: z.string().min(1),
    commonDir: z.string().min(1).max(4096), objectFormat: format, cwd: z.string().min(1).max(4096) })
export type RepositoryTarget = z.infer<typeof RepositoryTargetSchema>
export const RepositoryRequestSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('export'), operationId: id, source: WorkspaceSourceSchema }),
    z.strictObject({ action: z.literal('export-result'), operationId: id, environmentId: id, roundId: id }),
    z.strictObject({ action: z.literal('import'), operationId: id, snapshot: RepositorySnapshotSchema,
        files: materialFiles }),
    z.strictObject({ action: z.literal('fetch-result'), operationId: id, target: RepositoryTargetSchema, result: WorkspaceResultSchema,
        baseline: RepositoryMaterialSchema, output: RepositoryMaterialSchema }),
    z.strictObject({ action: z.literal('inspect'), operationId: id }),
    z.strictObject({ action: z.literal('release'), operationId: id, names: z.array(ArtifactNameSchema).min(1).optional() }),
])
export type RepositoryRequest = z.infer<typeof RepositoryRequestSchema>
export type RepositoryExportRequest = Extract<RepositoryRequest, { action: 'export' }>
export type RepositoryResultExportRequest = Extract<RepositoryRequest, { action: 'export-result' }>
export type RepositoryImportRequest = Extract<RepositoryRequest, { action: 'import' }>
export type RepositoryFetchRequest = Extract<RepositoryRequest, { action: 'fetch-result' }>
export type RepositoryFetch = { target: RepositoryTarget; ref: string; head: string; fetchedAt: number;
    repositories: Array<{ path: string; directory: string; commit: string }>;
    lfs: Array<{ repository: string; oid: string; size: number; path: string }> }
export type RepositoryImport = { source: WorkspaceSource; repositories: Array<{ path: string; directory: string; ref: string }> }
export type RepositoryOperation = {
    version: 1; request: RepositoryExportRequest | RepositoryResultExportRequest | RepositoryImportRequest | RepositoryFetchRequest; directory: string;
    status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'unknown';
    retention: 'retained' | 'releasing' | 'released'; releasedFiles: string[];
    createdAt: number; updatedAt: number; snapshot?: RepositorySnapshot; imported?: RepositoryImport; error?: WorkspaceProblem;
    fetched?: RepositoryFetch;
    sealed?: { source: WorkspaceSource; result: WorkspaceResult; verifiedAt: number };
    process?: { pid: number; marker: string | null };
    cache?: { retained: boolean; directory: string; reason?: WorkspaceProblem };
}
export type RepositoryResponse = { operation: RepositoryOperation } | { error: WorkspaceProblem }
