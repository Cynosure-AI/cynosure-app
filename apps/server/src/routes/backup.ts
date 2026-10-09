import type { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import type { ContentBlock } from '@shared/types'
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
import { loadEmbeddingServiceFromDb } from '../core/memory/embedding.js'
import { basename, dirname, join } from 'path'
import {
    existsSync,
    mkdirSync,
    rmSync
} from 'fs'
import type { LLMProviderConfig } from '../core/gateway/providers/base.provider.js'
import { ensureFolder, listFilesInFolder } from '../core/memory/memory-file-manager.js'
import { directoryPathForRelative, folderPathForDirectory, validateRelativePath } from '../core/memory/memory-folder-directories.js'
import { stopAllMemoryFolderWatchers, watchMemoryFolder } from '../core/memory/memory-folder-watcher.js'
import { scheduleCronJob, unscheduleCronJob } from '../core/triggers/cron-scheduler.js'
import { dropConversationAttachmentIndex, indexConversationAttachment } from '../core/artifacts/attachment-rag.js'
import type { FileAttachmentArtifact } from '../core/artifacts/file-artifacts.js'
import { DEFAULT_PERMANENT_MEMORY_TABLE, setActivePermanentMemoryTableName } from '../core/memory/memory-index-manifest.js'
import { invalidateDreamConversation } from '../core/memory/dream-worker.js'

type BroadcastFn = (event: string, data: unknown) => void

type ResetModule =
    | 'agents'
    | 'providers'
    | 'mcp'
    | 'settings'
    | 'channels'
    | 'memory'
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
    'conversations',
    'notifications',
    'usage',
    'vectors'
]

const BACKUP_MODULES = ['agents', 'providers', 'mcp', 'settings', 'channels', 'memory', 'conversations', 'usage']

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
    /** Non-fatal problems found while exporting, e.g. attachment files missing from disk. */
    warnings?: string[]
    /** Attachment assets left out because their files were missing; restore reports these as warnings, not errors. */
    skippedAttachmentAssetIds?: string[]
}

interface ModuleResult {
    restored: number
    errors: string[]
    warnings?: string[]
}

interface MemoryFileBackup {
    folderId: string
    fileName: string
    archiveName: string
}

type Row = Record<string, unknown>

interface RestoreContext {
    agentIds: Set<string>
    conversationIds: Set<string>
    messageIds: Set<string>
}

/**
 * A table archived as `<module>/<table>.json`. Columns come from the live
 * schema on export, and restore keeps only the archived fields that are still
 * columns, so schema changes need no edits here.
 */
interface BackupTable {
    table: string
    file?: string
    /** Columns that are neither exported nor restored. */
    omit?: string[]
    orderBy?: string
    /** Supporting tables are not counted in the module total. */
    counted?: false
    /** Adjust an archived row before insert, or return null to skip it. */
    prepare?: (row: Row, ctx: RestoreContext) => Row | null
    /** Runs for each row after it was inserted. */
    restored?: (row: Row, ctx: RestoreContext) => void
}

const inRestoredConversation = (row: Row, ctx: RestoreContext): Row | null =>
    ctx.conversationIds.has(String(row.conversation_id)) ? row : null

/**
 * Tables backed up generically, in restore order. Providers, settings, tool
 * approvals, memory and attachment files have their own formats and are
 * handled by the export and import routes directly.
 */
