import { nanoid } from 'nanoid'
import { getEventBus } from '../../telemetry/event-bus.js'
import { getMemoryAggregator, type AggregatedMemory } from '../../memory/memory-aggregator.js'
import type { LLMGateway } from '../../gateway/gateway.js'
import type { ChatMessage, ContentPart, ToolDefinition } from '../../gateway/providers/base.provider.js'
import type { RetrievedChunk } from '../../memory/parser.js'

const MEMORY_CANDIDATE_COUNT = 12
const MAX_SELECTED_MEMORIES = 5
const TURN_CHAR_LIMIT = 200
const MEMORY_TEXT_LIMIT = 900
const ROUTER_SELECTION_TOOL_NAME = 'select_relevant_memories'

export interface ApplyAutoMemoryRoutingInput {
    enabled: boolean
    conversationId: string
    userQuery?: string
    recentMessages?: ChatMessage[]
    gateway: LLMGateway
    providerId?: string
    model?: string
    routerModel?: string
    agentId?: string
    memorySpaceIds?: string[]
}

export async function applyAutoMemoryRouting(input: ApplyAutoMemoryRoutingInput): Promise<string | null> {
    const {
        enabled,
        conversationId,
        userQuery,
        recentMessages = [],
        gateway,
        providerId,
        model,
        routerModel,
        agentId,
        memorySpaceIds,
    } = input

    if (!shouldRouteMemory(userQuery, { enabled })) return null

    const taskId = `memory_router_${nanoid()}`
    const aggregator = getMemoryAggregator()

    try {
        emitMemoryRoutingStatus(conversationId, taskId)
        const query = buildRouterQuery(userQuery || '', recentMessages)
        const candidates = await aggregator.aggregate(query, {
            agentId,
            spaceIds: memorySpaceIds,
            permanentTopK: MEMORY_CANDIDATE_COUNT,
        })

        if (!candidates.permanent.length) {
            emitMemoryRoutingSelection(conversationId, taskId, [])
            return null
        }

        let selectedIds: Set<string>
        try {
            selectedIds = new Set(await llmConfirmMemories(query, candidates.permanent, {
                gateway,
                providerId,
                model: routerModel || model,
            }))
        } catch (err) {
            console.warn('[memory-router] LLM confirmation failed, using top retrieved memories:', err)
            selectedIds = new Set(candidates.permanent.slice(0, MAX_SELECTED_MEMORIES).map((chunk) => chunk.id))
        }

        const selectedMemory: AggregatedMemory = {
            permanent: candidates.permanent
                .filter((chunk) => selectedIds.has(chunk.id))
                .slice(0, MAX_SELECTED_MEMORIES),
        }

        emitMemoryRoutingSelection(conversationId, taskId, selectedMemory.permanent)
        const formatted = aggregator.format(selectedMemory)
        return formatted || null
    } catch (err) {
        console.warn('[memory-router] Routing failed, continuing without auto-memory:', err)
        emitMemoryRoutingSelection(conversationId, taskId, [])
        return null
    }
}

function shouldRouteMemory(userQuery?: string, opts: { enabled?: boolean } = {}): boolean {
    return opts.enabled === true && Boolean(userQuery?.trim())
}

function buildRouterQuery(currentMessage: string, messages: ChatMessage[] = []): string {
    const recent = messages
        .filter(({ role }) => role === 'user' || role === 'assistant')
        .slice(-5)

    if (!recent.length) return currentMessage

    const context = recent
        .map(({ role, content }) => `${role}: ${messageContentForRouter(content).slice(0, TURN_CHAR_LIMIT)}`)
        .join('\n')

    return `Recent conversation:\n${context}\n\nCurrent request: ${currentMessage}`
}

async function llmConfirmMemories(
    query: string,
    candidates: RetrievedChunk[],
    config: { gateway: LLMGateway; providerId?: string; model?: string },
): Promise<string[]> {
    if (!candidates.length) return []

    const availableMemories = candidates
        .map((chunk) => `${chunk.id}: ${memoryLabel(chunk)}\n${compactMemoryText(chunk.text)}`)
        .join('\n\n')

    const result = await config.gateway.complete({
        messages: [
            {
                role: 'system',
                content: `You select memory snippets for an assistant. Given a user request and candidate memories, call ${ROUTER_SELECTION_TOOL_NAME} with only memory IDs that materially help answer the request. If none apply, call it with an empty array. /no_think`,
            },
            {
                role: 'user',
                content: `Request: ${query}\n\nCandidate memories:\n${availableMemories}`,
            },
        ],
        model: config.model,
        maxTokens: 300,
        tools: [buildRouterSelectionTool(candidates)],
        toolChoice: { type: 'function', name: ROUTER_SELECTION_TOOL_NAME },
        thinkingEnabled: false,
    }, config.providerId)

    const allowedIds = new Set(candidates.map(({ id }) => id))
    const selectionCall = result.toolCalls?.find((call) => call.function.name === ROUTER_SELECTION_TOOL_NAME)
    const parsedIds = selectionCall ? parseMemorySelectionArguments(selectionCall.function.arguments) : null

    if (!parsedIds) return candidates.slice(0, MAX_SELECTED_MEMORIES).map(({ id }) => id)

    return parsedIds
        .filter((id) => allowedIds.has(id))
        .slice(0, MAX_SELECTED_MEMORIES)
}

function buildRouterSelectionTool(candidates: RetrievedChunk[]): ToolDefinition {
    return {
        name: ROUTER_SELECTION_TOOL_NAME,
        description: 'Select the memory IDs that are relevant to the current request.',
        timeout: 1_000,
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                memoryIds: {
                    type: 'array',
                    description: 'Relevant memory IDs.',
                    items: {
                        type: 'string',
                        enum: candidates.map(({ id }) => id),
                    },
                },
            },
            required: ['memoryIds'],
        },
        execute: async () => ({ success: true, output: 'ok' }),
    }
}

function parseMemorySelectionArguments(raw: string): string[] | null {
    try {
        const parsed = JSON.parse(raw) as { memoryIds?: unknown }
        return Array.isArray(parsed.memoryIds)
            ? parsed.memoryIds.filter((item): item is string => typeof item === 'string')
            : null
    } catch {
        return null
    }
}

function messageContentForRouter(content: string | ContentPart[]): string {
    if (typeof content === 'string') return content
    const text = content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim()
    return text || '[multipart content]'
}

function compactMemoryText(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, MEMORY_TEXT_LIMIT)
}

function memoryLabel(chunk: RetrievedChunk): string {
    const label = [
        chunk.spaceName,
        chunk.sourceFile,
        chunk.chunkIndex != null ? `part ${chunk.chunkIndex + 1}${chunk.totalChunks ? `/${chunk.totalChunks}` : ''}` : '',
    ].filter(Boolean).join(' - ')

    return label || 'Memory snippet'
}

function emitMemoryRoutingStatus(conversationId: string, taskId: string): void {
    getEventBus().emit('step:status', {
        conversationId,
        taskId,
        iteration: 0,
        status: 'routing-memory',
        message: 'Selecting relevant memories...',
    })
}

function emitMemoryRoutingSelection(conversationId: string, taskId: string, memories: RetrievedChunk[]): void {
    getEventBus().emit('step:tools-chosen', {
        conversationId,
        taskId,
        iteration: 0,
        toolCalls: memories.map((memory) => ({
            name: memoryLabel(memory),
            arguments: JSON.stringify({
                type: 'memory',
                sourceFile: memory.sourceFile,
                memorySpace: memory.spaceName,
                chunkIndex: memory.chunkIndex,
            }),
        })),
    })
}
