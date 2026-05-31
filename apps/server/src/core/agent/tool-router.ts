import { createHash } from 'crypto'
import { getEmbeddingProvider } from '../memory/embedding.js'
import { makeSearchAvailableMcpToolsTool } from '../tools/builtin/expand-available-toolset.js'
import {
    loadCachedRouterEmbeddings,
    pruneRouterEmbeddingCache,
    saveCachedRouterEmbedding,
    type RouterEmbeddingScope,
} from './router-embedding-cache.js'
import type { LLMGateway } from '../gateway/gateway.js'
import type { ChatMessage, ContentPart, ToolDefinition } from '../gateway/providers/base.provider.js'
import type { ToolNamespaceMetadata } from '../tools/tool-registry.js'
import { normalizeToolDescription } from '../tools/tool-description.js'

export const MCP_CANDIDATE_COUNT = 8 // Top-K MCP tool groups selected by embedding similarity and passed to the LLM for final confirmation
export const CONTEXT_WINDOW_TURNS = 5 // Recent turns included in routing query context
export const ROUTER_SELECTION_TOOL_NAME = 'select_relevant_tools' // Name of the tool the router LLM calls to confirm its tool selection

const TURN_CHAR_LIMIT = 200 // Max characters taken from each conversation turn when building the router query
const TOOL_DESCRIPTION_LIMIT = 320 // Max characters of a tool description used in embedding/LLM calls
const MAX_CONFIRMED_TOOLS = 40 // Upper bound on how many tools the LLM confirmation step may select
const FALLBACK_TOOL_COUNT = 12 // How many tools to fall back to via lexical scoring if LLM confirmation fails

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
    /** Explicitly selected tool names that must survive routing. */
    preferredToolNames?: Set<string>
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
        .filter(({ role }) => role === 'user' || role === 'assistant')
        .slice(-windowSize)

    if (!recent.length) return currentMessage

    const context = recent
        .map(({ role, content }) => {
            const text = messageContentForRouter(content).slice(0, TURN_CHAR_LIMIT)
            return `${role}: ${text}`
        })
        .join('\n')

    return `Recent conversation:\n${context}\n\nCurrent request: ${currentMessage}`
}

export function shouldRouteTools(
    tools: ToolDefinition[],
    userQuery?: string,
    opts: { enabled?: boolean } = {},
): boolean {
    const hasMcpTools = tools.some(isMcpTool)

    return opts.enabled === true && Boolean(userQuery?.trim()) && hasMcpTools
}

