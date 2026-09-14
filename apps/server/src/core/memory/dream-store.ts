import { randomUUID } from 'node:crypto'
import { getDb } from '../../db/database.js'

export interface DreamConfig {
    enabled: boolean
    providerId: string
    model: string
    windowId: string
    enabledAt: number
    startSequence: number
}
export interface DreamSource {
    id: string
    sequence: number
    role: 'user' | 'assistant'
    content: string
    offset: number
}
export interface DreamInput {
    sources: DreamSource[]
    context: string
    endSequence: number
    endOffset: number
    snapshotSequence: number
}
export interface DreamChange {
    key: string
    tool: string
    output: string
}
export interface DreamRun {
    id: string
    conversation_id: string | null
    window_id: string
    status: 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
    provider_id: string
    model: string
    input_json: string
    changes_json: string
    reviewed_count: number
    attempt: number
    next_attempt_at: number
    error: string | null
    created_at: number
    updated_at: number
}
export function getDreamConfig(): DreamConfig {
    const row = getDb().prepare("SELECT value_json FROM settings WHERE key = 'dreamMode'").get() as { value_json: string } | undefined
    return row ? JSON.parse(row.value_json) : { enabled: false, providerId: '', model: '', windowId: '', enabledAt: 0, startSequence: 0 }
}
export function saveDreamConfig(input: Pick<DreamConfig, 'enabled' | 'providerId' | 'model'>): DreamConfig {
    const current = getDreamConfig()
    const config = { ...current, ...input }
    if (config.enabled && !current.enabled) {
        config.windowId = randomUUID()
        config.enabledAt = Date.now()
        config.startSequence = (getDb().prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'dream_message_events'), 0) AS n").get() as { n: number }).n
    }
    getDb().prepare("INSERT OR REPLACE INTO settings(key, value_json) VALUES ('dreamMode', ?)").run(JSON.stringify(config))
    return config
}
export function getDreamRun(id: string): DreamRun | undefined {
    return getDb().prepare('SELECT * FROM dream_runs WHERE id = ?').get(id) as DreamRun | undefined
}
export function listDreamRuns(limit = 100): DreamRun[] {
    return getDb().prepare('SELECT * FROM dream_runs ORDER BY updated_at DESC LIMIT ?').all(limit) as DreamRun[]
}

/** Keep partial-message offsets so even a single oversized message is never skipped. */
export function buildDreamBatch(rows: Array<{ id: string; sequence: number; role: 'user' | 'assistant'; content: string }>, startOffset: number, maxChars: number): Omit<DreamInput, 'context' | 'snapshotSequence'> {
    const sources: DreamSource[] = []
    let remaining = maxChars
    let endSequence = 0
    let endOffset = 0
    for (const [index, row] of rows.entries()) {
        if (remaining <= 0) break
        const offset = index === 0 ? startOffset : 0
        const content = row.content.slice(offset, offset + remaining)
        sources.push({ ...row, content, offset })
        remaining -= Math.max(content.length, 1)
        endSequence = row.sequence
        endOffset = offset + content.length < row.content.length ? offset + content.length : 0
        if (endOffset) break
    }
    return { sources, endSequence, endOffset }
}
