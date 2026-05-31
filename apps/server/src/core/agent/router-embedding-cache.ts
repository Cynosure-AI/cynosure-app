import { getDb } from '../../db/database.js'

export interface RouterEmbeddingScope {
    providerId: string
    model: string
    dimensions: number
}

export function loadCachedRouterEmbeddings(
    groupIds: string[],
    hashes: Map<string, string>,
    scope: RouterEmbeddingScope,
): Map<string, number[]> {
    const vectors = new Map<string, number[]>()

    try {
        const stmt = getDb().prepare(`
            SELECT content_hash, vector_json
            FROM tool_router_embeddings
            WHERE namespace_id = ?
              AND embedding_provider_id = ?
              AND embedding_model = ?
              AND embedding_dimensions = ?
        `)

        for (const groupId of groupIds) {
            const row = stmt.get(groupId, scope.providerId, scope.model, scope.dimensions) as {
                content_hash: string
                vector_json: string
            } | undefined

            if (!row || row.content_hash !== hashes.get(groupId)) continue

            const vector = JSON.parse(row.vector_json) as unknown
            if (isNumberArray(vector)) vectors.set(groupId, vector)
        }
    } catch (err) {
        console.warn('[tool-router] Failed to read router embedding cache:', err)
    }

    return vectors
}

export function saveCachedRouterEmbedding(
    namespaceId: string,
    contentHash: string,
    vector: number[],
    scope: RouterEmbeddingScope,
): void {
    try {
        getDb().prepare(`
            INSERT INTO tool_router_embeddings (
                namespace_id,
                embedding_provider_id,
                embedding_model,
                embedding_dimensions,
                content_hash,
                vector_json,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(namespace_id, embedding_provider_id, embedding_model, embedding_dimensions)
            DO UPDATE SET
                content_hash = excluded.content_hash,
                vector_json = excluded.vector_json,
                updated_at = excluded.updated_at
        `).run(
            namespaceId,
            scope.providerId,
            scope.model,
            scope.dimensions,
            contentHash,
            JSON.stringify(vector),
            Date.now(),
        )
    } catch (err) {
        console.warn('[tool-router] Failed to write router embedding cache:', err)
    }
}

export function pruneRouterEmbeddingCache(
    activeNamespaceIds: string[],
    scope: RouterEmbeddingScope,
): void {
    if (!activeNamespaceIds.length) return

    try {
        const placeholders = activeNamespaceIds.map(() => '?').join(', ')

        getDb().prepare(`
            DELETE FROM tool_router_embeddings
            WHERE embedding_provider_id = ?
              AND embedding_model = ?
              AND embedding_dimensions = ?
              AND namespace_id NOT IN (${placeholders})
        `).run(scope.providerId, scope.model, scope.dimensions, ...activeNamespaceIds)
    } catch (err) {
        console.warn('[tool-router] Failed to prune router embedding cache:', err)
    }
}

function isNumberArray(value: unknown): value is number[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'number')
}
