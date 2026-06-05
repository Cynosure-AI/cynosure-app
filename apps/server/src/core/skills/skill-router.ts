import { createHash } from 'crypto'
import { getDb } from '../../db/database.js'
import { getEmbeddingProvider } from '../memory/embedding.js'
import type { SkillData } from './skill-store.js'
import type { LLMGateway } from '../gateway/gateway.js'
import type { ChatMessage, ContentPart, ToolDefinition } from '../gateway/providers/base.provider.js'

const SKILL_CANDIDATE_COUNT = 8
const MAX_SELECTED_SKILLS = 5
const TURN_CHAR_LIMIT = 200
const SKILL_TEXT_LIMIT = 500
const SKILL_PROMPT_CONTENT_LIMIT = 20_000
const ROUTER_SELECTION_TOOL_NAME = 'select_relevant_skills'

interface SkillEmbeddingScope {
    providerId: string
    model: string
    dimensions: number
}

export interface RouteSkillsInput {
    userQuery: string
    recentMessages?: ChatMessage[]
    skills: SkillData[]
    gateway: LLMGateway
    providerId?: string
    model?: string
    routerModel?: string
}

export function shouldRouteSkills(
    skills: SkillData[],
    userQuery?: string,
    opts: { enabled?: boolean } = {},
): boolean {
    return opts.enabled === true && Boolean(userQuery?.trim()) && skills.some((skill) => skill.enabled)
}

export function buildSkillsSystemPrompt(skills: SkillData[]): string {
    if (!skills.length) return ''

    const blocks = skills.map((skill) => [
        `### ${skill.name}${skill.category ? ` (${skill.category})` : ''}`,
        skill.description ? `Use when: ${skill.description}` : '',
        skill.content.trim().slice(0, SKILL_PROMPT_CONTENT_LIMIT),
    ].filter(Boolean).join('\n'))

    return [
        'Relevant skills for this task are provided below. Treat them as task-specific operating instructions and follow them when they apply.',
        ...blocks,
    ].join('\n\n')
}

