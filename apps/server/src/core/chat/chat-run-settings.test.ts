import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { DEFAULT_CHAT_RUN_SETTINGS, getChatRunSettings, readChatRunSettings, saveChatRunSettings } from './chat-run-settings.js'

function settingsDb(): Database.Database {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)')
    return db
}

describe('chat run settings', () => {
    test('defaults to compaction and reports that nothing was saved', () => {
        const db = settingsDb()
        expect(readChatRunSettings(db)).toEqual({ settings: DEFAULT_CHAT_RUN_SETTINGS, saved: false })
        db.close()
    })

    test('merges partial updates and keeps current values for invalid fields', () => {
        const db = settingsDb()
        saveChatRunSettings({ compactProviderId: ' openai ', compactModel: 'gpt-mini' }, db)
        const saved = saveChatRunSettings({ contextStrategy: 'bogus', generateTitle: 'no', titleModel: 42 }, db)
        expect(saved).toEqual({ ...DEFAULT_CHAT_RUN_SETTINGS, compactProviderId: 'openai', compactModel: 'gpt-mini' })
        expect(readChatRunSettings(db)).toEqual({ settings: saved, saved: true })
        db.close()
    })

    test('falls back to defaults for a malformed row', () => {
        const db = settingsDb()
        db.prepare('INSERT INTO settings VALUES (?, ?)').run('chatRunSettings', '{broken')
        expect(getChatRunSettings(db)).toEqual(DEFAULT_CHAT_RUN_SETTINGS)
        db.close()
    })
})
