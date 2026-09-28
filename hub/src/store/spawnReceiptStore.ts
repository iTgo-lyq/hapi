import type { Database } from 'bun:sqlite'
import type { SpawnReceipt } from '@hapi/protocol'

type ReceiptRow = {
    request_id: string; machine_id: string; session_id: string; created_at: number
    fingerprint: string; response: string | null
}

function receipt(row: ReceiptRow): SpawnReceipt {
    return {
        requestId: row.request_id, machineId: row.machine_id, sessionId: row.session_id,
        createdAt: row.created_at, response: row.response === null ? null : JSON.parse(row.response)
    }
}

export class SpawnRequestConflictError extends Error {
    constructor() { super('requestId already belongs to a different spawn request') }
}

/** A dispatch receipt survives session deletion; it is not an execution state store. */
export class SpawnReceiptStore {
    constructor(private readonly db: Database) {}

    private row(namespace: string, requestId: string): ReceiptRow | null {
        return this.db.prepare('SELECT * FROM spawn_receipts WHERE namespace = ? AND request_id = ?')
            .get(namespace, requestId) as ReceiptRow | null
    }

    get(namespace: string, requestId: string): SpawnReceipt | null {
        const row = this.row(namespace, requestId)
        return row ? receipt(row) : null
    }

    reserve(namespace: string, requestId: string, machineId: string, fingerprint: string,
        createSession: () => string): { created: boolean; receipt: SpawnReceipt } {
        return this.db.transaction(() => {
            const prior = this.row(namespace, requestId)
            if (prior) {
                if (prior.machine_id !== machineId || prior.fingerprint !== fingerprint) {
                    throw new SpawnRequestConflictError()
                }
                return { created: false, receipt: receipt(prior) }
            }
            // Synchronous callback and INSERT share one transaction. Dispatch is
            // allowed only after both the receipt and native stub have committed.
            const sessionId = createSession()
            const createdAt = Date.now()
            this.db.prepare(`INSERT INTO spawn_receipts
                (namespace, request_id, machine_id, session_id, fingerprint, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run(namespace, requestId, machineId, sessionId, fingerprint, createdAt)
            return { created: true, receipt: { requestId, machineId, sessionId, createdAt, response: null } }
        }).immediate()
    }

    finish(namespace: string, requestId: string, response: NonNullable<SpawnReceipt['response']>): void {
        this.db.prepare('UPDATE spawn_receipts SET response = ? WHERE namespace = ? AND request_id = ? AND response IS NULL')
            .run(JSON.stringify(response), namespace, requestId)
    }
}