export async function routeSkills(input: RouteSkillsInput): Promise<SkillData[]> {
    const enabled = input.skills.filter((skill) => skill.enabled)
    if (!enabled.length || !input.userQuery.trim()) return []

    const query = buildRouterQuery(input.userQuery, input.recentMessages || [])
    const candidateIds = new Set(await embeddingPreFilter(query, enabled, SKILL_CANDIDATE_COUNT))
    const candidates = enabled.filter((skill) => candidateIds.has(skill.id))

    try {
        const selectedIds = await llmConfirmSkills(query, candidates, {
            gateway: input.gateway,
            providerId: input.providerId,
            model: input.routerModel || input.model,
        })
        const selected = new Set(selectedIds)
        return candidates.filter((skill) => selected.has(skill.id)).slice(0, MAX_SELECTED_SKILLS)
    } catch (err) {
        console.warn('[skill-router] LLM confirmation failed, using lexical fallback:', err)
        const selected = new Set(lexicalSkillFallback(query, candidates, MAX_SELECTED_SKILLS))
        return candidates.filter((skill) => selected.has(skill.id))
    }
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

async function embeddingPreFilter(query: string, skills: SkillData[], topK: number): Promise<string[]> {
    if (skills.length <= topK) return skills.map(({ id }) => id)

    try {
        const embedder = getEmbeddingProvider()
        const scope = getSkillEmbeddingScope(embedder)
        const hashes = new Map(skills.map((skill) => [skill.id, skillContentHash(skill)]))
        const cachedVectors = loadCachedSkillEmbeddings(skills, hashes, scope)
        const missingSkills = skills.filter(({ id }) => !cachedVectors.has(id))

        const embeddings = await embedder.embedBatch([
            query,
            ...missingSkills.map(skillEmbeddingText),
        ])

        const queryVector = embeddings[0].vector
        const skillVectors = new Map(cachedVectors)

        missingSkills.forEach((skill, index) => {
            const vector = embeddings[index + 1]?.vector
            if (!vector) return
            skillVectors.set(skill.id, vector)
            saveCachedSkillEmbedding(skill.id, hashes.get(skill.id) || '', vector, scope)
        })

        pruneSkillEmbeddingCache(skills.map(({ id }) => id), scope)

        return skills
            .map((skill) => ({
                id: skill.id,
                score: cosineSimilarity(queryVector, skillVectors.get(skill.id) || []),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(({ id }) => id)
    } catch (err) {
        console.warn('[skill-router] Embedding pre-filter failed, using lexical fallback:', err)
        return lexicalSkillFallback(query, skills, topK)
    }
}

async function llmConfirmSkills(
    query: string,
    candidateSkills: SkillData[],
    config: { gateway: LLMGateway; providerId?: string; model?: string },
): Promise<string[]> {
    if (!candidateSkills.length) return []

    const availableSkills = candidateSkills
        .map((skill) => `${skill.id}: ${skill.name}${skill.category ? ` (${skill.category})` : ''} - ${compactSkillText(skill)}`)
        .join('\n')

    const result = await config.gateway.complete({
        messages: [
            {
                role: 'system',
                content: `You select reusable instruction skills for an assistant. Given a request and available skills, call ${ROUTER_SELECTION_TOOL_NAME} with only the skill IDs that materially help. If none apply, call it with an empty array. /no_think`,
            },
            {
                role: 'user',
                content: `Request: ${query}\n\nAvailable skills:\n${availableSkills}`,
            },
        ],
        model: config.model,
        maxTokens: 300,
        tools: [buildRouterSelectionTool(candidateSkills)],
        toolChoice: { type: 'function', name: ROUTER_SELECTION_TOOL_NAME },
        thinkingEnabled: false,
    }, config.providerId)

    const allowedIds = new Set(candidateSkills.map(({ id }) => id))
    const selectionCall = result.toolCalls?.find((call) => call.function.name === ROUTER_SELECTION_TOOL_NAME)
    const parsedIds = selectionCall ? parseSkillSelectionArguments(selectionCall.function.arguments) : null
    if (!parsedIds) return lexicalSkillFallback(query, candidateSkills, MAX_SELECTED_SKILLS)

    return parsedIds.filter((id) => allowedIds.has(id)).slice(0, MAX_SELECTED_SKILLS)
}

function buildRouterSelectionTool(candidateSkills: SkillData[]): ToolDefinition {
    return {
        name: ROUTER_SELECTION_TOOL_NAME,
        description: 'Select the skill IDs that are relevant to the current request.',
        timeout: 1_000,
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                skillIds: {
                    type: 'array',
                    description: 'Relevant skill IDs.',
                    items: {
                        type: 'string',
                        enum: candidateSkills.map(({ id }) => id),
                    },
                },
            },
            required: ['skillIds'],
        },
        execute: async () => ({ success: true, output: 'ok' }),
    }
}

function parseSkillSelectionArguments(raw: string): string[] | null {
    try {
        const parsed = JSON.parse(raw) as { skillIds?: unknown }
        return Array.isArray(parsed.skillIds)
            ? parsed.skillIds.filter((item): item is string => typeof item === 'string')
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

function compactSkillText(skill: SkillData): string {
    return [skill.description, skill.content]
        .filter(Boolean)
        .join('\n')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, SKILL_TEXT_LIMIT)
}

function skillEmbeddingText(skill: SkillData): string {
    return [
        `Name: ${skill.name}`,
        skill.category ? `Category: ${skill.category}` : '',
        skill.description ? `Description: ${skill.description}` : '',
        `Instructions:\n${skill.content}`,
    ].filter(Boolean).join('\n')
}

function skillContentHash(skill: SkillData): string {
    return createHash('sha256')
        .update(`${skill.id}\n${skill.name}\n${skill.category}\n${skill.description}\n${skill.content}`)
        .digest('hex')
}

function getSkillEmbeddingScope(embedder: ReturnType<typeof getEmbeddingProvider>): SkillEmbeddingScope {
    const config = embedder.getConfig()
    return {
        providerId: config.providerId || '',
        model: embedder.getModelName(),
        dimensions: embedder.getDimensions(),
    }
}

function loadCachedSkillEmbeddings(
    skills: SkillData[],
    hashes: Map<string, string>,
    scope: SkillEmbeddingScope,
): Map<string, number[]> {
    const vectors = new Map<string, number[]>()
    try {
        const stmt = getDb().prepare(`
            SELECT content_hash, vector_json
            FROM skill_embeddings
            WHERE skill_id = ?
              AND embedding_provider_id = ?
              AND embedding_model = ?
              AND embedding_dimensions = ?
        `)
        for (const skill of skills) {
            const row = stmt.get(skill.id, scope.providerId, scope.model, scope.dimensions) as {
                content_hash: string
                vector_json: string
            } | undefined
            if (!row || row.content_hash !== hashes.get(skill.id)) continue
            const vector = JSON.parse(row.vector_json) as unknown
            if (Array.isArray(vector) && vector.every((value) => typeof value === 'number')) {
                vectors.set(skill.id, vector)
            }
        }
    } catch (err) {
        console.warn('[skill-router] Failed to read skill embedding cache:', err)
    }
    return vectors
}

function saveCachedSkillEmbedding(
    skillId: string,
    contentHash: string,
    vector: number[],
    scope: SkillEmbeddingScope,
): void {
    try {
        getDb().prepare(`
            INSERT INTO skill_embeddings (
                skill_id,
                embedding_provider_id,
                embedding_model,
                embedding_dimensions,
                content_hash,
                vector_json,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(skill_id, embedding_provider_id, embedding_model, embedding_dimensions)
            DO UPDATE SET
                content_hash = excluded.content_hash,
                vector_json = excluded.vector_json,
                updated_at = excluded.updated_at
        `).run(skillId, scope.providerId, scope.model, scope.dimensions, contentHash, JSON.stringify(vector), Date.now())
    } catch (err) {
        console.warn('[skill-router] Failed to write skill embedding cache:', err)
    }
}

function pruneSkillEmbeddingCache(activeSkillIds: string[], scope: SkillEmbeddingScope): void {
    if (!activeSkillIds.length) return
    try {
        const placeholders = activeSkillIds.map(() => '?').join(', ')
        getDb().prepare(`
            DELETE FROM skill_embeddings
            WHERE embedding_provider_id = ?
              AND embedding_model = ?
              AND embedding_dimensions = ?
              AND skill_id NOT IN (${placeholders})
        `).run(scope.providerId, scope.model, scope.dimensions, ...activeSkillIds)
    } catch (err) {
        console.warn('[skill-router] Failed to prune skill embedding cache:', err)
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
    return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0
}

function lexicalSkillFallback(query: string, skills: SkillData[], limit: number): string[] {
    const terms = new Set(query.toLowerCase().split(/[^a-z0-9_]+/).filter((term) => term.length > 2))
    const scored = skills
        .map((skill, index) => {
            const haystack = skillEmbeddingText(skill).toLowerCase()
            const score = [...terms].reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0)
            return { id: skill.id, score, index }
        })
        .sort((a, b) => b.score - a.score || a.index - b.index)

    const matching = scored.filter(({ score }) => score > 0)
    if (!matching.length) return []

    return matching
        .slice(0, limit)
        .map(({ id }) => id)
}
