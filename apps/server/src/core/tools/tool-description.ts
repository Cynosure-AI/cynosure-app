export const COMPACT_TOOL_DESCRIPTION_LIMIT = 320

export function normalizeToolDescription(description: string, limit?: number): string {
    const compact = description
        .replace(/\s+/g, ' ')
        .trim()

    return typeof limit === 'number' ? compact.slice(0, limit) : compact
}

export function compactToolDescription(description: string): string {
    return normalizeToolDescription(description, COMPACT_TOOL_DESCRIPTION_LIMIT)
}
