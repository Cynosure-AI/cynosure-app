import type { FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import archiver from 'archiver'
import AdmZip from 'adm-zip'
import { ensureDefaultMemorySpace, getDb } from '../db/database.js'
import { getAppDataDir, getDefaultMemorySpaceDir, getMemorySpacesRootDir } from '../core/data-dir.js'
import { getGateway } from '../core/gateway/gateway.js'
import { loadSavedProviders } from './providers.js'
import { loadSavedMcpServers } from './mcp/index.js'
import { getChannelManager } from '../core/channels/channel-manager.js'
import { writeFileSync } from 'fs'
import { getConversationArtifactsDir } from '../core/artifacts/image-artifacts.js'
import { getRAGStore } from '../core/memory/rag.js'
import { getAgentMemory } from '../core/memory/agent-memory.js'
import { getMemoryParser } from '../core/memory/parser.js'
import { getEmbeddingProvider } from '../core/memory/embedding.js'
import { basename, join } from 'path'
import {
    existsSync,
    mkdirSync,
    rmSync
} from 'fs'
import type { LLMProviderConfig } from '../core/gateway/providers/base.provider.js'
import { ensureFolder, listFilesInFolder } from '../core/memory/memory-file-manager.js'
import { stopAllMemorySpaceWatchers, watchMemorySpace } from '../core/memory/memory-space-watcher.js'
import { scheduleCronJob, unscheduleCronJob } from '../core/triggers/cron-scheduler.js'

interface ManifestModule {
    count: number
}

interface BackupManifest {
    version: 1
    createdAt: string
    modules: Record<string, ManifestModule>
}

interface MemoryFileBackup {
    spaceId: string
    fileName: string
    archiveName: string
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

// ────────────────────────────────────────────────────────────────────────────
//  Route registration
// ────────────────────────────────────────────────────────────────────────────

export async function registerBackupRoutes(app: FastifyInstance): Promise<void> {
    await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024 } }) // 1 GB limit

    // ── GET /api/backup/export?modules=agents,providers,mcp,settings ────────
    app.get<{ Querystring: { modules?: string } }>(
        '/export',
        async (req, reply) => {
            const requested = (req.query.modules || 'agents,providers,mcp,settings,channels,memory,conversations,usage')
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
                    `SELECT id, name, description, provider_id, model, system_prompt, tools_json, icon_url, codename,
                     category, sub_agents_json, auto_approve_tools, override_sub_agents, thinking_enabled,
                     max_context_tokens, auto_tool_routing, tool_router_provider_id, tool_router_model,
                     auto_memory, memory_router_provider_id, memory_router_model,
                     sort_order, cron_prompt, icon_mime, created_at, updated_at
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

            // --- Memory spaces ---
            if (requested.includes('memory')) {
                const db = getDb()
                const spaces = db.prepare('SELECT * FROM memory_spaces ORDER BY created_at').all() as Record<string, unknown>[]
                const assignments = db.prepare('SELECT * FROM agent_memory_spaces').all()
                const files: MemoryFileBackup[] = []

                for (const space of spaces) {
                    const spaceId = String(space.id || '')
                    const folderPath = typeof space.folder_path === 'string' ? space.folder_path : ''
                    if (!spaceId || !folderPath) continue

                    for (const file of listFilesInFolder(folderPath).filter(f => f.supported)) {
                        const archiveName = `memory/files/${encodeURIComponent(spaceId)}/${encodeURIComponent(file.fileName)}`
                        archive.file(file.filePath, { name: archiveName })
                        files.push({ spaceId, fileName: file.fileName, archiveName })
                    }
                }

                archive.append(JSON.stringify({ spaces, assignments }, null, 2), { name: 'memory/spaces.json' })
                archive.append(JSON.stringify({ files }, null, 2), { name: 'memory/files.json' })
                manifest.modules.memory = { count: files.length }
            }

            // --- Conversations (agent-linked chat history) ---
            if (requested.includes('conversations')) {
                const db = getDb()
                const conversations = db.prepare('SELECT * FROM conversations ORDER BY created_at').all()
                const messages = db.prepare('SELECT * FROM messages ORDER BY created_at').all()
                const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at').all()

                archive.append(JSON.stringify(conversations, null, 2), { name: 'conversations/conversations.json' })
                archive.append(JSON.stringify(messages, null, 2), { name: 'conversations/messages.json' })
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

        // --- Restore Agents ---
        if (requestedModules.includes('agents') && manifest.modules.agents) {
            const res = { restored: 0, errors: [] as string[] }
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
                                   icon_url, codename, category, sub_agents_json, auto_approve_tools, override_sub_agents,
                                 thinking_enabled, max_context_tokens, auto_tool_routing, tool_router_provider_id, tool_router_model,
                                 auto_memory, memory_router_provider_id, memory_router_model,
                                 sort_order, cron_prompt, icon_data, icon_mime,
                                 created_at, updated_at)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).run(
                                row.id,
                                row.name || '',
                                row.description || '',
                                row.provider_id || null,
                                row.model || '',
                                row.system_prompt || '',
                                row.tools_json || '[]',
                                row.icon_url || null,
                                row.codename || '',
                                row.category || '',
                                row.sub_agents_json || '[]',
                                row.auto_approve_tools ?? 0,
                                row.override_sub_agents ?? 0,
                                row.thinking_enabled ?? 1,
                                row.max_context_tokens ?? null,
                                row.auto_tool_routing ?? 0,
                                row.tool_router_provider_id || '',
                                row.tool_router_model || '',
                                row.auto_memory ?? 0,
                                row.memory_router_provider_id || '',
                                row.memory_router_model || '',
                                row.sort_order ?? 0,
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
        }

        // --- Restore Providers ---
        if (requestedModules.includes('providers') && manifest.modules.providers) {
            const res = { restored: 0, errors: [] as string[] }
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
        }

        // --- Restore MCP ---
        if (requestedModules.includes('mcp') && manifest.modules.mcp) {
            const res = { restored: 0, errors: [] as string[] }
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
        }

        // --- Restore Settings ---
        if (requestedModules.includes('settings') && manifest.modules.settings) {
            const res = { restored: 0, errors: [] as string[] }
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
                                     provider_override, output_channel_id, output_target, created_at, updated_at, last_run_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
            // so that memory ingestion below uses the correct embedding endpoint.
            getEmbeddingProvider().loadFromDb()
            getMemoryParser().refreshConfig()
        }

        // --- Restore Channels ---
        if (requestedModules.includes('channels') && manifest.modules.channels) {
            const res = { restored: 0, errors: [] as string[] }
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
        }

        // --- Restore Memory spaces ---
        if (requestedModules.includes('memory') && manifest.modules.memory) {
            const res = { restored: 0, errors: [] as string[] }
            try {
                await stopAllMemorySpaceWatchers()

                // Reset LanceDB to avoid stale index references from previous state
                const ragStore = getRAGStore()
                await ragStore.close()
                const lanceDir = join(getAppDataDir(), 'lancedb')
                if (existsSync(lanceDir)) {
                    rmSync(lanceDir, { recursive: true, force: true })
                }
                await ragStore.initialize()

                db.prepare('DELETE FROM memory_file_index').run()
                db.prepare('DELETE FROM agent_memory_spaces').run()
                db.prepare('DELETE FROM memory_spaces').run()

                const memoryRoot = getMemorySpacesRootDir()
                if (existsSync(memoryRoot)) {
                    rmSync(memoryRoot, { recursive: true, force: true })
                }
                ensureFolder(memoryRoot)

                // Restore space metadata and assignments. Imported spaces are
                // placed under the local app data memory root so backups are portable.
                const spacesEntry = zip.getEntry('memory/spaces.json')
                const spaceIdMap = new Map<string, string>()
                if (spacesEntry) {
                    const { spaces, assignments } = JSON.parse(spacesEntry.getData().toString('utf-8')) as {
                        spaces: Record<string, unknown>[]
                        assignments: Record<string, unknown>[]
                    }
                    for (const sp of spaces) {
                        const importedId = String(sp.id || '')
                        if (!importedId) continue
                        const isDefault = sp.is_default === 1 || sp.is_default === true || importedId === 'default'
                        const id = isDefault ? 'default' : importedId
                        spaceIdMap.set(importedId, id)
                        const folderPath = id === 'default' ? getDefaultMemorySpaceDir() : join(memoryRoot, id)
                        ensureFolder(folderPath)
                        db.prepare(`
                            INSERT OR REPLACE INTO memory_spaces
                                (id, name, description, folder_path, sort_order, is_default, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                        `).run(
                            id,
                            sp.name || '',
                            sp.description || '',
                            folderPath,
                            sp.sort_order ?? 0,
                            id === 'default' ? 1 : 0,
                            sp.created_at || Date.now()
                        )
                    }
                    ensureDefaultMemorySpace(db)
                    for (const asg of assignments) {
                        const mappedSpaceId = spaceIdMap.get(String(asg.space_id || '')) || asg.space_id
                        db.prepare('INSERT OR IGNORE INTO agent_memory_spaces (agent_id, space_id) VALUES (?, ?)')
                            .run(asg.agent_id, mappedSpaceId)
                    }
                } else {
                    ensureDefaultMemorySpace(db)
                }

                // Restore source files first. Files are the source of truth for
                // file-backed memory; LanceDB is rebuilt from them.
                const filesEntry = zip.getEntry('memory/files.json')
                if (filesEntry) {
                    const { files } = JSON.parse(filesEntry.getData().toString('utf-8')) as { files: MemoryFileBackup[] }
                    const mem = getAgentMemory()
                    for (const file of files || []) {
                        try {
                            const safeFileName = basename(file.fileName)
                            if (!file.spaceId || !safeFileName || safeFileName !== file.fileName) {
                                throw new Error('Invalid memory file name')
                            }
                            const targetSpaceId = spaceIdMap.get(file.spaceId) || file.spaceId

                            const space = db.prepare('SELECT folder_path FROM memory_spaces WHERE id = ?')
                                .get(targetSpaceId) as { folder_path: string } | undefined
                            if (!space?.folder_path) throw new Error(`Memory space "${targetSpaceId}" not found`)

                            const entry = zip.getEntry(file.archiveName)
                            if (!entry || entry.isDirectory) throw new Error('File content missing from backup')

                            ensureFolder(space.folder_path)
                            writeFileSync(join(space.folder_path, safeFileName), entry.getData())
                            await mem.reindexFile(space.folder_path, safeFileName, targetSpaceId)
                            res.restored++
                        } catch (e) {
                            res.errors.push(`File "${file.fileName}": ${(e as Error).message}`)
                        }
                    }
                }

                const restoredSpaces = db.prepare('SELECT id, folder_path FROM memory_spaces WHERE folder_path != ?').all('') as {
                    id: string
                    folder_path: string
                }[]
                for (const space of restoredSpaces) {
                    watchMemorySpace(space.id, space.folder_path)
                }
            } catch (e) {
                res.errors.push((e as Error).message)
            }
            results.memory = res
        }

        // --- Restore Conversations (only for agents present in DB) ---
        if (requestedModules.includes('conversations') && manifest.modules.conversations) {
            const res = { restored: 0, errors: [] as string[] }
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
                                'INSERT OR REPLACE INTO conversations (id, title, agent_id, ma_workspace_id, origin, pinned, last_context_tokens, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                            ).run(c.id, c.title || '', c.agent_id || null, c.ma_workspace_id || null, c.origin || 'chat', c.pinned ?? 0, c.last_context_tokens ?? null, c.config_json || null, c.created_at || Date.now(), c.updated_at || Date.now())
                            importedConversationIds.add(c.id as string)
                            res.restored++
                        } catch (e) {
                            res.errors.push(`Conversation: ${(e as Error).message}`)
                        }
                    }
                }

                // Messages (only for imported conversations)
                const msgEntry = zip.getEntry('conversations/messages.json')
                if (msgEntry) {
                    const messages = JSON.parse(msgEntry.getData().toString('utf-8')) as Record<string, unknown>[]
                    for (const m of messages) {
                        if (!importedConversationIds.has(m.conversation_id as string)) continue
                        try {
                            db.prepare(
                                `INSERT OR REPLACE INTO messages (id, conversation_id, role, content, tool_calls_json, tool_call_id, provider, model, prompt_tokens, completion_tokens, context_tokens, latency_ms, agent_id, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).run(
                                m.id, m.conversation_id, m.role, m.content,
                                m.tool_calls_json || null, m.tool_call_id || null,
                                m.provider || null, m.model || null,
                                m.prompt_tokens ?? null, m.completion_tokens ?? null,
                                m.context_tokens ?? null,
                                m.latency_ms ?? null, m.agent_id || null,
                                m.created_at || Date.now()
                            )
                        } catch (e) {
                            res.errors.push(`Message: ${(e as Error).message}`)
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
                            const targetDir = join(artifactsBaseDir, convId)
                            mkdirSync(targetDir, { recursive: true })
                            writeFileSync(targetPath, entry.getData())
                        } catch (e) {
                            res.errors.push(`Artifact file ${entry.entryName}: ${(e as Error).message}`)
                        }
                    }
                } catch (e) {
                    res.errors.push(`Artifact restoration: ${(e as Error).message}`)
                }
            } catch (e) {
                res.errors.push((e as Error).message)
            }
            results.conversations = res
        }

        // --- Restore Usage statistics (execution trace data) ---
        if (requestedModules.includes('usage') && manifest.modules.usage) {
            const res = { restored: 0, errors: [] as string[] }
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
                                `INSERT OR REPLACE INTO execution_steps (id, conversation_id, task_id, iteration, status, message, plan, tool_calls_json, results_json, evaluation_json, ma_codename, ma_agent_name, ma_phase, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).run(
                                s.id, s.conversation_id, s.task_id || null, s.iteration ?? 0,
                                s.status, s.message || null, s.plan || null,
                                s.tool_calls_json || null,
                                s.results_json || s.result_json || null,
                                s.evaluation_json || null,
                                s.ma_codename || null,
                                s.ma_agent_name || null,
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

        return manifest
    })

    // ── POST /api/backup/reset ─────────────────────────────────────────────
    app.post('/reset', async (_req, _reply) => {
        const db = getDb()
        await stopAllMemorySpaceWatchers()
        const existingCronJobs = db.prepare('SELECT id FROM cron_jobs').all() as { id: string }[]
        for (const job of existingCronJobs) {
            unscheduleCronJob(job.id)
        }

        // Clear all database tables
        const tables = [
            'messages', 'conversations', 'execution_steps', 'execution_logs',
            'tasks', 'pending_hitl', 'notifications', 'tool_approvals', 'session_tool_approvals',
            'cron_jobs', 'channels',
            'memory_file_index', 'memory_spaces', 'agent_memory_spaces',
            'mcp_servers', 'providers', 'agents',
            'settings', 'tool_router_embeddings'
        ]
        for (const table of tables) {
            try { db.prepare(`DELETE FROM ${table}`).run() } catch { /* table may not exist */ }
        }

        // Clear LanceDB (vector memory)
        const ragStore = getRAGStore()
        await ragStore.close()
        const lanceDir = join(getAppDataDir(), 'lancedb')
        if (existsSync(lanceDir)) {
            rmSync(lanceDir, { recursive: true, force: true })
        }
        await ragStore.initialize()

        // Clear conversation artifacts (generated images, file attachments, etc.)
        const artifactsDir = join(getAppDataDir(), 'artifacts')
        if (existsSync(artifactsDir)) {
            rmSync(artifactsDir, { recursive: true, force: true })
        }

        // Clear logs
        const logsDir = join(getAppDataDir(), 'logs')
        if (existsSync(logsDir)) {
            rmSync(logsDir, { recursive: true, force: true })
        }

        const memoryRoot = getMemorySpacesRootDir()
        if (existsSync(memoryRoot)) {
            rmSync(memoryRoot, { recursive: true, force: true })
        }
        ensureDefaultMemorySpace(db)
        watchMemorySpace('default', getDefaultMemorySpaceDir())

        // Reload in-memory state
        try {
            const gateway = getGateway()
            for (const id of gateway.getAllProviders().keys()) gateway.removeProvider(id)
        } catch { /* ignore */ }
        try { await loadSavedMcpServers() } catch { /* ignore */ }

        return { success: true }
    })
}
