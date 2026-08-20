import type {
    ContextStrategy,
    DebugContextRound,
    DebugContextSnapshot,
    DebugContextTool,
    ReasoningEffort,
} from '@shared/types'
import type { ChatMessage, ToolDefinition, ToolCall } from '../gateway/providers/base.provider.js'

const MAX_CAPTURED_CONVERSATIONS = 20
const captures = new Map<string, DebugContextSnapshot>()

export interface BeginDebugContextInput {
    conversationId: string
    executionId: string
    providerId?: string
    model?: string
    contextWindow?: number
    contextStrategy?: ContextStrategy
}

export interface DebugModelRequest {
    messages: ChatMessage[]
    tools: ToolDefinition[]
    model?: string
    temperature?: number
    maxTokens?: number
    thinkingEnabled?: boolean
    reasoningEffort?: ReasoningEffort
}

export interface DebugModelResponse {
    content: string
    thinking: string
    toolCalls?: ToolCall[]
    images?: string[]
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
    error?: string
}

function clone<T>(value: T): T {
    return structuredClone(value)
}

function serializableTool(tool: ToolDefinition): DebugContextTool {
    return {
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        description: tool.description,
        parameters: clone(tool.parameters),
        ...(tool.outputSchema ? { outputSchema: clone(tool.outputSchema) } : {}),
    }
}

function touch(conversationId: string, snapshot: DebugContextSnapshot): void {
    captures.delete(conversationId)
    captures.set(conversationId, snapshot)
    while (captures.size > MAX_CAPTURED_CONVERSATIONS) {
        const oldest = captures.keys().next().value as string | undefined
        if (!oldest) break
        captures.delete(oldest)
    }
}

export function beginDebugContextCapture(input: BeginDebugContextInput): void {
    const now = Date.now()
    touch(input.conversationId, {
        ...input,
        createdAt: now,
        updatedAt: now,
        rounds: [],
        limitations: [
            'This is the complete request assembled by Cynosure at the LLM gateway boundary. A provider may serialize or normalize it before inference.',
            'Thinking contains only reasoning content explicitly returned by the provider. Provider-private chain-of-thought and platform instructions unavailable to Cynosure cannot be captured.',
        ],
    })
}

export function recordDebugModelRequest(conversationId: string, request: DebugModelRequest): number | undefined {
    const snapshot = captures.get(conversationId)
    if (!snapshot) return undefined

    const roundIndex = snapshot.rounds.length
    const round: DebugContextRound = {
        round: roundIndex + 1,
        capturedAt: Date.now(),
        request: {
            messages: clone(request.messages),
            tools: request.tools.map(serializableTool),
            model: request.model,
            temperature: request.temperature,
            maxTokens: request.maxTokens,
            thinkingEnabled: request.thinkingEnabled,
            reasoningEffort: request.reasoningEffort,
        },
    }
    snapshot.rounds.push(round)
    snapshot.updatedAt = Date.now()
    touch(conversationId, snapshot)
    return roundIndex
}

export function recordDebugModelResponse(
    conversationId: string,
    roundIndex: number | undefined,
    response: DebugModelResponse,
): void {
    if (roundIndex === undefined) return
    const snapshot = captures.get(conversationId)
    const round = snapshot?.rounds[roundIndex]
    if (!snapshot || !round) return

    round.response = {
        ...clone(response),
        completedAt: Date.now(),
    }
    snapshot.updatedAt = Date.now()
    touch(conversationId, snapshot)
}

export function getDebugContextCapture(conversationId: string): DebugContextSnapshot | null {
    const snapshot = captures.get(conversationId)
    return snapshot ? clone(snapshot) : null
}

export function clearDebugContextCapture(conversationId: string): void {
    captures.delete(conversationId)
}
