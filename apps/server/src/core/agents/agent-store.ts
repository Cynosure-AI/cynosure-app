import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getToolRegistry } from '../tools/tool-registry.js'
import type { ReasoningEffort } from '@shared/types'

// ---- Types ----

export interface SubAgentAssignment {
    agentId: string
}

export interface AgentConfig {
    name: string
    internalName: string
    description: string
    category: string
    providerId: string
    model: string
    tools: string[]
    subAgents: SubAgentAssignment[]
    autoApproveTools: boolean
    autoToolRouting: boolean
    autoMemory: boolean
    autoRouterProviderId: string
    autoRouterModel: string
    thinkingEnabled: boolean
    reasoningEffort: ReasoningEffort
    maxContextTokens: number | null
    sortOrder: number
    tags: string[]
    favorite: boolean
    createdAt: number
    updatedAt: number
}

export interface AgentData extends AgentConfig {
    id: string
    iconUrl: string | null
    systemPrompt: string
    cronPrompt: string
}

export type CreateAgentInput = {
    name: string
    internalName?: string
    description?: string
    category?: string
    iconUrl?: string | null
    providerId?: string
    model?: string
    systemPrompt?: string
    cronPrompt?: string
    tools?: string[]
    subAgents?: SubAgentAssignment[]
    autoApproveTools?: boolean
    autoToolRouting?: boolean
    autoMemory?: boolean
    autoRouterProviderId?: string
    autoRouterModel?: string
    thinkingEnabled?: boolean
    reasoningEffort?: ReasoningEffort
    maxContextTokens?: number | null
    sortOrder?: number
    tags?: string[]
    favorite?: boolean
}

export type UpdateAgentInput = Partial<Omit<CreateAgentInput, 'internalName'> & { internalName?: string; subAgents?: SubAgentAssignment[]; autoApproveTools?: boolean; autoToolRouting?: boolean; autoMemory?: boolean }>

// ---- Helpers ----

function toInternalName(name: string): string {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
}

/**
 * Normalize selected tools into stable registry keys before persisting an agent.
 *
 * The application stores only registry keys (`namespaceId::toolName`) in agent
 * definitions. Raw/bare tool names are intentionally rejected so tool selection
 * remains deterministic when multiple MCP servers expose the same tool name.
 */
function normalizeAgentTools(toolNames: string[]): string[] {
    const registry = getToolRegistry()
    const result: string[] = []
    const seen = new Set<string>()

    for (const raw of toolNames) {
        const name = raw.trim()
        if (!name) continue

        if (!registry.hasKey(name)) {
            console.warn(`[normalizeAgentTools] Dropping unknown tool key: ${name}`)
            continue
        }

        if (!seen.has(name)) {
            seen.add(name)
            result.push(name)
        }
    }

    return result
}

/** DB row type matching the agents table */
interface AgentRow {
    id: string
    name: string
    description: string
    provider_id: string | null
    model: string
    system_prompt: string
    tools_json: string
    icon_url: string | null
    internal_name: string
    category: string
    sub_agents_json: string
    auto_approve_tools: number
    auto_tool_routing: number
    tool_router_provider_id: string
    tool_router_model: string
    auto_memory: number
    memory_router_provider_id: string
    memory_router_model: string
    auto_router_provider_id: string
    auto_router_model: string
    thinking_enabled: number
    reasoning_effort: string
    max_context_tokens: number | null
    sort_order: number
    tags_json: string
    favorite: number
    cron_prompt: string
    icon_data: Buffer | null
    icon_mime: string | null
    created_at: number
    updated_at: number
}

