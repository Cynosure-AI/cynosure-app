import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import type { AgentData } from '../agents/agent-store.js'
import type { ToolRegistry } from '../tools/tool-registry.js'
import {
    buildInitialExecutionConfig,
    buildPersistedChatConfig,
    parseExecutionConfig,
    resolveChatRunFlags,
    resolveMemoryFolderOverrides,
    resolveToolSelection,
} from './run-config.js'

describe('chat run configuration', () => {
    test('deduplicates valid explicit tools and distinguishes manual from automatic routing', () => {
        const registry = { hasKey: (key: string) => key !== 'unknown' } as ToolRegistry

        expect(resolveToolSelection(registry, ['builtin::read', 'unknown', 'builtin::read'], false)).toEqual({
            selectedToolKeys: ['builtin::read'],
            hasExplicitToolAllowlist: true,
        })
        expect(resolveToolSelection(registry, [], true).hasExplicitToolAllowlist).toBe(false)
        expect(resolveToolSelection(registry)).toEqual({
            selectedToolKeys: [],
            hasExplicitToolAllowlist: false,
        })
    })

    test('lets a request override the agent automatic-memory default', () => {
        const agent = { autoMemory: true } as AgentData

        expect(resolveChatRunFlags({ resolvedAgent: agent }).autoMemory).toBe(true)
        expect(resolveChatRunFlags({ resolvedAgent: agent, autoMemory: false }).autoMemory).toBe(false)
        expect(resolveChatRunFlags({ resolvedAgent: null }).autoMemory).toBe(true)
    })

    test('resolves unique, existing memory folders while preserving request order', () => {
        const db = new Database(':memory:')
        db.exec('CREATE TABLE memory_folders (id TEXT, name TEXT, description TEXT, directory_path TEXT, is_uncategorized INTEGER)')
        db.prepare('INSERT INTO memory_folders VALUES (?, ?, ?, ?, ?)').run('uncategorized', 'Uncategorized', '', '/tmp/memory', 1)
        db.prepare('INSERT INTO memory_folders VALUES (?, ?, ?, ?, ?)').run('project', 'Project', 'Delivery context', '/tmp/project', 0)

        expect(resolveMemoryFolderOverrides(db, [' project ', '', 'missing', 'uncategorized', 'project'])).toEqual([
            { id: 'project', name: 'Project', description: 'Delivery context', folderPath: expect.any(String) },
            { id: 'uncategorized', name: 'Uncategorized', folderPath: '' },
        ])
        expect(resolveMemoryFolderOverrides(db)).toBeUndefined()
        db.close()
    })

    test('builds stable persisted defaults without sharing input arrays', () => {
        const selectedToolKeys = ['builtin::read']
        const persisted = buildPersistedChatConfig({
            selectedToolKeys,
            responseModel: 'model',
            responseProvider: 'provider',
            thinkingEnabled: true,
            autoToolRouting: false,
            autoMemory: true,
        })

        expect(persisted).toMatchObject({
            allowedTools: ['builtin::read'],
            subAgents: [],
            memoryFolderIds: [],
            systemPrompt: '',
            model: 'model',
            providerId: 'provider',
            reasoningEffort: 'medium',
            autoMemory: true,
        })
    })

    test('copies an agent preset and applies safe execution defaults', () => {
        const agent = {
            tools: ['tool-a'],
            subAgents: [{ agentId: 'sub-agent' }],
            systemPrompt: 'Be precise',
            model: 'model-a',
            providerId: 'provider-a',
            thinkingEnabled: false,
            reasoningEffort: 'high',
            autoToolRouting: true,
            autoMemory: true,
        } as AgentData
        const result = buildInitialExecutionConfig({ agent, memoryFolderIds: ['space-a'] })

        expect(result).toEqual({
            allowedTools: ['tool-a'],
            subAgents: [{ agentId: 'sub-agent' }],
            memoryFolderIds: ['space-a'],
            systemPrompt: 'Be precise',
            model: 'model-a',
            providerId: 'provider-a',
            thinkingEnabled: false,
            reasoningEffort: 'high',
            autoToolRouting: true,
            autoMemory: true,
        })
        expect(result.allowedTools).not.toBe(agent.tools)
        expect(buildInitialExecutionConfig().thinkingEnabled).toBe(true)
    })

    test('sanitizes persisted JSON instead of trusting malformed field types', () => {
        const parsed = parseExecutionConfig(JSON.stringify({
            allowedTools: ['tool-a', 1, null],
            subAgents: [{ agentId: 'valid' }, { agentId: 1 }, null],
            memoryFolderIds: ['space-a', false],
            systemPrompt: 12,
            model: null,
            providerId: {},
            thinkingEnabled: 'no',
            reasoningEffort: 'extreme',
            autoToolRouting: 1,
            autoMemory: true,
        }))

        expect(parsed).toEqual({
            allowedTools: ['tool-a'],
            subAgents: [{ agentId: 'valid' }],
            memoryFolderIds: ['space-a'],
            systemPrompt: '',
            model: '',
            providerId: '',
            thinkingEnabled: true,
            reasoningEffort: 'medium',
            autoToolRouting: false,
            autoMemory: true,
        })
        expect(parseExecutionConfig(null)).toEqual(buildInitialExecutionConfig())
    })
})
