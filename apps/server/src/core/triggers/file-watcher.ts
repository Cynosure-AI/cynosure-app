import chokidar, { type FSWatcher } from 'chokidar'
import { nanoid } from 'nanoid'
import { relative } from 'path'
import { getDb } from '../../db/database.js'
import { getAgent } from '../agents/agent-store.js'
import { runTriggerExecution } from './trigger-runner.js'

type BroadcastFn = (event: string, data: unknown) => void

let broadcast: BroadcastFn = () => { }

// ─── Change buffer types ───────────────────────────────────

interface ChangeEntry {
    type: 'add' | 'change' | 'unlink'
    path: string
    timestamp: number
}

// ─── In-memory state ───────────────────────────────────────

const fsWatchers = new Map<string, FSWatcher>()
const changeBuffers = new Map<string, ChangeEntry[]>()
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const activeRuns = new Map<string, { watcherId: string; agentId: string; conversationId: string; startedAt: number }>()
const activeAbortControllers = new Map<string, AbortController>()

// ─── DB row shape ──────────────────────────────────────────

interface FileWatcherRow {
    id: string
    name: string
    agent_id: string
    paths_json: string
    ignore_patterns_json: string | null
    prompt: string
    debounce_ms: number
    enabled: number
    model_override: string
    provider_override: string
    created_at: number
    updated_at: number
}

export interface FileWatcherData {
    id: string
    name: string
    agentId: string
    paths: string[]
    ignorePatterns: string[]
    prompt: string
    debounceMs: number
    enabled: boolean
    modelOverride: string
    providerOverride: string
    createdAt: number
    updatedAt: number
}

function rowToData(row: FileWatcherRow): FileWatcherData {
    return {
        id: row.id,
        name: row.name,
        agentId: row.agent_id,
        paths: JSON.parse(row.paths_json),
        ignorePatterns: row.ignore_patterns_json ? JSON.parse(row.ignore_patterns_json) : [],
        prompt: row.prompt,
        debounceMs: row.debounce_ms,
        enabled: row.enabled === 1,
        modelOverride: row.model_override || '',
        providerOverride: row.provider_override || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }
}

// ─── CRUD ──────────────────────────────────────────────────

export function listFileWatchers(): FileWatcherData[] {
    const db = getDb()
    const rows = db.prepare('SELECT * FROM file_watchers ORDER BY created_at DESC').all() as FileWatcherRow[]
    return rows.map(rowToData)
}

export function getFileWatcher(id: string): FileWatcherData | undefined {
    const db = getDb()
    const row = db.prepare('SELECT * FROM file_watchers WHERE id = ?').get(id) as FileWatcherRow | undefined
    return row ? rowToData(row) : undefined
}

