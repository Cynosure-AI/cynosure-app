import type { RegistryAwareToolDefinition, ToolDefinition } from '../../gateway/providers/base.provider.js'
import { compactToolDescription } from '../tool-description.js'

export const TOOL_SEARCH_TOOL_NAME = 'expand_available_toolset' // Name of the tool the router LLM calls to confirm its tool selection

const TOOL_SEARCH_LIMIT = 12

export interface SearchAvailableMcpToolsInput {
    requestedCapability: string
    availableTools: RegistryAwareToolDefinition[]
    limit: number
    signal?: AbortSignal
}

export type SearchAvailableMcpTools = (
    input: SearchAvailableMcpToolsInput,
) => Promise<RegistryAwareToolDefinition[]>

export interface SearchAvailableMcpToolsOptions {
    allTools: RegistryAwareToolDefinition[]
    getLoadedToolNames: () => Set<string>
    /** Optional AI + retrieval-backed search supplied by the execution router. */
    searchTools?: SearchAvailableMcpTools
}

export function makeSearchAvailableMcpToolsTool(
    opts: SearchAvailableMcpToolsOptions,
): ToolDefinition {
    const { allTools, getLoadedToolNames, searchTools } = opts
    const dynamicallyLoadedNames = new Set<string>()

    return {
        name: TOOL_SEARCH_TOOL_NAME,
        execution: { readOnly: true },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description:
            'IMPORTANT TOOL: Search installed MCPs and toolsets, then load the tools required for a capability when the current tools are insufficient or wrong. Use this before saying a capability is unavailable.',
        timeout: 60_000,
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
        execute: async (params, signal) => {
            const { requested_capability, limit } = parseSearchArgs(params)

            if (!requested_capability) {
                return { success: false, output: 'Provide a non-empty capability to search available tools.' }
            }

            const loadedNames = new Set([...getLoadedToolNames(), ...dynamicallyLoadedNames])
            const searchableTools = allTools.filter(
                (tool) => isMcpTool(tool) && tool.name !== TOOL_SEARCH_TOOL_NAME && !loadedNames.has(tool.name),
            )

            const matches = await searchAvailableMcpTools({
                requestedCapability: requested_capability,
                availableTools: searchableTools,
                limit,
                signal,
            }, searchTools)
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

async function searchAvailableMcpTools(
    input: SearchAvailableMcpToolsInput,
    searchTools?: SearchAvailableMcpTools,
): Promise<RegistryAwareToolDefinition[]> {
    if (searchTools) {
        try {
            const results = await searchTools(input)
            return keepAvailableMatches(results, input.availableTools, input.limit)
        } catch (err) {
            if ((err as Error).name === 'AbortError' || input.signal?.aborted) throw err
            console.warn('[tool-router] Runtime tool expansion failed, using lexical fallback:', err)
        }
    }

    return lexicalToolSearch(input.requestedCapability, input.availableTools, input.limit)
}

function keepAvailableMatches(
    results: RegistryAwareToolDefinition[],
    availableTools: RegistryAwareToolDefinition[],
    limit: number,
): RegistryAwareToolDefinition[] {
    const availableByName = new Map(availableTools.map((tool) => [tool.name, tool]))
    const seen = new Set<string>()
    const matches: RegistryAwareToolDefinition[] = []

    for (const result of results) {
        const available = availableByName.get(result.name)
        if (!available || seen.has(available.name)) continue
        seen.add(available.name)
        matches.push(available)
        if (matches.length >= limit) break
    }

    return matches
}

function lexicalToolSearch(
    requested_capability: string,
    tools: RegistryAwareToolDefinition[],
    limit: number,
): RegistryAwareToolDefinition[] {
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const scored = scoreItems(
        requested_capability,
        tools,
        toolText,
        ({ name }) => name,
    )

    const matching = scored.filter(({ score }) => score > 0)
    return (matching.length ? matching : scored)
        .slice(0, limit)
        .map(({ value }) => byName.get(value))
        .filter((tool): tool is RegistryAwareToolDefinition => Boolean(tool))
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
