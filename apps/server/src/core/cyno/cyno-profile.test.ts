import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, getDb } from '../../db/database.js'
import { CynoProfileError, DEFAULT_CYNO_SYSTEM_PROMPT, getCynoProfile, saveCynoProfile } from './cyno-profile.js'

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