function rowToAgentData(row: AgentRow): AgentData {
    const hasIcon = row.icon_data !== null || (row.icon_url !== null && row.icon_url !== '')
    return {
        id: row.id,
        name: row.name,
        internalName: row.internal_name || toInternalName(row.name),
        description: row.description || '',
        category: row.category || '',
        iconUrl: hasIcon ? `/api/agents/${encodeURIComponent(row.id)}/icon?t=${row.updated_at}` : null,
        providerId: row.provider_id || '',
        model: row.model || '',
        systemPrompt: row.system_prompt || '',
        cronPrompt: row.cron_prompt || '',
        tools: JSON.parse(row.tools_json || '[]'),
        subAgents: JSON.parse(row.sub_agents_json || '[]'),
        autoApproveTools: row.auto_approve_tools === 1,
        autoToolRouting: row.auto_tool_routing === 1,
        autoMemory: row.auto_memory === 1,
        autoRouterProviderId: row.auto_router_provider_id || '',
        autoRouterModel: row.auto_router_model || '',
        thinkingEnabled: row.thinking_enabled !== 0,
        reasoningEffort: row.reasoning_effort === 'low' || row.reasoning_effort === 'high'
            ? row.reasoning_effort
            : 'medium',
        maxContextTokens: typeof row.max_context_tokens === 'number' ? row.max_context_tokens : null,
        sortOrder: typeof row.sort_order === 'number' ? row.sort_order : 0,
        tags: parseTags(row.tags_json),
        favorite: row.favorite === 1,
        createdAt: row.created_at || 0,
        updatedAt: row.updated_at || 0,
    }
}

function parseTags(raw: string | null | undefined): string[] {
    try {
        const parsed = JSON.parse(raw || '[]') as unknown
        if (!Array.isArray(parsed)) return []
        return normalizeTags(parsed)
    } catch {
        return []
    }
}

function normalizeTags(tags: unknown[]): string[] {
    const result: string[] = []
    const seen = new Set<string>()

    for (const raw of tags) {
        if (typeof raw !== 'string') continue
        const tag = raw.trim().replace(/\s+/g, ' ')
        const key = tag.toLowerCase()
        if (!tag || seen.has(key)) continue
        seen.add(key)
        result.push(tag)
    }

    return result
}

function parseIconDataUrl(dataUrl: string): { data: Buffer; mime: string } | null {
    const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/)
    if (!match) return null
    return { data: Buffer.from(match[2], 'base64'), mime: match[1] }
}

// ---- Public API ----

export function listAgents(): AgentData[] {
    const db = getDb()
    const rows = db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as AgentRow[]
    return rows.map(rowToAgentData)
}

export function getAgent(id: string): AgentData | null {
    const db = getDb()
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
    if (!row) return null
    return rowToAgentData(row)
}

