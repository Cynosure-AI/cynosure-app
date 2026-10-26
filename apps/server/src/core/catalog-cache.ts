import { createHash } from 'crypto'
import { getDb } from '../db/database.js'

/**
 * Persisted copies of remote catalogues: provider model lists, model info and
 * pricing, and the models.dev index. Owners keep their own freshness rules and
 * serve these entries stale while they refresh, so a restart starts warm
 * instead of waiting on the network. Storage is best effort: a read or write
 * failure only means the next lookup goes to the network.
 */
export interface CatalogEntry<T> {
    value: T
    fetchedAt: number
}

/** Entries unused for this long are dropped at startup. */
const CATALOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function readCatalogEntry<T>(key: string): CatalogEntry<T> | undefined {
    try {
        const row = getDb().prepare('SELECT value_json, fetched_at FROM catalog_cache WHERE key = ?').get(key) as
            { value_json: string; fetched_at: number } | undefined
        return row ? { value: JSON.parse(row.value_json) as T, fetchedAt: row.fetched_at } : undefined
    } catch {
        return undefined
    }
}

export function writeCatalogEntry(key: string, value: unknown, fetchedAt = Date.now()): void {
    try {
        getDb().prepare(`
            INSERT INTO catalog_cache (key, value_json, fetched_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, fetched_at = excluded.fetched_at
        `).run(key, JSON.stringify(value), fetchedAt)
    } catch { /* the in-memory copy still serves this process */ }
}

export function pruneCatalogCache(now = Date.now()): void {
    try {
        getDb().prepare('DELETE FROM catalog_cache WHERE fetched_at < ?').run(now - CATALOG_MAX_AGE_MS)
    } catch { /* retried on the next start */ }
}

/**
 * Identifies the account a catalogue came from, so changing a provider's URL or
 * key never serves the previous account's models. Only a hash is stored.
 */
export function providerCatalogFingerprint(config: { type: string; baseUrl?: string; apiKey?: string }): string {
    return createHash('sha256').update(`${config.type}\0${config.baseUrl ?? ''}\0${config.apiKey ?? ''}`).digest('hex').slice(0, 16)
}