export async function embeddingPreFilter(
    query: string,
    mcpGroups: McpToolGroup[],
    topK = MCP_CANDIDATE_COUNT,
): Promise<string[]> {
    if (mcpGroups.length <= topK) return mcpGroups.map(({ id }) => id)

    try {
        const embedder = getEmbeddingProvider()
        const scope = getRouterEmbeddingScope(embedder)
        const hashes = new Map(mcpGroups.map((group) => [group.id, groupContentHash(group)]))
        const cachedVectors = loadCachedRouterEmbeddings(mcpGroups.map(({ id }) => id), hashes, scope)
        const missingGroups = mcpGroups.filter(({ id }) => !cachedVectors.has(id))

        const embeddings = await embedder.embedBatch([
            query,
            ...missingGroups.map(groupEmbeddingText),
        ])

        const queryVector = embeddings[0].vector
        const groupVectors = new Map(cachedVectors)

        missingGroups.forEach((group, index) => {
            const vector = embeddings[index + 1]?.vector
            if (!vector) return

            groupVectors.set(group.id, vector)
            saveCachedRouterEmbedding(group.id, hashes.get(group.id) || '', vector, scope)
        })

        pruneRouterEmbeddingCache(mcpGroups.map(({ id }) => id), scope)

        return mcpGroups
            .map((group) => ({
                id: group.id,
                score: cosineSimilarity(queryVector, groupVectors.get(group.id) || []),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(({ id }) => id)
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
                    `You are a tool selection assistant. Given a user request and a list of available tools, call ${ROUTER_SELECTION_TOOL_NAME} with every tool name needed to fulfill the request. Include prerequisite/helper tools when a selected tool description says another tool is required. If no tools are needed, call it with an empty array. /no_think`,
            },
            {
                role: 'user',
                content: `Request: ${query}\n\nAvailable tools:\n${availableTools}`,
            },
        ],
        model: config.model,
        maxTokens: 500,
        tools: [buildRouterSelectionTool(candidateTools)],
        toolChoice: { type: 'function', name: ROUTER_SELECTION_TOOL_NAME },
        thinkingEnabled: false,
        signal: config.signal,
    }, config.providerId)

    const allowedNames = new Set(candidateTools.map(({ name }) => name))
    const selectionCall = result.toolCalls?.find(
        (call) => call.function.name === ROUTER_SELECTION_TOOL_NAME,
    )

    const parsedNames = selectionCall
        ? parseToolSelectionArguments(selectionCall.function.arguments)
        : null

    if (!parsedNames) {
        return lexicalToolFallback(query, candidateTools, FALLBACK_TOOL_COUNT)
    }

    return parsedNames
        .filter((name) => allowedNames.has(name))
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
        preferredToolNames,
        usedToolNames,
        topK = MCP_CANDIDATE_COUNT,
        contextWindowTurns = CONTEXT_WINDOW_TURNS,
    } = input

    const localTools = allTools.filter((tool) => !isMcpTool(tool))
    const mcpTools = allTools.filter(isMcpTool)
    if (!mcpTools.length) return allTools

    const query = buildRouterQuery(userQuery, recentMessages, contextWindowTurns)
    const groups = buildMcpGroups(mcpTools, mcpMetadata)
    const fixedTools = preferredToolNames?.size
        ? allTools.filter(({ name }) => preferredToolNames.has(name))
        : []
    const fixedGroupIds = new Set(
        groups
            .filter((group) => countPreferredTools(group.tools, preferredToolNames) > 0)
            .map(({ id }) => id),
    )
    const candidateGroupIds = new Set([
        ...await embeddingPreFilter(query, groups, topK),
        ...fixedGroupIds,
    ])

    const candidateMcpTools = groups
        .filter(({ id }) => candidateGroupIds.has(id))
        .flatMap(({ tools }) => tools)

    const candidateTools = dedupeTools([...localTools, ...candidateMcpTools])

    let confirmedNames: Set<string>
    try {
        confirmedNames = new Set(await llmConfirmTools(query, candidateTools, {
            gateway,
            providerId,
            model: routerModel || model,
        }))
    } catch (err) {
        console.warn('[tool-router] LLM confirmation failed, using lexical tool fallback:', err)
        confirmedNames = new Set(lexicalToolFallback(query, candidateTools, FALLBACK_TOOL_COUNT))
    }

    const selectedTools = candidateTools.filter(({ name }) => confirmedNames.has(name))
    const stickyNames = collectStickyToolNames(recentMessages, usedToolNames)
    const stickyTools = allTools.filter(({ name }) => stickyNames.has(name))

    let routedTools: ToolDefinition[] = []
    const searchTool = makeSearchAvailableMcpToolsTool({
        allTools,
        getLoadedToolNames: () => new Set(routedTools.map(({ name }) => name)),
    })

    routedTools = dedupeTools([...fixedTools, ...selectedTools, ...stickyTools, searchTool])
    return routedTools
}

function buildRouterSelectionTool(candidateTools: ToolDefinition[]): ToolDefinition {
    return {
        name: ROUTER_SELECTION_TOOL_NAME,
        description: 'Select the tool names required to answer the current user request.',
        timeout: 1_000,
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                toolNames: {
                    type: 'array',
                    description: 'Names of tools required for the request, including prerequisite helper tools.',
                    items: {
                        type: 'string',
                        enum: candidateTools.map(({ name }) => name),
                    },
                },
            },
            required: ['toolNames'],
        },
        execute: async () => ({ success: true, output: 'ok' }),
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

function isMcpTool(tool: ToolDefinition): boolean {
    return Boolean(tool.namespaceId?.startsWith('mcp:'))
}