export function createFileWatcher(input: {
    name?: string
    agentId: string
    paths: string[]
    ignorePatterns?: string[]
    prompt?: string
    debounceMs?: number
    enabled?: boolean
    modelOverride?: string
    providerOverride?: string
}): FileWatcherData {
    const db = getDb()
    const id = nanoid()
    const now = Date.now()
    db.prepare(
        `INSERT INTO file_watchers (id, name, agent_id, paths_json, ignore_patterns_json, prompt, debounce_ms, enabled, model_override, provider_override, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        id,
        input.name || '',
        input.agentId,
        JSON.stringify(input.paths),
        input.ignorePatterns?.length ? JSON.stringify(input.ignorePatterns) : null,
        input.prompt || '',
        input.debounceMs ?? 5000,
        input.enabled !== false ? 1 : 0,
        input.modelOverride || '',
        input.providerOverride || '',
        now,
        now
    )
    return getFileWatcher(id)!
}

export function updateFileWatcher(id: string, input: {
    name?: string
    agentId?: string
    paths?: string[]
    ignorePatterns?: string[]
    prompt?: string
    debounceMs?: number
    enabled?: boolean
    modelOverride?: string
    providerOverride?: string
}): FileWatcherData | undefined {
    const db = getDb()
    const existing = db.prepare('SELECT * FROM file_watchers WHERE id = ?').get(id) as FileWatcherRow | undefined
    if (!existing) return undefined
    const now = Date.now()
    db.prepare(
        `UPDATE file_watchers SET name = ?, agent_id = ?, paths_json = ?, ignore_patterns_json = ?, prompt = ?, debounce_ms = ?, enabled = ?, model_override = ?, provider_override = ?, updated_at = ? WHERE id = ?`
    ).run(
        input.name !== undefined ? input.name : existing.name,
        input.agentId !== undefined ? input.agentId : existing.agent_id,
        input.paths !== undefined ? JSON.stringify(input.paths) : existing.paths_json,
        input.ignorePatterns !== undefined ? (input.ignorePatterns.length ? JSON.stringify(input.ignorePatterns) : null) : existing.ignore_patterns_json,
        input.prompt !== undefined ? input.prompt : existing.prompt,
        input.debounceMs !== undefined ? input.debounceMs : existing.debounce_ms,
        input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled,
        input.modelOverride !== undefined ? input.modelOverride : existing.model_override,
        input.providerOverride !== undefined ? input.providerOverride : existing.provider_override,
        now,
        id
    )
    return getFileWatcher(id)
}

export function deleteFileWatcher(id: string): boolean {
    stopWatcher(id)
    const db = getDb()
    const result = db.prepare('DELETE FROM file_watchers WHERE id = ?').run(id)
    return result.changes > 0
}

export function getFileWatchersForAgent(agentId: string): FileWatcherData[] {
    const db = getDb()
    const rows = db.prepare('SELECT * FROM file_watchers WHERE agent_id = ? ORDER BY created_at DESC').all(agentId) as FileWatcherRow[]
    return rows.map(rowToData)
}

// ─── Runtime info ──────────────────────────────────────────

export interface ActiveWatcherRun {
    watcherId: string
    agentId: string
    conversationId: string
    startedAt: number
}

export function getActiveWatcherRuns(): ActiveWatcherRun[] {
    return Array.from(activeRuns.values())
}

export function isWatcherActive(watcherId: string): boolean {
    return fsWatchers.has(watcherId)
}

// ─── Debounce + Flush ──────────────────────────────────────

function bufferChange(watcherId: string, entry: ChangeEntry): void {
    // Don't buffer changes while an agent run is in progress for this watcher.
    // They'll still be caught after the run completes since the watcher stays active.
    if (activeRuns.has(watcherId)) return

    const buffer = changeBuffers.get(watcherId) || []
    buffer.push(entry)
    changeBuffers.set(watcherId, buffer)

    // Reset debounce timer
    const existing = debounceTimers.get(watcherId)
    if (existing) clearTimeout(existing)

    const watcher = getFileWatcher(watcherId)
    const debounceMs = watcher?.debounceMs ?? 5000

    debounceTimers.set(watcherId, setTimeout(() => {
        debounceTimers.delete(watcherId)
        flushChanges(watcherId).catch((err) => {
            console.error(`[file-watcher] Error flushing changes for ${watcherId}:`, err)
        })
    }, debounceMs))
}

interface GroupedChanges {
    added: string[]
    modified: string[]
    deleted: string[]
}

function deduplicateAndGroup(entries: ChangeEntry[]): GroupedChanges {
    // Keep the latest event per path
    const latest = new Map<string, ChangeEntry>()
    for (const entry of entries) {
        latest.set(entry.path, entry)
    }

    // Net-zero: if a path was first added then unlinked (or vice versa), and the
    // final state is 'unlink' with an earlier 'add', remove both
    const added = new Set<string>()
    const modified = new Set<string>()
    const deleted = new Set<string>()

    // Check for add→unlink net-zero
    const addedPaths = new Set(entries.filter(e => e.type === 'add').map(e => e.path))

    for (const [path, entry] of latest) {
        if (entry.type === 'add') added.add(path)
        else if (entry.type === 'change') modified.add(path)
        else if (entry.type === 'unlink') {
            // If the file was added in this same batch and then deleted, skip both
            if (addedPaths.has(path)) continue
            deleted.add(path)
        }
    }

    return {
        added: Array.from(added).sort(),
        modified: Array.from(modified).sort(),
        deleted: Array.from(deleted).sort(),
    }
}

function buildChangeMessage(changes: GroupedChanges, prompt: string): string {
    const now = new Date()
    const lines: string[] = [`File watcher triggered at ${now.toISOString()}`, '', 'Changes detected:', '']

    if (changes.added.length) {
        lines.push(`Added (${changes.added.length}):`)
        for (const p of changes.added) lines.push(`  - ${p}`)
        lines.push('')
    }
    if (changes.modified.length) {
        lines.push(`Modified (${changes.modified.length}):`)
        for (const p of changes.modified) lines.push(`  - ${p}`)
        lines.push('')
    }
    if (changes.deleted.length) {
        lines.push(`Deleted (${changes.deleted.length}):`)
        for (const p of changes.deleted) lines.push(`  - ${p}`)
        lines.push('')
    }

    if (prompt) {
        lines.push(prompt)
    }

    return lines.join('\n')
}

async function flushChanges(watcherId: string): Promise<void> {
    const buffer = changeBuffers.get(watcherId)
    if (!buffer?.length) return
    changeBuffers.delete(watcherId)

    const changes = deduplicateAndGroup(buffer)
    const totalChanges = changes.added.length + changes.modified.length + changes.deleted.length
    if (totalChanges === 0) return

    const watcher = getFileWatcher(watcherId)
    if (!watcher || !watcher.enabled) return

    const agent = getAgent(watcher.agentId)
    if (!agent) return

    await runFileWatcher(watcher, agent, changes)
}

// ─── Run agent ─────────────────────────────────────────────

async function runFileWatcher(
    watcher: FileWatcherData,
    agent: ReturnType<typeof getAgent> & {},
    changes: GroupedChanges
): Promise<void> {
    activeRuns.set(watcher.id, { watcherId: watcher.id, agentId: watcher.agentId, conversationId: '', startedAt: Date.now() })

    const abortController = new AbortController()
    activeAbortControllers.set(watcher.id, abortController)

    const userContent = buildChangeMessage(changes, watcher.prompt)

    try {
        const { conversationId } = await runTriggerExecution({
            agent,
            userContent,
            origin: 'file-watcher',
            title: `File Watch ${new Date().toLocaleString()}`,
            systemPromptSuffix: '\nUse your tools to handle the file system changes.',
            providerOverride: watcher.providerOverride || undefined,
            modelOverride: watcher.modelOverride || undefined,
            broadcast,
            signal: abortController.signal,
            logPrefix: '[file-watcher]',
            onConversationCreated: (id) => {
                const run = activeRuns.get(watcher.id)
                if (run) run.conversationId = id
            },
        })
    } catch (err) {
        if ((err as Error).name === 'AbortError') return
        // Error already logged by trigger-runner
    } finally {
        activeRuns.delete(watcher.id)
        activeAbortControllers.delete(watcher.id)
    }
}

// ─── Watcher lifecycle ─────────────────────────────────────

export function startWatcher(watcherId: string): void {
    stopWatcher(watcherId)

    const watcher = getFileWatcher(watcherId)
    if (!watcher || !watcher.enabled || !watcher.paths.length) return

    const ignored = [
        /(^|[/\\])\./,  // dotfiles
        ...(watcher.ignorePatterns.length ? watcher.ignorePatterns : ['**/node_modules/**', '**/.git/**'])
    ]

    const fsWatcher = chokidar.watch(watcher.paths, {
        ignored,
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    })

    // Compute a common base for relative paths (use first path as reference)
    const basePath = watcher.paths[0]

    fsWatcher.on('add', (filePath) => {
        bufferChange(watcherId, { type: 'add', path: relative(basePath, filePath) || filePath, timestamp: Date.now() })
    })
    fsWatcher.on('change', (filePath) => {
        bufferChange(watcherId, { type: 'change', path: relative(basePath, filePath) || filePath, timestamp: Date.now() })
    })
    fsWatcher.on('unlink', (filePath) => {
        bufferChange(watcherId, { type: 'unlink', path: relative(basePath, filePath) || filePath, timestamp: Date.now() })
    })
    fsWatcher.on('error', (err) => {
        console.error(`[file-watcher] Error in watcher ${watcherId}:`, err)
    })

    fsWatchers.set(watcherId, fsWatcher)
}

export function stopWatcher(watcherId: string): void {
    const existing = fsWatchers.get(watcherId)
    if (existing) {
        existing.close().catch(() => { /* ignore */ })
        fsWatchers.delete(watcherId)
    }

    const timer = debounceTimers.get(watcherId)
    if (timer) {
        clearTimeout(timer)
        debounceTimers.delete(watcherId)
    }

    changeBuffers.delete(watcherId)
}

export function cancelWatcherRun(watcherId: string): boolean {
    const controller = activeAbortControllers.get(watcherId)
    if (controller) {
        controller.abort()
        activeAbortControllers.delete(watcherId)
        return true
    }
    return false
}

/** Unschedule all watchers for a specific agent (e.g. when agent is deleted) */
export function stopAllForAgent(agentId: string): void {
    const watchers = getFileWatchersForAgent(agentId)
    for (const w of watchers) {
        stopWatcher(w.id)
    }
}

/** Initialize file watching for all enabled watchers. Call once on server startup. */
export function startFileWatcherService(broadcastFn: BroadcastFn): void {
    broadcast = broadcastFn

    const watchers = listFileWatchers()
    for (const w of watchers) {
        if (w.enabled && w.paths.length) {
            startWatcher(w.id)
        }
    }
}

/** Stop all file watchers. */
export function stopFileWatcherService(): void {
    for (const [id] of fsWatchers) {
        stopWatcher(id)
    }
    fsWatchers.clear()
    changeBuffers.clear()
    debounceTimers.clear()
    activeRuns.clear()
}
