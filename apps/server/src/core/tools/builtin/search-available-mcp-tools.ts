import type { ToolDefinition } from '../../gateway/providers/base.provider.js'

export const TOOL_SEARCH_TOOL_NAME = 'search_available_mcp_tools'

const TOOL_DESCRIPTION_LIMIT = 320
const TOOL_SEARCH_LIMIT = 12

export interface SearchAvailableMcpToolsOptions {
    allTools: ToolDefinition[]
    getLoadedTools: () => ToolDefinition[]
}

export function makeSearchAvailableMcpToolsTool(
    opts: SearchAvailableMcpToolsOptions,
): ToolDefinition {
    const { allTools, getLoadedTools } = opts

    return {
        name: TOOL_SEARCH_TOOL_NAME,
        description:
            'IMPORTANT TOOL: Search and load additional available tools when the current tools are insufficient or the wrong ones. Use this before saying a capability is unavailable.',
        timeout: 1_000,
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                query: {
                    type: 'string',
                    description:
                        'Capability to search for, e.g. "gmail latest email", "calendar event", "github issue search" or "web content search".',
                },
                limit: {
                    type: 'number',
                    description: `Maximum tools to load. Defaults to ${TOOL_SEARCH_LIMIT}.`,
                },
            },
            required: ['query'],
        },
        execute: async (params) => {
            const { query, limit } = parseSearchArgs(params)

            if (!query) {
                return { success: false, output: 'Provide a non-empty query to search available tools.' }
            }

            const loadedTools = getLoadedTools()
            const loadedNames = new Set(loadedTools.map(({ name }) => name))
            const searchableTools = allTools.filter(
                (tool) => isMcpTool(tool) && tool.name !== TOOL_SEARCH_TOOL_NAME && !loadedNames.has(tool.name),
            )

            const names = lexicalToolSearch(query, searchableTools, limit)
            const matches = searchableTools.filter(({ name }) => names.includes(name))

            for (const tool of matches) {
                if (loadedNames.has(tool.name)) continue
                loadedTools.push(tool)
                loadedNames.add(tool.name)
            }

            if (!matches.length) {
                return { success: true, output: `No additional tools found for "${query}".` }
            }

            return {
                success: true,
                output: [
                    `Loaded ${matches.length} additional tool(s). They are available in the next tool-calling round:`,
                    ...matches.map((tool) => `- ${tool.name}: ${compactToolDescription(tool.description)}`),
                ].join('\n'),
                loadedTools: matches,
            }
        },
    }
}

function parseSearchArgs(params: unknown): { query: string; limit: number } {
    const args = params && typeof params === 'object'
        ? params as { query?: unknown; limit?: unknown }
        : {}

    const query = typeof args.query === 'string' ? args.query.trim() : ''
    const limit = typeof args.limit === 'number'
        ? Math.max(1, Math.min(TOOL_SEARCH_LIMIT, Math.floor(args.limit)))
        : TOOL_SEARCH_LIMIT

    return { query, limit }
}

function lexicalToolSearch(
    query: string,
    tools: ToolDefinition[],
    limit: number,
): string[] {
    const scored = scoreItems(
        query,
        tools,
        toolText,
        ({ name }) => name,
    )

    const matching = scored.filter(({ score }) => score > 0)
    return (matching.length ? matching : scored)
        .slice(0, limit)
        .map(({ value }) => value)
}

function scoreItems<T>(
    query: string,
    items: T[],
    textForItem: (item: T) => string,
    valueForItem: (item: T) => string,
): Array<{ value: string; score: number; index: number }> {
    const terms = tokenize(query)

    return items
        .map((item, index) => {
            const haystack = textForItem(item).toLowerCase()
            const score = [...terms].reduce(
                (sum, term) => sum + (haystack.includes(term) ? 1 : 0),
                0,
            )

            return {
                value: valueForItem(item),
                score,
                index,
            }
        })
        .sort((a, b) => b.score - a.score || a.index - b.index)
}

function tokenize(text: string): Set<string> {
    return new Set(text.toLowerCase().match(/[a-z0-9_]{3,}/g) || [])
}

function toolText(tool: ToolDefinition): string {
    return `${tool.name} ${tool.description}`
}

function isMcpTool(tool: ToolDefinition): boolean {
    return Boolean(tool.namespaceId?.startsWith('mcp:'))
}

function compactToolDescription(description: string): string {
    return description
        .replace(/^\[MCP:\s*[^\]]*\]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, TOOL_DESCRIPTION_LIMIT)
}
