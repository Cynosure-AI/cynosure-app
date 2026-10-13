import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb } from '../../db/database.js'
import { createAgent } from '../agents/agent-store.js'
import { getDefaultMemoryFolder } from '../memory/memory-folder-scope.js'
import type { ToolRegistry } from '../tools/tool-registry.js'
import { resolveRunSettings } from './run-settings.js'

let directory: string
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-run-settings-'))
    vi.stubEnv('CYNOSURE_DATA_DIR', directory)
})
afterEach(() => {
    closeDb()
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
})

const registry = { hasKey: (key: string) => key !== 'unknown' } as ToolRegistry

describe('run settings', () => {
    test('an agent run without choices uses the agent\'s saved settings', () => {
        const agent = createAgent({ name: 'Researcher', systemPrompt: 'Research.', autoMemory: true, thinkingEnabled: false, reasoningEffort: 'high', maxContextTokens: 8192, autoApproveTools: true })
        const settings = resolveRunSettings(agent, {}, registry)

        expect(settings.plan).toMatchObject({
            providerOverride: undefined, modelOverride: undefined, systemPrompt: undefined,
            memoryFolderOverrides: [], selectedToolKeys: undefined, hasExplicitToolAllowlist: false,
            autoToolRouting: false, autoMemory: true, thinkingEnabled: false, reasoningEffort: 'high',
        })
        expect(settings).toMatchObject({ hitl: false, thinkingEnabled: false, reasoningEffort: 'high', maxContextTokens: 8192 })
        expect(settings.persistedConfig('m', 'p')).toMatchObject({ systemPrompt: 'Research.', model: 'm', providerId: 'p', autoMemory: true })
    })

    test('choices take precedence over the agent and tools are checked against the registry', () => {
        const agent = createAgent({ name: 'Researcher', autoMemory: true })
        const settings = resolveRunSettings(agent, {
            model: 'glm-5.3', providerId: 'openrouter', allowedTools: ['builtin::read', 'unknown'],
            autoToolRouting: false, autoMemory: false, thinkingEnabled: true, memoryFolderIds: [],
        }, registry)

        expect(settings.plan).toMatchObject({
            modelOverride: 'glm-5.3', providerOverride: 'openrouter', selectedToolKeys: ['builtin::read'],
            hasExplicitToolAllowlist: true, autoMemory: false, memoryFolderOverrides: [],
        })
        expect(settings.persistedConfig('glm-5.3', 'openrouter')).toMatchObject({ allowedTools: ['builtin::read'], memoryFolderIds: [] })
    })

    test('Cyno runs ask before tools, search all memory when unset, and follow the chosen memory', () => {
        const unset = resolveRunSettings(null, {}, registry)
        expect(unset).toMatchObject({ hitl: true, maxContextTokens: null })
        expect(unset.plan).toMatchObject({ memoryFolderOverrides: undefined, autoToolRouting: true, autoMemory: true })

        const allMemory = resolveRunSettings(null, { memoryFolderIds: [getDefaultMemoryFolder()!.id] }, registry)
        expect(allMemory.plan.memoryFolderOverrides!.length).toBeGreaterThan(0)
    })
})