const BACKUP_TABLES: Record<string, BackupTable[]> = {
    agents: [{
        table: 'agents',
        file: 'agents/_db_agents.json',
        // Icons are archived separately as data URLs.
        omit: ['icon_data'],
        // Older backups named the internal name `codename`.
        prepare: (row) => ({ ...row, internal_name: row.internal_name ?? row.codename }),
    }],
    mcp: [{
        table: 'mcp_servers',
        file: 'mcp/servers.json',
        prepare: (row) => ({ ...row, original_name: row.original_name || row.name }),
    }],
    settings: [{
        table: 'cron_jobs',
        prepare: (job) => {
            if (job.id) unscheduleCronJob(String(job.id))
            return {
                ...job,
                notification_mode: job.notification_mode === 'conditional' ? 'conditional' : 'always',
                last_run_at: typeof job.last_run_at === 'number' ? job.last_run_at : Date.now(),
            }
        },
        restored: (job) => {
            if ((job.enabled ?? 1) === 1 && job.id) scheduleCronJob(String(job.id))
        },
    }],
    channels: [{ table: 'channels' }],
    conversations: [
        // Projects restore first so restored conversations keep their project link.
        { table: 'projects', counted: false },
        { table: 'project_tasks', counted: false },
        { table: 'project_brief_revisions', counted: false },
        { table: 'project_events', counted: false },
        {
            table: 'conversations',
            // Only restore conversations for agents present in the DB, including freshly restored ones.
            prepare: (row, ctx) => (row.agent_id && !ctx.agentIds.has(String(row.agent_id)) ? null : row),
            restored: (row, ctx) => {
                ctx.conversationIds.add(String(row.id))
                getDb().prepare('DELETE FROM chat_events WHERE conversation_id = ?').run(row.id)
            },
        },
        {
            table: 'messages',
            counted: false,
            prepare: inRestoredConversation,
            restored: (row, ctx) => {
                ctx.messageIds.add(String(row.id))
                // Restored history must not become new Dreaming Mode work.
                getDb().prepare('DELETE FROM dream_message_events WHERE message_id = ?').run(row.id)
            },
        },
        // Canonical replay history. Sequences are reassigned locally, keeping the archived order.
        { table: 'chat_events', orderBy: 'sequence', omit: ['sequence'], counted: false, prepare: inRestoredConversation },
        { table: 'subagent_sessions', counted: false, prepare: inRestoredConversation },
        {
            table: 'message_attachments',
            counted: false,
            prepare: (row, ctx) => (ctx.messageIds.has(String(row.message_id)) ? { ...row, asset_id: row.asset_id || row.id } : null),
        },
        {
            table: 'tasks',
            counted: false,
            prepare: (row, ctx) => (!row.conversation_id || ctx.conversationIds.has(String(row.conversation_id)) ? row : null),
        },
    ],
    usage: [{ table: 'execution_logs' }, { table: 'auxiliary_model_usage' }],
}

const archiveFile = (module: string, spec: BackupTable): string => spec.file ?? `${module}/${spec.table}.json`

// File index bookkeeping is rebuilt when the restored files are re-indexed.
const MEMORY_INDEX_STATE = ['content_hash', 'chunk_count', 'last_indexed_at']

// ────────────────────────────────────────────────────────────────────────────
//  Generic table copy
// ────────────────────────────────────────────────────────────────────────────

interface ColumnInfo {
    name: string
    notnull: number
    dflt_value: string | null
    pk: number
}

function tableColumns(table: string): ColumnInfo[] {
    return getDb().pragma(`table_info(${table})`) as ColumnInfo[]
}

function exportRows(table: string, options: { omit?: string[]; where?: string; orderBy?: string } = {}): Row[] {
    const columns = tableColumns(table).map((column) => column.name)
    const selected = columns.filter((name) => !options.omit?.includes(name))
    const orderBy = options.orderBy ?? (columns.includes('created_at') ? 'created_at' : '')
    return getDb().prepare(`
        SELECT ${selected.join(', ')} FROM ${table}
        ${options.where ? `WHERE ${options.where}` : ''}
        ${orderBy ? `ORDER BY ${orderBy}` : ''}
    `).all() as Row[]
}

/**
 * INSERT OR REPLACE archived rows into a table. Fields that are no longer
 * columns are dropped, missing or null values fall back to the column
 * default, and missing timestamps are set to now.
 */
function insertRows(table: string, rows: Row[], omit: string[] = []): { restored: Row[]; errors: string[] } {
    const db = getDb()
    const columns = tableColumns(table).filter((column) => !omit.includes(column.name))
    const keyColumn = columns.find((column) => column.pk === 1)?.name
    const statements = new Map<string, Database.Statement>()
    const restored: Row[] = []
    const errors: string[] = []
    const now = Date.now()

    db.transaction(() => {
        for (const row of rows) {
            const names: string[] = []
            const values: unknown[] = []
            for (const column of columns) {
                let value = row[column.name]
                if (typeof value === 'boolean') value = value ? 1 : 0
                if (value === undefined || (value === null && column.notnull)) {
                    if (column.notnull && column.dflt_value === null && (column.name === 'created_at' || column.name === 'updated_at')) {
                        value = now
                    } else {
                        continue
                    }
                }
                names.push(column.name)
                values.push(value)
            }

            const key = names.join(',')
            let statement = statements.get(key)
            if (!statement) {
                statement = db.prepare(`INSERT OR REPLACE INTO ${table} (${key}) VALUES (${names.map(() => '?').join(', ')})`)
                statements.set(key, statement)
            }
            try {
                statement.run(...values)
                restored.push(row)
            } catch (e) {
                errors.push(`${table} ${keyColumn ? String(row[keyColumn] ?? '') : ''}: ${(e as Error).message}`)
            }
        }
    })()

    return { restored, errors }
}

