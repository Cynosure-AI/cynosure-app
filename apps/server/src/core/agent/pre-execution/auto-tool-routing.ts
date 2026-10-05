import { nanoid } from 'nanoid'
import { getEventBus } from '../../telemetry/event-bus.js'
import { makeSearchAvailableMcpToolsTool, TOOL_SEARCH_TOOL_NAME } from '../../tools/builtin/expand-available-toolset.js'
import { MCP_CANDIDATE_COUNT, routeTools, routeToolsLexically, shouldRouteTools, type RoutedToolDefinition } from './../tool-router.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage, RegistryAwareToolDefinition, ToolDefinition } from '../../gateway/providers/base.provider.js'
import type { ToolNamespaceMetadata } from '../../tools/tool-registry.js'
import { emitRoutingDecision, parseCandidateIds, recentConversationBlock, ROUTER_TURN_CHAR_LIMIT, runRoutingPhase, selectRoutingCandidates } from './routing-kernel.js'

const TOOLSET_SELECTION_TOOL_NAME = 'select_toolsets'
const TOOLSET_DESCRIPTION_CHAR_LIMIT = 1_200
const AUTO_INCLUDE_TOOLSET_MAX_TOOLS = 9

export interface ApplyAutoToolRoutingInput {
    enabled: boolean
    conversationId: string
    userQuery?: string
    recentMessages?: ChatMessage[]
    gateway: LLMGateway
    providerId?: string
    model?: string
    tools: RegistryAwareToolDefinition[]
    mcpMetadata?: ToolNamespaceMetadata[]
    /** Explicitly selected tool names that must be included after routing. */
    preferredToolNames?: Set<string>
    usedToolNames?: Set<string>
    /** Toolsets already chosen by task-context planning; skips the separate toolset selector call. */
    plannedToolsetIds?: string[]
    /** Extra metadata to merge into emitted EventBus events (e.g. maCodename for sub-agents). */
    eventMeta?: Record<string, unknown>
    signal?: AbortSignal
}

export interface ToolsetCandidate {
    id: string
    label: string
    description: string
}

interface ToolsetSelection {
    namespaceIds: string[]
}

