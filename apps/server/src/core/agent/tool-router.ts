import { createHash } from 'crypto'
import { getEmbeddingProvider } from '../memory/embedding.js'
import { makeSearchAvailableMcpToolsTool } from '../tools/builtin/expand-available-toolset.js'
import {
    loadCachedRouterEmbeddings,
    loadCachedToolEmbeddings,
    pruneRouterEmbeddingCache,
    pruneToolEmbeddingCache,
    saveCachedRouterEmbedding,
    saveCachedToolEmbedding,
    type RouterEmbeddingScope,
} from './router-embedding-cache.js'
import type { ChatMessage, ContentPart, RegistryAwareToolDefinition, ToolDefinition } from '../gateway/providers/base.provider.js'
import type { ToolNamespaceMetadata } from '../tools/tool-registry.js'
import { compactToolDescription } from '../tools/tool-description.js'

export const MCP_CANDIDATE_COUNT = 8 // Top-K MCP tool groups selected by embedding similarity
export const CONTEXT_WINDOW_TURNS = 5 // Recent turns included in routing query context

const TURN_CHAR_LIMIT = 200 // Max characters taken from each conversation turn when building the router query
const MAX_ROUTED_TOOLS = 16 // Upper bound for automatically selected tools after individual ranking
const MIN_RELATIVE_TOOL_SCORE = 0.72 // Keep near-matches when their embedding score is close to the best hit

interface McpToolGroup {
    id: string
    label: string
    description: string
    tools: RegistryAwareToolDefinition[]
}

export type RoutedToolDefinition = ToolDefinition & { routerScore?: number }

