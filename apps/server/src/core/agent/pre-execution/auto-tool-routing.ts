import { nanoid } from 'nanoid'
import { getEventBus } from '../../telemetry/event-bus.js'
import {
    TOOL_SEARCH_TOOL_NAME,
    type SearchAvailableMcpTools,
} from '../../tools/builtin/expand-available-toolset.js'
import { MCP_CANDIDATE_COUNT, routeTools, routeToolsLexically, shouldRouteTools, type RoutedToolDefinition } from './../tool-router.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage, RegistryAwareToolDefinition, ToolDefinition } from '../../gateway/providers/base.provider.js'
import type { ToolNamespaceMetadata } from '../../tools/tool-registry.js'
import type { RequestedToolEffect } from './task-context.js'
import { completeWithDebugCapture } from '../../chat/debug-context.js'

const TOOLSET_SELECTION_TOOL_NAME = 'select_toolsets'
const TOOLSET_DESCRIPTION_CHAR_LIMIT = 1_200

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
    /** Extra metadata to merge into emitted EventBus events (e.g. maCodename for sub-agents). */
    eventMeta?: Record<string, unknown>
    signal?: AbortSignal
    requestedToolEffect?: RequestedToolEffect
    debugContextEnabled?: boolean
}

interface ToolsetCandidate {
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
        eventMeta,
        signal,
        requestedToolEffect,
        debugContextEnabled,
    } = input

    const protectedNames = collectProtectedToolNames(recentMessages || [], preferredToolNames, usedToolNames)
    const eligibleTools = requestedToolEffect
        ? filterToolsForRequestedEffect(tools, requestedToolEffect, protectedNames)
        : tools

    if (!shouldRouteTools(eligibleTools, userQuery, { enabled })) {
        emitAutoToolRoutingSkipped(
            conversationId,
            !eligibleTools.length ? 'no-tools' : !userQuery?.trim() ? 'no-query' : 'disabled',
            eventMeta,
        )
        return eligibleTools
    }

    const taskId = `router_${nanoid()}`
    const expandAvailableTools = makeToolExpansionSearch({
        conversationId,
        gateway,
        providerId,
        model,
        recentMessages: recentMessages || [],
        mcpMetadata: mcpMetadata || [],
        signal,
        debugContextEnabled,
    })
    try {
        signal?.throwIfAborted()
        emitToolRoutingStatus(conversationId, taskId, 'routing-tools', 'Selecting required MCPs and toolsets...', eventMeta)
        const selectedNamespaceIds = await selectToolsets({
            conversationId,
            gateway,
            providerId,
            model,
            userQuery: userQuery || '',
            recentMessages: recentMessages || [],
            tools: eligibleTools,
            mcpMetadata,
            signal,
            debugContextEnabled,
        })
        emitToolsetRoutingSelection(
            conversationId,
            taskId,
            selectedNamespaceIds,
            eligibleTools,
            mcpMetadata || [],
            eventMeta,
        )
        const namespaceFilteredTools = filterToolsByNamespace(eligibleTools, selectedNamespaceIds, protectedNames)
        emitToolRoutingStatus(
            conversationId,
            taskId,
            'finding-tools',
            `Filtering tools from ${selectedNamespaceIds.size} selected toolset${selectedNamespaceIds.size === 1 ? '' : 's'}...`,
            eventMeta,
        )
        const routedTools = await routeTools({
            userQuery: userQuery || '',
            recentMessages: recentMessages || [],
            allTools: namespaceFilteredTools,
            availableTools: eligibleTools,
            mcpMetadata: mcpMetadata?.filter(({ id }) => selectedNamespaceIds.has(id)),
            preferredToolNames,
            usedToolNames,
            onStatus: (status, message) => emitToolRoutingStatus(conversationId, taskId, status, message, eventMeta),
            expandAvailableTools,
        })
        signal?.throwIfAborted()
        emitToolRoutingSelection(
            conversationId,
            taskId,
            routedTools,
            'gathered-context',
            eventMeta,
            routedTools.length ? undefined : 'none-found',
            routedTools.some((tool) => typeof (tool as RoutedToolDefinition).routerScore === 'number') ? 'semantic' : 'lexical',
        )
        return routedTools
    } catch (err) {
        if ((err as Error).name === 'AbortError' || signal?.aborted) throw err
        console.warn('[tool-router] Routing failed, using deterministic lexical routing:', err)
        const fallbackTools = routeToolsLexically({
            userQuery: userQuery || '',
            recentMessages: recentMessages || [],
            allTools: eligibleTools,
            mcpMetadata,
            preferredToolNames,
            usedToolNames,
            expandAvailableTools,
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
    }
}

function makeToolExpansionSearch(input: {
    conversationId: string
    gateway: LLMGateway
    providerId?: string
    model?: string
    recentMessages: ChatMessage[]
    mcpMetadata: ToolNamespaceMetadata[]
    signal?: AbortSignal
    debugContextEnabled?: boolean
}): SearchAvailableMcpTools {
    return async ({ requestedCapability, availableTools, limit, signal }) => {
        const expansionSignal = signal || input.signal
        const selectedNamespaceIds = await selectToolsets({
            conversationId: input.conversationId,
            gateway: input.gateway,
            providerId: input.providerId,
            model: input.model,
            userQuery: requestedCapability,
            recentMessages: input.recentMessages,
            tools: availableTools,
            mcpMetadata: input.mcpMetadata,
            signal: expansionSignal,
            debugContextEnabled: input.debugContextEnabled,
        })
        const selectedTools = filterToolsByNamespace(
            availableTools,
            selectedNamespaceIds,
            new Set(),
        )

        return routeTools({
            userQuery: requestedCapability,
            recentMessages: input.recentMessages,
            allTools: selectedTools,
            availableTools,
            mcpMetadata: input.mcpMetadata.filter(({ id }) => selectedNamespaceIds.has(id)),
            maxTools: limit,
            includeExpansionTool: false,
        } as Parameters<typeof routeTools>[0])
    }
}

export function filterToolsForRequestedEffect<T extends ToolDefinition>(
    tools: T[],
    requestedEffect: RequestedToolEffect,
    protectedNames: Set<string> = new Set(),
): T[] {
    if (requestedEffect === 'destructive') return tools
    return tools.filter((tool) => {
        if (protectedNames.has(tool.name)) return true
        const destructive = tool.annotations?.destructiveHint === true || /(^|_)(delete|remove|destroy|revoke|cancel)(_|$)/i.test(tool.name)
        if (requestedEffect === 'write') return !destructive
        return tool.execution?.readOnly === true || (tool.annotations?.readOnlyHint === true && !destructive)
    })
}

export function emitAutoToolRoutingSkipped(
    _conversationId: string,
    _reason: 'disabled' | 'no-query' | 'no-tools',
    _eventMeta?: Record<string, unknown>,
): void {
    // Static or disabled tool selection is not a routing step, so keep the
    // pre-execution timeline quiet unless the auto-router actually runs.
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
    debugContextEnabled?: boolean
}): Promise<Set<string>> {
    const candidates = buildToolsetCandidates(input.tools, input.mcpMetadata || [])
    if (!candidates.length) return new Set()

    const candidateIds = candidates.map(({ id }) => id)
    try {
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
                        buildRecentConversationBlock(input.recentMessages),
                        `Current request: ${input.userQuery}`,
                        '',
                        'Available MCPs and toolsets:',
                        ...candidates.map(formatToolsetCandidate),
                    ].filter(Boolean).join('\n'),
                },
            ],
            model: input.model,
            maxTokens: 350,
            tools: [buildToolsetSelectionTool(candidateIds)],
            toolChoice: { type: 'function', name: TOOLSET_SELECTION_TOOL_NAME },
            thinkingEnabled: false,
            signal: input.signal,
        }
        const result = await completeWithDebugCapture({
            enabled: input.debugContextEnabled,
            conversationId: input.conversationId,
            phase: 'toolset-selection',
            label: 'MCP and toolset selection',
            gateway: input.gateway,
            providerId: input.providerId,
            request,
        })

        const selectionCall = result.toolCalls?.find((call) => call.function.name === TOOLSET_SELECTION_TOOL_NAME)
        const selection = selectionCall ? parseToolsetSelection(selectionCall.function.arguments, candidateIds) : null
        if (!selection) throw new Error('Toolset selector returned no valid selection')
        return new Set(selection.namespaceIds)
    } catch (err) {
        if ((err as Error).name === 'AbortError' || input.signal?.aborted) throw err
        throw err
    }
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
        if (!Array.isArray(parsed.namespaceIds)) return null

        const allowed = new Set(candidateIds)
        const requestedIds = parsed.namespaceIds.filter((id): id is string => typeof id === 'string')
        const namespaceIds = requestedIds
            .filter((id) => allowed.has(id))
            .filter((id, index, arr) => arr.indexOf(id) === index)
            .slice(0, MCP_CANDIDATE_COUNT)
        if (requestedIds.length > 0 && namespaceIds.length === 0) return null

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