function readArchiveJson<T>(zip: AdmZip, name: string): T | null {
    const entry = zip.getEntry(name)
    return entry ? JSON.parse(entry.getData().toString('utf-8')) as T : null
}

function addResult(res: ModuleResult, { restored, errors }: { restored: Row[]; errors: string[] }): void {
    res.restored += restored.length
    res.errors.push(...errors)
}

/** Export every generic table of a module and return the rows by table. */
function exportTables(archive: archiver.Archiver, module: string, manifest: BackupManifest): Record<string, Row[]> {
    const exported: Record<string, Row[]> = {}
    let count = 0
    for (const spec of BACKUP_TABLES[module] ?? []) {
        const rows = exportRows(spec.table, spec)
        archive.append(JSON.stringify(rows, null, 2), { name: archiveFile(module, spec) })
        exported[spec.table] = rows
        if (spec.counted !== false) count += rows.length
    }
    manifest.modules[module] = { count }
    return exported
}

/** Restore every generic table of a module that is present in the archive. */
function restoreTables(zip: AdmZip, module: string, ctx: RestoreContext, res: ModuleResult): void {
    for (const spec of BACKUP_TABLES[module] ?? []) {
        const archived = readArchiveJson<Row[]>(zip, archiveFile(module, spec))
        if (!archived) continue
        const rows = spec.prepare
            ? archived.map((row) => spec.prepare!(row, ctx)).filter((row): row is Row => row !== null)
            : archived
        const result = insertRows(spec.table, rows, spec.omit)
        for (const row of result.restored) spec.restored?.(row, ctx)
        if (spec.counted !== false) res.restored += result.restored.length
        res.errors.push(...result.errors)
    }
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

function relativePathFromBackupCategory(category: Row): string {
    if (typeof category.folderPath !== 'string') throw new Error('Memory folder path is missing from backup.')
    return validateRelativePath(category.folderPath)
}

function portableRelativePathForFolder(directoryPath: string): string {
    return validateRelativePath(folderPathForDirectory(directoryPath))
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

async function resetConversations(db = getDb()): Promise<void> {
    const conversationIds = db.prepare('SELECT id FROM conversations').all() as Array<{ id: string }>
    for (const { id } of conversationIds) await invalidateDreamConversation(id)
    db.prepare('DELETE FROM pending_hitl').run()
    db.prepare('DELETE FROM session_tool_approvals').run()
    db.prepare('DELETE FROM tasks').run()
    db.prepare('DELETE FROM dream_runs').run()
    db.prepare('DELETE FROM chat_events').run()
    db.prepare('DELETE FROM messages').run()
    db.prepare('DELETE FROM conversations').run()
    db.prepare('DELETE FROM project_events').run()
    db.prepare('DELETE FROM project_brief_revisions').run()
    db.prepare('DELETE FROM project_tasks').run()
    db.prepare('DELETE FROM projects').run()
    await dropConversationAttachmentIndex()

    const artifactsDir = join(getAppDataDir(), 'artifacts')
    if (existsSync(artifactsDir)) {
        rmSync(artifactsDir, { recursive: true, force: true })
    }
}

function resetUsage(db = getDb()): void {
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
//  Restore helpers
// ────────────────────────────────────────────────────────────────────────────

async function restoreMemory(zip: AdmZip, res: ModuleResult): Promise<void> {
    const db = getDb()
    await stopAllMemoryFolderWatchers()

    // Reset LanceDB to avoid stale index references from previous state
    const ragStore = getRAGStore()
    await ragStore.close()
    const lanceDir = join(getAppDataDir(), 'lancedb')
    if (existsSync(lanceDir)) {
        rmSync(lanceDir, { recursive: true, force: true })
    }
    await ragStore.initialize()

    db.prepare('DELETE FROM memory_file_index').run()
    db.prepare('DELETE FROM memory_document_revisions').run()
    db.prepare('DELETE FROM memory_documents').run()
    db.prepare('DELETE FROM agent_memory_folders').run()
    db.prepare('DELETE FROM memory_folders').run()

    const memoryRoot = getMemoryFoldersRootDir()
    if (existsSync(memoryRoot)) {
        rmSync(memoryRoot, { recursive: true, force: true })
    }
    ensureFolder(memoryRoot)

    // Restore current category and document state. Historical revisions
    // in older backups are intentionally ignored.
    const metadata = readArchiveJson<{
        categories: Row[]
        assignments: Row[]
        fileIndex?: Row[]
        documents?: Row[]
    }>(zip, 'memory/categories.json')
    if (!metadata) throw new Error('Backup does not contain categorized memory metadata.')

    const folderIdMap = new Map<string, string>()
    const mapFolder = (id: unknown): string => folderIdMap.get(String(id || '')) || String(id || '')
    const folders: Row[] = []
    for (const folder of metadata.categories) {
        const importedId = String(folder.id || '')
        if (!importedId) continue
        const isUncategorized = folder.is_uncategorized === 1 || folder.is_uncategorized === true || importedId === 'uncategorized'
        const id = isUncategorized ? 'uncategorized' : importedId
        folderIdMap.set(importedId, id)
        const directoryPath = isUncategorized ? getDefaultMemoryFolderDir() : directoryPathForRelative(relativePathFromBackupCategory(folder))
        ensureFolder(directoryPath)
        folders.push({ ...folder, id, directory_path: directoryPath, is_uncategorized: isUncategorized ? 1 : 0 })
    }
    res.errors.push(...insertRows('memory_folders', folders).errors)
    ensureDefaultMemoryFolder(db)
    res.errors.push(...insertRows('agent_memory_folders', metadata.assignments.map((row) => ({ ...row, category_id: mapFolder(row.category_id) }))).errors)
    res.errors.push(...insertRows('memory_file_index', (metadata.fileIndex ?? []).map((row) => ({ ...row, category_id: mapFolder(row.category_id) })), MEMORY_INDEX_STATE).errors)
    res.errors.push(...insertRows('memory_documents', (metadata.documents ?? [])
        .filter((row) => row.status !== 'deleted')
        .map((row) => ({ ...row, category_id: mapFolder(row.category_id) }))).errors)

    // Restore source files only. Files are the source of truth for
    // file-backed memory; vectors should be rebuilt on the target
    // machine by re-indexing with its local embedding configuration.
    const { files } = readArchiveJson<{ files: MemoryFileBackup[] }>(zip, 'memory/files.json') ?? { files: [] }
    for (const file of files || []) {
        try {
            const safeFileName = basename(file.fileName)
            if (!file.folderId || !safeFileName || safeFileName !== file.fileName) {
                throw new Error('Invalid memory file name')
            }
            const targetFolderId = mapFolder(file.folderId)

            const category = db.prepare('SELECT directory_path FROM memory_folders WHERE id = ?')
                .get(targetFolderId) as { directory_path: string } | undefined
            if (!category?.directory_path) throw new Error(`Memory folder "${targetFolderId}" not found`)

            const entry = zip.getEntry(file.archiveName)
            if (!entry || entry.isDirectory) throw new Error('File content missing from backup')

            ensureFolder(category.directory_path)
            writeFileSync(join(category.directory_path, safeFileName), entry.getData())
            res.restored++
        } catch (e) {
            res.errors.push(`File "${file.fileName}": ${(e as Error).message}`)
        }
    }

    const restoredCategories = db.prepare('SELECT id, directory_path FROM memory_folders WHERE directory_path != ?').all('') as {
        id: string
        directory_path: string
    }[]
    for (const category of restoredCategories) {
        watchMemoryFolder(category.id, category.directory_path)
    }
}

function restoreArtifactFiles(zip: AdmZip, conversationIds: Set<string>, res: ModuleResult): void {
    const artifactsBaseDir = join(getAppDataDir(), 'artifacts', 'conversations')
    for (const entry of zip.getEntries()) {
        // Match entries like: conversations/artifacts/{convId}/{relative/path/to/file}
        const match = entry.entryName.match(/^conversations\/artifacts\/([^/]+)\/(.+)$/)
        if (!match || entry.isDirectory || !conversationIds.has(match[1])) continue
        try {
            const targetPath = join(artifactsBaseDir, match[1], match[2])
            mkdirSync(dirname(targetPath), { recursive: true })
            writeFileSync(targetPath, entry.getData())
        } catch (e) {
            res.errors.push(`Artifact file ${entry.entryName}: ${(e as Error).message}`)
        }
    }
}

/**
 * Re-home absolute media URLs to this installation's data directory.
 * Backup archives retain filenames, while the old absolute prefix may
 * belong to another OS, user account, or CYNOSURE_DATA_DIR.
 */
function rehomeMediaUrls(conversationIds: Set<string>): void {
    const db = getDb()
    const ids = Array.from(conversationIds)
    const placeholders = ids.map(() => '?').join(',') || "''"
    const artifactsBaseDir = join(getAppDataDir(), 'artifacts', 'conversations')
    const rehomeMediaUrl = (url: string, conversationId: string, kind?: string): string => {
        const oldPath = extractFilePathFromFileUrl(url)
        if (!oldPath) return url
        const directory = kind === 'image' ? 'images' : kind === 'video' ? 'videos' : kind === 'audio' ? 'audio'
            : /[\\/]images[\\/]/.test(oldPath) ? 'images' : /[\\/]videos[\\/]/.test(oldPath) ? 'videos'
                : /[\\/]audio[\\/]/.test(oldPath) ? 'audio' : null
        if (!directory) return url
        const targetPath = join(artifactsBaseDir, conversationId, directory, basename(oldPath))
        return existsSync(targetPath) ? toFileUrl(targetPath) : url
    }
    const rehomeBlocks = (json: string | null, conversationId: string): string | null => {
        if (!json) return null
        try {
            const blocks = JSON.parse(json) as ContentBlock[]
            return JSON.stringify(blocks.map((block) => {
                if (block.type !== 'image' && block.type !== 'video' && block.type !== 'audio') return block
                const url = rehomeMediaUrl(block.url, conversationId, block.type)
                return { ...block, artifactId: url, url }
            }))
        } catch {
            return json
        }
    }
    const rehomeEventValue = (value: unknown, conversationId: string): unknown => {
        if (Array.isArray(value)) return value.map(item => rehomeEventValue(item, conversationId))
        if (value && typeof value === 'object') {
            const mapped: Record<string, unknown> = {}
            for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
                mapped[key] = key === 'url' && typeof item === 'string'
                    ? rehomeMediaUrl(item, conversationId)
                    : rehomeEventValue(item, conversationId)
            }
            if (typeof mapped.url === 'string' && typeof mapped.artifactId === 'string') mapped.artifactId = mapped.url
            return mapped
        }
        return value
    }

    const messages = db.prepare(`SELECT id, conversation_id, content_blocks_json FROM messages WHERE conversation_id IN (${placeholders})`)
        .all(...ids) as { id: string; conversation_id: string; content_blocks_json: string | null }[]
    const updateMessage = db.prepare('UPDATE messages SET content_blocks_json = ? WHERE id = ?')
    for (const row of messages) {
        updateMessage.run(rehomeBlocks(row.content_blocks_json, row.conversation_id), row.id)
    }
    const events = db.prepare(`SELECT sequence, conversation_id, event_json FROM chat_events WHERE conversation_id IN (${placeholders})`)
        .all(...ids) as Array<{ sequence: number; conversation_id: string; event_json: string }>
    const updateEvent = db.prepare('UPDATE chat_events SET event_json = ? WHERE sequence = ?')
    for (const row of events) {
        updateEvent.run(JSON.stringify(rehomeEventValue(JSON.parse(row.event_json), row.conversation_id)), row.sequence)
    }
}

/** Restore attachment asset files, re-home their paths, and rebuild conversation-scoped vectors. */
async function restoreAttachments(
    zip: AdmZip,
    conversationIds: Set<string>,
    skippedAssetIds: Set<string>,
    res: ModuleResult,
): Promise<void> {
    const db = getDb()
    const ids = Array.from(conversationIds)
    const placeholders = ids.map(() => '?').join(',') || "''"
    const appDataDir = getAppDataDir()
    const artifactsBaseDir = join(appDataDir, 'artifacts', 'conversations')
    const archivedAssets = readArchiveJson<Row[]>(zip, 'conversations/attachment_assets.json') ?? []
    const importedAssetIds = new Set(
        (db.prepare(`SELECT DISTINCT asset_id FROM message_attachments WHERE conversation_id IN (${placeholders})`)
            .all(...ids) as Array<{ asset_id: string | null }>)
            .map(row => row.asset_id).filter((id): id is string => Boolean(id))
    )
    for (const asset of archivedAssets) {
        const id = asset.id
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id) || !importedAssetIds.has(id)) continue
        const original = zip.getEntry(`conversations/attachment-assets/${id}/original`)
        const text = zip.getEntry(`conversations/attachment-assets/${id}/text`)
        if (!original || !text) {
            res.errors.push(`Attachment asset ${id}: missing file in backup`)
            continue
        }
        const assetDir = join(appDataDir, 'artifacts', 'attachment-assets')
        mkdirSync(assetDir, { recursive: true })
        const originalPath = join(assetDir, basename(String(asset.original_path || id)))
        const textPath = join(assetDir, basename(String(asset.text_path || `${id}.parsed.md`)))
        writeFileSync(originalPath, original.getData())
        writeFileSync(textPath, text.getData())
        res.errors.push(...insertRows('attachment_assets', [{ ...asset, original_path: originalPath, text_path: textPath }]).errors)
        db.prepare(`UPDATE message_attachments SET original_path = ?, text_path = ? WHERE asset_id = ? AND conversation_id IN (${placeholders})`)
            .run(originalPath, textPath, id, ...ids)
    }

    const rows = db.prepare(`
        SELECT id, asset_id, conversation_id, name, original_path, text_path, size_bytes, text_bytes, chunk_count
        FROM message_attachments
        WHERE conversation_id IN (${placeholders}) AND kind = 'file'
    `).all(...ids) as {
        id: string
        asset_id: string | null
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
        const restoredAsset = archivedAssets.some(asset => asset.id === row.asset_id)
        const originalPath = restoredAsset ? row.original_path : join(artifactsBaseDir, row.conversation_id, 'files', basename(row.original_path))
        const textPath = restoredAsset ? row.text_path : join(artifactsBaseDir, row.conversation_id, 'files', basename(row.text_path))
        if (!existsSync(originalPath) || !existsSync(textPath)) {
            if (row.asset_id && skippedAssetIds.has(row.asset_id)) {
                (res.warnings ??= []).push(`Attachment "${row.name}" was not restored: its file was already missing when the backup was created`)
            } else {
                res.errors.push(`Attachment ${row.id}: missing file in backup`)
            }
            continue
        }
        const attachment: FileAttachmentArtifact = {
            id: row.id,
            assetId: row.asset_id || row.id,
            name: row.name,
            originalPath,
            textPath,
            sizeBytes: row.size_bytes ?? 0,
            textBytes: row.text_bytes ?? 0,
            chunkCount: row.chunk_count ?? undefined,
        }
        const chunkCount = await indexConversationAttachment(row.conversation_id, attachment)
        const metadataJson = JSON.stringify({ ...attachment, chunkCount })
        res.errors.push(...insertRows('attachment_assets', [{
            id: attachment.assetId,
            name: row.name,
            original_path: originalPath,
            text_path: textPath,
            size_bytes: attachment.sizeBytes,
            text_bytes: attachment.textBytes,
            chunk_count: chunkCount,
            metadata_json: metadataJson,
            created_at: Date.now(),
        }]).errors)
        db.prepare(`
            UPDATE message_attachments
            SET original_path = ?, text_path = ?, chunk_count = ?, metadata_json = ?
            WHERE id = ?
        `).run(originalPath, textPath, chunkCount, metadataJson, row.id)
    }
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
        const auxiliaryModelUsage = count('auxiliary_model_usage')

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
            conversations: {
                count: conversations,
                details: { conversations, messages, attachments, tasks }
            },
            usage: {
                count: executionLogs + auxiliaryModelUsage,
                details: { runs: executionLogs, auxiliaryModelUsage, chatMessages: messages }
            }
        }

        return { modules }
    })


    // ── GET /api/backup/export?modules=agents,providers,mcp,settings ────────
    app.get<{ Querystring: { modules?: string } }>(
        '/export',
        async (req, reply) => {
            const requested = (req.query.modules || BACKUP_MODULES.join(','))
                .split(',')
                .map((m) => m.trim())
                .filter((m) => BACKUP_MODULES.includes(m))

            const manifest: BackupManifest = {
                version: 1,
                createdAt: new Date().toISOString(),
                modules: {}
            }

            const warnings: string[] = []
            const skippedAttachmentAssetIds: string[] = []
            const archive = archiver('zip', { zlib: { level: 5 } })
            const chunks: Buffer[] = []

            archive.on('data', (chunk: Buffer) => chunks.push(chunk))
            const archiveFinished = new Promise<void>((resolve, reject) => {
                archive.on('end', resolve)
                archive.on('error', reject)
            })

            for (const module of requested) {
                const exported = exportTables(archive, module, manifest)
                const db = getDb()

                if (module === 'agents') {
                    // Export icon BLOBs as base64 data URLs alongside the rows
                    const agentIcons: Record<string, string> = {}
                    const iconRows = db.prepare('SELECT id, icon_data, icon_mime FROM agents WHERE icon_data IS NOT NULL').all() as {
                        id: string; icon_data: Buffer; icon_mime: string
                    }[]
                    for (const row of iconRows) {
                        agentIcons[row.id] = `data:${row.icon_mime};base64,${row.icon_data.toString('base64')}`
                    }
                    if (iconRows.length > 0) {
                        archive.append(JSON.stringify(agentIcons, null, 2), { name: 'agents/_db_agent_icons.json' })
                    }
                }

                if (module === 'providers') {
                    const providers = getProviderRows()
                    archive.append(JSON.stringify(providers, null, 2), { name: 'providers/providers.json' })
                    manifest.modules.providers.count = providers.length
                }

                if (module === 'settings') {
                    const settings = getSettingsRows()
                    const approvals = getToolApprovalRows()
                    archive.append(JSON.stringify(settings, null, 2), { name: 'settings/settings.json' })
                    archive.append(JSON.stringify(approvals, null, 2), { name: 'settings/tool_approvals.json' })
                    manifest.modules.settings.count += Object.keys(settings).length + approvals.length
                }

                // --- Categorized, revisional memory ---
                if (module === 'memory') {
                    const categories = exportRows('memory_folders').map((category): Row => {
                        const directoryPath = typeof category.directory_path === 'string' ? category.directory_path : ''
                        const isUncategorized = category.is_uncategorized === 1 || category.is_uncategorized === true
                        return {
                            ...category,
                            folderPath: isUncategorized || !directoryPath ? '' : portableRelativePathForFolder(directoryPath),
                        }
                    })
                    const assignments = exportRows('agent_memory_folders')
                    const fileIndex = exportRows('memory_file_index', { omit: MEMORY_INDEX_STATE })
                    const documents = exportRows('memory_documents', { where: "status = 'active'" })
                    const files: MemoryFileBackup[] = []

                    for (const category of categories) {
                        const folderId = String(category.id || '')
                        const directoryPath = typeof category.directory_path === 'string' ? category.directory_path : ''
                        if (!folderId || !directoryPath) continue

                        for (const file of listFilesInFolder(directoryPath).filter(f => f.supported)) {
                            const archiveName = `memory/files/${encodeURIComponent(folderId)}/${encodeURIComponent(file.fileName)}`
                            archive.file(file.filePath, { name: archiveName })
                            files.push({ folderId, fileName: file.fileName, archiveName })
                        }
                    }

                    archive.append(JSON.stringify({ categories, assignments, fileIndex, documents }, null, 2), { name: 'memory/categories.json' })
                    archive.append(JSON.stringify({ files }, null, 2), { name: 'memory/files.json' })
                    manifest.modules.memory.count = files.length
                }

                if (module === 'conversations') {
                    const attachmentAssets = db.prepare(`
                        SELECT DISTINCT a.* FROM attachment_assets a
                        JOIN message_attachments ma ON ma.asset_id = a.id
                        ORDER BY a.created_at
                    `).all() as Array<{ id: string; original_path: string; text_path: string }>
                    // Assets whose files are gone from disk are already broken locally; skip them instead of failing the whole export.
                    const preservedAssets = attachmentAssets.filter((asset) => {
                        if (asset.original_path && asset.text_path && existsSync(asset.original_path) && existsSync(asset.text_path)) return true
                        warnings.push(`Attachment asset ${asset.id} is missing its file on disk and was skipped`)
                        skippedAttachmentAssetIds.push(asset.id)
                        return false
                    })
                    archive.append(JSON.stringify(preservedAssets, null, 2), { name: 'conversations/attachment_assets.json' })
                    for (const asset of preservedAssets) {
                        archive.file(asset.original_path, { name: `conversations/attachment-assets/${asset.id}/original` })
                        archive.file(asset.text_path, { name: `conversations/attachment-assets/${asset.id}/text` })
                    }

                    for (const { id } of exported.conversations) {
                        const artifactDir = getConversationArtifactsDir(String(id))
                        if (existsSync(artifactDir)) {
                            archive.directory(artifactDir, `conversations/artifacts/${id}`)
                        }
                    }
                }
            }

            if (warnings.length) {
                manifest.warnings = warnings
                if (skippedAttachmentAssetIds.length) manifest.skippedAttachmentAssetIds = skippedAttachmentAssetIds
                req.log.warn({ warnings }, 'Backup export completed with skipped items')
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
                .header('X-Backup-Warning-Count', String(warnings.length))
                .header('Access-Control-Expose-Headers', 'X-Backup-Warning-Count')
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
        const manifest = readArchiveJson<BackupManifest>(zip, 'manifest.json')
        if (!manifest) {
            return reply.status(400).send({ error: 'Invalid backup: missing manifest.json' })
        }

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
        const results: Record<string, ModuleResult> = {}
        const restoreModules = requestedModules.filter((module) =>
            // Backups made while the knowledge graph existed may list it; it is no longer restored.
            Boolean(manifest.modules[module]) && module !== 'knowledge'
        )
        let restoreIndex = 0
        const emitRestoreProgress = (module: string, status: 'started' | 'completed' | 'failed', errors: string[] = []) => {
            if (!broadcast) return
            const total = restoreModules.length
            const current = status === 'started'
                ? restoreIndex + 1
                : Math.min(restoreIndex + 1, total)
            broadcast('backup:restore-progress', { module, status, current, total, errors })
            if (status !== 'started') restoreIndex++
        }
        const restore = async (module: string, action: (res: ModuleResult) => void | Promise<void>) => {
            if (!restoreModules.includes(module)) return
            const res: ModuleResult = { restored: 0, errors: [] }
            emitRestoreProgress(module, 'started')
            try {
                await action(res)
            } catch (e) {
                res.errors.push((e as Error).message)
            }
            results[module] = res
            emitRestoreProgress(module, res.errors.length > 0 ? 'failed' : 'completed', res.errors)
        }
        const ctx: RestoreContext = { agentIds: new Set(), conversationIds: new Set(), messageIds: new Set() }

        await restore('agents', (res) => {
            restoreTables(zip, 'agents', ctx, res)
            const icons = readArchiveJson<Record<string, string>>(zip, 'agents/_db_agent_icons.json') ?? {}
            const setIcon = db.prepare('UPDATE agents SET icon_data = ?, icon_mime = ? WHERE id = ?')
            for (const [id, dataUrl] of Object.entries(icons)) {
                const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/)
                if (match) setIcon.run(Buffer.from(match[2], 'base64'), match[1], id)
            }
        })

        await restore('providers', (res) => {
            const providers = readArchiveJson<LLMProviderConfig[]>(zip, 'providers/providers.json')
            if (!providers) return
            const now = Date.now()
            addResult(res, insertRows('providers', providers.map((config) => ({
                id: config.id,
                name: config.name,
                type: config.type,
                base_url: config.baseUrl,
                api_key_enc: config.apiKey || null,
                default_model: config.defaultModel,
                config_json: JSON.stringify({ ...config, apiKey: undefined }),
                created_at: now,
                updated_at: now,
            }))))
            // Reload gateway providers
            const gateway = getGateway()
            for (const [id] of gateway.getAllProviders()) {
                gateway.removeProvider(id)
            }
            loadSavedProviders()
        })

        await restore('mcp', async (res) => {
            restoreTables(zip, 'mcp', ctx, res)
            await loadSavedMcpServers()
        })

        await restore('settings', (res) => {
            try {
                const settings = readArchiveJson<Record<string, unknown>>(zip, 'settings/settings.json') ?? {}
                addResult(res, insertRows('settings', Object.entries(settings).map(([key, value]) => ({ key, value_json: JSON.stringify(value) }))))
                const approvals = readArchiveJson<{ toolName: string; autoApprove: boolean }[]>(zip, 'settings/tool_approvals.json') ?? []
                addResult(res, insertRows('tool_approvals', approvals.map((approval) => ({ tool_name: approval.toolName, auto_approve: approval.autoApprove }))))
                restoreTables(zip, 'settings', ctx, res)
            } finally {
                // Reload the embedding provider from freshly restored settings.
                loadEmbeddingServiceFromDb()
            }
        })

        await restore('channels', async (res) => {
            restoreTables(zip, 'channels', ctx, res)
            // Reload channel manager to pick up restored channels
            await getChannelManager().loadAll()
        })

        await restore('memory', (res) => restoreMemory(zip, res))

        await restore('conversations', async (res) => {
            for (const { id } of db.prepare('SELECT id FROM agents').all() as { id: string }[]) ctx.agentIds.add(id)
            restoreTables(zip, 'conversations', ctx, res)
            try {
                restoreArtifactFiles(zip, ctx.conversationIds, res)
            } catch (e) {
                res.errors.push(`Artifact restoration: ${(e as Error).message}`)
            }
            try {
                rehomeMediaUrls(ctx.conversationIds)
            } catch (e) {
                res.errors.push(`Artifact path migration: ${(e as Error).message}`)
            }
            try {
                await restoreAttachments(zip, ctx.conversationIds, new Set(manifest.skippedAttachmentAssetIds ?? []), res)
            } catch (e) {
                res.errors.push(`Attachment reindex: ${(e as Error).message}`)
            }
        })

        await restore('usage', (res) => restoreTables(zip, 'usage', ctx, res))

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

        // The knowledge graph module was removed; older backups may still list it.
        delete manifest.modules.knowledge

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
