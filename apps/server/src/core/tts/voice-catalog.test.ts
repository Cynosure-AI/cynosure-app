import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCatalog, deleteVoice, getInstalledVoicePaths, getTtsDir, isValidVoiceId, listVoices, resetVoiceCatalogState } from './voice-catalog.js'

const piperVoices = {
    'en_GB-aru-medium': {
        name: 'aru', quality: 'medium', num_speakers: 12,
        language: { code: 'en_GB', name_english: 'English', country_english: 'Great Britain' },
        files: { 'en/en_GB/aru/medium/en_GB-aru-medium.onnx': { size_bytes: 76754097 }, 'en/en_GB/aru/medium/en_GB-aru-medium.onnx.json': { size_bytes: 5048 } },
    },
    'de_DE-thorsten-medium': {
        name: 'thorsten', quality: 'medium', num_speakers: 1,
        language: { code: 'de_DE', name_english: 'German', country_english: 'Germany' },
        files: { 'de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx': { size_bytes: 63201294 } },
    },
    'it_IT-serena-medium': { name: 'serena', quality: 'medium', language: { code: 'it_IT' }, files: {} },
    '../escape-medium': { name: 'bad', quality: 'medium' },
}

let directory: string
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-voices-'))
    vi.stubEnv('CYNOSURE_DATA_DIR', directory)
    resetVoiceCatalogState()
})
afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    rmSync(directory, { recursive: true, force: true })
})

function installFakeVoice(id: string): void {
    const dir = join(getTtsDir(), 'voices', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'model.onnx'), '')
    writeFileSync(join(dir, 'tokens.txt'), '')
    writeFileSync(join(dir, 'voice.json'), JSON.stringify({ id, name: 'aru', languageCode: 'en_GB', languageName: 'English', countryName: '', quality: 'medium', numSpeakers: 12, sizeBytes: 1 }))
    mkdirSync(join(getTtsDir(), 'espeak-ng-data'), { recursive: true })
    writeFileSync(join(getTtsDir(), 'espeak-ng-data', 'phontab'), '')
}

describe('voice catalog', () => {
    test('accepts only catalog-shaped voice ids', () => {
        expect(isValidVoiceId('en_GB-aru-medium')).toBe(true)
        expect(isValidVoiceId('de_DE-thorsten_emotional-x_low')).toBe(true)
        expect(isValidVoiceId('../en_GB-aru-medium')).toBe(false)
        expect(isValidVoiceId('en_GB-aru-medium/../../x')).toBe(false)
        expect(isValidVoiceId(42)).toBe(false)
    })

    test('lists only mirrored voices, sorted by language', () => {
        const voices = buildCatalog(piperVoices, new Set(['en_GB-aru-medium', 'de_DE-thorsten-medium', '../escape-medium']))
        expect(voices.map((voice) => voice.id)).toEqual(['en_GB-aru-medium', 'de_DE-thorsten-medium'])
        expect(voices[0]).toEqual({
            id: 'en_GB-aru-medium', name: 'aru', languageCode: 'en_GB', languageName: 'English', countryName: 'Great Britain',
            quality: 'medium', numSpeakers: 12, sizeBytes: 76754097,
        })
    })

    test('still lists installed voices when the catalog cannot be fetched', async () => {
        installFakeVoice('en_GB-aru-medium')
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

        const list = await listVoices()

        expect(list.catalogError).toContain('offline')
        expect(list.voices).toEqual([expect.objectContaining({ id: 'en_GB-aru-medium', installed: true })])
    })

    test('marks installed catalog voices and resolves their files', async () => {
        installFakeVoice('en_GB-aru-medium')
        vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('voices.json')
            ? piperVoices
            : [{ id: 'csukuangfj/vits-piper-en_GB-aru-medium' }, { id: 'csukuangfj/vits-piper-de_DE-thorsten-medium' }])))

        const list = await listVoices()

        expect(list.voices.map((voice) => [voice.id, voice.installed])).toEqual([['en_GB-aru-medium', true], ['de_DE-thorsten-medium', false]])
        expect(getInstalledVoicePaths('en_GB-aru-medium')?.model).toBe(join(getTtsDir(), 'voices', 'en_GB-aru-medium', 'model.onnx'))
        expect(getInstalledVoicePaths('de_DE-thorsten-medium')).toBeNull()
    })

    test('deletes an installed voice', () => {
        installFakeVoice('en_GB-aru-medium')
        expect(deleteVoice('en_GB-aru-medium')).toBe(true)
        expect(getInstalledVoicePaths('en_GB-aru-medium')).toBeNull()
        expect(deleteVoice('en_GB-aru-medium')).toBe(false)
    })
})
