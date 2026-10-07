import { describe, expect, test } from 'vitest'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describeMcpConnectionError, toMcpConnectionError } from './connection-error.js'

function fetchFailed(cause: unknown): TypeError {
    return new TypeError('fetch failed', { cause })
}

function codedError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code })
}

describe('describeMcpConnectionError', () => {
    test('unwraps a self-signed certificate failure hidden behind "fetch failed"', () => {
        const err = fetchFailed(codedError('self-signed certificate in certificate chain', 'SELF_SIGNED_CERT_IN_CHAIN'))
        const message = describeMcpConnectionError(err)
        expect(message).toContain('fetch failed (SELF_SIGNED_CERT_IN_CHAIN: self-signed certificate in certificate chain)')
        expect(message).toContain('NODE_EXTRA_CA_CERTS')
    })

    test('explains DNS failures', () => {
        const err = fetchFailed(codedError('getaddrinfo ENOTFOUND site.local', 'ENOTFOUND'))
        const message = describeMcpConnectionError(err)
        expect(message).toContain('getaddrinfo ENOTFOUND site.local')
        expect(message).toContain('hostname could not be resolved')
    })

    test('reads codes from AggregateError causes', () => {
        const aggregate = new AggregateError([
            codedError('connect ECONNREFUSED ::1:8080', 'ECONNREFUSED'),
            codedError('connect ECONNREFUSED 127.0.0.1:8080', 'ECONNREFUSED'),
        ], '')
        expect(describeMcpConnectionError(fetchFailed(aggregate))).toContain('Connection refused')
    })

    test('adds HTTP status hints for Streamable HTTP errors', () => {
        const err = new StreamableHTTPError(404, 'Error POSTing to endpoint: Not Found')
        expect(describeMcpConnectionError(err)).toContain('No MCP endpoint at this URL')
    })

    test('passes through plain errors unchanged', () => {
        expect(describeMcpConnectionError(new Error('MCP connection timeout'))).toBe('MCP connection timeout')
    })

    test('keeps the original error as cause', () => {
        const original = fetchFailed(codedError('boom', 'ECONNRESET'))
        expect(toMcpConnectionError(original).cause).toBe(original)
    })
})
