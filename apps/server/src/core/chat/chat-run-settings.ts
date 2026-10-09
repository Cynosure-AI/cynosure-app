import { getDb } from '../../db/database.js'
import type Database from 'better-sqlite3'
import type { ChatRunSettings, ContextStrategy } from '@shared/types'

const SETTINGS_KEY = 'chatRunSettings'
const CONTEXT_STRATEGIES = new Set<ContextStrategy>(['compact', 'sliding-window', 'truncate-middle', 'none'])

export const DEFAULT_CHAT_RUN_SETTINGS: ChatRunSettings = {
    contextStrategy: 'compact',
    generateTitle: true,
    titleProviderId: '',
    titleModel: '',
    compactProviderId: '',
    compactModel: '',
}

/** Settings saved on the server, and whether any were saved yet. */
export function readChatRunSettings(db: Database.Database = getDb()): { settings: ChatRunSettings; saved: boolean } {
    const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value_json: string } | undefined
    if (!row) return { settings: { ...DEFAULT_CHAT_RUN_SETTINGS }, saved: false }
    try {
        return { settings: normalizeChatRunSettings(JSON.parse(row.value_json), DEFAULT_CHAT_RUN_SETTINGS), saved: true }
    } catch {
        return { settings: { ...DEFAULT_CHAT_RUN_SETTINGS }, saved: true }
    }
}

export function getChatRunSettings(db: Database.Database = getDb()): ChatRunSettings {
    return readChatRunSettings(db).settings
}

/** Merge a partial update into the saved settings; invalid fields keep their current value. */
export function saveChatRunSettings(input: unknown, db: Database.Database = getDb()): ChatRunSettings {
    const next = normalizeChatRunSettings(input, getChatRunSettings(db))
    db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(SETTINGS_KEY, JSON.stringify(next))
    return next
}

function normalizeChatRunSettings(input: unknown, fallback: ChatRunSettings): ChatRunSettings {
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const text = (key: keyof ChatRunSettings) => typeof value[key] === 'string' ? (value[key] as string).trim() : fallback[key] as string
    return {
        contextStrategy: CONTEXT_STRATEGIES.has(value.contextStrategy as ContextStrategy)
            ? value.contextStrategy as ContextStrategy
            : fallback.contextStrategy,
        generateTitle: typeof value.generateTitle === 'boolean' ? value.generateTitle : fallback.generateTitle,
        titleProviderId: text('titleProviderId'),
        titleModel: text('titleModel'),
        compactProviderId: text('compactProviderId'),
        compactModel: text('compactModel'),
    }
}