export async function applyAutoToolRouting(input: ApplyAutoToolRoutingInput): Promise<ToolDefinition[]> {
    const {
        enabled,
        conversationId,
        userQuery,
        recentMessages,
        gateway,
        providerId,
        model,
        tools,
        mcpMetadata,
        preferredToolNames,
        usedToolNames,
        plannedToolsetIds,
        eventMeta,
        signal,
    } = input

    const protectedNames = collectProtectedToolNames(recentMessages || [], preferredToolNames, usedToolNames)
    // Discovery must see the complete configured catalogue. Behavior hints
    // control approval at execution time; using them as a visibility filter
    // makes valid write/destructive capabilities impossible to discover.
    if (!shouldRouteTools(tools, userQuery, { enabled })) return tools

    const taskId = `router_${nanoid()}`
    return runRoutingPhase({
        signal,
        label: 'tool-router',
        run: async () => {
            emitToolRoutingStatus(conversationId, taskId, 'routing-tools', 'Selecting required MCPs and toolsets...', eventMeta)
            const selectedNamespaceIds = plannedToolsetIds ? new Set(plannedToolsetIds) : await selectToolsets({
                conversationId,
                gateway,
                providerId,
                model,
                userQuery: userQuery || '',
                recentMessages: recentMessages || [],
                tools,
                mcpMetadata,
                signal,
            })
            emitToolsetRoutingSelection(
                conversationId,
                taskId,
                selectedNamespaceIds,
                tools,
                mcpMetadata || [],
                eventMeta,
            )
            const namespaceFilteredTools = filterToolsByNamespace(tools, selectedNamespaceIds, protectedNames)
            const autoIncludedToolNames = collectAutoIncludedToolNames(namespaceFilteredTools, selectedNamespaceIds)
            const toolsToRank = namespaceFilteredTools.filter((tool) =>
                !autoIncludedToolNames.has(tool.name) && !protectedNames.has(tool.name))
            emitToolRoutingStatus(
                conversationId,
                taskId,
                'finding-tools',
                `Filtering tools from ${selectedNamespaceIds.size} selected toolset${selectedNamespaceIds.size === 1 ? '' : 's'}...`,
                eventMeta,
            )
            const rankedTools = toolsToRank.length ? await routeTools({
                userQuery: userQuery || '',
                recentMessages: recentMessages || [],
                allTools: namespaceFilteredTools.filter((tool) => !autoIncludedToolNames.has(tool.name)),
                availableTools: tools,
                mcpMetadata,
                preferredToolNames,
                usedToolNames,
                onStatus: (status, message) => emitToolRoutingStatus(conversationId, taskId, status, message, eventMeta),
            }) : []
            let routedTools: ToolDefinition[] = [
                ...namespaceFilteredTools.filter((tool) => autoIncludedToolNames.has(tool.name) || protectedNames.has(tool.name)),
                ...rankedTools.filter((tool) => tool.name !== TOOL_SEARCH_TOOL_NAME),
            ]
            routedTools = [...new Map(routedTools.filter((tool) => tool.name !== TOOL_SEARCH_TOOL_NAME)
                .map((tool) => [tool.name, tool])).values()]
            const searchTool = makeSearchAvailableMcpToolsTool({
                allTools: tools,
                mcpMetadata,
                getLoadedToolNames: () => new Set(routedTools.map((tool) => tool.name)),
            })
            routedTools.push(searchTool)
            signal?.throwIfAborted()
            emitToolRoutingSelection(
                conversationId,
                taskId,
                routedTools,
                'gathered-context',
                eventMeta,
                routedTools.length > 1 ? undefined : 'none-found',
                autoIncludedToolNames.size > 0
                    ? 'automatic'
                    : routedTools.some((tool) => typeof (tool as RoutedToolDefinition).routerScore === 'number') ? 'semantic' : 'lexical',
            )
            return routedTools
        },
        fallback: () => {
            const fallbackTools = routeToolsLexically({
                userQuery: userQuery || '',
                recentMessages: recentMessages || [],
                allTools: tools,
                mcpMetadata,
                preferredToolNames,
                usedToolNames,
            })
            emitToolRoutingSelection(
                conversationId,
                taskId,
                fallbackTools,
                'gathered-context',
                eventMeta,
                fallbackTools.length ? undefined : 'routing-failed',
                'lexical',
            )
            return fallbackTools
        },
    })
}

async function selectToolsets(input: {
    conversationId: string
    gateway: LLMGateway
    providerId?: string
    model?: string
    userQuery: string
    recentMessages: ChatMessage[]
    tools: RegistryAwareToolDefinition[]
    mcpMetadata?: ToolNamespaceMetadata[]
    signal?: AbortSignal
}): Promise<Set<string>> {
    const candidates = buildToolsetCandidates(input.tools, input.mcpMetadata || [])
    if (!candidates.length) return new Set()

    const candidateIds = candidates.map(({ id }) => id)
    const request: Parameters<LLMGateway['complete']>[0] = {
        messages: [
            {
                role: 'system',
                content: [
                    'You select MCP servers and toolsets before tools are filtered for the main assistant run.',
                    'Given the current request, recent conversation, and available toolsets, call select_toolsets with only the namespace IDs whose capabilities are required for this turn.',
                    `Select at most ${MCP_CANDIDATE_COUNT} namespace IDs.`,
                    'Prefer the smallest sufficient set. Select a toolset when the task is likely to need one or more of its capabilities.',
                    'Return an empty list when the request needs no external or built-in tools.',
                    'Do not answer the user. Do not include rationale. /no_think',
                ].join('\n'),
            },
            {
                role: 'user',
                content: [
                    recentConversationBlock(input.recentMessages, ROUTER_TURN_CHAR_LIMIT),
                    `Current request: ${input.userQuery}`,
                    '',
                    'Available MCPs and toolsets:',
                    ...candidates.map(formatToolsetCandidate),
                ].filter(Boolean).join('\n'),
            },
        ],
        model: input.model,
        maxTokens: 1_500,
        tools: [buildToolsetSelectionTool(candidateIds)],
        toolChoice: { type: 'function', name: TOOLSET_SELECTION_TOOL_NAME },
        thinkingEnabled: false,
        signal: input.signal,
    }
    const selection = await selectRoutingCandidates({
        conversationId: input.conversationId,
        gateway: input.gateway,
        providerId: input.providerId,
        model: input.model,
        signal: input.signal,
        usageKind: 'tool-router',
        toolName: TOOLSET_SELECTION_TOOL_NAME,
        request,
        parse: (raw) => parseToolsetSelection(raw, candidateIds),
    })
    if (!selection) throw new Error('Toolset selector returned no valid selection')
    return new Set(selection.namespaceIds)
}

