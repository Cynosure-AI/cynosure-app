import { join } from 'path'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, cpSync } from 'fs'
import { nanoid } from 'nanoid'
import { getAppDataDir } from '../data-dir.js'

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
    getMemoriesAtStart: boolean
    autoApproveTools: boolean
    maxToolOutputChars: number
    showInCarousel: boolean
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
    getMemoriesAtStart?: boolean
    autoApproveTools?: boolean
    maxToolOutputChars?: number
    showInCarousel?: boolean
    favorite?: boolean
}

export type UpdateAgentInput = Partial<Omit<CreateAgentInput, 'codename'> & { codename?: string; subAgents?: SubAgentAssignment[]; autoApproveTools?: boolean }>

// ---- Helpers ----

function getAgentsDir(): string {
    const dir = join(getAppDataDir(), 'agents')
    mkdirSync(dir, { recursive: true })
    return dir
}

function toCodename(name: string): string {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
}

const ICON_EXTENSIONS = ['png', 'jpg', 'jpeg', 'svg', 'webp'] as const

function findIconFile(agentDir: string): string | null {
    for (const ext of ICON_EXTENSIONS) {
        const p = join(agentDir, `icon.${ext}`)
        if (existsSync(p)) return p
    }
    return null
}

function removeExistingIcons(agentDir: string): void {
    for (const ext of ICON_EXTENSIONS) {
        const p = join(agentDir, `icon.${ext}`)
        if (existsSync(p)) rmSync(p)
    }
}

function mimeToExt(mime: string): string {
    const map: Record<string, string> = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/svg+xml': 'svg',
        'image/webp': 'webp',
    }
    return map[mime] || 'png'
}

function saveIconFromDataUrl(agentDir: string, dataUrl: string): void {
    const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/)
    if (!match) return
    const ext = mimeToExt(match[1])
    const buffer = Buffer.from(match[2], 'base64')
    removeExistingIcons(agentDir)
    writeFileSync(join(agentDir, `icon.${ext}`), buffer)
}

function readAgentFromDir(agentDir: string, id: string): AgentData | null {
    const configPath = join(agentDir, 'agent.json')
    if (!existsSync(configPath)) return null

    let config: AgentConfig
    try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'))
    } catch {
        return null
    }

    let systemPrompt = ''
    const promptPath = join(agentDir, 'SYSTEM_PROMPT.md')
    if (existsSync(promptPath)) {
        systemPrompt = readFileSync(promptPath, 'utf-8')
    }

    let cronPrompt = ''
    const cronPath = join(agentDir, 'CRON.md')
    if (existsSync(cronPath)) {
        cronPrompt = readFileSync(cronPath, 'utf-8')
    }

    const hasIcon = findIconFile(agentDir) !== null

    // Backward compat: migrate legacy memoryEnabled toggles into the tools array
    const raw = config as unknown as Record<string, unknown>
    let tools = config.tools || []
    if (raw.memoryEnabled === true || (raw.memoryEnabled !== false && config.getMemoriesAtStart === undefined && raw.memoryEnabled === undefined)) {
        // Old agents with memoryEnabled: true → add memory tools if missing
        if (raw.memoryEnabled === true) {
            if (!tools.includes('memory_retrieve_chunks')) tools = [...tools, 'memory_retrieve_chunks']
            if (!tools.includes('memory_semantic_search')) tools = [...tools, 'memory_semantic_search']
        }
    }

    // Resolve getMemoriesAtStart: prefer new field, fall back to legacy memoryEnabled
    const getMemoriesAtStart = config.getMemoriesAtStart !== undefined
        ? config.getMemoriesAtStart
        : (raw.memoryEnabled !== undefined ? raw.memoryEnabled === true : false)

    return {
        id,
        name: config.name,
        codename: config.codename || toCodename(config.name),
        description: config.description || '',
        category: config.category || '',
        iconUrl: hasIcon ? `/api/agents/${encodeURIComponent(id)}/icon?t=${config.updatedAt}` : null,
        providerId: config.providerId || '',
        model: config.model || '',
        systemPrompt,
        cronPrompt,
        tools,
        subAgents: config.subAgents || [],
        getMemoriesAtStart: getMemoriesAtStart as boolean,
        autoApproveTools: config.autoApproveTools === true,
        maxToolOutputChars: config.maxToolOutputChars ?? 16_384,
        showInCarousel: config.showInCarousel !== false,
        favorite: config.favorite === true,
        createdAt: config.createdAt || 0,
        updatedAt: config.updatedAt || 0,
    }
}

// ---- Public API ----

export function listAgents(): AgentData[] {
    const agentsDir = getAgentsDir()
    let entries: string[]
    try {
        entries = readdirSync(agentsDir)
    } catch {
        return []
    }

    const agents: AgentData[] = []
    for (const entry of entries) {
        const fullPath = join(agentsDir, entry)
        if (!statSync(fullPath).isDirectory()) continue
        const agent = readAgentFromDir(fullPath, entry)
        if (agent) agents.push(agent)
    }

    return agents.sort((a, b) => b.createdAt - a.createdAt)
}

export function getAgent(id: string): AgentData | null {
    const agentsDir = getAgentsDir()
    const agentDir = join(agentsDir, id)
    if (!existsSync(agentDir)) return null
    return readAgentFromDir(agentDir, id)
}

