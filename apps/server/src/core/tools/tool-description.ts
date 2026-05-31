export function normalizeToolDescription(description: string, limit?: number): string {
    const compact = description
        .replace(/\s+/g, ' ')
        .trim()

    return typeof limit === 'number' ? compact.slice(0, limit) : compact
}