function buildToolsetSelectionTool(candidateIds: string[]): ToolDefinition {
    return {
        name: TOOLSET_SELECTION_TOOL_NAME,
        description: 'Select the MCP servers and toolsets required for the current assistant turn.',
        timeout: 10_000,
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                namespaceIds: {
                    type: 'array',
                    description: 'Namespace IDs whose tools should be considered, ordered by usefulness.',
                    items: { type: 'string', enum: candidateIds },
                    maxItems: MCP_CANDIDATE_COUNT,
                },
            },
            required: ['namespaceIds'],
        },
        execute: async () => ({ success: true, output: 'ok' }),
    }
}

function parseToolsetSelection(raw: string, candidateIds: string[]): ToolsetSelection | null {
    try {
        const parsed = JSON.parse(raw) as { namespaceIds?: unknown }
        const namespaceIds = parseCandidateIds(parsed.namespaceIds, candidateIds, MCP_CANDIDATE_COUNT)
        if (!namespaceIds) return null
        return { namespaceIds }
    } catch {
        return null
    }
}

function collectProtectedToolNames(
    recentMessages: ChatMessage[],
    preferredToolNames?: Set<string>,
    usedToolNames?: Set<string>,
): Set<string> {
    const names = new Set<string>([TOOL_SEARCH_TOOL_NAME])

    for (const preferredToolName of preferredToolNames || []) {
        names.add(preferredToolName)
    }
    for (const usedToolName of usedToolNames || []) {
        names.add(usedToolName)
    }
    for (const message of recentMessages) {
        for (const call of message.toolCalls || []) {
            names.add(call.function.name)
        }
    }

    return names
}

function toolNamespaceId(tool: RegistryAwareToolDefinition): string {
    return tool.namespaceId || 'local'
}

export function buildToolsetCandidates(tools: RegistryAwareToolDefinition[], metadata: ToolNamespaceMetadata[]): ToolsetCandidate[] {
    const metadataById = new Map(metadata.map((item) => [item.id, item]))
    const grouped = new Map<string, RegistryAwareToolDefinition[]>()
    for (const tool of tools) {
        const id = toolNamespaceId(tool)
        grouped.set(id, [...(grouped.get(id) || []), tool])
    }
    return [...grouped.entries()].map(([id, namespaceTools]) => {
        const meta = metadataById.get(id)
        const description = meta?.description || namespaceTools[0]?.namespaceDescription || namespaceTools
            .slice(0, 12)
            .map((tool) => `${tool.name}: ${tool.description}`)
            .join('\n')
        return {
            id,
            label: meta?.label || namespaceTools[0]?.namespaceLabel || (id === 'local' ? 'Built-in tools' : id),
            description: description.slice(0, TOOLSET_DESCRIPTION_CHAR_LIMIT),
        }
    })
}

export function formatToolsetCandidate(candidate: ToolsetCandidate): string {
    return `- ${candidate.id}: ${candidate.label}\n${candidate.description}`
}

function filterToolsByNamespace(
    tools: RegistryAwareToolDefinition[],
    selectedNamespaceIds: Set<string>,
    protectedNames: Set<string>,
): RegistryAwareToolDefinition[] {
    return tools.filter((tool) => selectedNamespaceIds.has(toolNamespaceId(tool)) || protectedNames.has(tool.name))
}

/** Selected toolsets of at most nine tools bypass semantic ranking entirely. */
export function collectAutoIncludedToolNames(
    tools: RegistryAwareToolDefinition[],
    selectedNamespaceIds: Set<string>,
): Set<string> {
    const grouped = new Map<string, RegistryAwareToolDefinition[]>()
    for (const tool of tools) {
        const namespaceId = toolNamespaceId(tool)
        if (!selectedNamespaceIds.has(namespaceId)) continue
        grouped.set(namespaceId, [...(grouped.get(namespaceId) || []), tool])
    }

    const included = new Set<string>()
    for (const namespaceTools of grouped.values()) {
        if (namespaceTools.length > AUTO_INCLUDE_TOOLSET_MAX_TOOLS) continue
        namespaceTools.forEach((tool) => included.add(tool.name))
    }
    return included
}

