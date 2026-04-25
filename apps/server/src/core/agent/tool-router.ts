import { createHash } from 'crypto'
import { getEmbeddingProvider } from '../memory/embedding.js'
import { getDb } from '../../db/database.js'
import type { LLMGateway } from '../gateway/gateway.js'
import type { ChatMessage, ContentPart, ToolDefinition } from '../gateway/providers/base.provider.js'
import type { ToolNamespaceMetadata } from '../tools/tool-registry.js'

export const MCP_CANDIDATE_COUNT = 8
export const CONTEXT_WINDOW_TURNS = 5
export const TOOL_COUNT_THRESHOLD = 20
export const ROUTER_SELECTION_TOOL_NAME = 'select_relevant_tools'
export const TOOL_SEARCH_TOOL_NAME = 'search_available_mcp_tools'

const TURN_CHAR_LIMIT = 200
const TOOL_DESCRIPTION_LIMIT = 320
const MAX_CONFIRMED_TOOLS = 40
const FALLBACK_TOOL_COUNT = 12
const TOOL_SEARCH_LIMIT = 12

interface McpToolGroup {
    id: string
    label: string
    description: string
    tools: ToolDefinition[]
}

interface RouterEmbeddingScope {
    providerId: string
    model: string
    dimensions: number
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
    opts: { enabled?: boolean; threshold?: number } = {},
): boolean {
    return (
        opts.enabled !== false &&
        Boolean(userQuery?.trim()) &&
        tools.length > (opts.threshold ?? TOOL_COUNT_THRESHOLD) &&
        tools.some(isMcpTool)
    )
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
        const cachedVectors = loadCachedRouterEmbeddings(mcpGroups, hashes, scope)
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
            .map(({ id }) => ({
                id,
                score: cosineSimilarity(queryVector, groupVectors.get(id) || []),
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
        : parseToolNameArray(result.content)

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
        usedToolNames,
        topK = MCP_CANDIDATE_COUNT,
        contextWindowTurns = CONTEXT_WINDOW_TURNS,
    } = input

    const localTools = allTools.filter((tool) => !isMcpTool(tool))
    const mcpTools = allTools.filter(isMcpTool)
    if (!mcpTools.length) return allTools

    const query = buildRouterQuery(userQuery, recentMessages, contextWindowTurns)
    const groups = buildMcpGroups(mcpTools, mcpMetadata)
    const candidateGroupIds = new Set(await embeddingPreFilter(query, groups, topK))

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
    const stickyNames = collectStickyToolNames(recentMessages, contextWindowTurns, usedToolNames)
    const stickyTools = allTools.filter(({ name }) => stickyNames.has(name))

    let routedTools: ToolDefinition[] = []
    const searchTool = buildToolSearchTool(allTools, () => routedTools)

    routedTools = dedupeTools([...selectedTools, ...stickyTools, searchTool])
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

function buildToolSearchTool(
    allTools: ToolDefinition[],
    getLoadedTools: () => ToolDefinition[],
): ToolDefinition {
    return {
        name: TOOL_SEARCH_TOOL_NAME,
        description:
            'Search and load additional available tools when the current tools are insufficient. Use this before saying a capability is unavailable.',
        timeout: 1_000,
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                query: {
                    type: 'string',
                    description:
                        'Capability to search for, e.g. "gmail latest email", "calendar event", or "github issue search".',
                },
                limit: {
                    type: 'number',
                    description: `Maximum tools to load. Defaults to ${TOOL_SEARCH_LIMIT}.`,
                },
            },
            required: ['query'],
        },
        execute: async (params) => {
            const { query, limit } = parseToolSearchArgs(params)

            if (!query) {
                return { success: false, output: 'Provide a non-empty query to search available tools.' }
            }

            const loadedTools = getLoadedTools()
            const loadedNames = new Set(loadedTools.map(({ name }) => name))
            const searchableTools = allTools.filter(
                (tool) => isMcpTool(tool) && tool.name !== TOOL_SEARCH_TOOL_NAME && !loadedNames.has(tool.name),
            )

            const names = lexicalToolFallback(query, searchableTools, limit)
            const matches = searchableTools.filter(({ name }) => names.includes(name))

            for (const tool of matches) {
                if (loadedNames.has(tool.name)) continue
                loadedTools.push(tool)
                loadedNames.add(tool.name)
            }

            if (!matches.length) {
                return { success: true, output: `No additional tools found for "${query}".` }
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

function parseToolSearchArgs(params: unknown): { query: string; limit: number } {
    const args = params && typeof params === 'object'
        ? params as { query?: unknown; limit?: unknown }
        : {}

    const query = typeof args.query === 'string' ? args.query.trim() : ''
    const limit = typeof args.limit === 'number'
        ? Math.max(1, Math.min(TOOL_SEARCH_LIMIT, Math.floor(args.limit)))
        : TOOL_SEARCH_LIMIT

    return { query, limit }
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
    return description
        .replace(/^\[MCP:\s*[^\]]*\]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, TOOL_DESCRIPTION_LIMIT)
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

function loadCachedRouterEmbeddings(
    groups: McpToolGroup[],
    hashes: Map<string, string>,
    scope: RouterEmbeddingScope,
): Map<string, number[]> {
    const vectors = new Map<string, number[]>()

    try {
        const stmt = getDb().prepare(`
            SELECT content_hash, vector_json
            FROM tool_router_embeddings
            WHERE namespace_id = ?
              AND embedding_provider_id = ?
              AND embedding_model = ?
              AND embedding_dimensions = ?
        `)

        for (const group of groups) {
            const row = stmt.get(group.id, scope.providerId, scope.model, scope.dimensions) as {
                content_hash: string
                vector_json: string
            } | undefined

            if (!row || row.content_hash !== hashes.get(group.id)) continue

            const vector = JSON.parse(row.vector_json) as unknown
            if (isNumberArray(vector)) vectors.set(group.id, vector)
        }
    } catch (err) {
        console.warn('[tool-router] Failed to read router embedding cache:', err)
    }

    return vectors
}

function saveCachedRouterEmbedding(
    namespaceId: string,
    contentHash: string,
    vector: number[],
    scope: RouterEmbeddingScope,
): void {
    try {
        getDb().prepare(`
            INSERT INTO tool_router_embeddings (
                namespace_id,
                embedding_provider_id,
                embedding_model,
                embedding_dimensions,
                content_hash,
                vector_json,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(namespace_id, embedding_provider_id, embedding_model, embedding_dimensions)
            DO UPDATE SET
                content_hash = excluded.content_hash,
                vector_json = excluded.vector_json,
                updated_at = excluded.updated_at
        `).run(
            namespaceId,
            scope.providerId,
            scope.model,
            scope.dimensions,
            contentHash,
            JSON.stringify(vector),
            Date.now(),
        )
    } catch (err) {
        console.warn('[tool-router] Failed to write router embedding cache:', err)
    }
}

function pruneRouterEmbeddingCache(
    activeNamespaceIds: string[],
    scope: RouterEmbeddingScope,
): void {
    if (!activeNamespaceIds.length) return

    try {
        const placeholders = activeNamespaceIds.map(() => '?').join(', ')

        getDb().prepare(`
            DELETE FROM tool_router_embeddings
            WHERE embedding_provider_id = ?
              AND embedding_model = ?
              AND embedding_dimensions = ?
              AND namespace_id NOT IN (${placeholders})
        `).run(scope.providerId, scope.model, scope.dimensions, ...activeNamespaceIds)
    } catch (err) {
        console.warn('[tool-router] Failed to prune router embedding cache:', err)
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
): Array<{ value: string; score: number; index: number }> {
    const terms = tokenize(query)

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

function parseToolNameArray(content: string): string[] | null {
    const cleaned = content
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/i, '')
        .trim()

    const start = cleaned.indexOf('[')
    const end = cleaned.lastIndexOf(']')
    if (start === -1 || end === -1 || end < start) return null

    return parseStringArray(cleaned.slice(start, end + 1))
}

function parseToolSelectionArguments(argumentsJson: string): string[] | null {
    try {
        const parsed = JSON.parse(argumentsJson) as unknown

        if (Array.isArray(parsed)) return filterStrings(parsed)
        if (!parsed || typeof parsed !== 'object') return null

        const args = parsed as Record<string, unknown>
        const toolNames = args.toolNames || args.tools || args.selectedTools

        return Array.isArray(toolNames) ? filterStrings(toolNames) : null
    } catch {
        return null
    }
}

function parseStringArray(json: string): string[] | null {
    try {
        const parsed = JSON.parse(json) as unknown
        return Array.isArray(parsed) ? filterStrings(parsed) : null
    } catch {
        return null
    }
}

function filterStrings(items: unknown[]): string[] {
    return items.filter((item): item is string => typeof item === 'string')
}

function isNumberArray(value: unknown): value is number[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'number')
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
