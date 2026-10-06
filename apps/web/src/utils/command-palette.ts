/**
 * Scoring helpers for the global search palette. Items are matched on the
 * client for entity lists that are already small (agents, MCP servers, cron
 * jobs); conversations are searched on the server.
 */

/**
 * Score how well `query` matches a list of fields, highest wins.
 * Earlier fields weigh more than later ones (name before description).
 * Returns 0 when no field matches every query term.
 */
export function scoreMatch(query: string, fields: Array<string | null | undefined>): number {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return 1

    const haystacks = fields.map((field) => (field ?? '').toLowerCase())
    let total = 0
    for (const term of terms) {
        let best = 0
        haystacks.forEach((text, index) => {
            const at = text.indexOf(term)
            if (at === -1) return
            const fieldWeight = 1 / (index + 1)
            const positionBonus = text === term
                ? 4
                : at === 0
                    ? 3
                    : /[\s\-_/.:]/.test(text[at - 1])
                        ? 2
                        : 1
            best = Math.max(best, positionBonus * fieldWeight)
        })
        if (best === 0) return 0
        total += best
    }
    return total
}

/** Filter and rank `items` against `query`, keeping at most `limit` matches. */
export function rankItems<T>(
    items: readonly T[],
    query: string,
    fields: (item: T) => Array<string | null | undefined>,
    limit: number,
): T[] {
    return items
        .map((item, index) => ({ item, index, score: scoreMatch(query, fields(item)) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, limit)
        .map((entry) => entry.item)
}
