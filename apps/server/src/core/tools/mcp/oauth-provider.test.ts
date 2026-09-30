import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { McpOAuthProvider } from './oauth-provider.js'

let directory: string
const url = 'https://example.test/mcp'
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cynosure-oauth-'))
    vi.stubEnv('CYNOSURE_DATA_DIR', directory)
})
afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
})
function provider() {
    return new McpOAuthProvider(url, 'http://localhost:3099/api/mcp/oauth/callback/server', vi.fn())
}
test('uses public client registration and validates a unique state per attempt', () => {
    const first = provider()
    const second = provider()
    expect(first.clientMetadata.token_endpoint_auth_method).toBe('none')
    expect(first.validateState(first.state())).toBe(true)
    expect(first.validateState(second.state())).toBe(false)
    expect(first.validateState()).toBe(false)
    expect(first.validateState('wrong')).toBe(false)
    expect(first.validateState('é'.repeat(64))).toBe(false)
})
test('restores tokens and PKCE verifier for reconnects and stores secrets privately', () => {
    const first = provider()
    const tokens = { access_token: 'access', token_type: 'Bearer', refresh_token: 'refresh' }
    first.saveTokens(tokens)
    first.saveCodeVerifier('pkce-verifier')
    const restored = provider()
    expect(restored.tokens()).toEqual(tokens)
    expect(restored.codeVerifier()).toBe('pkce-verifier')
    const hash = createHash('md5').update(url).digest('hex')
    expect(statSync(join(directory, 'data', 'mcp-oauth', hash, 'tokens.json')).mode & 0o777).toBe(0o600)
    restored.invalidateCredentials('all')
    expect(provider().tokens()).toBeUndefined()
})
