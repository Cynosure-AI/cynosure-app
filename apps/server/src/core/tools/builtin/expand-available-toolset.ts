import type { RegistryAwareToolDefinition, ToolDefinition } from '../../gateway/providers/base.provider.js'
import type { ToolNamespaceMetadata } from '../tool-registry.js'
import { compactToolDescription } from '../tool-description.js'

export const TOOL_SEARCH_TOOL_NAME = 'expand_available_toolset' // Runtime capability discovery tool

const TOOL_SEARCH_LIMIT = 12

export interface SearchAvailableMcpToolsOptions {
    allTools: RegistryAwareToolDefinition[]
    mcpMetadata?: ToolNamespaceMetadata[]
    getLoadedToolNames: () => Set<string>
}

export function makeSearchAvailableMcpToolsTool(
    opts: SearchAvailableMcpToolsOptions,
): ToolDefinition {
    const { allTools, mcpMetadata, getLoadedToolNames } = opts
    const dynamicallyLoadedNames = new Set<string>()

    return {
        name: TOOL_SEARCH_TOOL_NAME,
        execution: { readOnly: true },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description:
            'IMPORTANT TOOL: Semantically search MCP capabilities and load additional available tools when the current tools are insufficient or the wrong ones. Use this before saying a capability is unavailable.',
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
            signal?.throwIfAborted()
            const { requested_capability, limit } = parseSearchArgs(params)

            if (!requested_capability) {
                return { success: false, output: 'Provide a non-empty capability to search available tools.' }
            }

            const loadedNames = new Set([...getLoadedToolNames(), ...dynamicallyLoadedNames])
            const searchableTools = allTools.filter(
                (tool) => isMcpTool(tool) && tool.name !== TOOL_SEARCH_TOOL_NAME && !loadedNames.has(tool.name),
            )

            // Load lazily: the router also constructs this tool for every routed turn.
            const { retrieveMcpTools } = await import('../../agent/tool-router.js')
            const matches = await retrieveMcpTools({
                userQuery: requested_capability,
                allTools: searchableTools,
                mcpMetadata,
                maxTools: limit,
            })
            signal?.throwIfAborted()
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
    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
        ? Math.max(1, Math.min(TOOL_SEARCH_LIMIT, Math.floor(args.limit)))
        : TOOL_SEARCH_LIMIT

    return { requested_capability, limit }
}

function isMcpTool(tool: RegistryAwareToolDefinition): boolean {
    return Boolean(tool.namespaceId?.startsWith('mcp:'))
}
