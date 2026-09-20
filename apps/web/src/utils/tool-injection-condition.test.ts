import { describe, expect, test } from 'vitest'
import { toolInjectionCondition } from './tool-injection-condition'

describe('toolInjectionCondition', () => {
    test.each([
        ['memory_search', 'builtin:memory', 'Memory enabled + folder available'],
        ['knowledge_assert', 'builtin:memory', 'Memory enabled + folder available'],
        ['todo_write', 'builtin:utility', 'Thinking + execution tools'],
        ['attachment_read', 'builtin:utility', 'Tool-capable chat + files'],
        ['expand_available_toolset', 'builtin:utility', 'Auto-tool routing enabled'],
        ['spawn_subagent', 'builtin:utility', 'Sub-agent assigned'],
        ['schedule_create', 'builtin:scheduling', 'Selected or auto-routed'],
        ['manage_mcp', 'builtin:utility', 'Selected explicitly'],
        ['notify_user_in_app', 'builtin:notifications', 'Selected or auto-routed'],
        ['search', 'mcp:example', 'MCP'],
    ])('%s uses its runtime injection condition', (name, namespace, expected) => {
        expect(toolInjectionCondition(name, namespace)).toBe(expected)
    })
})
