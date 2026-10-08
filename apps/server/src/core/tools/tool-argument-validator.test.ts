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

    describe('JSON Schema dialects', () => {
        test('validates draft 2020-12 schemas such as Playwright MCP tools', () => {
            const browserNavigate = {
                $schema: 'https://json-schema.org/draft/2020-12/schema',
                type: 'object',
                properties: { url: { type: 'string', description: 'The URL to navigate to' } },
                required: ['url'],
                additionalProperties: false,
            }
            expect(validateToolArguments({ url: 'https://example.com' }, browserNavigate)).toEqual({ valid: true, errors: [] })
            expect(validateToolArguments({}, browserNavigate)).toEqual({ valid: false, errors: ['$.url is required'] })
        })

        test('applies 2020-12 semantics for prefixItems', () => {
            const tuple = {
                $schema: 'https://json-schema.org/draft/2020-12/schema',
                type: 'array',
                prefixItems: [{ type: 'string' }, { type: 'integer' }],
                items: false,
            }
            expect(validateToolArguments(['a', 1], tuple).valid).toBe(true)
            expect(validateToolArguments(['a', 'b'], tuple).valid).toBe(false)
            expect(validateToolArguments(['a', 1, 2], tuple).valid).toBe(false)
        })

        test('validates draft 2019-09 schemas including unevaluatedProperties', () => {
            const schema = {
                $schema: 'https://json-schema.org/draft/2019-09/schema',
                type: 'object',
                allOf: [{ properties: { name: { type: 'string' } } }],
                unevaluatedProperties: false,
            }
            expect(validateToolArguments({ name: 'x' }, schema).valid).toBe(true)
            expect(validateToolArguments({ name: 'x', extra: 1 }, schema)).toEqual({ valid: false, errors: ['$.extra is not allowed'] })
        })

        test('accepts explicit draft-07 and common spelling variants of meta-schema URIs', () => {
            for (const $schema of [
                'http://json-schema.org/draft-07/schema#',
                'https://json-schema.org/draft-07/schema',
                'http://json-schema.org/draft/2020-12/schema',
                'https://json-schema.org/draft/2020-12/schema#',
            ]) {
                const schema = { $schema, type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }
                expect(validateToolArguments({ n: 1 }, schema).valid).toBe(true)
                expect(validateToolArguments({ n: 'one' }, schema).valid).toBe(false)
            }
        })

        test('fails closed for unsupported dialects', () => {
            const result = validateToolArguments({}, { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' })
            expect(result.valid).toBe(false)
            expect(result.errors[0]).toMatch(/^tool schema is invalid: unsupported JSON Schema dialect/)
        })
    })
})
