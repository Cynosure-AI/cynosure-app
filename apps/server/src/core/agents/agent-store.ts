import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getToolRegistry } from '../tools/tool-registry.js'

// ---- Types ----

export interface SubAgentAssignment {
    agentId: string
    codename: string
    role: string
}

export interface AgentConfig {
    name: string
    codename: string
    description: string
    category: string
    providerId: string
    model: string
    tools: string[]
    subAgents: SubAgentAssignment[]
    autoApproveTools: boolean
    autoToolRouting: boolean
    toolRouterProviderId: string
    toolRouterModel: string
    showInCarousel: boolean
    thinkingEnabled: boolean
    maxContextTokens: number | null
    sortOrder: number
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
    codename?: string
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
    toolRouterProviderId?: string
    toolRouterModel?: string
    showInCarousel?: boolean
    thinkingEnabled?: boolean
    maxContextTokens?: number | null
    sortOrder?: number
}

export type UpdateAgentInput = Partial<Omit<CreateAgentInput, 'codename'> & { codename?: string; subAgents?: SubAgentAssignment[]; autoApproveTools?: boolean; autoToolRouting?: boolean }>

// ---- Helpers ----

function toCodename(name: string): string {
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

/**
 * Generate a sub-agent codename from a name.
 * Uses underscores (matching tool naming convention) and appends `_agent` suffix
 * so the LLM clearly sees these as delegatable agent tools.
 */
export function toSubAgentCodename(name: string): string {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        + '_agent'
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
    codename: string
    category: string
    sub_agents_json: string
    auto_approve_tools: number
    auto_tool_routing: number
    tool_router_provider_id: string
    tool_router_model: string
    show_in_carousel: number
    thinking_enabled: number
    max_context_tokens: number | null
    sort_order: number
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
        codename: row.codename || toCodename(row.name),
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
        toolRouterProviderId: row.tool_router_provider_id || '',
        toolRouterModel: row.tool_router_model || '',
        showInCarousel: row.show_in_carousel !== 0,
        thinkingEnabled: row.thinking_enabled !== 0,
        maxContextTokens: typeof row.max_context_tokens === 'number' ? row.max_context_tokens : null,
        sortOrder: typeof row.sort_order === 'number' ? row.sort_order : 0,
        createdAt: row.created_at || 0,
        updatedAt: row.updated_at || 0,
    }
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
    const codename = input.codename?.trim() || toCodename(input.name)

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
        `INSERT INTO agents (id, name, description, provider_id, model, system_prompt, tools_json, icon_url, codename,
         category, sub_agents_json, auto_approve_tools, show_in_carousel, thinking_enabled, max_context_tokens,
         auto_tool_routing, tool_router_provider_id, tool_router_model, sort_order, cron_prompt, icon_data, icon_mime, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        id,
        input.name,
        input.description || '',
        input.providerId || null,
        input.model || '',
        input.systemPrompt || '',
        JSON.stringify(normalizedTools),
        null, // icon_url - not used for new agents; icon_data/icon_mime used instead
        codename,
        input.category || '',
        JSON.stringify(input.subAgents || []),
        input.autoApproveTools === true ? 1 : 0,
        input.showInCarousel !== false ? 1 : 0,
        input.thinkingEnabled !== false ? 1 : 0,
        typeof input.maxContextTokens === 'number' ? input.maxContextTokens : null,
        input.autoToolRouting === true ? 1 : 0,
        input.toolRouterProviderId || '',
        input.toolRouterModel || '',
        typeof input.sortOrder === 'number' ? input.sortOrder : 0,
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
    const resolvedCodename = toCodename(input.name ?? existing.name)

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
    const updatedToolRouterProviderId = input.toolRouterProviderId !== undefined ? (input.toolRouterProviderId || '') : (existing.tool_router_provider_id || '')
    const updatedToolRouterModel = input.toolRouterModel !== undefined ? (input.toolRouterModel || '') : (existing.tool_router_model || '')
    const updatedShowInCarousel = input.showInCarousel !== undefined ? input.showInCarousel : (existing.show_in_carousel !== 0)
    const updatedThinkingEnabled = input.thinkingEnabled !== undefined ? input.thinkingEnabled : (existing.thinking_enabled !== 0)
    const updatedMaxContextTokens = input.maxContextTokens !== undefined
        ? (typeof input.maxContextTokens === 'number' ? input.maxContextTokens : null)
        : existing.max_context_tokens
    const updatedSortOrder = input.sortOrder !== undefined ? input.sortOrder : (existing.sort_order || 0)

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
         codename = ?, category = ?, sub_agents_json = ?, auto_approve_tools = ?, show_in_carousel = ?,
         thinking_enabled = ?, max_context_tokens = ?, auto_tool_routing = ?, tool_router_provider_id = ?, tool_router_model = ?, sort_order = ?, cron_prompt = ?,
         icon_data = ?, icon_mime = ?, updated_at = ?
         WHERE id = ?`
    ).run(
        updatedName,
        updatedDescription,
        updatedProviderId,
        updatedModel,
        updatedSystemPrompt,
        JSON.stringify(updatedTools),
        resolvedCodename,
        updatedCategory,
        JSON.stringify(updatedSubAgents),
        updatedAutoApprove ? 1 : 0,
        updatedShowInCarousel ? 1 : 0,
        updatedThinkingEnabled ? 1 : 0,
        updatedMaxContextTokens,
        updatedAutoToolRouting ? 1 : 0,
        updatedToolRouterProviderId,
        updatedToolRouterModel,
        updatedSortOrder,
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
    const newCodename = toCodename(newName)

    db.prepare(
        `INSERT INTO agents (id, name, description, provider_id, model, system_prompt, tools_json, icon_url, codename,
         category, sub_agents_json, auto_approve_tools, show_in_carousel, thinking_enabled, max_context_tokens,
         auto_tool_routing, tool_router_provider_id, tool_router_model, sort_order, cron_prompt, icon_data, icon_mime, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        newId,
        newName,
        existing.description,
        existing.provider_id,
        existing.model,
        existing.system_prompt,
        existing.tools_json,
        existing.icon_url,
        newCodename,
        existing.category,
        existing.sub_agents_json,
        existing.auto_approve_tools,
        existing.show_in_carousel,
        existing.thinking_enabled,
        existing.max_context_tokens,
        existing.auto_tool_routing,
        existing.tool_router_provider_id,
        existing.tool_router_model,
        existing.sort_order,
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
