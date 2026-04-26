import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'fs'
import { createHash } from 'crypto'
import { getAppDataDir } from '../../data-dir.js'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
    OAuthClientMetadata,
    OAuthTokens,
    OAuthClientInformationMixed,
} from '@modelcontextprotocol/sdk/shared/auth.js'

/**
 * File-backed OAuthClientProvider for MCP StreamableHTTP connections.
 * Persists tokens, client info, and code verifiers to disk per-server
 * under `<appDataDir>/mcp-oauth/<md5(serverUrl)>/`.
 */
export class McpOAuthProvider implements OAuthClientProvider {
    private storageDir: string
    private _tokens?: OAuthTokens
    private _clientInfo?: OAuthClientInformationMixed
    private _codeVerifier?: string

    constructor(
        private serverUrl: string,
        private _redirectUrl: string,
        private onRedirect: (url: string) => void
    ) {
        const hash = createHash('md5').update(serverUrl).digest('hex')
        this.storageDir = join(getAppDataDir(), 'mcp-oauth', hash)
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
            token_endpoint_auth_method: 'client_secret_post',
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
        writeFileSync(join(this.storageDir, filename), JSON.stringify(data, null, 2))
    }

    private deleteFile(filename: string): void {
        const p = join(this.storageDir, filename)
        try { if (existsSync(p)) unlinkSync(p) } catch { /* ignore */ }
    }
}
