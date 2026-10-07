/**
 * Turn low-level MCP connection failures into actionable messages.
 *
 * Node's fetch (undici) reports every network failure as a bare
 * `TypeError: fetch failed` and hides the real reason in `err.cause`
 * (TLS, DNS, refused connection, ...). Without unwrapping it the user only
 * ever sees "fetch failed".
 */

const TLS_SELF_SIGNED_CODES = new Set([
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
])

const SELF_SIGNED_HINT = 'The server uses a certificate Node.js does not trust (common for self-signed local dev sites). '
    + 'Start Cynosure with NODE_EXTRA_CA_CERTS=<path to the root CA .crt>, use http:// if the site serves it, '
    + 'or for local development only set NODE_TLS_REJECT_UNAUTHORIZED=0.'

const CODE_HINTS: Record<string, string> = {
    CERT_HAS_EXPIRED: 'The server\'s TLS certificate has expired.',
    ERR_TLS_CERT_ALTNAME_INVALID: 'The TLS certificate does not match this hostname.',
    ENOTFOUND: 'The hostname could not be resolved. Check the URL, or the hosts file/DNS of the machine running the Cynosure server.',
    EAI_AGAIN: 'DNS lookup failed temporarily. Check the network connection.',
    ECONNREFUSED: 'Connection refused — nothing is listening at this address/port.',
    ECONNRESET: 'The server closed the connection unexpectedly.',
    ETIMEDOUT: 'The connection timed out.',
    UND_ERR_CONNECT_TIMEOUT: 'The connection timed out.',
    EHOSTUNREACH: 'The host is unreachable from this machine.',
    ENETUNREACH: 'The network is unreachable.',
    EPROTO: 'TLS handshake failed — the server may not speak HTTPS on this port (try http://).',
    ERR_SSL_WRONG_VERSION_NUMBER: 'TLS handshake failed — the server may not speak HTTPS on this port (try http://).',
}

const HTTP_STATUS_HINTS: Record<number, string> = {
    401: 'The server rejected the credentials. Check the token or authentication type.',
    403: 'Access denied. The credentials are valid but lack permission for this MCP endpoint.',
    404: 'No MCP endpoint at this URL. Check the path (many servers use /mcp or /sse).',
    405: 'The server does not accept Streamable HTTP POST at this URL. It may be an SSE-only server or the wrong path.',
}

type ErrorLike = { message?: unknown; code?: unknown; cause?: unknown }

function asErrorLike(value: unknown): ErrorLike | null {
    return value && typeof value === 'object' ? value as ErrorLike : null
}

/** Walk the `cause` chain (bounded) collecting messages and string codes. */
function collectChain(err: unknown): { messages: string[]; codes: string[]; httpStatus?: number } {
    const messages: string[] = []
    const codes: string[] = []
    let httpStatus: number | undefined
    let current: unknown = err
    for (let depth = 0; current && depth < 6; depth++) {
        const e = asErrorLike(current)
        if (!e) {
            messages.push(String(current))
            break
        }
        if (typeof e.message === 'string' && e.message) messages.push(e.message)
        if (typeof e.code === 'string') codes.push(e.code)
        // StreamableHTTPError carries the HTTP status as a numeric code.
        if (typeof e.code === 'number' && e.code >= 400 && httpStatus === undefined) httpStatus = e.code
        // AggregateError (e.g. happy-eyeballs IPv4+IPv6 failures) hides codes in `errors`.
        const nested = (current as { errors?: unknown }).errors
        if (Array.isArray(nested)) {
            for (const inner of nested) {
                const code = asErrorLike(inner)?.code
                if (typeof code === 'string') codes.push(code)
            }
        }
        current = e.cause
    }
    return { messages, codes, httpStatus }
}

function hintFor(codes: string[], httpStatus?: number): string | undefined {
    for (const code of codes) {
        if (TLS_SELF_SIGNED_CODES.has(code)) return SELF_SIGNED_HINT
        if (CODE_HINTS[code]) return CODE_HINTS[code]
    }
    return httpStatus ? HTTP_STATUS_HINTS[httpStatus] : undefined
}

/**
 * Build a user-facing description of a connection error, e.g.
 * `fetch failed (SELF_SIGNED_CERT_IN_CHAIN: self-signed certificate in certificate chain) — The server uses ...`
 */
export function describeMcpConnectionError(err: unknown): string {
    const { messages, codes, httpStatus } = collectChain(err)
    const [top = 'Unknown error', ...rest] = messages
    const code = codes[0]
    const detail = rest.length
        ? (code && !rest[rest.length - 1].includes(code) ? `${code}: ` : '') + rest[rest.length - 1]
        : (code && !top.includes(code) ? code : '')
    const base = detail && detail !== top ? `${top} (${detail})` : top
    const hint = hintFor(codes, httpStatus)
    return hint ? `${base} — ${hint}` : base
}

/** Wrap an error with a descriptive message while keeping the original as `cause`. */
export function toMcpConnectionError(err: unknown): Error {
    const message = describeMcpConnectionError(err)
    if (err instanceof Error && err.message === message) return err
    return new Error(message, { cause: err })
}
