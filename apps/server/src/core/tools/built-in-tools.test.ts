import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOL_NAMES, getBuiltInMemoryToolKeys, getBuiltInNamespace, getBuiltInToolKey } from './built-in-tools.js'

describe('built-in tool categories', () => {
    it.each([
        'knowledge_assert', 'knowledge_delete',
        'knowledge_entity_merge',
    ])('keeps %s selectable and routable without automatic memory activation', (name) => {
        expect(BUILTIN_TOOL_NAMES).toContain(name)
        expect(getBuiltInToolKey(name)).toBe(`builtin:memory::${name}`)
        expect(getBuiltInMemoryToolKeys()).not.toContain(getBuiltInToolKey(name))
    })
    it.each([
        ['memory_search', 'builtin:memory', 'Built-In: Memory'],
        ['knowledge_assert', 'builtin:memory', 'Built-In: Memory'],
        ['schedule_create', 'builtin:scheduling', 'Built-In: Scheduling'],
        ['notify_user_in_app', 'builtin:notifications', 'Built-In: Notifications'],
        ['notify_user_on_channel', 'builtin:notifications', 'Built-In: Notifications'],
        ['manage_mcp', 'builtin:utility', 'Built-In: Utility'],
        ['attachment_search', 'builtin:utility', 'Built-In: Utility'],
        ['spawn_subagent', 'builtin:utility', 'Built-In: Utility'],
        ['continue_subagent', 'builtin:utility', 'Built-In: Utility'],
    ])('places %s in its category', (name, id, label) => {
        expect(getBuiltInNamespace(name)).toMatchObject({ id, label })
        expect(getBuiltInToolKey(name)).toBe(`${id}::${name}`)
    })
})
