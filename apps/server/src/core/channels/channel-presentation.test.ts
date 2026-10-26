import { describe, expect, test } from 'vitest'
import { splitChannelReply } from './channel-presentation.js'

describe('channel reply splitting', () => {
    test('keeps paragraphs readable and preserves all content in order', () => {
        const text = 'A short paragraph.\n\nAnother paragraph with a little more detail.\n\nLast line.'
        const chunks = splitChannelReply(text, 30)
        expect(chunks.join('')).toBe(text)
        expect(chunks.every(chunk => chunk.length <= 30)).toBe(true)
        expect(chunks[0]).toBe('A short paragraph.')
    })

    test('splits long unbroken text without breaking emoji', () => {
        const text = 'x'.repeat(19) + '🥔'.repeat(30)
        const chunks = splitChannelReply(text, 20)
        expect(chunks.join('')).toBe(text)
        expect(chunks.every(chunk => chunk.length <= 20)).toBe(true)
        expect(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true)
        expect(chunks.every(chunk => !/^[\uDC00-\uDFFF]/.test(chunk))).toBe(true)
    })
})
