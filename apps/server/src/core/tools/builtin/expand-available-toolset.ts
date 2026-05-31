import type { RegistryAwareToolDefinition, ToolDefinition } from '../../gateway/providers/base.provider.js'
import { compactToolDescription } from '../tool-description.js'

export const TOOL_SEARCH_TOOL_NAME = 'expand_available_toolset' // Name of the tool the router LLM calls to confirm its tool selection

const TOOL_SEARCH_LIMIT = 12

export interface SearchAvailableMcpToolsOptions {
    allTools: RegistryAwareToolDefinition[]
    getLoadedToolNames: () => Set<string>
}

export function makeSearchAvailableMcpToolsTool(
    opts: SearchAvailableMcpToolsOptions,
): ToolDefinition {
    const { allTools, getLoadedToolNames } = opts
    const dynamicallyLoadedNames = new Set<string>()

    return {
        name: TOOL_SEARCH_TOOL_NAME,
        description:
            'IMPORTANT TOOL: Search and load additional available tools when the current tools are insufficient or the wrong ones. Use this before saying a capability is unavailable.',
        timeout: 1_000,
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                requested_capability: {
                    type: 'string',
                    description:
                        'Capability to search for, e.g. "gmail latest email", "calendar event", "github issue search" or "web content search".',
                },
                limit: {
                    type: 'number',
                    description: `Maximum tools to load. Defaults to ${TOOL_SEARCH_LIMIT}.`,
                },
            },
            required: ['requested_capability'],
        },
        execute: async (params) => {
            const { requested_capability, limit } = parseSearchArgs(params)

            if (!requested_capability) {
                return { success: false, output: 'Provide a non-empty capability to search available tools.' }
            }

            const loadedNames = new Set([...getLoadedToolNames(), ...dynamicallyLoadedNames])
            const searchableTools = allTools.filter(
                (tool) => isMcpTool(tool) && tool.name !== TOOL_SEARCH_TOOL_NAME && !loadedNames.has(tool.name),
            )

            const names = lexicalToolSearch(requested_capability, searchableTools, limit)
            const matches = searchableTools.filter(({ name }) => names.includes(name))
            for (const tool of matches) {
                dynamicallyLoadedNames.add(tool.name)
            }

            if (!matches.length) {
                return { success: true, output: `No additional tools found for "${requested_capability}".` }
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

function parseSearchArgs(params: unknown): { requested_capability: string; limit: number } {
    const args = params && typeof params === 'object'
        ? params as { requested_capability?: unknown; limit?: unknown }
        : {}

    const requested_capability = typeof args.requested_capability === 'string' ? args.requested_capability.trim() : ''
    const limit = typeof args.limit === 'number'
        ? Math.max(1, Math.min(TOOL_SEARCH_LIMIT, Math.floor(args.limit)))
        : TOOL_SEARCH_LIMIT

    return { requested_capability, limit }
}

function lexicalToolSearch(
    requested_capability: string,
    tools: ToolDefinition[],
    limit: number,
): string[] {
    const scored = scoreItems(
        requested_capability,
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
    requested_capability: string,
    items: T[],
    textForItem: (item: T) => string,
    valueForItem: (item: T) => string,
): Array<{ value: string; score: number; index: number }> {
    const terms = tokenize(requested_capability)

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

function isMcpTool(tool: RegistryAwareToolDefinition): boolean {
    return Boolean(tool.namespaceId?.startsWith('mcp:'))
}
