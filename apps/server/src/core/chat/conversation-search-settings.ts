import type { ConversationSearchConfig } from '@shared/types'
import { getDb } from '../../db/database.js'

const SETTINGS_KEY = 'conversationSearch'

/** Whether models may search past conversations. Off until the user enables it in Memory settings. */
export function getConversationSearchConfig(): ConversationSearchConfig {
    const row = getDb().prepare('SELECT value_json FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value_json: string } | undefined
    if (!row) return { enabled: false }
    try {
        const value = JSON.parse(row.value_json) as Partial<ConversationSearchConfig>
        return { enabled: value.enabled === true }
    } catch {
        return { enabled: false }
    }
}

export function saveConversationSearchConfig(input: ConversationSearchConfig): ConversationSearchConfig {
    const config: ConversationSearchConfig = { enabled: input.enabled === true }
    getDb().prepare('INSERT OR REPLACE INTO settings(key, value_json) VALUES (?, ?)').run(SETTINGS_KEY, JSON.stringify(config))
    return config
}
