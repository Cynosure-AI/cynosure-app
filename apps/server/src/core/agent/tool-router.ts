import { getEmbeddingProvider } from '../memory/embedding.js'
import type { LLMGateway } from '../gateway/gateway.js'
import type { ChatMessage, ContentPart, ToolDefinition } from '../gateway/providers/base.provider.js'
import type { ToolNamespaceMetadata } from '../tools/tool-registry.js'

export const ROUTER_MODEL = 'qwen/qwen3-0.6b'
export const MCP_CANDIDATE_COUNT = 8
export const CONTEXT_WINDOW_TURNS = 5
export const TOOL_COUNT_THRESHOLD = 20

const TURN_CHAR_LIMIT = 200
const TOOL_DESCRIPTION_LIMIT = 320
const MAX_CONFIRMED_TOOLS = 40

interface McpToolGroup {
    id: string
    label: string
    description: string
    tools: ToolDefinition[]
}

export interface RouteToolsInput {
    userQuery: string
    recentMessages?: ChatMessage[]
    allTools: ToolDefinition[]
    gateway: LLMGateway
    providerId?: string
    model?: string
    routerModel?: string
    mcpMetadata?: ToolNamespaceMetadata[]
    usedToolNames?: Set<string>
    topK?: number
    contextWindowTurns?: number
}

export function buildRouterQuery(
    currentMessage: string,
    messages: ChatMessage[] = [],
    windowSize = CONTEXT_WINDOW_TURNS,
): string {
    const recent = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-windowSize)

    if (!recent.length) return currentMessage

    const context = recent
        .map((m) => `${m.role}: ${messageContentForRouter(m.content).slice(0, TURN_CHAR_LIMIT)}`)
        .join('\n')

    return `Recent conversation:\n${context}\n\nCurrent request: ${currentMessage}`
}

export function shouldRouteTools(
    tools: ToolDefinition[],
    userQuery?: string,
    opts: { enabled?: boolean; threshold?: number } = {},
): boolean {
    if (opts.enabled === false) return false
    if (!userQuery?.trim()) return false
    if (tools.length <= (opts.threshold ?? TOOL_COUNT_THRESHOLD)) return false
    return tools.some((tool) => isMcpTool(tool))
}