export function createAgent(input: CreateAgentInput): AgentData {
    const agentsDir = getAgentsDir()
    const id = nanoid()
    const agentDir = join(agentsDir, id)
    mkdirSync(agentDir, { recursive: true })

    const now = Date.now()
    const config: AgentConfig = {
        name: input.name,
        codename: input.codename?.trim() || toCodename(input.name),
        description: input.description || '',
        category: input.category || '',
        providerId: input.providerId || '',
        model: input.model || '',
        tools: input.tools || [],
        subAgents: input.subAgents || [],
        getMemoriesAtStart: input.getMemoriesAtStart === true,
        autoApproveTools: input.autoApproveTools === true,
        maxToolOutputChars: input.maxToolOutputChars ?? 16_384,
        showInCarousel: input.showInCarousel !== false,
        favorite: input.favorite === true,
        createdAt: now,
        updatedAt: now,
    }

    writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(config, null, 2) + '\n')
    writeFileSync(join(agentDir, 'SYSTEM_PROMPT.md'), input.systemPrompt || '')
    if (input.cronPrompt) {
        writeFileSync(join(agentDir, 'CRON.md'), input.cronPrompt)
    }

    if (input.iconUrl && input.iconUrl.startsWith('data:')) {
        saveIconFromDataUrl(agentDir, input.iconUrl)
    }

    return readAgentFromDir(agentDir, id)!
}

export function updateAgent(id: string, input: UpdateAgentInput): AgentData | null {
    const agentsDir = getAgentsDir()
    const agentDir = join(agentsDir, id)
    const configPath = join(agentDir, 'agent.json')
    if (!existsSync(configPath)) return null

    let existing: AgentConfig
    try {
        existing = JSON.parse(readFileSync(configPath, 'utf-8'))
    } catch {
        return null
    }

    const now = Date.now()

    // Always derive codename from the (possibly updated) name
    const resolvedCodename = toCodename(input.name ?? existing.name)

    const config: AgentConfig = {
        name: input.name ?? existing.name,
        codename: resolvedCodename,
        description: input.description ?? existing.description,
        category: input.category !== undefined ? input.category : (existing.category || ''),
        providerId: input.providerId !== undefined ? (input.providerId || '') : existing.providerId,
        model: input.model ?? existing.model,
        tools: input.tools !== undefined ? input.tools : existing.tools,
        subAgents: input.subAgents !== undefined ? input.subAgents : (existing.subAgents || []),
        getMemoriesAtStart: input.getMemoriesAtStart !== undefined ? input.getMemoriesAtStart : existing.getMemoriesAtStart,
        autoApproveTools: input.autoApproveTools !== undefined ? input.autoApproveTools : (existing.autoApproveTools === true),
        maxToolOutputChars: input.maxToolOutputChars !== undefined ? input.maxToolOutputChars : (existing.maxToolOutputChars ?? 16_384),
        showInCarousel: input.showInCarousel !== undefined ? input.showInCarousel : (existing.showInCarousel !== false),
        favorite: input.favorite !== undefined ? input.favorite : (existing.favorite === true),
        createdAt: existing.createdAt,
        updatedAt: now,
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')

    if (input.systemPrompt !== undefined) {
        writeFileSync(join(agentDir, 'SYSTEM_PROMPT.md'), input.systemPrompt)
    }

    if (input.cronPrompt !== undefined) {
        const cronPath = join(agentDir, 'CRON.md')
        if (input.cronPrompt) {
            writeFileSync(cronPath, input.cronPrompt)
        } else if (existsSync(cronPath)) {
            rmSync(cronPath)
        }
    }

    if (input.iconUrl !== undefined) {
        if (input.iconUrl && input.iconUrl.startsWith('data:')) {
            saveIconFromDataUrl(agentDir, input.iconUrl)
        } else if (input.iconUrl === null || input.iconUrl === '') {
            removeExistingIcons(agentDir)
        }
    }

    return readAgentFromDir(agentDir, id)!
}

export function deleteAgent(id: string): boolean {
    const agentsDir = getAgentsDir()
    const agentDir = join(agentsDir, id)
    if (!existsSync(agentDir)) return false
    rmSync(agentDir, { recursive: true })
    return true
}

export function duplicateAgent(id: string): AgentData | null {
    const agentsDir = getAgentsDir()
    const srcDir = join(agentsDir, id)
    if (!existsSync(srcDir)) return null

    const newId = nanoid()
    const destDir = join(agentsDir, newId)

    // Copy entire folder
    cpSync(srcDir, destDir, { recursive: true })

    // Update config: new name, new timestamps
    const configPath = join(destDir, 'agent.json')
    let config: AgentConfig
    try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'))
    } catch {
        rmSync(destDir, { recursive: true })
        return null
    }

    const now = Date.now()
    config.name = `${config.name} (copy)`
    config.codename = toCodename(config.name)
    config.createdAt = now
    config.updatedAt = now
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')

    return readAgentFromDir(destDir, newId)!
}

export function getIconPath(id: string): { path: string; ext: string } | null {
    const agentsDir = getAgentsDir()
    const agentDir = join(agentsDir, id)
    const iconPath = findIconFile(agentDir)
    if (!iconPath) return null
    const ext = iconPath.split('.').pop()!
    return { path: iconPath, ext }
}
