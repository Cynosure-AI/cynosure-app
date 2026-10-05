import type { ToolDefinition } from '../../core/gateway/providers/base.provider.js'
import type { ToolNamespace, ToolRegistry } from '../../core/tools/tool-registry.js'
import { existsSync, readFileSync } from 'fs'
import { dirname, join, isAbsolute, resolve } from 'path'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface McpEnvHint {
    name: string
    description?: string
    required: boolean
    sensitive?: boolean
}

interface ServerJsonEnvVar {
    name: string
    description?: string
    isRequired?: boolean
    format?: string
    isSecret?: boolean
}

interface ServerJson {
    packages?: Array<{
        environmentVariables?: ServerJsonEnvVar[]
    }>
}

// ── Tool registration ──────────────────────────────────────────────────────────

/**
 * Register MCP tools into the registry under a stable namespace key.
 * Collision resolution is deferred to execution time via
 * registry.resolveForExecution(), which adds a slug prefix to the LLM-facing
 * function name when same-named tools are available.
 */
export function registerMcpTools(
    tools: ToolDefinition[],
    ns: ToolNamespace,
    registry: ToolRegistry
): void {
    for (const tool of tools) {
        registry.register(tool, ns)
    }
}

// ── Icon resolution ────────────────────────────────────────────────────────────

const ICON_EXTS = ['png', 'jpg', 'jpeg', 'svg', 'webp'] as const
const MIME_MAP: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp' }

/**
 * Try to find an icon file (icon.png, icon.jpg, etc.) in the MCP server's folder.
 * Derives the folder from the first path-like argument, then walks up a few
 * levels. Falls back to process.cwd() so local servers launched with a
 * relative path (e.g. `node server.js`) still pick up an icon.png in the
 * user's project directory.
 */
export function findMcpIcon(argsJson: string): { path: string; mime: string } | null {
    const args = JSON.parse(argsJson) as string[]
    const entryPath = args.find(a => isAbsolute(a) && !a.startsWith('-'))

    const searchDirs: string[] = []
    if (entryPath) {
        let dir = dirname(resolve(entryPath))
        const root = dirname(dir)
        for (let i = 0; i < 3 && dir.length > 1; i++) {
            searchDirs.push(dir)
            if (dir === root) break
            dir = dirname(dir)
        }
    }

    // Fallback: also look in process.cwd() so `node server.js` (no absolute
    // path) still finds an icon.png in the project root the user is in.
    const cwd = process.cwd()
    if (!searchDirs.includes(cwd)) searchDirs.push(cwd)
    if (!searchDirs.includes(dirname(cwd))) searchDirs.push(dirname(cwd))

    for (const dir of searchDirs) {
        for (const ext of ICON_EXTS) {
            const p = join(dir, `icon.${ext}`)
            if (existsSync(p)) return { path: p, mime: MIME_MAP[ext] }
        }
    }
    return null
}

// ── Env hint resolution ────────────────────────────────────────────────────────

/** Parse env hints from a server.json (official MCP registry format) */
function parseServerJsonHints(content: string): McpEnvHint[] | null {
    try {
        const serverJson = JSON.parse(content) as ServerJson
        const pkg = serverJson.packages?.[0]
        if (!pkg?.environmentVariables?.length) return null

        return pkg.environmentVariables.map(ev => ({
            name: ev.name,
            description: ev.description,
            required: ev.isRequired ?? false,
            sensitive: ev.isSecret,
        }))
    } catch {
        return null
    }
}

/**
 * Try to find a `server.json` next to the MCP server's entry file
 * and extract env var hints from it.
 */
export function findEnvHints(argsJson: string): McpEnvHint[] | null {
    const args = JSON.parse(argsJson) as string[]
    const entryPath = args.find(a => isAbsolute(a) && !a.startsWith('-'))
    if (!entryPath) return null

    let dir = dirname(resolve(entryPath))
    for (let i = 0; i < 3 && dir.length > 1; i++) {
        const sj = join(dir, 'server.json')
        if (existsSync(sj)) {
            const hints = parseServerJsonHints(readFileSync(sj, 'utf-8'))
            if (hints) return hints
        }
        dir = dirname(dir)
    }
    return null
}