function buildRecentConversationBlock(messages: ChatMessage[]): string {
    const recent = messages
        .filter(({ role }) => role === 'user' || role === 'assistant')
        .slice(-5)

    if (!recent.length) return ''

    const context = recent
        .map(({ role, content }) => `${role}: ${messageContentForRouter(content).slice(0, 200)}`)
        .join('\n')

    return `Recent conversation:\n${context}\n`
}

function messageContentForRouter(content: ChatMessage['content']): string {
    if (typeof content === 'string') return content
    const text = content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim()
    return text || '[multipart content]'
}

function toolNamespaceId(tool: RegistryAwareToolDefinition): string {
    return tool.namespaceId || 'local'
}

function buildToolsetCandidates(tools: RegistryAwareToolDefinition[], metadata: ToolNamespaceMetadata[]): ToolsetCandidate[] {
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

function formatToolsetCandidate(candidate: ToolsetCandidate): string {
    return `- ${candidate.id}: ${candidate.label}\n${candidate.description}`
}

function filterToolsByNamespace(
    tools: RegistryAwareToolDefinition[],
    selectedNamespaceIds: Set<string>,
    protectedNames: Set<string>,
): RegistryAwareToolDefinition[] {
    return tools.filter((tool) => selectedNamespaceIds.has(toolNamespaceId(tool)) || protectedNames.has(tool.name))
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
    getEventBus().emit('step:tools-chosen', {
        conversationId,
        taskId,
        iteration: 0,
        ...eventMeta,
        toolCalls: [...selectedNamespaceIds].map((namespaceId) => ({
            name: candidatesById.get(namespaceId)?.label || namespaceId,
            arguments: JSON.stringify({ type: 'toolset-router', namespaceId, selectionMethod: 'llm' }),
        })),
    })
}

function emitToolRoutingSelection(
    conversationId: string,
    taskId: string,
    tools: Array<ToolDefinition | RoutedToolDefinition>,
    contextPhase: 'gathered-results' | 'gathered-context' = 'gathered-context',
    eventMeta?: Record<string, unknown>,
    emptyReason?: 'none-found' | 'none-relevant' | 'routing-failed' | 'disabled' | 'no-query' | 'no-tools',
    selectionMethod: 'semantic' | 'lexical' = 'semantic',
): void {
    const visibleTools = tools.filter((tool) => tool.name !== TOOL_SEARCH_TOOL_NAME)
    getEventBus().emit('step:tools-chosen', {
        conversationId,
        taskId,
        iteration: 0,
        ...eventMeta,
        toolCalls: visibleTools.length ? visibleTools
            .map((tool) => ({
                name: tool.name,
                arguments: typeof (tool as RoutedToolDefinition).routerScore === 'number'
                    ? JSON.stringify({ type: 'tool-router', contextPhase, selectionMethod, routerScore: (tool as RoutedToolDefinition).routerScore })
                    : JSON.stringify({ type: 'tool-router', contextPhase, selectionMethod })
            })) : [{
                name: toolEmptyLabel(emptyReason),
                arguments: JSON.stringify({
                    type: 'tool-router',
                    contextPhase,
                    selectionMethod,
                    emptyReason: emptyReason || 'none-selected',
                    content: toolEmptyContent(emptyReason),
                }),
            }],
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
