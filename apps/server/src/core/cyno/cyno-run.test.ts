import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb } from '../../db/database.js'
import { getDefaultMemoryFolder } from '../memory/memory-folder-scope.js'
import { getBuiltInToolKey } from '../tools/built-in-tools.js'
import { saveCynoProfile } from './cyno-profile.js'
import { cynoExecutionConfig } from './cyno-run.js'
import { resolveRunSettings } from '../agent/run-settings.js'

let directory: string
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-cyno-run-'))
    vi.stubEnv('CYNOSURE_DATA_DIR', directory)
})
afterEach(() => {
    closeDb()
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
})

describe('Cyno runs outside the app', () => {
    test('unset tools and memory resolve to the defaults a new Cyno chat uses', () => {
        const config = cynoExecutionConfig()
        expect(config.allowedTools).toContain(getBuiltInToolKey('schedule_create'))
        expect(config.allowedTools).toContain(getBuiltInToolKey('manage_mcp'))
        expect(config.memoryFolderIds).toEqual([getDefaultMemoryFolder()!.id])
        expect(resolveRunSettings(null, config).plan.memoryFolderOverrides!.length).toBeGreaterThan(0)
    })

    test('saved choices are used as they are, including memory off', () => {
        saveCynoProfile({ tools: [], memoryFolders: [], model: 'glm-5.3', providerId: 'openrouter', autoToolRouting: false })
        const config = cynoExecutionConfig()

        expect(config).toMatchObject({ allowedTools: [], memoryFolderIds: [], model: 'glm-5.3', providerId: 'openrouter' })
        expect(resolveRunSettings(null, config).plan).toMatchObject({
            memoryFolderOverrides: [], modelOverride: 'glm-5.3', providerOverride: 'openrouter', hasExplicitToolAllowlist: true,
        })
    })
})