export function createAgent(input: CreateAgentInput): AgentData {
    const db = getDb()
    const id = nanoid()
    const now = Date.now()
    const internalName = input.internalName?.trim() || toInternalName(input.name)

    let iconData: Buffer | null = null
    let iconMime: string | null = null
    if (input.iconUrl && input.iconUrl.startsWith('data:')) {
        const parsed = parseIconDataUrl(input.iconUrl)
        if (parsed) {
            iconData = parsed.data
            iconMime = parsed.mime
        }
    }

    const normalizedTools = normalizeAgentTools(input.tools || [])

    db.prepare(
        `INSERT INTO agents (id, name, description, provider_id, model, system_prompt, tools_json, icon_url, internal_name,
            category, sub_agents_json, auto_approve_tools, thinking_enabled, reasoning_effort, max_context_tokens,
            auto_tool_routing, tool_router_provider_id, tool_router_model,
            auto_memory, memory_router_provider_id, memory_router_model,
            sort_order, tags_json, favorite, cron_prompt, icon_data, icon_mime, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        id,
        input.name,
        input.description || '',
        input.providerId || null,
        input.model || '',
        input.systemPrompt || '',
        JSON.stringify(normalizedTools),
        null, // icon_url - not used for new agents; icon_data/icon_mime used instead
        internalName,
        input.category || '',
        JSON.stringify(input.subAgents || []),
        input.autoApproveTools === true ? 1 : 0,
        input.thinkingEnabled !== false ? 1 : 0,
        input.reasoningEffort || 'medium',
        typeof input.maxContextTokens === 'number' ? input.maxContextTokens : null,
        input.autoToolRouting === true ? 1 : 0,
        '',
        '',
        input.autoMemory === true ? 1 : 0,
        '',
        '',
        typeof input.sortOrder === 'number' ? input.sortOrder : 0,
        JSON.stringify(normalizeTags(input.tags || [])),
        input.favorite === true ? 1 : 0,
        input.cronPrompt || '',
        iconData,
        iconMime,
        now,
        now
    )

    return getAgent(id)!
}

export function updateAgent(id: string, input: UpdateAgentInput): AgentData | null {
    const db = getDb()
    const existing = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
    if (!existing) return null

    const now = Date.now()
    const resolvedInternalName = input.internalName?.trim() || toInternalName(input.name ?? existing.name)

    const updatedName = input.name ?? existing.name
    const updatedDescription = input.description ?? existing.description
    const updatedCategory = input.category !== undefined ? input.category : (existing.category || '')
    const updatedProviderId = input.providerId !== undefined ? (input.providerId || null) : existing.provider_id
    const updatedModel = input.model ?? existing.model
    const updatedSystemPrompt = input.systemPrompt !== undefined ? input.systemPrompt : existing.system_prompt
    const updatedCronPrompt = input.cronPrompt !== undefined ? (input.cronPrompt || '') : existing.cron_prompt
    const updatedTools = input.tools !== undefined ? normalizeAgentTools(input.tools) : JSON.parse(existing.tools_json || '[]')
    const updatedSubAgents = input.subAgents !== undefined ? input.subAgents : JSON.parse(existing.sub_agents_json || '[]')
    const updatedAutoApprove = input.autoApproveTools !== undefined ? input.autoApproveTools : (existing.auto_approve_tools === 1)
    const updatedAutoToolRouting = input.autoToolRouting !== undefined ? input.autoToolRouting : (existing.auto_tool_routing === 1)
    const updatedAutoMemory = input.autoMemory !== undefined ? input.autoMemory : (existing.auto_memory === 1)
    const updatedAutoRouterProviderId = input.autoRouterProviderId !== undefined ? (input.autoRouterProviderId || '') : (existing.auto_router_provider_id || '')
    const updatedAutoRouterModel = input.autoRouterModel !== undefined ? (input.autoRouterModel || '') : (existing.auto_router_model || '')
    const updatedThinkingEnabled = input.thinkingEnabled !== undefined ? input.thinkingEnabled : (existing.thinking_enabled !== 0)
    const updatedReasoningEffort = input.reasoningEffort ?? (
        existing.reasoning_effort === 'low' || existing.reasoning_effort === 'high'
            ? existing.reasoning_effort
            : 'medium'
    )
    const updatedMaxContextTokens = input.maxContextTokens !== undefined
        ? (typeof input.maxContextTokens === 'number' ? input.maxContextTokens : null)
        : existing.max_context_tokens
    const updatedSortOrder = input.sortOrder !== undefined ? input.sortOrder : (existing.sort_order || 0)
    const updatedTags = input.tags !== undefined ? normalizeTags(input.tags) : parseTags(existing.tags_json)
    const updatedFavorite = input.favorite !== undefined ? input.favorite : (existing.favorite === 1)

    // Handle icon update
    let iconData: Buffer | null = existing.icon_data
    let iconMime: string | null = existing.icon_mime
    if (input.iconUrl !== undefined) {
        if (input.iconUrl && input.iconUrl.startsWith('data:')) {
            const parsed = parseIconDataUrl(input.iconUrl)
            if (parsed) {
                iconData = parsed.data
                iconMime = parsed.mime
            }
        } else if (input.iconUrl === null || input.iconUrl === '') {
            iconData = null
            iconMime = null
        }
    }

    db.prepare(
        `UPDATE agents SET name = ?, description = ?, provider_id = ?, model = ?, system_prompt = ?, tools_json = ?,
         internal_name = ?, category = ?, sub_agents_json = ?, auto_approve_tools = ?,
            thinking_enabled = ?, reasoning_effort = ?, max_context_tokens = ?, auto_tool_routing = ?, tool_router_provider_id = ?, tool_router_model = ?,
            auto_memory = ?, memory_router_provider_id = ?, memory_router_model = ?,
            auto_router_provider_id = ?, auto_router_model = ?, sort_order = ?, tags_json = ?, favorite = ?, cron_prompt = ?,
         icon_data = ?, icon_mime = ?, updated_at = ?
         WHERE id = ?`
    ).run(
        updatedName,
        updatedDescription,
        updatedProviderId,
        updatedModel,
        updatedSystemPrompt,
        JSON.stringify(updatedTools),
        resolvedInternalName,
        updatedCategory,
        JSON.stringify(updatedSubAgents),
        updatedAutoApprove ? 1 : 0,
        updatedThinkingEnabled ? 1 : 0,
        updatedReasoningEffort,
        updatedMaxContextTokens,
        updatedAutoToolRouting ? 1 : 0,
        existing.tool_router_provider_id || '',
        existing.tool_router_model || '',
        updatedAutoMemory ? 1 : 0,
        existing.memory_router_provider_id || '',
        existing.memory_router_model || '',
        updatedAutoRouterProviderId,
        updatedAutoRouterModel,
        updatedSortOrder,
        JSON.stringify(updatedTags),
        updatedFavorite ? 1 : 0,
        updatedCronPrompt,
        iconData,
        iconMime,
        now,
        id
    )

    return getAgent(id)!
}

export function deleteAgent(id: string): boolean {
    const db = getDb()
    const result = db.prepare('DELETE FROM agents WHERE id = ?').run(id)
    return result.changes > 0
}

export function duplicateAgent(id: string): AgentData | null {
    const db = getDb()
    const existing = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
    if (!existing) return null

    const newId = nanoid()
    const now = Date.now()
    const newName = `${existing.name} (copy)`
    const newInternalName = toInternalName(newName)

    db.prepare(
        `INSERT INTO agents (id, name, description, provider_id, model, system_prompt, tools_json, icon_url, internal_name,
            category, sub_agents_json, auto_approve_tools, thinking_enabled, reasoning_effort, max_context_tokens,
            auto_tool_routing, tool_router_provider_id, tool_router_model,
            auto_memory, memory_router_provider_id, memory_router_model,
            sort_order, tags_json, favorite, cron_prompt, icon_data, icon_mime, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        newId,
        newName,
        existing.description,
        existing.provider_id,
        existing.model,
        existing.system_prompt,
        existing.tools_json,
        existing.icon_url,
        newInternalName,
        existing.category,
        existing.sub_agents_json,
        existing.auto_approve_tools,
        existing.thinking_enabled,
        existing.reasoning_effort,
        existing.max_context_tokens,
        existing.auto_tool_routing,
        existing.tool_router_provider_id,
        existing.tool_router_model,
        existing.auto_memory,
        existing.memory_router_provider_id,
        existing.memory_router_model,
        existing.sort_order,
        existing.tags_json || '[]',
        existing.favorite,
        existing.cron_prompt,
        existing.icon_data,
        existing.icon_mime,
        now,
        now
    )

    return getAgent(newId)!
}

export function getIconData(id: string): { data: Buffer; mime: string } | null {
    const db = getDb()
    const row = db.prepare('SELECT icon_data, icon_mime FROM agents WHERE id = ?').get(id) as {
        icon_data: Buffer | null; icon_mime: string | null
    } | undefined
    if (!row?.icon_data || !row.icon_mime) return null
    return { data: row.icon_data, mime: row.icon_mime }
}
