import { customAlphabet } from 'nanoid'
import { basename } from 'path'

const MCP_ID_SLUG_LIMIT = 48
const MCP_ID_SUFFIX_LENGTH = 8
const createSuffix = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', MCP_ID_SUFFIX_LENGTH)

function sourceLabel(value: string): string {
    const trimmed = value.trim()
    if (!trimmed) return 'server'

    // Keep local filesystem details out of persistent IDs. The entry filename
    // is still useful while remaining portable across machines.
    if (/^(?:[a-z]:[\\/]|\.{0,2}[\\/]|[\\/])/i.test(trimmed)) {
        return basename(trimmed.replace(/\\/g, '/')).replace(/\.[^.]+$/, '')
    }

    // Package versions are mutable configuration, not part of server identity.
    return trimmed.replace(/@(latest|next|\d+(?:\.\d+)*(?:[-+][a-z0-9.-]+)?)$/i, '')
}

export function mcpServerIdSlug(value: string): string {
    const slug = sourceLabel(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^(?:mcp(?:-server)?|server)-/, '')
        .replace(/^-+|-+$/g, '')
        .slice(0, MCP_ID_SLUG_LIMIT)
        .replace(/-+$/g, '')

    return slug || 'server'
}

/** Create an immutable, readable ID for a newly installed MCP server. */
export function createMcpServerId(sourceName: string): string {
    return `${mcpServerIdSlug(sourceName)}_${createSuffix()}`
}
