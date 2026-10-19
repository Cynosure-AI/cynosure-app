import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../../../db/database.js'
import { makeScheduleTools, SCHEDULE_TOOL_NAMES } from './schedule-tools.js'
import { hydrateBuiltInTools, getBuiltInNamespace } from '../built-in-tools.js'
import { ToolRegistry } from '../tool-registry.js'
import type { RegistryAwareToolDefinition } from '../../gateway/providers/base.provider.js'

const { routeTools } = vi.hoisted(() => ({
    routeTools: vi.fn(async (input: { tools: RegistryAwareToolDefinition[] }) => input.tools),
}))
vi.mock('../../agent/pre-execution/auto-tool-routing.js', () => ({ applyAutoToolRouting: routeTools }))

import { resolveExecutionTools } from '../../agent/pre-execution/execution-tools.js'
import { resetStickyToolsets } from '../../agent/pre-execution/conversation-toolset.js'

let directory: string
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-temporary-scheduling-'))
    process.env.CYNOSURE_DATA_DIR = directory
    getDb().prepare('INSERT INTO conversations (id, title, temporary, created_at, updated_at) VALUES (?, ?, 1, 1, 1)')
        .run('temporary-chat', 'Temporary chat')
    resetStickyToolsets()
})

afterEach(() => {
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    rmSync(directory, { recursive: true, force: true })
})

test('every scheduling tool rejects execution in a temporary chat', async () => {
    for (const tool of makeScheduleTools({ agentId: 'agent-1', conversationId: 'temporary-chat' })) {
        await expect(tool.execute({})).resolves.toMatchObject({
            success: false, error: expect.stringContaining('not available in temporary chats'),
        })
    }
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM cron_jobs').get()).toEqual({ count: 0 })
})

test('hydration excludes scheduling tools even when their execution names are aliased', () => {
    const tools = makeScheduleTools({ agentId: 'agent-1' }).map(tool => ({
        ...tool, originalName: tool.name, name: `aliased_${tool.name}`,
    }))
    const context = { conversationId: 'temporary-chat', agentId: 'agent-1', broadcast: () => undefined, memoryFolderOverrides: [] }
    expect(hydrateBuiltInTools(tools, context)).toEqual([])

    getDb().prepare('UPDATE conversations SET temporary = 0 WHERE id = ?').run('temporary-chat')
    expect(hydrateBuiltInTools(tools, context).map(tool => tool.originalName)).toEqual(SCHEDULE_TOOL_NAMES)
})

test.each([
    { autoToolRouting: false, suppressAutoTools: false },
    { autoToolRouting: true, suppressAutoTools: false },
    { autoToolRouting: true, suppressAutoTools: true },
])('excludes scheduling from selected, routed and discoverable tools: %j', async ({ autoToolRouting, suppressAutoTools }) => {
    const registry = new ToolRegistry()
    for (const tool of makeScheduleTools({ agentId: 'agent-1' })) registry.register(tool, getBuiltInNamespace(tool.name))
    registry.register({ name: 'other_tool', description: 'Other tool', parameters: {}, timeout: 1_000,
        execute: async () => ({ success: true, output: '' }) }, { id: 'mcp:test', label: 'Test' })
    const selectedKeys = registry.listRegisteredTools().map(tool => tool.key)
    const input = {
        preset: { id: 'agent-1', tools: selectedKeys, subAgents: [], autoToolRouting },
        conversationId: 'temporary-chat', broadcast: () => undefined,
        toolRegistry: registry, gateway: {}, resolvedProviderId: 'provider', resolvedModel: 'model',
        preferredToolKeys: selectedKeys, autoToolRouting, suppressAutoTools, autoMemory: false,
        memoryFolderOverrides: [],
    } as unknown as Parameters<typeof resolveExecutionTools>[0]

    const result = await resolveExecutionTools(input)
    expect(result.tools.map(tool => tool.name)).toContain('other_tool')
    expect(result.tools.filter(tool => SCHEDULE_TOOL_NAMES.includes(tool.name as never))).toEqual([])
    for (const [call] of routeTools.mock.calls) {
        expect(call.tools.map(tool => tool.name)).toEqual(['other_tool'])
    }

    getDb().prepare('UPDATE conversations SET temporary = 0 WHERE id = ?').run('temporary-chat')
    const saved = await resolveExecutionTools(input)
    expect(saved.tools.map(tool => tool.originalName ?? tool.name)).toEqual(expect.arrayContaining([...SCHEDULE_TOOL_NAMES]))
})
