import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import type { AgentData } from '../agents/agent-store.js'
import type { ToolRegistry } from '../tools/tool-registry.js'
import {
    buildInitialExecutionConfig,
    buildPersistedChatConfig,
    parseExecutionConfig,
    resolveChatRunFlags,
    resolveMemorySpaceOverrides,
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
        expect(resolveChatRunFlags({ resolvedAgent: null }).autoMemory).toBe(false)
    })

    test('resolves unique, existing memory spaces while preserving request order', () => {
        const db = new Database(':memory:')
        db.exec('CREATE TABLE memory_spaces (id TEXT, name TEXT, folder_path TEXT, is_default INTEGER)')
        db.prepare('INSERT INTO memory_spaces VALUES (?, ?, ?, ?)').run('default', 'Default', '/tmp/default', 1)
        db.prepare('INSERT INTO memory_spaces VALUES (?, ?, ?, ?)').run('project', 'Project', '/tmp/project', 0)

        expect(resolveMemorySpaceOverrides(db, [' project ', '', 'missing', 'default', 'project'])).toEqual([
            { id: 'project', name: 'Project', relativePath: expect.any(String) },
            { id: 'default', name: 'Default', relativePath: '' },
        ])
        expect(resolveMemorySpaceOverrides(db)).toBeUndefined()
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
            memorySpaceIds: [],
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
        const result = buildInitialExecutionConfig({ agent, memorySpaceIds: ['space-a'] })

        expect(result).toEqual({
            allowedTools: ['tool-a'],
            subAgents: [{ agentId: 'sub-agent' }],
            memorySpaceIds: ['space-a'],
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
            memorySpaceIds: ['space-a', false],
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
            memorySpaceIds: ['space-a'],
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
