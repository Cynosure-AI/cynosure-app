import type { FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import archiver from 'archiver'
import AdmZip from 'adm-zip'
import { ensureDefaultMemoryFolder, getDb } from '../db/database.js'
import { getAppDataDir, getDefaultMemoryFolderDir, getMemoryFoldersRootDir } from '../core/data-dir.js'
import { getGateway } from '../core/gateway/gateway.js'
import { loadSavedProviders } from './providers.js'
import { loadSavedMcpServers } from './mcp/index.js'
import { getChannelManager } from '../core/channels/channel-manager.js'
import { writeFileSync } from 'fs'
import { extractFilePathFromFileUrl, getConversationArtifactsDir, toFileUrl } from '../core/artifacts/image-artifacts.js'
import { getRAGStore } from '../core/memory/rag.js'
import { getMemoryParser } from '../core/memory/parser.js'
import { getEmbeddingProvider } from '../core/memory/embedding.js'
import { basename, dirname, join } from 'path'
import {
    existsSync,
    mkdirSync,
    rmSync
} from 'fs'
import type { LLMProviderConfig } from '../core/gateway/providers/base.provider.js'
import { ensureFolder, listFilesInFolder } from '../core/memory/memory-file-manager.js'
import { directoryPathForRelative, categoryPathForDirectory, validateRelativePath } from '../core/memory/memory-folder-directories.js'
import { stopAllMemoryFolderWatchers, watchMemoryFolder } from '../core/memory/memory-folder-watcher.js'
import { scheduleCronJob, unscheduleCronJob } from '../core/triggers/cron-scheduler.js'
import { dropConversationAttachmentIndex, indexConversationAttachment } from '../core/artifacts/attachment-rag.js'
import type { FileAttachmentArtifact } from '../core/artifacts/file-artifacts.js'
import { DEFAULT_PERMANENT_MEMORY_TABLE, setActivePermanentMemoryTableName } from '../core/memory/memory-index-manifest.js'
import { getMemoryKnowledgeStore } from '../core/memory/memory-knowledge.js'
import { invalidateDreamConversation } from '../core/memory/dream-worker.js'
import {
    createMemoryKnowledgeBackup,
    memoryKnowledgeBackupCount,
    restoreMemoryKnowledgeBackup,
    type MemoryKnowledgeBackup,
} from '../core/memory/memory-knowledge-backup.js'

type BroadcastFn = (event: string, data: unknown) => void

type ResetModule =
    | 'agents'
    | 'providers'
    | 'mcp'
    | 'settings'
    | 'channels'
    | 'memory'
    | 'knowledge'
    | 'conversations'
    | 'notifications'
    | 'usage'
    | 'vectors'

const RESET_MODULES: ResetModule[] = [
    'agents',
    'providers',
    'mcp',
    'settings',
    'channels',
    'memory',
    'knowledge',
    'conversations',
    'notifications',
    'usage',
    'vectors'
]

interface ManifestModule {
    count: number
}

interface BackupSummaryModule extends ManifestModule {
    details?: Record<string, number>
}

interface BackupManifest {
    version: 1
    createdAt: string
    modules: Record<string, ManifestModule>
}

interface MemoryFileBackup {
    categoryId: string
    fileName: string
    archiveName: string
}

interface MemoryFileIdentityBackup {
    document_id: string
    document_ref: string
    category_id: string
    file_name: string
    dreamed_at?: number
    created_at: number
}

type MemoryDocumentBackup = Record<string, string | number | null>
type MemoryRevisionBackup = Record<string, string | number | null>

interface MemoryFolderBackupRow extends Record<string, unknown> {
    id?: unknown
    name?: unknown
    directory_path?: unknown
    categoryPath?: unknown
    is_uncategorized?: unknown
    sort_order?: unknown
    created_at?: unknown
}

// ────────────────────────────────────────────────────────────────────────────
//  Export helpers
// ────────────────────────────────────────────────────────────────────────────

function getProviderRows(): LLMProviderConfig[] {
    const db = getDb()
    const rows = db
        .prepare('SELECT config_json, api_key_enc FROM providers ORDER BY created_at')
        .all() as { config_json: string; api_key_enc: string | null }[]

    return rows.map((row) => {
        const config = JSON.parse(row.config_json) as LLMProviderConfig
        if (row.api_key_enc) config.apiKey = row.api_key_enc
        return config
    })
}

function getMcpRows(): unknown[] {
    const db = getDb()
    return db.prepare('SELECT * FROM mcp_servers ORDER BY created_at').all()
}

function getSettingsRows(): Record<string, unknown> {
    const db = getDb()
    const rows = db.prepare('SELECT key, value_json FROM settings').all() as {
        key: string
        value_json: string
    }[]
    const result: Record<string, unknown> = {}
    for (const r of rows) {
        try {
            result[r.key] = JSON.parse(r.value_json)
        } catch {
            result[r.key] = r.value_json
        }
    }
    return result
}

function getToolApprovalRows(): { toolName: string; autoApprove: boolean }[] {
    const db = getDb()
    return (
        db.prepare('SELECT tool_name, auto_approve FROM tool_approvals').all() as {
            tool_name: string
            auto_approve: number
        }[]
    ).map((r) => ({ toolName: r.tool_name, autoApprove: r.auto_approve === 1 }))
}

function getCronJobRows(): unknown[] {
    const db = getDb()
    return db.prepare('SELECT * FROM cron_jobs ORDER BY created_at').all()
}

function getChannelRows(): unknown[] {
    const db = getDb()
    return db.prepare('SELECT * FROM channels ORDER BY created_at').all()
}

function getMemoryKnowledgeBackup(zip: AdmZip): MemoryKnowledgeBackup | null {
    const entry = zip.getEntry('knowledge/knowledge.json')
    if (!entry) return null
    return JSON.parse(entry.getData().toString('utf-8')) as MemoryKnowledgeBackup
}

function relativePathFromBackupCategory(category: MemoryFolderBackupRow): string {
    if (typeof category.categoryPath !== 'string') throw new Error('Memory folder path is missing from backup.')
    return validateRelativePath(category.categoryPath)
}

function portableRelativePathForFolder(directoryPath: string): string {
    return validateRelativePath(categoryPathForDirectory(directoryPath))
}

async function resetVectorIndexes(): Promise<void> {
    const ragStore = getRAGStore()
    await ragStore.close()
    const lanceDir = join(getAppDataDir(), 'lancedb')
    if (existsSync(lanceDir)) {
        rmSync(lanceDir, { recursive: true, force: true })
    }
    await ragStore.initialize()
    setActivePermanentMemoryTableName(DEFAULT_PERMANENT_MEMORY_TABLE)
    await dropConversationAttachmentIndex()
    try { getDb().prepare('DELETE FROM memory_file_index').run() } catch { /* ignore */ }
}

async function resetMemoryFolders(db = getDb()): Promise<void> {
    await stopAllMemoryFolderWatchers()
    await resetVectorIndexes()
    await getMemoryKnowledgeStore().reset()
    db.prepare('DELETE FROM memory_document_revisions').run()
    db.prepare('DELETE FROM memory_documents').run()
    db.prepare('DELETE FROM agent_memory_folders').run()
    db.prepare('DELETE FROM memory_folders').run()

    const memoryRoot = getMemoryFoldersRootDir()
    if (existsSync(memoryRoot)) {
        rmSync(memoryRoot, { recursive: true, force: true })
    }

    ensureDefaultMemoryFolder(db)
    watchMemoryFolder('uncategorized', getDefaultMemoryFolderDir())
}

async function resetKnowledge(): Promise<void> {
    await getMemoryKnowledgeStore().reset()
}

async function resetConversations(db = getDb()): Promise<void> {
    const conversationIds = db.prepare('SELECT id FROM conversations').all() as Array<{ id: string }>
    for (const { id } of conversationIds) await invalidateDreamConversation(id)
    db.prepare('DELETE FROM pending_hitl').run()
    db.prepare('DELETE FROM session_tool_approvals').run()
    db.prepare('DELETE FROM tasks').run()
    db.prepare('DELETE FROM execution_steps').run()
    db.prepare('DELETE FROM dream_runs').run()
    db.prepare('DELETE FROM messages').run()
    db.prepare('DELETE FROM conversations').run()
    await dropConversationAttachmentIndex()

    const artifactsDir = join(getAppDataDir(), 'artifacts')
    if (existsSync(artifactsDir)) {
        rmSync(artifactsDir, { recursive: true, force: true })
    }
}

function resetUsage(db = getDb()): void {
    db.prepare('DELETE FROM execution_steps').run()
    db.prepare('DELETE FROM execution_logs').run()
    try { db.prepare('DELETE FROM auxiliary_model_usage').run() } catch { /* table may not exist */ }
    db.prepare(`
        INSERT INTO settings (key, value_json)
        VALUES ('metrics_reset_at', ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
    `).run(JSON.stringify(Date.now()))
}

function resetNotifications(db = getDb()): void {
    db.prepare('DELETE FROM notifications').run()
}

function resetSettings(db = getDb()): void {
    const existingCronJobs = db.prepare('SELECT id FROM cron_jobs').all() as { id: string }[]
    for (const job of existingCronJobs) {
        unscheduleCronJob(job.id)
    }
    db.prepare('DELETE FROM tool_approvals').run()
    db.prepare('DELETE FROM session_tool_approvals').run()
    db.prepare('DELETE FROM cron_jobs').run()
    db.prepare('DELETE FROM settings').run()
    db.prepare('DELETE FROM tool_router_embeddings').run()
    db.prepare('DELETE FROM tool_router_tool_embeddings').run()
}

async function resetProviders(db = getDb()): Promise<void> {
    db.prepare('DELETE FROM providers').run()
    const gateway = getGateway()
    for (const id of gateway.getAllProviders().keys()) gateway.removeProvider(id)
}

async function resetMcpServers(db = getDb()): Promise<void> {
    db.prepare('DELETE FROM mcp_servers').run()
    await loadSavedMcpServers()
}

function resetAgents(db = getDb()): void {
    const existingCronJobs = db.prepare('SELECT id FROM cron_jobs').all() as { id: string }[]
    for (const job of existingCronJobs) {
        unscheduleCronJob(job.id)
    }
    db.prepare('DELETE FROM pending_hitl').run()
    db.prepare('DELETE FROM session_tool_approvals').run()
    db.prepare('DELETE FROM cron_jobs').run()
    db.prepare('DELETE FROM channels').run()
    db.prepare('DELETE FROM agent_memory_folders').run()
    db.prepare('DELETE FROM agents').run()
}

function resetChannels(db = getDb()): void {
    db.prepare('DELETE FROM channels').run()
}

async function resetSelectedModules(modules: ResetModule[]): Promise<Record<string, { reset: boolean; errors: string[] }>> {
    const db = getDb()
    const selected = new Set(modules)
    const results: Record<string, { reset: boolean; errors: string[] }> = {}
    const run = async (module: ResetModule, action: () => void | Promise<void>) => {
        if (!selected.has(module)) return
        const res = { reset: false, errors: [] as string[] }
        try {
            await action()
            res.reset = true
        } catch (e) {
            res.errors.push((e as Error).message)
        }
        results[module] = res
    }

    if (selected.has('memory')) selected.delete('vectors')

    await run('conversations', () => resetConversations(db))
    await run('notifications', () => resetNotifications(db))
    await run('usage', () => resetUsage(db))
    await run('memory', () => resetMemoryFolders(db))
    await run('vectors', resetVectorIndexes)
    await run('knowledge', resetKnowledge)
    await run('settings', () => resetSettings(db))
    await run('channels', () => resetChannels(db))
    await run('agents', () => resetAgents(db))
    await run('providers', () => resetProviders(db))
    await run('mcp', () => resetMcpServers(db))

    if (selected.has('memory')) {
        // resetMemoryFolders already restarted the default watcher.
    } else {
        try {
            const categories = db.prepare('SELECT id, directory_path FROM memory_folders WHERE directory_path != ?').all('') as {
                id: string
                directory_path: string
            }[]
            for (const category of categories) {
                watchMemoryFolder(category.id, category.directory_path)
            }
        } catch { /* ignore watcher refresh failures */ }
    }

    return results
}

// ────────────────────────────────────────────────────────────────────────────
//  Route registration
// ────────────────────────────────────────────────────────────────────────────

export async function registerBackupRoutes(app: FastifyInstance, broadcast?: BroadcastFn): Promise<void> {
    await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024 } }) // 1 GB limit

    app.get('/summary', async () => {
        const db = getDb()
        const count = (table: string): number => {
            const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
            return row.count
        }

        const memoryFolders = db.prepare('SELECT directory_path FROM memory_folders').all() as { directory_path: string }[]
        const memoryDocuments = memoryFolders.reduce((total, category) => {
            if (!category.directory_path) return total
            return total + listFilesInFolder(category.directory_path).filter((file) => file.supported).length
        }, 0)
        const settings = count('settings')
        const approvals = count('tool_approvals')
        const cronJobs = count('cron_jobs')
        const conversations = count('conversations')
        const messages = count('messages')
        const attachments = count('message_attachments')
        const tasks = count('tasks')
        const executionLogs = count('execution_logs')
        const executionSteps = count('execution_steps')
        const knowledgeEntities = count('memory_knowledge_entities')
        const knowledgeRelationships = count('memory_knowledge_assertions')
        const knowledgeEvidence = count('memory_knowledge_assertion_evidence')
        const knowledgeRows = knowledgeEntities + knowledgeRelationships + knowledgeEvidence

        const modules: Record<string, BackupSummaryModule> = {
            agents: { count: count('agents') },
            providers: { count: count('providers') },
            mcp: { count: count('mcp_servers') },
            settings: {
                count: settings + approvals + cronJobs,
                details: { settings, approvals, cronJobs }
            },
            channels: { count: count('channels') },
            memory: {
                count: memoryDocuments,
                details: { categories: memoryFolders.length, documents: memoryDocuments }
            },
            knowledge: {
                count: knowledgeRows,
                details: {
                    entities: knowledgeEntities,
                    relationships: knowledgeRelationships,
                    evidence: knowledgeEvidence,
                }
            },
            conversations: {
                count: conversations,
                details: { conversations, messages, attachments, tasks }
            },
            usage: {
                count: executionLogs + executionSteps,
                details: { runs: executionLogs, steps: executionSteps }
            }
        }

        return { modules }
    })

    // ── GET /api/backup/export?modules=agents,providers,mcp,settings ────────
    app.get<{ Querystring: { modules?: string } }>(
        '/export',
        async (req, reply) => {
            const requested = (req.query.modules || 'agents,providers,mcp,settings,channels,memory,knowledge,conversations,usage')
                .split(',')
                .map((m) => m.trim())

            const manifest: BackupManifest = {
                version: 1,
                createdAt: new Date().toISOString(),
                modules: {}
            }

            const archive = archiver('zip', { zlib: { level: 5 } })
            const chunks: Buffer[] = []

            archive.on('data', (chunk: Buffer) => chunks.push(chunk))
            const archiveFinished = new Promise<void>((resolve, reject) => {
                archive.on('end', resolve)
                archive.on('error', reject)
            })

            // --- Agents ---
            if (requested.includes('agents')) {
                const db = getDb()
                const agentRows = db.prepare(
                    `SELECT id, name, description, provider_id, model, system_prompt, tools_json, icon_url, internal_name,
                     category, sub_agents_json, auto_approve_tools, thinking_enabled,
                     max_context_tokens, auto_tool_routing, tool_router_provider_id, tool_router_model,
                     auto_memory, memory_router_provider_id, memory_router_model,
                     auto_router_provider_id, auto_router_model,
                     sort_order, tags_json, favorite, cron_prompt, icon_mime, created_at, updated_at
                     FROM agents ORDER BY created_at`
                ).all() as Record<string, unknown>[]

                // Export icon BLOBs as base64 data URLs alongside the rows
                const agentIcons: Record<string, string> = {}
                const iconRows = db.prepare('SELECT id, icon_data, icon_mime FROM agents WHERE icon_data IS NOT NULL').all() as {
                    id: string; icon_data: Buffer; icon_mime: string
                }[]
                for (const row of iconRows) {
                    agentIcons[row.id] = `data:${row.icon_mime};base64,${row.icon_data.toString('base64')}`
                }

                archive.append(JSON.stringify(agentRows, null, 2), { name: 'agents/_db_agents.json' })
                if (Object.keys(agentIcons).length > 0) {
                    archive.append(JSON.stringify(agentIcons, null, 2), { name: 'agents/_db_agent_icons.json' })
                }
                manifest.modules.agents = { count: agentRows.length }
            }

            // --- Providers ---
            if (requested.includes('providers')) {
                const providers = getProviderRows()
                archive.append(JSON.stringify(providers, null, 2), {
                    name: 'providers/providers.json'
                })
                manifest.modules.providers = { count: providers.length }
            }

            // --- MCP ---
            if (requested.includes('mcp')) {
                const servers = getMcpRows()
                archive.append(JSON.stringify(servers, null, 2), {
                    name: 'mcp/servers.json'
                })
                manifest.modules.mcp = { count: servers.length }
            }

            // --- Settings (settings, tool approvals, cron jobs) ---
            if (requested.includes('settings')) {
                const settings = getSettingsRows()
                const approvals = getToolApprovalRows()
                const cronJobs = getCronJobRows()
                archive.append(JSON.stringify(settings, null, 2), {
                    name: 'settings/settings.json'
                })
                archive.append(JSON.stringify(approvals, null, 2), {
                    name: 'settings/tool_approvals.json'
                })
                archive.append(JSON.stringify(cronJobs, null, 2), {
                    name: 'settings/cron_jobs.json'
                })
                manifest.modules.settings = {
                    count:
                        Object.keys(settings).length + approvals.length + cronJobs.length
                }
            }

            // --- Channels ---
            if (requested.includes('channels')) {
                const channels = getChannelRows()
                archive.append(JSON.stringify(channels, null, 2), {
                    name: 'channels/channels.json'
                })
                manifest.modules.channels = { count: channels.length }
            }

            // --- Categorized, revisional memory ---
            if (requested.includes('memory')) {
                const db = getDb()
                const categories: MemoryFolderBackupRow[] = (db.prepare('SELECT * FROM memory_folders ORDER BY created_at').all() as MemoryFolderBackupRow[])
                    .map((category) => {
                        const directoryPath = typeof category.directory_path === 'string' ? category.directory_path : ''
                        const isUncategorized = category.is_uncategorized === 1 || category.is_uncategorized === true
                        return {
                            ...category,
                            categoryPath: isUncategorized || !directoryPath ? '' : portableRelativePathForFolder(directoryPath),
                        }
                    })
                const assignments = db.prepare('SELECT * FROM agent_memory_folders').all()
                const fileIndex = db.prepare(`
                    SELECT document_id, document_ref, category_id, file_name, dreamed_at, created_at
                    FROM memory_file_index ORDER BY created_at
                `).all() as MemoryFileIdentityBackup[]
                const documents = db.prepare('SELECT * FROM memory_documents ORDER BY created_at').all() as MemoryDocumentBackup[]
                const revisions = db.prepare('SELECT * FROM memory_document_revisions ORDER BY document_id, revision_number').all() as MemoryRevisionBackup[]
                const files: MemoryFileBackup[] = []

                for (const category of categories) {
                    const categoryId = String(category.id || '')
                    const directoryPath = typeof category.directory_path === 'string' ? category.directory_path : ''
                    if (!categoryId || !directoryPath) continue

                    for (const file of listFilesInFolder(directoryPath).filter(f => f.supported)) {
                        const archiveName = `memory/files/${encodeURIComponent(categoryId)}/${encodeURIComponent(file.fileName)}`
                        archive.file(file.filePath, { name: archiveName })
                        files.push({ categoryId, fileName: file.fileName, archiveName })
                    }
                }

                archive.append(JSON.stringify({ categories, assignments, fileIndex, documents, revisions }, null, 2), { name: 'memory/categories.json' })
                archive.append(JSON.stringify({ files }, null, 2), { name: 'memory/files.json' })
                manifest.modules.memory = { count: files.length }
            }

            // --- Governed knowledge state ---
            if (requested.includes('knowledge')) {
                const knowledge = createMemoryKnowledgeBackup()
                archive.append(JSON.stringify(knowledge), { name: 'knowledge/knowledge.json' })
                manifest.modules.knowledge = { count: memoryKnowledgeBackupCount(knowledge) }
            }
            // --- Conversations (agent-linked chat history) ---
            if (requested.includes('conversations')) {
                const db = getDb()
                const conversations = db.prepare('SELECT * FROM conversations ORDER BY created_at').all()
                const messages = db.prepare('SELECT * FROM messages ORDER BY created_at').all()
                const subagentSessions = db.prepare('SELECT * FROM subagent_sessions ORDER BY created_at').all()
                const messageAttachments = db.prepare('SELECT * FROM message_attachments ORDER BY created_at').all()
                const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at').all()

                archive.append(JSON.stringify(conversations, null, 2), { name: 'conversations/conversations.json' })
                archive.append(JSON.stringify(messages, null, 2), { name: 'conversations/messages.json' })
                archive.append(JSON.stringify(subagentSessions, null, 2), { name: 'conversations/subagent_sessions.json' })
                archive.append(JSON.stringify(messageAttachments, null, 2), { name: 'conversations/message_attachments.json' })
                archive.append(JSON.stringify(tasks, null, 2), { name: 'conversations/tasks.json' })

                // Export artifact files for each conversation
                const conversationIds = (conversations as Record<string, unknown>[]).map(c => c.id as string)
                for (const convId of conversationIds) {
                    const artifactDir = getConversationArtifactsDir(convId)
                    if (existsSync(artifactDir)) {
                        // Add the entire artifacts directory for this conversation
                        archive.directory(artifactDir, `conversations/artifacts/${convId}`)
                    }
                }

                manifest.modules.conversations = { count: conversations.length }
            }

            // --- Usage statistics (execution trace data) ---
            if (requested.includes('usage')) {
                const db = getDb()
                const executionLogs = db.prepare('SELECT * FROM execution_logs ORDER BY created_at').all()
                const executionSteps = db.prepare('SELECT * FROM execution_steps ORDER BY created_at').all()

                archive.append(JSON.stringify(executionLogs, null, 2), { name: 'usage/execution_logs.json' })
                archive.append(JSON.stringify(executionSteps, null, 2), { name: 'usage/execution_steps.json' })
                manifest.modules.usage = { count: executionLogs.length + executionSteps.length }
            }

            // Write manifest
            archive.append(JSON.stringify(manifest, null, 2), {
                name: 'manifest.json'
            })

            await archive.finalize()
            await archiveFinished

            const buffer = Buffer.concat(chunks)
            const filename = `cynosure-backup-${new Date().toISOString().slice(0, 10)}.zip`

            return reply
                .header('Content-Type', 'application/zip')
                .header(
                    'Content-Disposition',
                    `attachment; filename="${filename}"`
                )
                .send(buffer)
        }
    )

    // ── POST /api/backup/import  (multipart form with zip file + modules) ──
    app.post('/import', async (req, reply) => {
        const data = await req.file()
        if (!data) {
            return reply.status(400).send({ error: 'No file uploaded' })
        }

        const buf = await data.toBuffer()
        const zip = new AdmZip(buf)

        // Parse manifest
        const manifestEntry = zip.getEntry('manifest.json')
        if (!manifestEntry) {
            return reply.status(400).send({ error: 'Invalid backup: missing manifest.json' })
        }
        const manifest = JSON.parse(
            manifestEntry.getData().toString('utf-8')
        ) as BackupManifest
        const knowledgeBackup = getMemoryKnowledgeBackup(zip)

        // Determine which modules to restore (from form field or restore all available)
        const modulesField = data.fields?.modules
        const requestedModules: string[] = modulesField
            ? (typeof modulesField === 'string'
                ? modulesField
                : (modulesField as { value: string }).value
            )
                .split(',')
                .map((m: string) => m.trim())
            : Object.keys(manifest.modules)

        const db = getDb()
        const results: Record<string, { restored: number; errors: string[] }> = {}
        const restoreModules = requestedModules.filter((module) =>
            Boolean(manifest.modules[module]) && (module !== 'knowledge' || Boolean(knowledgeBackup))
        )
        let restoreIndex = 0
        const emitRestoreProgress = (module: string, status: 'started' | 'completed' | 'failed') => {
            if (!broadcast) return
            const total = restoreModules.length
            const current = status === 'started'
                ? restoreIndex + 1
                : Math.min(restoreIndex + 1, total)
            broadcast('backup:restore-progress', { module, status, current, total })
            if (status !== 'started') restoreIndex++
        }

        // --- Restore Agents ---
        if (requestedModules.includes('agents') && manifest.modules.agents) {
            const res = { restored: 0, errors: [] as string[] }
            emitRestoreProgress('agents', 'started')
            try {
                // Restore DB rows
                const dbEntry = zip.getEntry('agents/_db_agents.json')
                if (dbEntry) {
                    const agentRows = JSON.parse(
                        dbEntry.getData().toString('utf-8')
                    ) as Record<string, unknown>[]

                    // Load icon data URLs if present
                    let agentIcons: Record<string, string> = {}
                    const iconsEntry = zip.getEntry('agents/_db_agent_icons.json')
                    if (iconsEntry) {
                        agentIcons = JSON.parse(iconsEntry.getData().toString('utf-8'))
                    }

                    for (const row of agentRows) {
                        try {
                            // Parse icon data URL if available
                            let iconData: Buffer | null = null
                            let iconMime: string | null = (row.icon_mime as string) || null
                            const iconDataUrl = agentIcons[row.id as string]
                            if (iconDataUrl) {
                                const match = iconDataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/)
                                if (match) {
                                    iconMime = match[1]
                                    iconData = Buffer.from(match[2], 'base64')
                                }
                            }

                            db.prepare(
                                `INSERT OR REPLACE INTO agents (id, name, description, provider_id, model, system_prompt, tools_json,
                                   icon_url, internal_name, category, sub_agents_json, auto_approve_tools,
                                 thinking_enabled, max_context_tokens, auto_tool_routing, tool_router_provider_id, tool_router_model,
                                 auto_memory, memory_router_provider_id, memory_router_model,
                                 auto_router_provider_id, auto_router_model,
                                 sort_order, tags_json, favorite, cron_prompt, icon_data, icon_mime,
                                 created_at, updated_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).run(
                                row.id,
                                row.name || '',
                                row.description || '',
                                row.provider_id || null,
                                row.model || '',
                                row.system_prompt || '',
                                row.tools_json || '[]',
                                row.icon_url || null,
                                row.internal_name || row.codename || '',
                                row.category || '',
                                row.sub_agents_json || '[]',
                                row.auto_approve_tools ?? 0,
                                row.thinking_enabled ?? 1,
                                row.max_context_tokens ?? null,
                                row.auto_tool_routing ?? 0,
                                row.tool_router_provider_id || '',
                                row.tool_router_model || '',
                                row.auto_memory ?? 0,
                                row.memory_router_provider_id || '',
                                row.memory_router_model || '',
                                row.auto_router_provider_id || '',
                                row.auto_router_model || '',
                                row.sort_order ?? 0,
                                row.tags_json || '[]',
                                row.favorite ?? 0,
                                row.cron_prompt || '',
                                iconData,
                                iconMime,
                                row.created_at || Date.now(),
                                row.updated_at || Date.now()
                            )
                            res.restored++
                        } catch (e) {
                            res.errors.push(`Agent DB row ${row.id}: ${(e as Error).message}`)
                        }
                    }
                }
            } catch (e) {
                res.errors.push((e as Error).message)
            }
            results.agents = res
            emitRestoreProgress('agents', res.errors.length > 0 ? 'failed' : 'completed')
        }

        // --- Restore Providers ---
        if (requestedModules.includes('providers') && manifest.modules.providers) {
            const res = { restored: 0, errors: [] as string[] }
            emitRestoreProgress('providers', 'started')
            try {
                const entry = zip.getEntry('providers/providers.json')
                if (entry) {
                    const providers = JSON.parse(
                        entry.getData().toString('utf-8')
                    ) as LLMProviderConfig[]
                    const now = Date.now()
                    for (const config of providers) {
                        try {
                            const apiKeyPlain = config.apiKey || null
                            const configForStorage = { ...config, apiKey: undefined }
                            db.prepare(
                                `INSERT OR REPLACE INTO providers (id, name, type, base_url, api_key_enc, default_model, config_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).run(
                                config.id,
                                config.name,
                                config.type,
                                config.baseUrl,
                                apiKeyPlain,
                                config.defaultModel,
                                JSON.stringify(configForStorage),
                                now,
                                now
                            )
                            res.restored++
                        } catch (e) {
                            res.errors.push(
                                `Provider ${config.name}: ${(e as Error).message}`
                            )
                        }
                    }
                    // Reload gateway providers
                    const gateway = getGateway()
                    for (const [id] of gateway.getAllProviders()) {
                        gateway.removeProvider(id)
                    }
                    loadSavedProviders()
                }
            } catch (e) {
                res.errors.push((e as Error).message)
            }
            results.providers = res
            emitRestoreProgress('providers', res.errors.length > 0 ? 'failed' : 'completed')
        }

        // --- Restore MCP ---
        if (requestedModules.includes('mcp') && manifest.modules.mcp) {
            const res = { restored: 0, errors: [] as string[] }
            emitRestoreProgress('mcp', 'started')
            try {
                const entry = zip.getEntry('mcp/servers.json')
                if (entry) {
                    const servers = JSON.parse(
                        entry.getData().toString('utf-8')
                    ) as Record<string, unknown>[]
                    for (const srv of servers) {
                        try {
                            db.prepare(
                                `INSERT OR REPLACE INTO mcp_servers (id, name, original_name, custom_name, command, args_json, env_json, enabled, icon_url, origin, description, env_hints_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).run(
                                srv.id,
                                srv.name,
                                srv.original_name || srv.name,
                                srv.custom_name || null,
                                srv.command,
                                srv.args_json || '[]',
                                srv.env_json || '{}',
                                srv.enabled ?? 1,
                                srv.icon_url || null,
                                srv.origin || null,
                                srv.description || '',
                                srv.env_hints_json || null,
                                srv.created_at || Date.now(),
                                srv.updated_at || Date.now()
                            )
                            res.restored++
                        } catch (e) {
                            res.errors.push(
                                `MCP ${srv.name}: ${(e as Error).message}`
                            )
                        }
                    }
                    // Reload MCP servers
                    await loadSavedMcpServers()
                }
            } catch (e) {
                res.errors.push((e as Error).message)
            }
            results.mcp = res
            emitRestoreProgress('mcp', res.errors.length > 0 ? 'failed' : 'completed')
        }

        // --- Restore Settings ---
        if (requestedModules.includes('settings') && manifest.modules.settings) {
            const res = { restored: 0, errors: [] as string[] }
            emitRestoreProgress('settings', 'started')
            try {
                // Settings key/values
                const settingsEntry = zip.getEntry('settings/settings.json')
                if (settingsEntry) {
                    const settings = JSON.parse(
                        settingsEntry.getData().toString('utf-8')
                    ) as Record<string, unknown>
                    for (const [key, value] of Object.entries(settings)) {
                        db.prepare(
                            "INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)"
                        ).run(key, JSON.stringify(value))
                        res.restored++
                    }
                }

                // Tool approvals
                const approvalsEntry = zip.getEntry('settings/tool_approvals.json')
                if (approvalsEntry) {
                    const approvals = JSON.parse(
                        approvalsEntry.getData().toString('utf-8')
                    ) as { toolName: string; autoApprove: boolean }[]
                    for (const ta of approvals) {
                        db.prepare(
                            'INSERT OR REPLACE INTO tool_approvals (tool_name, auto_approve) VALUES (?, ?)'
                        ).run(ta.toolName, ta.autoApprove ? 1 : 0)
                        res.restored++
                    }
                }

                // Cron jobs
                const cronEntry = zip.getEntry('settings/cron_jobs.json')
                if (cronEntry) {
                    const jobs = JSON.parse(
                        cronEntry.getData().toString('utf-8')
                    ) as Record<string, unknown>[]
                    for (const job of jobs) {
                        try {
                            if (job.id) unscheduleCronJob(String(job.id))
                            const now = Date.now()
                            db.prepare(
                                `INSERT OR REPLACE INTO cron_jobs
                                    (id, name, agent_id, schedule, prompt, enabled, one_off, model_override,
                                     provider_override, output_channel_id, output_target, notification_mode,
                                     notification_condition, execution_config_json, created_at, updated_at, last_run_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).run(
                                job.id,
                                job.name || '',
                                job.agent_id,
                                job.schedule,
                                job.prompt || '',
                                job.enabled ?? 1,
                                job.one_off ?? 0,
                                job.model_override || '',
                                job.provider_override || '',
                                job.output_channel_id || '',
                                job.output_target || '',
                                job.notification_mode === 'conditional' ? 'conditional' : 'always',
                                job.notification_condition || '',
                                job.execution_config_json || '{}',
                                job.created_at || now,
                                job.updated_at || now,
                                typeof job.last_run_at === 'number' ? job.last_run_at : now
                            )
                            if ((job.enabled ?? 1) === 1 && job.id) scheduleCronJob(String(job.id))
                            res.restored++
                        } catch (e) {
                            res.errors.push(`Cron job: ${(e as Error).message}`)
                        }
                    }
                }
            } catch (e) {
                res.errors.push((e as Error).message)
            }
            results.settings = res

            // Reload embedding provider & parser config from freshly restored settings
            // so subsequent user-triggered indexing uses the restored configuration.
            getEmbeddingProvider().loadFromDb()
            getMemoryParser().refreshConfig()
            emitRestoreProgress('settings', res.errors.length > 0 ? 'failed' : 'completed')
        }

        // --- Restore Channels ---
        if (requestedModules.includes('channels') && manifest.modules.channels) {
            const res = { restored: 0, errors: [] as string[] }
            emitRestoreProgress('channels', 'started')
            try {
                const entry = zip.getEntry('channels/channels.json')
                if (entry) {
                    const channels = JSON.parse(
                        entry.getData().toString('utf-8')
                    ) as Record<string, unknown>[]
                    for (const ch of channels) {
                        try {
                            db.prepare(
                                `INSERT OR REPLACE INTO channels (id, name, type, agent_id, config_json, enabled, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                            ).run(
                                ch.id,
                                ch.name,
                                ch.type,
                                ch.agent_id,
                                ch.config_json || '{}',
                                ch.enabled ?? 1,
                                ch.created_at || Date.now(),
                                ch.updated_at || Date.now()
                            )
                            res.restored++
                        } catch (e) {
                            res.errors.push(
                                `Channel ${ch.name}: ${(e as Error).message}`
                            )
                        }
                    }
                    // Reload channel manager to pick up restored channels
                    await getChannelManager().loadAll()
                }
            } catch (e) {
                res.errors.push((e as Error).message)
            }
            results.channels = res
            emitRestoreProgress('channels', res.errors.length > 0 ? 'failed' : 'completed')
        }

        // --- Restore categorized, revisional memory ---
        if (requestedModules.includes('memory') && manifest.modules.memory) {
            const res = { restored: 0, errors: [] as string[] }
            emitRestoreProgress('memory', 'started')
            try {
                await stopAllMemoryFolderWatchers()

                // Memory replacement must not leave facts from the previous
                // workspace addressable under reused category IDs such as default.
                await getMemoryKnowledgeStore().reset()

                // Reset LanceDB to avoid stale index references from previous state
                const ragStore = getRAGStore()
                await ragStore.close()
                const lanceDir = join(getAppDataDir(), 'lancedb')
                if (existsSync(lanceDir)) {
                    rmSync(lanceDir, { recursive: true, force: true })
                }
                await ragStore.initialize()

                db.prepare('DELETE FROM memory_file_index').run()
                db.prepare('DELETE FROM agent_memory_folders').run()
                db.prepare('DELETE FROM memory_folders').run()

                const memoryRoot = getMemoryFoldersRootDir()
                if (existsSync(memoryRoot)) {
                    rmSync(memoryRoot, { recursive: true, force: true })
                }
                ensureFolder(memoryRoot)

                // Restore category metadata, document identities, revisions, and assignments.
                const categoriesEntry = zip.getEntry('memory/categories.json')
                const categoryIdMap = new Map<string, string>()
                if (categoriesEntry) {
                    const { categories, assignments, fileIndex, documents, revisions } = JSON.parse(categoriesEntry.getData().toString('utf-8')) as {
                        categories: MemoryFolderBackupRow[]
                        assignments: Record<string, unknown>[]
                        fileIndex?: MemoryFileIdentityBackup[]
                        documents?: MemoryDocumentBackup[]
                        revisions?: MemoryRevisionBackup[]
                    }
                    for (const sp of categories) {
                        const importedId = String(sp.id || '')
                        if (!importedId) continue
                        const isUncategorized = sp.is_uncategorized === 1 || sp.is_uncategorized === true || importedId === 'uncategorized'
                        const id = isUncategorized ? 'uncategorized' : importedId
                        categoryIdMap.set(importedId, id)
                        const directoryPath = id === 'uncategorized' ? getDefaultMemoryFolderDir() : directoryPathForRelative(relativePathFromBackupCategory(sp))
                        ensureFolder(directoryPath)
                        db.prepare(`
                            INSERT OR REPLACE INTO memory_folders
                                (id, name, description, directory_path, sort_order, is_uncategorized, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                        `).run(
                            id,
                            sp.name || '',
                            sp.description || '',
                            directoryPath,
                            sp.sort_order ?? 0,
                            id === 'uncategorized' ? 1 : 0,
                            sp.created_at || Date.now()
                        )
                    }
                    ensureDefaultMemoryFolder(db)
                    for (const asg of assignments) {
                        const mappedCategoryId = categoryIdMap.get(String(asg.category_id || '')) || asg.category_id
                        db.prepare('INSERT OR IGNORE INTO agent_memory_folders (agent_id, category_id) VALUES (?, ?)')
                            .run(asg.agent_id, mappedCategoryId)
                    }
                    for (const file of fileIndex || []) {
                        const mappedCategoryId = categoryIdMap.get(file.category_id) || file.category_id
                        db.prepare(`
                            INSERT OR REPLACE INTO memory_file_index
                                (document_id, document_ref, category_id, file_name, content_hash,
                                 chunk_count, last_indexed_at, deep_researched_at, dreamed_at, tags_json, created_at)
                            VALUES (?, ?, ?, ?, '', 0, 0, 0, ?, '[]', ?)
                        `).run(file.document_id, file.document_ref, mappedCategoryId, file.file_name, file.dreamed_at || 0, file.created_at || Date.now())
                    }
                    for (const document of documents || []) {
                        const categoryId = categoryIdMap.get(String(document.category_id || '')) || String(document.category_id || '')
                        db.prepare(`INSERT OR REPLACE INTO memory_documents
                            (document_id, document_ref, category_id, file_name, current_hash, status, indexing_status, created_at, updated_at, deleted_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                            .run(document.document_id, document.document_ref, categoryId, document.file_name,
                                document.current_hash || '', document.status || 'active', document.indexing_status || 'pending', document.created_at || Date.now(),
                                document.updated_at || Date.now(), document.deleted_at || null)
                    }
                    for (const revision of revisions || []) {
                        db.prepare(`INSERT OR REPLACE INTO memory_document_revisions
                            (id, document_id, revision_number, content_hash, content, source, conversation_id, agent_id, message_ids_json, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                            .run(revision.id, revision.document_id, revision.revision_number, revision.content_hash,
                                revision.content, revision.source, revision.conversation_id || null, revision.agent_id || null,
                                revision.message_ids_json || '[]', revision.created_at || Date.now())
                    }
                } else {
                    throw new Error('Backup does not contain categorized memory metadata.')
                }

                // Restore source files only. Files are the source of truth for
                // file-backed memory; vectors should be rebuilt on the target
                // machine by re-indexing with its local embedding configuration.
                const filesEntry = zip.getEntry('memory/files.json')
                if (filesEntry) {
                    const { files } = JSON.parse(filesEntry.getData().toString('utf-8')) as { files: MemoryFileBackup[] }
                    for (const file of files || []) {
                        try {
                            const safeFileName = basename(file.fileName)
                            if (!file.categoryId || !safeFileName || safeFileName !== file.fileName) {
                                throw new Error('Invalid memory file name')
                            }
                            const targetCategoryId = categoryIdMap.get(file.categoryId) || file.categoryId

                            const category = db.prepare('SELECT directory_path FROM memory_folders WHERE id = ?')
                                .get(targetCategoryId) as { directory_path: string } | undefined
                            if (!category?.directory_path) throw new Error(`Memory folder "${targetCategoryId}" not found`)

                            const entry = zip.getEntry(file.archiveName)
                            if (!entry || entry.isDirectory) throw new Error('File content missing from backup')

                            ensureFolder(category.directory_path)
                            writeFileSync(join(category.directory_path, safeFileName), entry.getData())
                            res.restored++
                        } catch (e) {
                            res.errors.push(`File "${file.fileName}": ${(e as Error).message}`)
                        }
                    }
                }

                const restoredCategories = db.prepare('SELECT id, directory_path FROM memory_folders WHERE directory_path != ?').all('') as {
                    id: string
                    directory_path: string
                }[]
                for (const category of restoredCategories) {
                    watchMemoryFolder(category.id, category.directory_path)
                }
            } catch (e) {
                res.errors.push((e as Error).message)
            }
            results.memory = res
            emitRestoreProgress('memory', res.errors.length > 0 ? 'failed' : 'completed')
        }

        // --- Restore governed knowledge, including manual corrections ---
        if (requestedModules.includes('knowledge') && manifest.modules.knowledge && knowledgeBackup) {
            const res = { restored: 0, errors: [] as string[] }
            emitRestoreProgress('knowledge', 'started')
            try {
                const restored = await restoreMemoryKnowledgeBackup(knowledgeBackup, db)
                res.restored = restored.restored
                if (restored.projectionError) {
                    res.errors.push(`Knowledge search projection: ${restored.projectionError}`)
                }
            } catch (e) {
                res.errors.push((e as Error).message)
            }
            results.knowledge = res
            emitRestoreProgress('knowledge', res.errors.length > 0 ? 'failed' : 'completed')
        }

        // --- Restore Conversations (only for agents present in DB) ---
        if (requestedModules.includes('conversations') && manifest.modules.conversations) {
            const res = { restored: 0, errors: [] as string[] }
            emitRestoreProgress('conversations', 'started')
            try {
                // Get the set of agent IDs that exist in the DB (including freshly imported ones)
                const existingAgentIds = new Set(
                    (db.prepare('SELECT id FROM agents').all() as { id: string }[]).map(a => a.id)
                )

                // Conversations
                const convEntry = zip.getEntry('conversations/conversations.json')
                const importedConversationIds = new Set<string>()
                if (convEntry) {
                    const conversations = JSON.parse(convEntry.getData().toString('utf-8')) as Record<string, unknown>[]
                    for (const c of conversations) {
                        // Only restore conversations for agents that exist in the DB
                        if (c.agent_id && !existingAgentIds.has(c.agent_id as string)) continue
                        try {
                            db.prepare(
                                'INSERT OR REPLACE INTO conversations (id, title, agent_id, ma_workspace_id, origin, pinned, last_context_tokens, execution_config_json, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                            ).run(
                                c.id,
                                c.title || '',
                                c.agent_id || null,
                                c.ma_workspace_id || null,
                                c.origin || 'chat',
                                c.pinned ?? 0,
                                c.last_context_tokens ?? null,
                                c.execution_config_json || '{}',
                                c.metadata_json || '{}',
                                c.created_at || Date.now(),
                                c.updated_at || Date.now()
                            )
                            importedConversationIds.add(c.id as string)
                            res.restored++
                        } catch (e) {
                            res.errors.push(`Conversation: ${(e as Error).message}`)
                        }
                    }
                }

                // Messages (only for imported conversations)
                const importedMessageIds = new Set<string>()
                const msgEntry = zip.getEntry('conversations/messages.json')
                if (msgEntry) {
                    const messages = JSON.parse(msgEntry.getData().toString('utf-8')) as Record<string, unknown>[]
                    for (const m of messages) {
                        if (!importedConversationIds.has(m.conversation_id as string)) continue
                        try {
                            db.prepare(
                                `INSERT OR REPLACE INTO messages (
                                    id, conversation_id, role, content, tool_calls_json, tool_call_id,
                                    provider, model, prompt_tokens, completion_tokens, context_tokens,
                                    latency_ms, image_urls_json, video_urls_json, agent_id, memory_sources_json, thinking,
                                    audio_urls_json, structured_content_json, created_at
                                 )
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).run(
                                m.id, m.conversation_id, m.role, m.content,
                                m.tool_calls_json || null, m.tool_call_id || null,
                                m.provider || null, m.model || null,
                                m.prompt_tokens ?? null, m.completion_tokens ?? null,
                                m.context_tokens ?? null,
                                m.latency_ms ?? null, m.image_urls_json || null, m.video_urls_json || null, m.agent_id || null,
                                m.memory_sources_json || null, m.thinking || null,
                                m.audio_urls_json || null,
                                m.structured_content_json || null,
                                m.created_at || Date.now()
                            )
                            importedMessageIds.add(m.id as string)
                        } catch (e) {
                            res.errors.push(`Message: ${(e as Error).message}`)
                        }
                    }
                }

                // Durable sub-agent sessions (only for imported conversations)
                const subagentSessionsEntry = zip.getEntry('conversations/subagent_sessions.json')
                if (subagentSessionsEntry) {
                    const sessions = JSON.parse(subagentSessionsEntry.getData().toString('utf-8')) as Record<string, unknown>[]
                    for (const session of sessions) {
                        if (!importedConversationIds.has(session.conversation_id as string)) continue
                        try {
                            db.prepare(
                                `INSERT OR REPLACE INTO subagent_sessions (
                                    invocation_id, conversation_id, agent_id, history_json, created_at, updated_at
                                 ) VALUES (?, ?, ?, ?, ?, ?)`
                            ).run(
                                session.invocation_id, session.conversation_id, session.agent_id,
                                session.history_json || '[]', session.created_at || Date.now(), session.updated_at || Date.now()
                            )
                        } catch (e) {
                            res.errors.push(`Sub-agent session: ${(e as Error).message}`)
                        }
                    }
                }

                // Message attachments (only for imported messages)
                const attachmentsEntry = zip.getEntry('conversations/message_attachments.json')
                if (attachmentsEntry) {
                    const attachments = JSON.parse(attachmentsEntry.getData().toString('utf-8')) as Record<string, unknown>[]
                    for (const a of attachments) {
                        if (!importedMessageIds.has(a.message_id as string)) continue
                        try {
                            db.prepare(
                                `INSERT OR REPLACE INTO message_attachments (
                                    id, message_id, conversation_id, kind, name, original_path, text_path,
                                    size_bytes, text_bytes, chunk_count, metadata_json, created_at
                                 )
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).run(
                                a.id, a.message_id, a.conversation_id, a.kind || 'file', a.name || '',
                                a.original_path || null, a.text_path || null,
                                a.size_bytes ?? null, a.text_bytes ?? null, a.chunk_count ?? null,
                                a.metadata_json || null, a.created_at || Date.now()
                            )
                        } catch (e) {
                            res.errors.push(`Message attachment: ${(e as Error).message}`)
                        }
                    }
                }

                // Tasks (only for imported conversations)
                const tasksEntry = zip.getEntry('conversations/tasks.json')
                if (tasksEntry) {
                    const tasks = JSON.parse(tasksEntry.getData().toString('utf-8')) as Record<string, unknown>[]
                    for (const t of tasks) {
                        if (t.conversation_id && !importedConversationIds.has(t.conversation_id as string)) continue
                        try {
                            db.prepare(
                                `INSERT OR REPLACE INTO tasks (id, conversation_id, status, definition_json, result_json, iterations, created_at, updated_at, completed_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).run(
                                t.id, t.conversation_id || null, t.status || 'completed',
                                t.definition_json || '{}', t.result_json || null,
                                t.iterations ?? 0, t.created_at || Date.now(),
                                t.updated_at || t.created_at || Date.now(),
                                t.completed_at || null
                            )
                        } catch (e) {
                            res.errors.push(`Task: ${(e as Error).message}`)
                        }
                    }
                }

                // Restore artifact files for imported conversations
                try {
                    const appDataDir = getAppDataDir()
                    const artifactsBaseDir = join(appDataDir, 'artifacts', 'conversations')

                    // Get all entries in the zip
                    const allEntries = zip.getEntries()
                    for (const entry of allEntries) {
                        // Match entries like: conversations/artifacts/{convId}/{relative/path/to/file}
                        const match = entry.entryName.match(/^conversations\/artifacts\/([^/]+)\/(.+)$/)
                        if (!match) continue

                        const convId = match[1]
                        const relPath = match[2]

                        // Only restore artifacts for conversations we're importing
                        if (!importedConversationIds.has(convId)) continue

                        // Skip directories, only restore files
                        if (entry.isDirectory) continue

                        try {
                            const targetPath = join(artifactsBaseDir, convId, relPath)
                            mkdirSync(dirname(targetPath), { recursive: true })
                            writeFileSync(targetPath, entry.getData())
                        } catch (e) {
                            res.errors.push(`Artifact file ${entry.entryName}: ${(e as Error).message}`)
                        }
                    }
                } catch (e) {
                    res.errors.push(`Artifact restoration: ${(e as Error).message}`)
                }

                // Re-home absolute media URLs to this installation's data directory.
                // Backup archives retain filenames, while the old absolute prefix may
                // belong to another OS, user account, or CYNOSURE_DATA_DIR.
                try {
                    const artifactsBaseDir = join(getAppDataDir(), 'artifacts', 'conversations')
                    const placeholders = Array.from(importedConversationIds).map(() => '?').join(',') || "''"
                    const rows = db.prepare(`
                        SELECT id, conversation_id, image_urls_json, video_urls_json, audio_urls_json
                        FROM messages
                        WHERE conversation_id IN (${placeholders})
                    `).all(...Array.from(importedConversationIds)) as {
                        id: string
                        conversation_id: string
                        image_urls_json: string | null
                        video_urls_json: string | null
                        audio_urls_json: string | null
                    }[]
                    const rehome = (json: string | null, conversationId: string, directory: string): string | null => {
                        if (!json) return null
                        try {
                            const urls = JSON.parse(json) as string[]
                            return JSON.stringify(urls.map((url) => {
                                const oldPath = extractFilePathFromFileUrl(url)
                                if (!oldPath) return url
                                const targetPath = join(artifactsBaseDir, conversationId, directory, basename(oldPath))
                                return existsSync(targetPath) ? toFileUrl(targetPath) : url
                            }))
                        } catch {
                            return json
                        }
                    }
                    const update = db.prepare(`
                        UPDATE messages
                        SET image_urls_json = ?, video_urls_json = ?, audio_urls_json = ?
                        WHERE id = ?
                    `)
                    for (const row of rows) {
                        update.run(
                            rehome(row.image_urls_json, row.conversation_id, 'images'),
                            rehome(row.video_urls_json, row.conversation_id, 'videos'),
                            rehome(row.audio_urls_json, row.conversation_id, 'audio'),
                            row.id,
                        )
                    }
                } catch (e) {
                    res.errors.push(`Artifact path migration: ${(e as Error).message}`)
                }

                // Re-home restored attachment artifact paths and rebuild conversation-scoped vectors.
                try {
                    const appDataDir = getAppDataDir()
                    const artifactsBaseDir = join(appDataDir, 'artifacts', 'conversations')
                    const rows = db.prepare(`
                        SELECT id, conversation_id, name, original_path, text_path, size_bytes, text_bytes, chunk_count
                        FROM message_attachments
                        WHERE conversation_id IN (${Array.from(importedConversationIds).map(() => '?').join(',') || "''"})
                          AND kind = 'file'
                    `).all(...Array.from(importedConversationIds)) as {
                        id: string
                        conversation_id: string
                        name: string
                        original_path: string | null
                        text_path: string | null
                        size_bytes: number | null
                        text_bytes: number | null
                        chunk_count: number | null
                    }[]

                    for (const row of rows) {
                        if (!row.original_path || !row.text_path) continue
                        const originalPath = join(artifactsBaseDir, row.conversation_id, 'files', basename(row.original_path))
                        const textPath = join(artifactsBaseDir, row.conversation_id, 'files', basename(row.text_path))
                        const attachment: FileAttachmentArtifact = {
                            id: row.id,
                            name: row.name,
                            originalPath,
                            textPath,
                            sizeBytes: row.size_bytes ?? 0,
                            textBytes: row.text_bytes ?? 0,
                            chunkCount: row.chunk_count ?? undefined,
                        }
                        const chunkCount = await indexConversationAttachment(row.conversation_id, attachment)
                        db.prepare(`
                            UPDATE message_attachments
                            SET original_path = ?, text_path = ?, chunk_count = ?, metadata_json = ?
                            WHERE id = ?
                        `).run(originalPath, textPath, chunkCount, JSON.stringify({ ...attachment, chunkCount }), row.id)
                    }
                } catch (e) {
                    res.errors.push(`Attachment reindex: ${(e as Error).message}`)
                }
            } catch (e) {
                res.errors.push((e as Error).message)
            }
            results.conversations = res
            emitRestoreProgress('conversations', res.errors.length > 0 ? 'failed' : 'completed')
        }

        // --- Restore Usage statistics (execution trace data) ---
        if (requestedModules.includes('usage') && manifest.modules.usage) {
            const res = { restored: 0, errors: [] as string[] }
            emitRestoreProgress('usage', 'started')
            try {
                // Execution logs
                const logsEntry = zip.getEntry('usage/execution_logs.json')
                if (logsEntry) {
                    const logs = JSON.parse(logsEntry.getData().toString('utf-8')) as Record<string, unknown>[]
                    for (const log of logs) {
                        try {
                            db.prepare(
                                `INSERT OR REPLACE INTO execution_logs (id, task_id, conversation_id, iteration, event_type, data_json, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?)`
                            ).run(log.id, log.task_id, log.conversation_id, log.iteration ?? 0, log.event_type, log.data_json, log.created_at || Date.now())
                            res.restored++
                        } catch (e) {
                            res.errors.push(`Execution log: ${(e as Error).message}`)
                        }
                    }
                }

                // Execution steps
                const stepsEntry = zip.getEntry('usage/execution_steps.json')
                if (stepsEntry) {
                    const steps = JSON.parse(stepsEntry.getData().toString('utf-8')) as Record<string, unknown>[]
                    for (const s of steps) {
                        try {
                            db.prepare(
                                `INSERT OR REPLACE INTO execution_steps (id, conversation_id, task_id, iteration, status, message, plan, tool_calls_json, results_json, evaluation_json, ma_codename, ma_agent_name, ma_invocation_id, ma_phase, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).run(
                                s.id, s.conversation_id, s.task_id || null, s.iteration ?? 0,
                                s.status, s.message || null, s.plan || null,
                                s.tool_calls_json || null,
                                s.results_json || s.result_json || null,
                                s.evaluation_json || null,
                                s.ma_codename || null,
                                s.ma_agent_name || null,
                                s.ma_invocation_id || null,
                                s.ma_phase || null,
                                s.created_at || Date.now()
                            )
                            res.restored++
                        } catch (e) {
                            res.errors.push(`Execution step: ${(e as Error).message}`)
                        }
                    }
                }
            } catch (e) {
                res.errors.push((e as Error).message)
            }
            results.usage = res
            emitRestoreProgress('usage', res.errors.length > 0 ? 'failed' : 'completed')
        }

        return { success: true, results }
    })

    // ── GET /api/backup/preview (upload zip, return manifest info) ──────────
    app.post('/preview', async (req, reply) => {
        const data = await req.file()
        if (!data) {
            return reply.status(400).send({ error: 'No file uploaded' })
        }

        const buf = await data.toBuffer()
        const zip = new AdmZip(buf)

        const manifestEntry = zip.getEntry('manifest.json')
        if (!manifestEntry) {
            return reply.status(400).send({ error: 'Invalid backup: missing manifest.json' })
        }

        const manifest = JSON.parse(
            manifestEntry.getData().toString('utf-8')
        ) as BackupManifest

        // Advertise Knowledge only when its versioned payload is present.
        if (!getMemoryKnowledgeBackup(zip)) delete manifest.modules.knowledge

        return manifest
    })

    // ── POST /api/backup/reset ─────────────────────────────────────────────
    app.post<{ Body?: { modules?: string[] } }>('/reset', async (req, reply) => {
        const requested = Array.isArray(req.body?.modules) && req.body.modules.length > 0
            ? req.body.modules
            : RESET_MODULES
        const modules = requested.filter((module): module is ResetModule =>
            RESET_MODULES.includes(module as ResetModule)
        )

        if (modules.length === 0) {
            return reply.status(400).send({ error: 'No valid reset modules selected' })
        }

        const results = await resetSelectedModules(modules)

        // Clear logs only for the full reset path.
        if (modules.length === RESET_MODULES.length) {
            const logsDir = join(getAppDataDir(), 'logs')
            if (existsSync(logsDir)) {
                rmSync(logsDir, { recursive: true, force: true })
            }
        }

        return { success: true, results }
    })
}