export interface RouteToolsInput {
    userQuery: string
    recentMessages?: ChatMessage[]
    allTools: RegistryAwareToolDefinition[]
    mcpMetadata?: ToolNamespaceMetadata[]
    /** Explicitly selected tool names that must survive routing. */
    preferredToolNames?: Set<string>
    usedToolNames?: Set<string>
    topK?: number
    maxTools?: number
    contextWindowTurns?: number
    onStatus?: (status: 'indexing-tools' | 'finding-tools', message: string) => void
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
    tools: RegistryAwareToolDefinition[],
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
    onStatus?: RouteToolsInput['onStatus'],
): Promise<{ groupIds: string[]; queryVector: number[] }> {
    if (mcpGroups.length <= topK) {
        const embedder = getEmbeddingProvider()
        const { vector: queryVector } = await embedder.embed(query)
        return { groupIds: mcpGroups.map(({ id }) => id), queryVector }
    }

    try {
        const embedder = getEmbeddingProvider()
        const scope = getRouterEmbeddingScope(embedder)
        const hashes = new Map(mcpGroups.map((group) => [group.id, groupContentHash(group)]))
        const cachedVectors = loadCachedRouterEmbeddings(mcpGroups.map(({ id }) => id), hashes, scope)
        const missingGroups = mcpGroups.filter(({ id }) => !cachedVectors.has(id))

        if (missingGroups.length) {
            onStatus?.('indexing-tools', `Indexing ${missingGroups.length} tool group${missingGroups.length === 1 ? '' : 's'}...`)
        }

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

        const groupIds = mcpGroups
            .map((group) => ({
                id: group.id,
                score: cosineSimilarity(queryVector, groupVectors.get(group.id) || []),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(({ id }) => id)

        return { groupIds, queryVector }
    } catch (err) {
        console.warn('[tool-router] Embedding pre-filter failed, using lexical fallback:', err)
        const embedder = getEmbeddingProvider()
        onStatus?.('indexing-tools', 'Indexing tool search query...')
        const { vector: queryVector } = await embedder.embed(query)
        return { groupIds: lexicalPreFilter(query, mcpGroups, topK), queryVector }
    }
}

export async function routeTools(input: RouteToolsInput): Promise<RoutedToolDefinition[]> {
    const {
        userQuery,
        recentMessages = [],
        allTools,
        mcpMetadata = [],
        preferredToolNames,
        usedToolNames,
        topK = MCP_CANDIDATE_COUNT,
        maxTools = MAX_ROUTED_TOOLS,
        contextWindowTurns = CONTEXT_WINDOW_TURNS,
        onStatus,
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
    const stickyNames = collectStickyToolNames(recentMessages, usedToolNames)
    const protectedNames = new Set([
        ...fixedTools.map(({ name }) => name),
        ...stickyNames,
    ])

    // Single unified embedding pass: group pre-filter + tool ranking share the query vector.
    const { groupIds: candidateGroupIdList, queryVector } = await embeddingPreFilter(query, groups, topK, onStatus)
    const candidateGroupIds = new Set([...candidateGroupIdList, ...fixedGroupIds])

    const candidateMcpTools = groups
        .filter(({ id }) => candidateGroupIds.has(id))
        .flatMap(({ tools }) => tools)

    const candidateTools = dedupeTools([...localTools, ...candidateMcpTools])
    const selectedTools = await rankCandidateTools(query, queryVector, candidateTools, allTools, maxTools, protectedNames, onStatus)
    const stickyTools = allTools.filter(({ name }) => stickyNames.has(name))

    let routedTools: RoutedToolDefinition[] = []
    const searchTool = makeSearchAvailableMcpToolsTool({
        allTools,
        getLoadedToolNames: () => new Set(routedTools.map(({ name }) => name)),
    })

    routedTools = dedupeTools([...fixedTools, ...selectedTools, ...stickyTools, searchTool])
    return routedTools
}

async function rankCandidateTools(
    query: string,
    queryVector: number[],
    tools: RegistryAwareToolDefinition[],
    allTools: RegistryAwareToolDefinition[],
    limit: number,
    protectedNames: Set<string>,
    onStatus?: RouteToolsInput['onStatus'],
): Promise<RoutedToolDefinition[]> {
    const rankable = tools.filter(({ name }) => !protectedNames.has(name))

    try {
        const embedder = getEmbeddingProvider()
        const scope = getRouterEmbeddingScope(embedder)

        // Compute content hashes for all rankable tools
        const hashes = new Map(rankable.map((tool) => [toolCacheKey(tool), toolContentHash(tool)]))
        const cachedVectors = loadCachedToolEmbeddings(
            rankable.map(toolCacheKey), hashes, scope,
        )
        const missingTools = rankable.filter((tool) => !cachedVectors.has(toolCacheKey(tool)))

        // Only embed tools not already cached — query vector is pre-computed
        const toolVectors = new Map(cachedVectors)
        if (missingTools.length) {
            onStatus?.('indexing-tools', `Indexing ${missingTools.length} tool${missingTools.length === 1 ? '' : 's'}...`)
            const embeddings = await embedder.embedBatch(missingTools.map(toolEmbeddingText))

            missingTools.forEach((tool, index) => {
                const vector = embeddings[index]?.vector
                if (!vector) return

                const cacheKey = toolCacheKey(tool)
                toolVectors.set(cacheKey, vector)
                saveCachedToolEmbedding(cacheKey, hashes.get(cacheKey) || '', vector, scope)
            })
        }

        // Prune against the full installed tool set, not just this call's narrowed
        // candidate subset — otherwise tools outside the current top-K groups would
        // have their cached embeddings evicted every call, defeating the cache.
        pruneToolEmbeddingCache(allTools.map(toolCacheKey), scope)

        onStatus?.('finding-tools', 'Finding required tools...')
        const scored = rankable
            .map((tool, index) => ({
                tool,
                score: cosineSimilarity(queryVector, toolVectors.get(toolCacheKey(tool)) || []),
                index,
            }))
            .sort((a, b) => b.score - a.score || a.index - b.index)

        const bestScore = scored[0]?.score ?? 0
        const minScore = bestScore > 0 ? bestScore * MIN_RELATIVE_TOOL_SCORE : Number.POSITIVE_INFINITY
        const nearMatches = scored.filter(({ score }) => score >= minScore)
        const selected = nearMatches.length ? nearMatches : scored

        return selected.slice(0, limit).map(({ tool, score }) => ({ ...tool, routerScore: score }))
    } catch (err) {
        console.warn('[tool-router] Tool ranking failed, using lexical fallback:', err)
        return lexicalToolRank(query, rankable, limit)
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

function isMcpTool(tool: RegistryAwareToolDefinition): boolean {
    return Boolean(tool.namespaceId?.startsWith('mcp:'))
}

function buildMcpGroups(
    tools: RegistryAwareToolDefinition[],
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

function toolContentHash(tool: ToolDefinition): string {
    const namespaceId = (tool as RegistryAwareToolDefinition).namespaceId || ''
    const originalName = (tool as RegistryAwareToolDefinition).originalName || tool.name

    return createHash('sha256')
        .update(`${namespaceId}\n${originalName}\n${tool.name}\n${compactToolDescription(tool.description)}\n${JSON.stringify(tool.parameters || {})}`)
        .digest('hex')
}

function toolCacheKey(tool: RegistryAwareToolDefinition): string {
    return tool.namespaceId
        ? `${tool.namespaceId}::${tool.originalName || tool.name}`
        : tool.name
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

function lexicalToolRank(
    query: string,
    tools: ToolDefinition[],
    limit: number,
): ToolDefinition[] {
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const scored = scoreItems(
        query,
        tools,
        toolText,
        ({ name }) => name,
    )
    const matching = scored.filter(({ score }) => score > 0)

    return (matching.length ? matching : scored)
        .slice(0, limit)
        .map(({ value }) => byName.get(value))
        .filter((tool): tool is ToolDefinition => Boolean(tool))
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

function toolEmbeddingText(tool: ToolDefinition): string {
    return [
        `Tool: ${tool.name}`,
        compactToolDescription(tool.description),
        JSON.stringify(tool.parameters || {}),
    ].filter(Boolean).join('\n')
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

function dedupeTools<T extends ToolDefinition>(tools: T[]): T[] {
    const seen = new Set<string>()
    const result: T[] = []

    for (const tool of tools) {
        if (seen.has(tool.name)) continue

        seen.add(tool.name)
        result.push(tool)
    }

    return result
}