function emitToolRoutingStatus(conversationId: string, taskId: string, status: string, message: string, eventMeta?: Record<string, unknown>): void {
    getEventBus().emit('step:status', {
        conversationId,
        taskId,
        iteration: 0,
        status,
        message,
        ...eventMeta,
    })
}

function emitToolsetRoutingSelection(
    conversationId: string,
    taskId: string,
    selectedNamespaceIds: Set<string>,
    tools: RegistryAwareToolDefinition[],
    mcpMetadata: ToolNamespaceMetadata[],
    eventMeta?: Record<string, unknown>,
): void {
    const candidatesById = new Map(buildToolsetCandidates(tools, mcpMetadata).map((candidate) => [candidate.id, candidate]))
    const selectedToolsets = [...selectedNamespaceIds].map((namespaceId) => ({
        name: candidatesById.get(namespaceId)?.label || namespaceId,
        details: { type: 'toolset-router', namespaceId, selectionMethod: 'llm' },
    }))
    emitRoutingDecision({
        conversationId,
        taskId,
        phase: 'toolsets',
        eventMeta,
        entries: selectedToolsets,
        empty: {
            name: 'No toolsets selected',
            details: {
                type: 'toolset-router',
                selectionMethod: 'llm',
                emptyReason: 'none-relevant',
                content: 'AI toolset selection ran, but no MCPs or toolsets were relevant for this turn.',
            },
        },
    })
}

function emitToolRoutingSelection(
    conversationId: string,
    taskId: string,
    tools: Array<ToolDefinition | RoutedToolDefinition>,
    contextPhase: 'gathered-results' | 'gathered-context' = 'gathered-context',
    eventMeta?: Record<string, unknown>,
    emptyReason?: 'none-found' | 'none-relevant' | 'routing-failed' | 'disabled' | 'no-query' | 'no-tools',
    selectionMethod: 'semantic' | 'lexical' | 'automatic' = 'semantic',
): void {
    const visibleTools = tools.filter((tool) => tool.name !== TOOL_SEARCH_TOOL_NAME)
    emitRoutingDecision({
        conversationId,
        taskId,
        phase: 'tools',
        eventMeta,
        entries: visibleTools.map((tool) => ({
            name: tool.name,
            details: {
                type: 'tool-router', contextPhase, selectionMethod,
                ...(typeof (tool as RoutedToolDefinition).routerScore === 'number'
                    ? { routerScore: (tool as RoutedToolDefinition).routerScore } : {}),
                namespaceId: (tool as RegistryAwareToolDefinition).namespaceId,
                namespaceLabel: (tool as RegistryAwareToolDefinition).namespaceLabel,
            },
        })),
        empty: {
            name: toolEmptyLabel(emptyReason),
            details: {
                type: 'tool-router', contextPhase, selectionMethod,
                emptyReason: emptyReason || 'none-selected',
                content: toolEmptyContent(emptyReason),
            },
        },
    })
}

function toolEmptyContent(reason?: string): string {
    switch (reason) {
        case 'none-found':
            return 'Auto tool routing ran, but no tools matched this turn.'
        case 'none-relevant':
            return 'Auto tool routing found candidates, but the curation step selected none as useful for this turn.'
        case 'routing-failed':
            return 'Auto tool routing failed; the turn continued with the local fallback tool list.'
        case 'disabled':
            return 'Auto tool routing is disabled for this turn.'
        case 'no-query':
            return 'Auto tool routing did not run because there was no text query to route.'
        case 'no-tools':
            return 'Auto tool routing did not run because no tools are available.'
        default:
            return 'Auto tool routing did not select any tools for this turn.'
    }
}

function toolEmptyLabel(reason?: string): string {
    switch (reason) {
        case 'none-found': return 'No tools found'
        case 'none-relevant': return 'No tools selected'
        case 'routing-failed': return 'Tool routing skipped'
        case 'disabled': return 'Auto tools disabled'
        case 'no-query': return 'No tool query'
        case 'no-tools': return 'No tools available'
        default: return 'No tools selected'
    }
}
