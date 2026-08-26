import { describe, expect, it } from 'vitest'
import { getBuiltInNamespace, getBuiltInToolKey } from './built-in-tools.js'

describe('built-in tool categories', () => {
    it.each([
        ['memory_semantic_search', 'builtin:memory', 'Built-In: Memory'],
        ['knowledge_assert', 'builtin:memory', 'Built-In: Memory'],
        ['schedule_create', 'builtin:scheduling', 'Built-In: Scheduling'],
        ['create_app_notification', 'builtin:notifications', 'Built-In: Notifications'],
        ['notify_user_on_channel', 'builtin:notifications', 'Built-In: Notifications'],
        ['attachment_search', 'builtin:utility', 'Built-In: Utility'],
        ['spawn_subagent', 'builtin:utility', 'Built-In: Utility'],
    ])('places %s in its category', (name, id, label) => {
        expect(getBuiltInNamespace(name)).toEqual({ id, label })
        expect(getBuiltInToolKey(name)).toBe(`${id}::${name}`)
    })
})
