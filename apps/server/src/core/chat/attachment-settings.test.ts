import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import {
    getChatAttachmentConfig,
    normalizeInlineAttachmentTextLimit,
    saveChatAttachmentConfig,
} from './attachment-settings.js'

function settingsDb(): Database.Database {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)')
    return db
}

describe('chat attachment settings', () => {
    test('normalizes invalid, fractional, and out-of-range limits', () => {
        expect(normalizeInlineAttachmentTextLimit('not-a-number')).toBe(24_000)
        expect(normalizeInlineAttachmentTextLimit(1)).toBe(2_000)
        expect(normalizeInlineAttachmentTextLimit('3456.9')).toBe(3_456)
        expect(normalizeInlineAttachmentTextLimit(Infinity)).toBe(24_000)
        expect(normalizeInlineAttachmentTextLimit(900_000)).toBe(500_000)
    })

    test('uses defaults for missing or malformed persisted settings', () => {
        const db = settingsDb()
        expect(getChatAttachmentConfig(db)).toEqual({ inlineAttachmentTextLimit: 24_000 })
        db.prepare('INSERT INTO settings VALUES (?, ?)').run('chatAttachments', '{broken')
        expect(getChatAttachmentConfig(db)).toEqual({ inlineAttachmentTextLimit: 24_000 })
        db.close()
    })

    test('persists and returns the normalized value', () => {
        const db = settingsDb()
        expect(saveChatAttachmentConfig({ inlineAttachmentTextLimit: '32000.8' }, db)).toEqual({
            inlineAttachmentTextLimit: 32_000,
        })
        expect(getChatAttachmentConfig(db)).toEqual({ inlineAttachmentTextLimit: 32_000 })
        db.close()
    })
})
