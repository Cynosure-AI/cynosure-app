import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../../db/database.js'
import { CynoProfileError, DEFAULT_CYNO_AVATAR, DEFAULT_CYNO_SYSTEM_PROMPT, getCynoProfile, saveCynoProfile } from './cyno-profile.js'

let directory: string
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-cyno-'))
    vi.stubEnv('CYNOSURE_DATA_DIR', directory)
})
afterEach(() => {
    closeDb()
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
})

describe('Cyno profile', () => {
    test('starts with the crimson default face and falls back to it when reset', () => {
        expect(getCynoProfile().avatar).toEqual(DEFAULT_CYNO_AVATAR)
        const custom = { seed: null, hue: 30, tone: 0.4, shape: null }
        expect(saveCynoProfile({ avatar: custom }).avatar).toEqual(custom)
        expect(getCynoProfile().avatar).toEqual(custom)
        expect(() => saveCynoProfile({ avatar: { tone: 2 } })).toThrow(CynoProfileError)
        expect(saveCynoProfile({ avatar: null }).avatar).toEqual(DEFAULT_CYNO_AVATAR)
        expect(getCynoProfile().avatar).toEqual(DEFAULT_CYNO_AVATAR)
    })

    test('uploading an image selects it, and the generated avatar can be chosen while keeping it', () => {
        const image = 'data:image/png;base64,iVBORw0KGgo='
        expect(getCynoProfile().avatarSource).toBe('generated')
        expect(saveCynoProfile({ iconUrl: image })).toMatchObject({ iconUrl: image, avatarSource: 'image' })
        expect(saveCynoProfile({ avatarSource: 'generated' })).toMatchObject({ iconUrl: image, avatarSource: 'generated' })
        expect(saveCynoProfile({ iconUrl: null })).toMatchObject({ iconUrl: null, avatarSource: 'generated' })
        expect(() => saveCynoProfile({ avatarSource: 'emoji' })).toThrow(CynoProfileError)
    })

    test('profiles saved before the choice existed keep showing their image', () => {
        getDb().prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)')
            .run('cynoProfile', JSON.stringify({ name: 'Cyno', iconUrl: 'data:image/png;base64,iVBORw0KGgo=' }))
        expect(getCynoProfile().avatarSource).toBe('image')
    })

    test('stores the default face as null so it keeps following the default', () => {
        saveCynoProfile({ avatar: { ...DEFAULT_CYNO_AVATAR } })
        const row = getDb().prepare("SELECT value_json FROM settings WHERE key = 'cynoProfile'").get() as { value_json: string }
        expect(JSON.parse(row.value_json).avatar).toBeNull()
    })

    test('starts from defaults: All Memory, default tools, automatic routing and memory', () => {
        expect(getCynoProfile()).toMatchObject({
            name: 'Cyno', iconUrl: null, systemPrompt: DEFAULT_CYNO_SYSTEM_PROMPT, providerId: '', model: '',
            tools: null, memoryFolders: null, subAgents: [], autoToolRouting: true, autoMemory: true, dreamingEnabled: true,
        })
    })

    test('saves partial updates and keeps an empty memory selection as memory off', () => {
        saveCynoProfile({ name: '  Nova ', model: 'glm-5.3', providerId: 'openrouter', memoryFolders: [] })
        saveCynoProfile({ subAgents: [{ agentId: 'researcher' }, { agentId: 'researcher' }], reasoningEffort: 'high' })

        expect(getCynoProfile()).toMatchObject({
            name: 'Nova', model: 'glm-5.3', providerId: 'openrouter', memoryFolders: [],
            subAgents: [{ agentId: 'researcher' }], reasoningEffort: 'high', tools: null,
        })
        expect(getCynoProfile().updatedAt).toBeGreaterThan(0)
        expect(saveCynoProfile({ memoryFolders: null }).memoryFolders).toBeNull()
    })

    test('rejects invalid values without saving', () => {
        expect(() => saveCynoProfile({ name: ' ' })).toThrow(CynoProfileError)
        expect(() => saveCynoProfile({ iconUrl: 'https://example.com/icon.png' })).toThrow(CynoProfileError)
        expect(() => saveCynoProfile({ reasoningEffort: 'extreme' })).toThrow(CynoProfileError)
        expect(() => saveCynoProfile({ tools: 'all' })).toThrow(CynoProfileError)
        expect(getCynoProfile().name).toBe('Cyno')
        expect(saveCynoProfile({ iconUrl: 'data:image/png;base64,AAAA' }).iconUrl).toBe('data:image/png;base64,AAAA')
    })

    test('a corrupt stored row falls back to defaults', () => {
        getDb().prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES ('cynoProfile', '{not json')").run()
        expect(getCynoProfile().name).toBe('Cyno')
    })
})