function buildMcpGroups(
    tools: ToolDefinition[],
    metadata: ToolNamespaceMetadata[],
): McpToolGroup[] {
    const metadataById = new Map(metadata.map((item) => [item.id, item]))
    const groups = new Map<string, McpToolGroup>()

    for (const tool of tools) {
        const id = tool.namespaceId
        if (!id) continue

        if (!groups.has(id)) {
            const meta = metadataById.get(id)
            groups.set(id, {
                id,
                label: meta?.label || tool.namespaceLabel || id,
                description: meta?.description || tool.namespaceDescription || '',
                tools: [],
            })
        }

        groups.get(id)?.tools.push(tool)
    }

    for (const group of groups.values()) {
        if (group.description.trim()) continue

        group.description = group.tools
            .slice(0, 8)
            .map((tool) => `${tool.name}: ${compactToolDescription(tool.description)}`)
            .join('\n')
    }

    return [...groups.values()]
}

function compactToolDescription(description: string): string {
    return normalizeToolDescription(description, TOOL_DESCRIPTION_LIMIT)
}

function groupEmbeddingText(group: McpToolGroup): string {
    const toolSamples = group.tools
        .slice(0, 24)
        .map((tool) => `${tool.name}: ${compactToolDescription(tool.description)}`)
        .join('\n')

    return [
        `Namespace: ${group.label}`,
        `ID: ${group.id}`,
        group.description ? `Description: ${group.description}` : '',
        toolSamples ? `Tools:\n${toolSamples}` : '',
    ].filter(Boolean).join('\n')
}

function groupContentHash(group: McpToolGroup): string {
    const fullToolText = group.tools
        .map((tool) => [
            tool.name,
            compactToolDescription(tool.description),
            JSON.stringify(tool.parameters || {}),
        ].join('\n'))
        .join('\n---\n')

    return createHash('sha256')
        .update(`${group.id}\n${group.label}\n${group.description}\n${fullToolText}`)
        .digest('hex')
}

function getRouterEmbeddingScope(
    embedder: ReturnType<typeof getEmbeddingProvider>,
): RouterEmbeddingScope {
    const config = embedder.getConfig()

    return {
        providerId: config.providerId || '',
        model: embedder.getModelName(),
        dimensions: embedder.getDimensions(),
    }
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

    return magA && magB
        ? dot / (Math.sqrt(magA) * Math.sqrt(magB))
        : 0
}

function lexicalPreFilter(
    query: string,
    groups: McpToolGroup[],
    topK: number,
): string[] {
    return scoreItems(
        query,
        groups,
        (group) => `${group.label}\n${group.description}\n${group.tools.map(toolText).join('\n')}`,
        ({ id }) => id,
    )
        .slice(0, topK)
        .map(({ value }) => value)
}

function lexicalToolFallback(
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
    bonusForItem?: (item: T) => number,
): Array<{ value: string; score: number; index: number }> {
    const terms = tokenize(query)

    return items
        .map((item, index) => {
            const haystack = textForItem(item).toLowerCase()
            const score = [...terms].reduce(
                (sum, term) => sum + (haystack.includes(term) ? 1 : 0),
                0,
            ) + (bonusForItem?.(item) || 0)

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

function parseToolSelectionArguments(argumentsJson: string): string[] | null {
    try {
        const parsed = JSON.parse(argumentsJson) as unknown

        if (!parsed || typeof parsed !== 'object') return null

        const args = parsed as Record<string, unknown>
        const toolNames = args.toolNames

        return Array.isArray(toolNames) ? extractStringArray(toolNames) : null
    } catch {
        return null
    }
}

function extractStringArray(items: unknown[]): string[] {
    return items.filter((item): item is string => typeof item === 'string')
}

function collectStickyToolNames(
    recentMessages: ChatMessage[],
    usedToolNames?: Set<string>,
): Set<string> {
    const names = new Set<string>()

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

function countPreferredTools(tools: Array<{ name: string }>, preferredToolNames?: Set<string>): number {
    if (!preferredToolNames?.size) return 0

    let matches = 0
    for (const tool of tools) {
        if (preferredToolNames.has(tool.name)) matches++
    }
    return matches
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
