import type { Database } from 'better-sqlite3'

// Protect uploads between materialization and durable draft/message/queue ownership.
const leases = new WeakMap<object, { db: Database; assetId: string }>()
const counts = new WeakMap<Database, Map<string, number>>()

export function retainAttachmentAsset<T extends { id: string; assetId?: string }>(db: Database, artifact: T): T {
    const assetId = artifact.assetId || artifact.id
    const current = counts.get(db) ?? new Map<string, number>()
    current.set(assetId, (current.get(assetId) ?? 0) + 1)
    counts.set(db, current)
    leases.set(artifact, { db, assetId })
    return artifact
}

export function releaseAttachmentAsset(artifact: object): void {
    const lease = leases.get(artifact)
    if (!lease) return
    const current = counts.get(lease.db)!
    const remaining = (current.get(lease.assetId) ?? 1) - 1
    if (remaining) current.set(lease.assetId, remaining)
    else current.delete(lease.assetId)
    leases.delete(artifact)
}

export function hasAttachmentAssetReferences(db: Database, assetId: string): boolean {
    if (counts.get(db)?.has(assetId)) return true
    return Boolean(db.prepare(`
        SELECT 1 FROM message_attachments WHERE asset_id = @assetId
        UNION ALL
        SELECT 1 FROM staged_chat_attachments
        WHERE COALESCE(json_extract(artifact_json, '$.assetId'), json_extract(artifact_json, '$.id')) = @assetId
        UNION ALL
        SELECT 1 FROM queued_chat_messages q, json_each(q.file_artifacts_json) f
        WHERE COALESCE(json_extract(f.value, '$.assetId'), json_extract(f.value, '$.id')) = @assetId
        LIMIT 1
    `).get({ assetId }))
}
