import { describe, expect, test } from 'vitest'
import { isDiscordUserAllowed, normalizeDiscordUserIds } from './discord.channel.js'

describe('Discord user allowlist', () => {
    test('keeps only unique snowflake IDs', () => {
        expect(normalizeDiscordUserIds([' 123456789012345678 ', '123456789012345678', 'abc', '42', 123456789012345678]))
            .toEqual(['123456789012345678'])
        expect(normalizeDiscordUserIds(undefined)).toEqual([])
    })

    test('denies unknown and missing users', () => {
        const allowed = new Set(['123456789012345678'])
        expect(isDiscordUserAllowed(allowed, '123456789012345678')).toBe(true)
        expect(isDiscordUserAllowed(allowed, '876543210987654321')).toBe(false)
        expect(isDiscordUserAllowed(allowed, undefined)).toBe(false)
    })
})
