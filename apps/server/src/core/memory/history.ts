import { getDb } from '../../db/database.js'
import { nanoid } from 'nanoid'
import { join } from 'path'
import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { getAppDataDir } from '../data-dir.js'

export interface HistoryEntry {
  id: string
  taskId: string
  conversationId: string
  iteration?: number
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  toolCalls?: unknown[]
  provider?: string
  model?: string
  promptTokens?: number
  completionTokens?: number
  latencyMs?: number
  spanId?: string
  timestamp: number
}

export interface HistoryFilter {
  taskId?: string
  conversationId?: string
  role?: string
  since?: number
  until?: number
  limit?: number
}

/**
 * Execution history store using SQLite for indexed queries + JSONL for raw logs.
 */
export class HistoryStore {
  private logDir: string

  constructor() {
    this.logDir = join(getAppDataDir(), 'logs')
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true })
    }
  }

  /**
   * Log an entry to both SQLite and JSONL.
   */
  async log(entry: Omit<HistoryEntry, 'id'>): Promise<string> {
    const id = nanoid()
    const fullEntry = { id, ...entry }

    // SQLite
    const db = getDb()
    db.prepare(
      `INSERT INTO execution_logs (id, conversation_id, event_type, data_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      id,
      entry.conversationId,
      entry.role,
      JSON.stringify(fullEntry),
      entry.timestamp
    )

    // JSONL append
    const logFile = join(this.logDir, `${entry.conversationId}.jsonl`)
    appendFileSync(logFile, JSON.stringify(fullEntry) + '\n')

    return id
  }

  /**
   * Query history with filters.
   */
  async query(filter: HistoryFilter): Promise<HistoryEntry[]> {
    const db = getDb()
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter.conversationId) {
      conditions.push('conversation_id = ?')
      params.push(filter.conversationId)
    }
    if (filter.since) {
      conditions.push('created_at >= ?')
      params.push(filter.since)
    }
    if (filter.until) {
      conditions.push('created_at <= ?')
      params.push(filter.until)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = filter.limit ? `LIMIT ${filter.limit}` : 'LIMIT 100'

    const rows = db
      .prepare(
        `SELECT data_json FROM execution_logs ${where} ORDER BY created_at ASC ${limit}`
      )
      .all(...params) as { data_json: string }[]

    return rows.map((r) => {
      const entry = JSON.parse(r.data_json) as HistoryEntry

      // Apply additional filters that can't be done in SQL easily
      if (filter.taskId && entry.taskId !== filter.taskId) return null
      if (filter.role && entry.role !== filter.role) return null
      return entry
    }).filter(Boolean) as HistoryEntry[]
  }

  /**
   * Get conversation thread entries.
   */
  async getThread(conversationId: string): Promise<HistoryEntry[]> {
    return this.query({ conversationId })
  }
}

let historyInstance: HistoryStore | null = null

export function getHistoryStore(): HistoryStore {
  if (!historyInstance) {
    historyInstance = new HistoryStore()
  }
  return historyInstance
}
