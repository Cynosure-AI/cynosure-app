import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb } from '../../db/database.js'
import { DEFAULT_VOICE_OUTPUT_SETTINGS, getVoiceOutputSettings, normalizeVoiceOutputSettings, saveVoiceOutputSettings } from './voice-settings.js'

let directory: string
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-voice-'))
    vi.stubEnv('CYNOSURE_DATA_DIR', directory)
})
afterEach(() => {
    closeDb()
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
})

describe('voice output settings', () => {
    test('start enabled, without a voice, reading aloud only voice turns', () => {
        expect(getVoiceOutputSettings()).toEqual({ enabled: true, voiceId: '', speakerId: 0, speed: 1, autoRead: 'voice' })
    })

    test('merges partial updates and keeps earlier choices', () => {
        saveVoiceOutputSettings({ voiceId: ' en_GB-aru-medium ', speakerId: 3 })
        expect(saveVoiceOutputSettings({ autoRead: 'always' })).toEqual({
            enabled: true, voiceId: 'en_GB-aru-medium', speakerId: 3, speed: 1, autoRead: 'always',
        })
        expect(getVoiceOutputSettings().voiceId).toBe('en_GB-aru-medium')
    })

    test('clamps speed and ignores invalid values', () => {
        expect(normalizeVoiceOutputSettings({ speed: 9, speakerId: -1, autoRead: 'loud', enabled: 'yes' }, DEFAULT_VOICE_OUTPUT_SETTINGS))
            .toEqual({ ...DEFAULT_VOICE_OUTPUT_SETTINGS, speed: 2 })
        expect(normalizeVoiceOutputSettings({ speed: 0.1 }, DEFAULT_VOICE_OUTPUT_SETTINGS).speed).toBe(0.5)
    })
})
