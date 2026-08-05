import { describe, expect, test } from 'vitest'
import { validateToolArguments } from './tool-argument-validator.js'

describe('validateToolArguments', () => {
    const schema = {
        type: 'object',
        additionalProperties: false,
        properties: {
            documentId: { type: 'string' },
            partStart: { type: 'integer', minimum: 1 },
        },
        required: ['documentId', 'partStart'],
    }

    test('accepts valid structured arguments', () => {
        expect(validateToolArguments({ documentId: 'doc', partStart: 1 }, schema)).toEqual({ valid: true, errors: [] })
    })

    test('rejects missing, mistyped, and extraneous arguments', () => {
        const result = validateToolArguments({ partStart: 0.5, mode: 'append' }, schema)
        expect(result.valid).toBe(false)
        expect(result.errors).toEqual(expect.arrayContaining([
            '$.documentId is required',
            '$.mode is not allowed',
            '$.partStart must be integer',
        ]))
    })

    test('supports composed JSON Schemas used by third-party tools', () => {
        const composed = {
            oneOf: [
                { type: 'object', additionalProperties: false, properties: { query: { type: 'string' } }, required: ['query'] },
                { type: 'object', additionalProperties: false, properties: { id: { type: 'integer' } }, required: ['id'] },
            ],
        }
        expect(validateToolArguments({ id: 42 }, composed).valid).toBe(true)
        expect(validateToolArguments({ id: '42' }, composed).valid).toBe(false)
    })
})
