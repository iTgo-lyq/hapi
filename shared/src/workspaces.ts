import { z } from 'zod'
import { ArtifactNameSchema } from './artifacts'

const id = z.string().uuid()
const path = z.string().min(1).max(4096).refine(value => !value.includes('\0'), 'Invalid path')
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
export const PreparedWorkspaceSchema = z.strictObject({ environmentId: id, preparationId: id })
export type PreparedWorkspace = z.infer<typeof PreparedWorkspaceSchema>
export const WorkspaceSourceSchema = z.strictObject({
    machineId: z.string().min(1), repositoryId: z.string().min(1), sourcePath: path,
    repositoryRoot: path, commonDir: path, relativePath: z.string(),
    baseRef: z.string().min(1), baseCommit: sha, objectFormat: z.enum(['sha1', 'sha256']), dirty: z.boolean(),
})
export type WorkspaceSource = z.infer<typeof WorkspaceSourceSchema>
const input = z.strictObject({ name: ArtifactNameSchema, path,
    sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative() })
export const WorkspaceRequestSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('resolve'), cwd: path, baseRef: z.string().trim().min(1).default('HEAD') }),
    z.strictObject({ action: z.literal('prepare'), environmentId: id, preparationId: id, roundId: id,
        source: WorkspaceSourceSchema, expectedHead: sha, inputs: z.array(input).max(100).default([]).refine(files => new Set(files.map(file => file.name)).size === files.length, 'Duplicate input names') }),
    z.strictObject({ action: z.literal('inspect'), environmentId: id }),
    z.strictObject({ action: z.literal('finalize'), environmentId: id, preparationId: id, roundId: id, attemptId: id,
        sessionId: z.string().min(1).optional(), partial: z.boolean().default(false) }),
    z.strictObject({ action: z.literal('remove'), environmentId: id, attemptId: id, expectedHead: sha, discardIgnored: z.boolean().default(false) }),
])
export type WorkspaceRequest = z.infer<typeof WorkspaceRequestSchema>
export type WorkspaceMutation = Exclude<WorkspaceRequest, { action: 'resolve' | 'inspect' }>
export type WorkspaceProblem = { code: string; message: string; hint?: string }
export type WorkspacePreparation = PreparedWorkspace & { roundId: string; cwd: string; startHead: string;
    inputs: Array<{ name: string; path: string; sha256: string; size: number }>; readyAt: number; sessionId?: string }
export type WorkspaceResult = { environmentId: string; roundId: string; baseCommit: string; startHead: string;
    resultHead: string; resultRef: string; checkpoint?: string; partial: boolean; fileCount: number; paths: string[]; sealedAt: number }
export type WorkspaceOperation = { id: string; request: WorkspaceMutation;
    status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'unknown'; createdAt: number; updatedAt: number;
    error?: WorkspaceProblem; expectedHead?: string; checkpoint?: string;
    process?: { pid: number; marker: string | null }; startedGit?: boolean }
export type ManagedWorkspace = {
    version: 1; environmentId: string; source: WorkspaceSource; checkout: string; cwd: string; branch: string;
    status: 'retained' | 'deleting' | 'removed'; createdAt: number;
    preparations: Record<string, WorkspacePreparation>; results: Record<string, WorkspaceResult>;
    operations: Record<string, WorkspaceOperation>; sessions: Record<string, { preparationId: string; attemptedAt: number; rejected?: boolean }>;
}
export type WorkspaceResponse = { source: WorkspaceSource } | { workspace: ManagedWorkspace; operation?: WorkspaceOperation }
