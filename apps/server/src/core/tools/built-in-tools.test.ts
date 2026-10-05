import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOL_NAMES, getBuiltInNamespace, getBuiltInToolKey } from './built-in-tools.js'

describe('built-in tool categories', () => {
    it('exposes one unified notification tool', () => {
        expect(BUILTIN_TOOL_NAMES).toContain('notify_user')
        expect(BUILTIN_TOOL_NAMES).not.toContain('notify_user_in_app')
        expect(BUILTIN_TOOL_NAMES).not.toContain('notify_user_on_channel')
    })
    it.each([
        ['memory_search', 'builtin:memory', 'Built-In: Memory'],
        ['schedule_create', 'builtin:scheduling', 'Built-In: Scheduling'],
        ['notify_user', 'builtin:utility', 'Built-In: Utility'],
        ['manage_mcp', 'builtin:utility', 'Built-In: Utility'],
        ['attachment_search', 'builtin:utility', 'Built-In: Utility'],
        ['spawn_subagent', 'builtin:utility', 'Built-In: Utility'],
        ['continue_subagent', 'builtin:utility', 'Built-In: Utility'],
    ])('places %s in its category', (name, id, label) => {
        expect(getBuiltInNamespace(name)).toMatchObject({ id, label })
        expect(getBuiltInToolKey(name)).toBe(`${id}::${name}`)
    })
})
