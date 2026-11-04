import type Database from 'better-sqlite3'
import type { MessageSearchHit } from '@shared/types'

/** Marks the start and end of a matched term inside a snippet. Never part of message text. */
export const SNIPPET_MATCH_START = '\u0002'
export const SNIPPET_MATCH_END = '\u0003'

const MAX_TERMS = 12
const SNIPPET_TOKENS = 16

/**
 * Turn free text into a safe FTS5 query. Every word becomes a quoted prefix
 * term, so FTS5 operators and punctuation in the input are treated as text;
 * "double-quoted" parts are matched as exact phrases. All terms must match.
 * Returns null when nothing searchable remains.
 */
export function buildMessageSearchQuery(input: string): string | null {
    const terms: string[] = []
    for (const match of input.matchAll(/"([^"]*)"|(\S+)/g)) {
        const phrase = match[1]
        const word = match[2]
        const text = (phrase ?? word ?? '').replace(/"/g, '')
        if (!/[\p{L}\p{N}]/u.test(text)) continue
        terms.push(phrase !== undefined ? `"${text}"` : `"${text}"*`)
        if (terms.length >= MAX_TERMS) break
    }
    return terms.length ? terms.join(' ') : null
}

/**
 * Search user and assistant message text with BM25 ranking, returning the best
 * matching message per conversation. Incognito conversations are excluded.
 */
export function searchMessages(db: Database.Database, input: string, limit = 20): MessageSearchHit[] {
    const query = buildMessageSearchQuery(input)
    if (!query) return []
    const rows = db.prepare(`
        WITH matches AS (
            SELECT
                r.message_id,
                bm25(message_search) AS score,
                snippet(message_search, 0, ?, ?, '…', ${SNIPPET_TOKENS}) AS snippet
            FROM message_search
            JOIN message_search_rowids r ON r.rowid = message_search.rowid
            WHERE message_search MATCH ?
        ),
        ranked AS (
            SELECT
                m.conversation_id, m.id AS message_id, m.role, m.created_at,
                matches.score, matches.snippet,
                ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY matches.score, m.created_at DESC) AS position,
                COUNT(*) OVER (PARTITION BY m.conversation_id) AS match_count
            FROM matches
            JOIN messages m ON m.id = matches.message_id
            JOIN conversations c ON c.id = m.conversation_id
            WHERE c.temporary = 0
        )
        SELECT
            ranked.conversation_id, ranked.message_id, ranked.role, ranked.created_at,
            ranked.snippet, ranked.match_count,
            c.title, c.agent_id, c.project_id, c.origin, c.updated_at
        FROM ranked
        JOIN conversations c ON c.id = ranked.conversation_id
        WHERE ranked.position = 1
        ORDER BY ranked.score, c.updated_at DESC
        LIMIT ?
    `).all(SNIPPET_MATCH_START, SNIPPET_MATCH_END, query, limit) as Array<{
        conversation_id: string
        message_id: string
        role: 'user' | 'assistant'
        created_at: number
        snippet: string
        match_count: number
        title: string | null
        agent_id: string | null
        project_id: string | null
        origin: string
        updated_at: number
    }>
    return rows.map((row) => ({
        conversationId: row.conversation_id,
        title: row.title,
        agentId: row.agent_id,
        projectId: row.project_id,
        origin: row.origin,
        updatedAt: row.updated_at,
        messageId: row.message_id,
        role: row.role,
        createdAt: row.created_at,
        snippet: row.snippet,
        matchCount: row.match_count,
    }))
}
