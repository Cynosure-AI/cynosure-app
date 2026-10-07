import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync, cpSync } from 'fs'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { getAppDataDir } from '../../data-dir.js'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
    OAuthClientMetadata,
    OAuthTokens,
    OAuthClientInformationMixed,
} from '@modelcontextprotocol/sdk/shared/auth.js'

/**
 * File-backed OAuthClientProvider for MCP StreamableHTTP connections.
 * Persists tokens, client info, and code verifiers to disk under
 * `<appDataDir>/mcp-oauth/<md5(storageKey)>/`. The storage key defaults to the
 * server URL; McpManager passes a per-server key so two entries pointing at
 * the same URL can hold different accounts.
 */
export class McpOAuthProvider implements OAuthClientProvider {
    private storageDir: string
    private _tokens?: OAuthTokens
    private _clientInfo?: OAuthClientInformationMixed
    private _codeVerifier?: string
    private _state = randomBytes(32).toString('hex')

    state(): string {
        return this._state
    }

    validateState(state?: string): boolean {
        if (!state || state.length !== this._state.length) return false
        const actual = Buffer.from(state)
        const expected = Buffer.from(this._state)
        return actual.length === expected.length && timingSafeEqual(actual, expected)
    }

    static storageDirFor(storageKey: string): string {
        return join(getAppDataDir(), 'mcp-oauth', createHash('md5').update(storageKey).digest('hex'))
    }

    static serverStorageKey(serverId: string, serverUrl: string): string {
        return `${serverId}|${serverUrl}`
    }

    constructor(
        serverUrl: string,
        private _redirectUrl: string,
        private onRedirect: (url: string) => void,
        storageKey: string = serverUrl,
    ) {
        this.storageDir = McpOAuthProvider.storageDirFor(storageKey)
        // Tokens used to be stored per URL; carry them over so existing sign-ins survive.
        const legacyDir = McpOAuthProvider.storageDirFor(serverUrl)
        if (storageKey !== serverUrl && !existsSync(this.storageDir) && existsSync(legacyDir)) {
            try { cpSync(legacyDir, this.storageDir, { recursive: true }) } catch { /* start fresh */ }
        }
        mkdirSync(this.storageDir, { recursive: true })

        // Restore persisted state
        this._tokens = this.loadJson('tokens.json')
        this._clientInfo = this.loadJson('client-info.json')
        const cv = this.loadJson<{ verifier: string }>('code-verifier.json')
        if (cv) this._codeVerifier = cv.verifier
    }

    get redirectUrl(): string {
        return this._redirectUrl
    }

    get clientMetadata(): OAuthClientMetadata {
        return {
            client_name: 'Cynosure',
            redirect_uris: [this._redirectUrl],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
        }
    }

    clientInformation(): OAuthClientInformationMixed | undefined {
        return this._clientInfo
    }

    saveClientInformation(info: OAuthClientInformationMixed): void {
        this._clientInfo = info
        this.saveJson('client-info.json', info)
    }

    tokens(): OAuthTokens | undefined {
        return this._tokens
    }

    saveTokens(tokens: OAuthTokens): void {
        this._tokens = tokens
        this.saveJson('tokens.json', tokens)
    }

    redirectToAuthorization(authorizationUrl: URL): void {
        this.onRedirect(authorizationUrl.toString())
    }

    saveCodeVerifier(codeVerifier: string): void {
        this._codeVerifier = codeVerifier
        this.saveJson('code-verifier.json', { verifier: codeVerifier })
    }

    codeVerifier(): string {
        if (!this._codeVerifier) {
            throw new Error('No code verifier saved')
        }
        return this._codeVerifier
    }

    invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
        if (scope === 'all' || scope === 'tokens') {
            this._tokens = undefined
            this.deleteFile('tokens.json')
        }
        if (scope === 'all' || scope === 'client') {
            this._clientInfo = undefined
            this.deleteFile('client-info.json')
        }
        if (scope === 'all' || scope === 'verifier') {
            this._codeVerifier = undefined
            this.deleteFile('code-verifier.json')
        }
        if (scope === 'all' || scope === 'discovery') {
            this.deleteFile('discovery-state.json')
        }
    }

    saveDiscoveryState(state: OAuthDiscoveryState): void {
        this.saveJson('discovery-state.json', state)
    }

    discoveryState(): OAuthDiscoveryState | undefined {
        return this.loadJson('discovery-state.json')
    }

    /** Wipe all persisted OAuth state (for forced re-auth). */
    clearAll(): void {
        try { rmSync(this.storageDir, { recursive: true, force: true }) } catch { /* ignore */ }
        this._tokens = undefined
        this._clientInfo = undefined
        this._codeVerifier = undefined
    }

    // ── Persistence helpers ───────────────────────────────────────────

    private loadJson<T>(filename: string): T | undefined {
        const p = join(this.storageDir, filename)
        if (!existsSync(p)) return undefined
        try { return JSON.parse(readFileSync(p, 'utf-8')) as T } catch { return undefined }
    }

    private saveJson(filename: string, data: unknown): void {
        if (!existsSync(this.storageDir)) mkdirSync(this.storageDir, { recursive: true })
        writeFileSync(join(this.storageDir, filename), JSON.stringify(data, null, 2), { mode: 0o600 })
    }

    private deleteFile(filename: string): void {
        const p = join(this.storageDir, filename)
        try { if (existsSync(p)) unlinkSync(p) } catch { /* ignore */ }
    }
}
