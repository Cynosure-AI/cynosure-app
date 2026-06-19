import { nanoid } from 'nanoid'
import { getEventBus } from '../../telemetry/event-bus.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../tools/builtin/expand-available-toolset.js'
import { compactToolDescription } from '../../tools/tool-description.js'
import { routeTools, shouldRouteTools, type RoutedToolDefinition } from './../tool-router.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage, RegistryAwareToolDefinition, ToolDefinition } from '../../gateway/providers/base.provider.js'
import type { ToolNamespaceMetadata } from '../../tools/tool-registry.js'

const TOOL_CONTEXT_SELECTION_TOOL_NAME = 'select_tool_context'
const MAX_CURATED_TOOLS = 16
const TOOL_DESCRIPTION_CHAR_LIMIT = 800

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
}

interface ToolContextSelection {
    toolIds: string[]
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
    } = input

    if (!shouldRouteTools(tools, userQuery, { enabled })) {
        return tools
    }

    const taskId = `router_${nanoid()}`
    try {
        emitToolRoutingStatus(conversationId, taskId, 'routing-tools', 'Selecting relevant tools...', eventMeta)
        const routedTools = await routeTools({
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
            routedTools,
            'gathered-results',
            eventMeta,
            routedTools.length ? undefined : 'none-found',
        )
        emitToolRoutingStatus(conversationId, taskId, 'curating-tools', 'Curating tool context...', eventMeta)
        const curatedTools = await curateRoutedTools({
            gateway,
            providerId,
            model,
            userQuery: userQuery || '',
            recentMessages: recentMessages || [],
            routedTools,
            preferredToolNames,
            usedToolNames,
        })
        emitToolRoutingSelection(
            conversationId,
            taskId,
            curatedTools,
            'gathered-context',
            eventMeta,
            curatedTools.length ? undefined : 'none-relevant',
        )
        return curatedTools
    } catch (err) {
        console.warn('[tool-router] Routing failed, using local tool list:', err)
        const fallbackTools = tools.filter((tool) => !tool.namespaceId?.startsWith('mcp:'))
        emitToolRoutingSelection(
            conversationId,
            taskId,
            fallbackTools,
            'gathered-context',
            eventMeta,
            fallbackTools.length ? undefined : 'routing-failed',
        )
        return fallbackTools
    }
}

async function curateRoutedTools(input: {
    gateway: LLMGateway
    providerId?: string
    model?: string
    userQuery: string
    recentMessages: ChatMessage[]
    routedTools: RoutedToolDefinition[]
    preferredToolNames?: Set<string>
    usedToolNames?: Set<string>
}): Promise<RoutedToolDefinition[]> {
    const protectedNames = collectProtectedToolNames(input.recentMessages, input.preferredToolNames, input.usedToolNames)
    const curatableTools = input.routedTools.filter((tool) => !protectedNames.has(tool.name))
    if (!curatableTools.length) return input.routedTools

    try {
        const candidateIds = curatableTools.map((_, index) => toolCandidateId(index))
        const result = await input.gateway.complete({
            messages: [
                {
                    role: 'system',
                    content: [
                        'You curate routed tool candidates before the main assistant run.',
                        'Given the current request, recent conversation, and candidate tools, call select_tool_context with only the tool IDs that are useful for this next assistant turn.',
                        `Select at most ${MAX_CURATED_TOOLS} tool IDs.`,
                        'Prefer the smallest sufficient tool set. Keep broad or expensive capabilities out unless they are likely needed.',
                        'Return an empty list if none of the candidates are useful.',
                        'Some explicitly selected, recently used, or search-expansion tools are protected and will be kept automatically; they are not listed here.',
                        'Do not answer the user. Do not include rationale. /no_think',
                    ].join('\n'),
                },
                {
                    role: 'user',
                    content: [
                        buildRecentConversationBlock(input.recentMessages),
                        `Current request: ${input.userQuery}`,
                        '',
                        'Tool candidates:',
                        ...curatableTools.map((tool, index) => formatToolCandidate(tool, candidateIds[index])),
                    ].filter(Boolean).join('\n'),
                },
            ],
            model: input.model,
            maxTokens: 350,
            tools: [buildToolContextSelectionTool(candidateIds)],
            toolChoice: { type: 'function', name: TOOL_CONTEXT_SELECTION_TOOL_NAME },
            thinkingEnabled: false,
        }, input.providerId)

        const selectionCall = result.toolCalls?.find((call) => call.function.name === TOOL_CONTEXT_SELECTION_TOOL_NAME)
        const selection = selectionCall ? parseToolContextSelection(selectionCall.function.arguments, candidateIds) : null
        if (!selection) return input.routedTools

        const selectedNames = new Set(resolveSelectedTools(curatableTools, selection.toolIds).map((tool) => tool.name))
        return input.routedTools.filter((tool) => protectedNames.has(tool.name) || selectedNames.has(tool.name))
    } catch (err) {
        console.warn('[tool-router] Tool context curation failed, using routed tools:', err)
        return input.routedTools
    }
}

