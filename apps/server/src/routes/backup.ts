import type { FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import archiver from 'archiver'
import AdmZip from 'adm-zip'
import { getDb } from '../db/database.js'
import { getAppDataDir } from '../core/data-dir.js'
import { getGateway } from '../core/gateway/gateway.js'
import { loadSavedProviders } from './providers.js'
import { loadSavedMcpServers } from './mcp.js'
import { getChannelManager } from '../core/channels/channel-manager.js'
import { getRAGStore } from '../core/memory/rag.js'
import { getAgentMemory } from '../core/memory/agent-memory.js'
import { getMemoryParser } from '../core/memory/parser.js'
import { getEmbeddingProvider } from '../core/memory/embedding.js'
import { join } from 'path'
import {
    existsSync,
    readdirSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
    statSync,
    rmSync
} from 'fs'
import type { LLMProviderConfig } from '../core/gateway/providers/base.provider.js'
import { nanoid } from 'nanoid'

interface ManifestModule {
    count: number
}

interface BackupManifest {
    version: 1
    createdAt: string
    modules: Record<string, ManifestModule>
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
    await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } })

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
                const agentsDir = join(getAppDataDir(), 'agents')
                let count = 0
                if (existsSync(agentsDir)) {
                    const dirs = readdirSync(agentsDir, { withFileTypes: true }).filter(
                        (d) => d.isDirectory()
                    )
                    for (const dir of dirs) {
                        const agentPath = join(agentsDir, dir.name)
                        const files = readdirSync(agentPath)
                        for (const file of files) {
                            const filePath = join(agentPath, file)
                            if (statSync(filePath).isFile()) {
                                archive.file(filePath, { name: `agents/${dir.name}/${file}` })
                            }
                        }
                        count++
                    }
                }
                // Also export agent rows from DB (contain provider_id, model, tools, etc.)
                const db = getDb()
                const agentRows = db.prepare('SELECT * FROM agents ORDER BY created_at').all()
                archive.append(JSON.stringify(agentRows, null, 2), {
                    name: 'agents/_db_agents.json'
                })
                manifest.modules.agents = { count }
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
                const spaces = db.prepare('SELECT * FROM memory_spaces ORDER BY created_at').all()
                const assignments = db.prepare('SELECT * FROM agent_memory_spaces').all()

                // Export chunk texts from LanceDB (no vectors — they're re-embedded on import)
                const ragStore = getRAGStore()
                const { chunkOverlap } = getMemoryParser().getConfig()
                const allDocs = await ragStore.listDocuments('permanent_memory')

                // Group chunks by (spaceId, sourceFile), sort by chunkIndex
                type DocGroup = { spaceId: string; sourceFile: string; chunks: string[] }
                const groupMap = new Map<string, { meta: DocGroup; indexed: { idx: number; text: string }[] }>()
                for (const doc of allDocs) {
                    if (!doc.sourceFile) continue
                    const key = `${doc.spaceId || ''}||${doc.sourceFile}`
                    if (!groupMap.has(key)) {
                        groupMap.set(key, {
                            meta: { spaceId: doc.spaceId || '', sourceFile: doc.sourceFile, chunks: [] },
                            indexed: []
                        })
                    }
                    groupMap.get(key)!.indexed.push({ idx: doc.chunkIndex ?? 0, text: doc.text })
                }
                const documents: DocGroup[] = []
                for (const { meta, indexed } of groupMap.values()) {
                    meta.chunks = indexed.sort((a, b) => a.idx - b.idx).map(c => c.text)
                    documents.push(meta)
                }

                archive.append(JSON.stringify({ spaces, assignments }, null, 2), { name: 'memory/spaces.json' })
                archive.append(JSON.stringify({ chunkOverlap, documents }, null, 2), { name: 'memory/documents.json' })
                manifest.modules.memory = { count: documents.length }
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
            const filename = `openagent-backup-${new Date().toISOString().slice(0, 10)}.zip`

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
                // Restore DB rows first
                const dbEntry = zip.getEntry('agents/_db_agents.json')
                if (dbEntry) {
                    const agentRows = JSON.parse(
                        dbEntry.getData().toString('utf-8')
                    ) as Record<string, unknown>[]
                    for (const row of agentRows) {
                        try {
                            db.prepare(
                                `INSERT OR REPLACE INTO agents (id, name, description, provider_id, model, system_prompt, tools_json, temperature, memory_enabled, icon_url, codename, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).run(
                                row.id,
                                row.name,
                                row.description || '',
                                row.provider_id || null,
                                row.model || '',
                                row.system_prompt || '',
                                row.tools_json || '[]',
                                row.temperature ?? null,
                                row.memory_enabled ?? 1,
                                row.icon_url || null,
                                row.codename || '',
                                row.created_at || Date.now(),
                                row.updated_at || Date.now()
                            )
                        } catch (e) {
                            res.errors.push(`Agent DB row ${row.id}: ${(e as Error).message}`)
                        }
                    }
                }

                // Restore agent files
                const agentsDir = join(getAppDataDir(), 'agents')
                const agentEntries = zip.getEntries().filter(
                    (e) =>
                        e.entryName.startsWith('agents/') &&
                        !e.isDirectory &&
                        e.entryName !== 'agents/_db_agents.json'
                )
                for (const entry of agentEntries) {
                    const relative = entry.entryName.slice('agents/'.length) // e.g. "abc123/agent.json"
                    const targetPath = join(agentsDir, relative)
                    const targetDir = join(targetPath, '..')
                    mkdirSync(targetDir, { recursive: true })
                    writeFileSync(targetPath, entry.getData())
                }
                res.restored = manifest.modules.agents.count
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
                                `INSERT OR REPLACE INTO mcp_servers (id, name, command, args_json, env_json, enabled, icon_url, origin, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).run(
                                srv.id,
                                srv.name,
                                srv.command,
                                srv.args_json || '[]',
                                srv.env_json || '{}',
                                srv.enabled ?? 1,
                                srv.icon_url || null,
                                srv.origin || null,
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
                            db.prepare(
                                `INSERT OR REPLACE INTO cron_jobs (id, name, agent_id, schedule, prompt, enabled, one_off, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).run(
                                job.id,
                                job.name || '',
                                job.agent_id,
                                job.schedule,
                                job.prompt || '',
                                job.enabled ?? 1,
                                job.one_off ?? 0,
                                job.created_at || Date.now(),
                                job.updated_at || Date.now()
                            )
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
                // Reset LanceDB to avoid stale index references from previous state
                const ragStore = getRAGStore()
                await ragStore.close()
                const lanceDir = join(getAppDataDir(), 'lancedb')
                if (existsSync(lanceDir)) {
                    rmSync(lanceDir, { recursive: true, force: true })
                }
                await ragStore.initialize()

                // Restore space metadata and assignments
                const spacesEntry = zip.getEntry('memory/spaces.json')
                if (spacesEntry) {
                    const { spaces, assignments } = JSON.parse(spacesEntry.getData().toString('utf-8')) as {
                        spaces: Record<string, unknown>[]
                        assignments: Record<string, unknown>[]
                    }
                    for (const sp of spaces) {
                        db.prepare('INSERT OR REPLACE INTO memory_spaces (id, name, description, created_at) VALUES (?, ?, ?, ?)')
                            .run(sp.id, sp.name, sp.description || '', sp.created_at || Date.now())
                    }
                    for (const asg of assignments) {
                        db.prepare('INSERT OR IGNORE INTO agent_memory_spaces (agent_id, space_id) VALUES (?, ?)')
                            .run(asg.agent_id, asg.space_id)
                    }
                }

                // Re-embed and restore document chunks
                const docsEntry = zip.getEntry('memory/documents.json')
                if (docsEntry) {
                    const { chunkOverlap, documents } = JSON.parse(docsEntry.getData().toString('utf-8')) as {
                        chunkOverlap: number
                        documents: Array<{ spaceId: string; agentId?: string; sourceFile: string; chunks: string[] }>
                    }
                    const mem = getAgentMemory()
                    const overlap = chunkOverlap ?? 64
                    for (const doc of documents) {
                        if (!doc.chunks?.length) continue
                        try {
                            // Reconstruct full text by stripping per-chunk overlap
                            let fullText = doc.chunks[0]
                            for (let i = 1; i < doc.chunks.length; i++) {
                                const chunk = doc.chunks[i]
                                fullText += chunk.length > overlap ? chunk.slice(overlap) : (' ' + chunk)
                            }
                            await mem.store(fullText, doc.sourceFile || undefined, doc.spaceId || undefined)
                            res.restored++
                        } catch (e) {
                            res.errors.push(`Document "${doc.sourceFile}": ${(e as Error).message}`)
                        }
                    }
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
                                `INSERT OR REPLACE INTO tasks (id, conversation_id, status, definition_json, result_json, iterations, created_at, completed_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                            ).run(
                                t.id, t.conversation_id || null, t.status || 'completed',
                                t.definition_json || '{}', t.result_json || null,
                                t.iterations ?? 0, t.created_at || Date.now(), t.completed_at || null
                            )
                        } catch (e) {
                            res.errors.push(`Task: ${(e as Error).message}`)
                        }
                    }
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
                                `INSERT OR REPLACE INTO execution_steps (id, conversation_id, task_id, iteration, status, message, plan, tool_calls_json, result_json, tokens_used, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).run(
                                s.id, s.conversation_id, s.task_id || null, s.iteration ?? 0,
                                s.status, s.message || null, s.plan || null,
                                s.tool_calls_json || null, s.result_json || null,
                                s.tokens_used ?? null, s.created_at || Date.now()
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
    app.post('/reset', async (_req, reply) => {
        const db = getDb()

        // Clear all database tables
        const tables = [
            'messages', 'conversations', 'execution_steps', 'execution_logs',
            'tasks', 'pending_hitl', 'notifications', 'tool_approvals',
            'cron_jobs', 'channels', 'file_watchers',
            'memory_spaces', 'agent_memory_spaces',
            'mcp_servers', 'providers', 'agents',
            'settings'
        ]
        for (const table of tables) {
            try { db.prepare(`DELETE FROM ${table}`).run() } catch { /* table may not exist */ }
        }

        // Remove agent files on disk
        const agentsDir = join(getAppDataDir(), 'agents')
        if (existsSync(agentsDir)) {
            rmSync(agentsDir, { recursive: true, force: true })
            mkdirSync(agentsDir, { recursive: true })
        }

        // Clear LanceDB (vector memory)
        const ragStore = getRAGStore()
        await ragStore.close()
        const lanceDir = join(getAppDataDir(), 'lancedb')
        if (existsSync(lanceDir)) {
            rmSync(lanceDir, { recursive: true, force: true })
        }
        await ragStore.initialize()

        // Clear MCP images
        const mcpImagesDir = join(getAppDataDir(), 'mcp-images')
        if (existsSync(mcpImagesDir)) {
            rmSync(mcpImagesDir, { recursive: true, force: true })
        }

        // Clear logs
        const logsDir = join(getAppDataDir(), 'logs')
        if (existsSync(logsDir)) {
            rmSync(logsDir, { recursive: true, force: true })
        }

        // Reload in-memory state
        try {
            const gateway = getGateway()
            for (const id of gateway.getAllProviders().keys()) gateway.removeProvider(id)
        } catch { /* ignore */ }
        try { await loadSavedMcpServers() } catch { /* ignore */ }

        return { success: true }
    })
}
