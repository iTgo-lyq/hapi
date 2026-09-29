import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { Artifact, ArtifactLimits, ArtifactProblem, ArtifactReference, ArtifactReserve } from '@hapi/protocol'
import { ArtifactError } from '../artifacts/errors'

type Row = { id: string; namespace: string; request_id: string; filename: string; mime_type: string; size: number;
    sha256: string; state: Artifact['state']; created_at: number; published_at: number | null; deleted_at: number | null;
    error: string | null; fingerprint: string }
function object(row: Row): Artifact {
    return { id: row.id, namespace: row.namespace, requestId: row.request_id, filename: row.filename,
        mimeType: row.mime_type, size: row.size, sha256: row.sha256, state: row.state, createdAt: row.created_at,
        publishedAt: row.published_at, deletedAt: row.deleted_at, error: row.error ? JSON.parse(row.error) : null }
}
export class ArtifactStore {
    constructor(private readonly db: Database) {}
    get(namespace: string, id: string): Artifact {
        const row = this.db.query('SELECT * FROM artifacts WHERE namespace=? AND id=?').get(namespace, id) as Row | null
        if (!row) throw new ArtifactError(404, 'artifact_not_found', 'File object was not found in this namespace.')
        return object(row)
    }
    byRequest(namespace: string, requestId: string): Artifact {
        const row = this.db.query('SELECT * FROM artifacts WHERE namespace=? AND request_id=?').get(namespace, requestId) as Row | null
        if (!row) throw new ArtifactError(404, 'artifact_request_not_found', 'No file object has accepted this request ID.')
        return object(row)
    }
    usage(namespace: string): number {
        return (this.db.query("SELECT COALESCE(SUM(size),0) AS bytes FROM artifacts WHERE namespace=? AND state<>'deleted'")
            .get(namespace) as { bytes: number }).bytes
    }
    list(namespace: string, offset = 0, limit = 50): Artifact[] {
        return (this.db.query('SELECT * FROM artifacts WHERE namespace=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?')
            .all(namespace, limit, offset) as Row[]).map(object)
    }
    reserve(namespace: string, request: ArtifactReserve, limits: ArtifactLimits): Artifact {
        return this.db.transaction(() => {
            const fingerprint = JSON.stringify([request.filename, request.mimeType, request.size, request.sha256,
                request.reference?.reference ?? null, request.reference?.purpose ?? null])
            const prior = this.db.query('SELECT * FROM artifacts WHERE namespace=? AND request_id=?').get(namespace, request.requestId) as Row | null
            if (prior) {
                if (prior.fingerprint !== fingerprint) throw new ArtifactError(409, 'artifact_request_conflict', 'Request ID already describes a different file.', 'Retry the original file or use a new request ID for changed content.')
                return object(prior)
            }
            if (request.size > limits.maxFileBytes) throw new ArtifactError(413, 'artifact_too_large', `File exceeds the ${limits.maxFileBytes} byte limit.`, 'Check HAPI_ARTIFACT_MAX_FILE_BYTES on the hosting Hub.')
            if (request.size + this.usage(namespace) > limits.namespaceQuotaBytes) throw new ArtifactError(409, 'artifact_quota_exceeded', `Namespace quota of ${limits.namespaceQuotaBytes} bytes would be exceeded.`, 'Release unused references and remove unreferenced objects, or increase HAPI_ARTIFACT_NAMESPACE_QUOTA_BYTES.')
            const id = randomUUID(), now = Date.now()
            this.db.query(`INSERT INTO artifacts (id,namespace,request_id,fingerprint,filename,mime_type,size,sha256,state,created_at)
                VALUES (?,?,?,?,?,?,?,?,'reserved',?)`).run(id, namespace, request.requestId, fingerprint, request.filename, request.mimeType, request.size, request.sha256, now)
            if (request.reference) this.pin(namespace, id, request.reference)
            return this.get(namespace, id)
        }).immediate()
    }
    references(namespace: string, id: string): ArtifactReference[] {
        this.get(namespace, id)
        return this.db.query('SELECT reference,purpose,created_at AS createdAt FROM artifact_references WHERE namespace=? AND artifact_id=? ORDER BY created_at,reference')
            .all(namespace, id) as ArtifactReference[]
    }
    pin(namespace: string, id: string, reference: Pick<ArtifactReference, 'reference' | 'purpose'>): Artifact {
        return this.db.transaction(() => {
            const artifact = this.get(namespace, id)
            if (artifact.state === 'deleting' || artifact.state === 'deleted') throw new ArtifactError(410, 'artifact_deleted', 'File object is being deleted or has been deleted.')
            const prior = this.db.query('SELECT purpose FROM artifact_references WHERE namespace=? AND artifact_id=? AND reference=?')
                .get(namespace, id, reference.reference) as { purpose: string } | null
            if (prior && prior.purpose !== reference.purpose) throw new ArtifactError(409, 'artifact_reference_conflict', 'Reference already has a different purpose.')
            this.db.query('INSERT OR IGNORE INTO artifact_references VALUES (?,?,?,?,?)').run(namespace, id, reference.reference, reference.purpose, Date.now())
            return artifact
        }).immediate()
    }
    unpin(namespace: string, id: string, reference: string) {
        this.get(namespace, id)
        this.db.query('DELETE FROM artifact_references WHERE namespace=? AND artifact_id=? AND reference=?').run(namespace, id, reference)
    }
    publish(namespace: string, id: string): Artifact {
        this.db.query("UPDATE artifacts SET state='available',published_at=?,error=NULL WHERE namespace=? AND id=? AND state='reserved'")
            .run(Date.now(), namespace, id)
        const result = this.get(namespace, id)
        if (result.state !== 'available') throw new ArtifactError(410, 'artifact_deleted', 'File object was deleted during publication.')
        return result
    }
    fail(namespace: string, id: string, error: ArtifactProblem) {
        this.db.query("UPDATE artifacts SET error=? WHERE namespace=? AND id=? AND state='reserved'").run(JSON.stringify(error), namespace, id)
    }
    beginDelete(namespace: string, id: string): Artifact {
        return this.db.transaction(() => {
            const artifact = this.get(namespace, id)
            if (this.references(namespace, id).length) throw new ArtifactError(409, 'artifact_referenced', 'File object is still retained by a reference.', 'Inspect object references and release their owning retention before deleting.')
            if (artifact.state !== 'deleted') this.db.query("UPDATE artifacts SET state='deleting' WHERE namespace=? AND id=?").run(namespace, id)
            return this.get(namespace, id)
        }).immediate()
    }
    deleted(namespace: string, id: string): Artifact {
        this.db.query("UPDATE artifacts SET state='deleted',deleted_at=?,error=NULL WHERE namespace=? AND id=? AND state='deleting'")
            .run(Date.now(), namespace, id)
        return this.get(namespace, id)
    }
}