function buildToolContextSelectionTool(candidateIds: string[]): ToolDefinition {
    return {
        name: TOOL_CONTEXT_SELECTION_TOOL_NAME,
        description: 'Select the routed tool candidates that should be exposed to the main assistant run.',
        timeout: 10_000,
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                toolIds: {
                    type: 'array',
                    description: 'Candidate IDs to expose to the main assistant, ordered by usefulness.',
                    items: { type: 'string', enum: candidateIds },
                    maxItems: MAX_CURATED_TOOLS,
                },
            },
            required: ['toolIds'],
        },
        execute: async () => ({ success: true, output: 'ok' }),
    }
}

function parseToolContextSelection(raw: string, candidateIds: string[]): ToolContextSelection | null {
    try {
        const parsed = JSON.parse(raw) as { toolIds?: unknown }
        if (!Array.isArray(parsed.toolIds)) return null

        const allowed = new Set(candidateIds)
        const requestedIds = parsed.toolIds.filter((id): id is string => typeof id === 'string')
        const toolIds = requestedIds
            .filter((id) => allowed.has(id))
            .filter((id, index, arr) => arr.indexOf(id) === index)
            .slice(0, MAX_CURATED_TOOLS)
        if (requestedIds.length > 0 && toolIds.length === 0) return null

        return { toolIds }
    } catch {
        return null
    }
}

function resolveSelectedTools(candidates: RoutedToolDefinition[], toolIds: string[]): RoutedToolDefinition[] {
    const byId = new Map(candidates.map((candidate, index) => [toolCandidateId(index), candidate]))
    return toolIds
        .map((id) => byId.get(id))
        .filter((tool): tool is RoutedToolDefinition => Boolean(tool))
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

function toolCandidateId(index: number): string {
    return `t${index + 1}`
}

function formatToolCandidate(tool: RoutedToolDefinition, id: string): string {
    const metadataTool = tool as RoutedToolDefinition & Partial<RegistryAwareToolDefinition>
    const metadata = [
        metadataTool.namespaceLabel ? `namespace=${metadataTool.namespaceLabel}` : '',
        metadataTool.namespaceId ? `namespaceId=${metadataTool.namespaceId}` : '',
        typeof tool.routerScore === 'number' && Number.isFinite(tool.routerScore) ? `score=${tool.routerScore.toFixed(4)}` : '',
    ].filter(Boolean).join(', ')
    const description = compactToolDescription(tool.description).slice(0, TOOL_DESCRIPTION_CHAR_LIMIT)

    return [
        `- ${id}: ${tool.name}${metadata ? ` (${metadata})` : ''}`,
        description,
    ].join('\n')
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

function emitToolRoutingSelection(
    conversationId: string,
    taskId: string,
    tools: Array<ToolDefinition | RoutedToolDefinition>,
    contextPhase: 'gathered-results' | 'gathered-context' = 'gathered-context',
    eventMeta?: Record<string, unknown>,
    emptyReason?: 'none-found' | 'none-relevant' | 'routing-failed',
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
                    ? JSON.stringify({ type: 'tool-router', contextPhase, routerScore: (tool as RoutedToolDefinition).routerScore })
                    : JSON.stringify({ type: 'tool-router', contextPhase })
            })) : [{
                name: toolEmptyLabel(emptyReason),
                arguments: JSON.stringify({
                    type: 'tool-router',
                    contextPhase,
                    emptyReason: emptyReason || 'none-selected',
                }),
            }],
    })
}

function toolEmptyLabel(reason?: string): string {
    switch (reason) {
        case 'none-found': return 'No tools found'
        case 'none-relevant': return 'No tools selected'
        case 'routing-failed': return 'Tool routing skipped'
        default: return 'No tools selected'
    }
}
