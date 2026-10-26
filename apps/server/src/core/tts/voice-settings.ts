import { getDb } from '../../db/database.js'
import type Database from 'better-sqlite3'
import type { VoiceAutoRead, VoiceOutputSettings } from '@shared/types'

const SETTINGS_KEY = 'voiceOutputSettings'
const AUTO_READ_MODES = new Set<VoiceAutoRead>(['off', 'voice', 'always'])
export const MIN_SPEECH_SPEED = 0.5
export const MAX_SPEECH_SPEED = 2

export const DEFAULT_VOICE_OUTPUT_SETTINGS: VoiceOutputSettings = {
    enabled: true,
    voiceId: '',
    speakerId: 0,
    speed: 1,
    autoRead: 'voice',
}

export function getVoiceOutputSettings(db: Database.Database = getDb()): VoiceOutputSettings {
    const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value_json: string } | undefined
    if (!row) return { ...DEFAULT_VOICE_OUTPUT_SETTINGS }
    try {
        return normalizeVoiceOutputSettings(JSON.parse(row.value_json), DEFAULT_VOICE_OUTPUT_SETTINGS)
    } catch {
        return { ...DEFAULT_VOICE_OUTPUT_SETTINGS }
    }
}

/** Merge a partial update into the saved settings; invalid fields keep their current value. */
export function saveVoiceOutputSettings(input: unknown, db: Database.Database = getDb()): VoiceOutputSettings {
    const next = normalizeVoiceOutputSettings(input, getVoiceOutputSettings(db))
    db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(SETTINGS_KEY, JSON.stringify(next))
    return next
}

export function normalizeVoiceOutputSettings(input: unknown, fallback: VoiceOutputSettings): VoiceOutputSettings {
    const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const speed = typeof value.speed === 'number' && Number.isFinite(value.speed)
        ? Math.min(MAX_SPEECH_SPEED, Math.max(MIN_SPEECH_SPEED, value.speed))
        : fallback.speed
    return {
        enabled: typeof value.enabled === 'boolean' ? value.enabled : fallback.enabled,
        voiceId: typeof value.voiceId === 'string' ? value.voiceId.trim() : fallback.voiceId,
        speakerId: Number.isSafeInteger(value.speakerId) && (value.speakerId as number) >= 0 ? value.speakerId as number : fallback.speakerId,
        speed,
        autoRead: AUTO_READ_MODES.has(value.autoRead as VoiceAutoRead) ? value.autoRead as VoiceAutoRead : fallback.autoRead,
    }
}