export async function embeddingPreFilter(
    query: string,
    mcpGroups: McpToolGroup[],
    topK = MCP_CANDIDATE_COUNT,
): Promise<string[]> {
    if (mcpGroups.length <= topK) return mcpGroups.map((group) => group.id)

    try {
        const embedder = getEmbeddingProvider()
        const embeddings = await embedder.embedBatch([
            query,
            ...mcpGroups.map((group) => `${group.label}\n${group.description}`),
        ])
        const queryVector = embeddings[0].vector

        return mcpGroups
            .map((group, index) => ({
                id: group.id,
                score: cosineSimilarity(queryVector, embeddings[index + 1].vector),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map((item) => item.id)
    } catch (err) {
        console.warn('[tool-router] Embedding pre-filter failed, using lexical fallback:', err)
        return lexicalPreFilter(query, mcpGroups, topK)
    }
}

export async function llmConfirmTools(
    query: string,
    candidateTools: ToolDefinition[],
    config: { gateway: LLMGateway; providerId?: string; model?: string; signal?: AbortSignal },
): Promise<string[]> {
    if (!candidateTools.length) return []

    const availableTools = candidateTools
        .map((tool) => `${tool.name}: ${compactToolDescription(tool.description)}`)
        .join('\n')

    const result = await config.gateway.complete({
        messages: [
            {
                role: 'system',
                content:
                    'You are a tool selection assistant. Given a user request and a list of available tools, return a JSON array of tool names that are needed to fulfill the request. Return ONLY the JSON array. No explanation. No markdown. If no tools are needed, return []. /no_think',
            },
            {
                role: 'user',
                content: `Request: ${query}\n\nAvailable tools:\n${availableTools}\n\nReturn the tool names needed as a JSON array.`,
            },
        ],
        model: config.model,
        maxTokens: 500,
        temperature: 0,
        thinkingEnabled: false,
        signal: config.signal,
    }, config.providerId)

    const allowed = new Set(candidateTools.map((tool) => tool.name))
    const parsedNames = parseToolNameArray(result.content)
    if (!parsedNames) return candidateTools.map((tool) => tool.name).slice(0, MAX_CONFIRMED_TOOLS)

    return parsedNames
        .filter((name) => allowed.has(name))
        .slice(0, MAX_CONFIRMED_TOOLS)
}

export async function routeTools(input: RouteToolsInput): Promise<ToolDefinition[]> {
    const {
        userQuery,
        recentMessages = [],
        allTools,
        gateway,
        providerId,
        model,
        routerModel,
        mcpMetadata = [],
        usedToolNames,
        topK = MCP_CANDIDATE_COUNT,
        contextWindowTurns = CONTEXT_WINDOW_TURNS,
    } = input

    const alwaysIncluded = allTools.filter((tool) => !isMcpTool(tool))
    const mcpTools = allTools.filter(isMcpTool)
    if (!mcpTools.length) return allTools

    const query = buildRouterQuery(userQuery, recentMessages, contextWindowTurns)
    const groups = buildMcpGroups(mcpTools, mcpMetadata)
    const candidateGroupIds = new Set(await embeddingPreFilter(query, groups, topK))
    const candidateTools = groups
        .filter((group) => candidateGroupIds.has(group.id))
        .flatMap((group) => group.tools)

    const confirmedNames = new Set(await llmConfirmTools(query, candidateTools, {
        gateway,
        providerId,
        model: routerModel || model,
    }))

    const selected = candidateTools.filter((tool) => confirmedNames.has(tool.name))
    const stickyNames = collectStickyToolNames(recentMessages, contextWindowTurns, usedToolNames)
    const stickyTools = allTools.filter((tool) => stickyNames.has(tool.name))

    return dedupeTools([...alwaysIncluded, ...selected, ...stickyTools])
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

function isMcpTool(tool: ToolDefinition): boolean {
    return Boolean(tool.namespaceId?.startsWith('mcp:'))
}

function buildMcpGroups(tools: ToolDefinition[], metadata: ToolNamespaceMetadata[]): McpToolGroup[] {
    const metadataById = new Map(metadata.map((item) => [item.id, item]))
    const groups = new Map<string, McpToolGroup>()

    for (const tool of tools) {
        const id = tool.namespaceId
        if (!id) continue

        let group = groups.get(id)
        if (!group) {
            const meta = metadataById.get(id)
            group = {
                id,
                label: meta?.label || tool.namespaceLabel || id,
                description: meta?.description || tool.namespaceDescription || '',
                tools: [],
            }
            groups.set(id, group)
        }
        group.tools.push(tool)
    }

    for (const group of groups.values()) {
        if (!group.description.trim()) {
            group.description = group.tools
                .slice(0, 8)
                .map((tool) => `${tool.name}: ${compactToolDescription(tool.description)}`)
                .join('\n')
        }
    }

    return [...groups.values()]
}

function compactToolDescription(description: string): string {
    return description
        .replace(/^\[MCP:\s*[^\]]*\]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, TOOL_DESCRIPTION_LIMIT)
}

function cosineSimilarity(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length)
    let dot = 0
    let magA = 0
    let magB = 0

    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i]
        magA += a[i] * a[i]
        magB += b[i] * b[i]
    }

    if (!magA || !magB) return 0
    return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

function lexicalPreFilter(query: string, groups: McpToolGroup[], topK: number): string[] {
    const terms = new Set(query.toLowerCase().match(/[a-z0-9_]{3,}/g) || [])
    return groups
        .map((group) => {
            const haystack = `${group.label}\n${group.description}\n${group.tools.map((tool) => `${tool.name} ${tool.description}`).join('\n')}`.toLowerCase()
            let score = 0
            for (const term of terms) {
                if (haystack.includes(term)) score += 1
            }
            return { id: group.id, score }
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map((item) => item.id)
}

function parseToolNameArray(content: string): string[] | null {
    const cleaned = content
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/i, '')
        .trim()

    const start = cleaned.indexOf('[')
    const end = cleaned.lastIndexOf(']')
    if (start === -1 || end === -1 || end < start) return null

    try {
        const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown
        if (!Array.isArray(parsed)) return null
        return parsed.filter((item): item is string => typeof item === 'string')
    } catch {
        return null
    }
}

function collectStickyToolNames(
    recentMessages: ChatMessage[],
    windowSize: number,
    usedToolNames?: Set<string>,
): Set<string> {
    const names = new Set(usedToolNames ? [...usedToolNames] : [])
    for (const message of recentMessages.slice(-windowSize)) {
        for (const call of message.toolCalls || []) {
            names.add(call.function.name)
        }
    }
    return names
}

function dedupeTools(tools: ToolDefinition[]): ToolDefinition[] {
    const seen = new Set<string>()
    const result: ToolDefinition[] = []

    for (const tool of tools) {
        if (seen.has(tool.name)) continue
        seen.add(tool.name)
        result.push(tool)
    }

    return result
}
