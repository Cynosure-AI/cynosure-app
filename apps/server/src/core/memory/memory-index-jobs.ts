import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getEventBus } from '../telemetry/event-bus.js'

export type MemoryIndexJobKind = 'reindex' | 'knowledge-extraction'
export type MemoryIndexJobStatus = 'queued' | 'running' | 'retrying' | 'completed' | 'cancelled' | 'error' | 'dead_letter'

export interface MemoryIndexJobSnapshot<T = unknown> {
    id: string
    kind: MemoryIndexJobKind
    spaceId: string
    fileName: string
    status: MemoryIndexJobStatus
    createdAt: number
    updatedAt: number
    attempt: number
    maxAttempts: number
    nextAttemptAt?: number
    progressCurrent?: number
    progressTotal?: number
    result?: T
    error?: string
}

interface MemoryIndexJob<T = unknown> extends MemoryIndexJobSnapshot<T> {
    controller: AbortController
    promise: Promise<void>
    run: (signal: AbortSignal, reportProgress: (current: number, total: number) => void) => Promise<T>
}

const jobs = new Map<string, MemoryIndexJob>()
const COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_RUNNING_JOBS = 5
const DEFAULT_MAX_ATTEMPTS = 1
let persistedJobsLoaded = false

function persistedRowToSnapshot(row: Record<string, unknown>): MemoryIndexJobSnapshot {
    let result: unknown
    try { result = row.result_json ? JSON.parse(String(row.result_json)) : undefined } catch { result = undefined }
    return {
        id: String(row.id), kind: row.kind as MemoryIndexJobKind,
        spaceId: String(row.space_id), fileName: String(row.file_name),
        status: row.status as MemoryIndexJobStatus,
        createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
        attempt: Number(row.attempt || 0), maxAttempts: Number(row.max_attempts || DEFAULT_MAX_ATTEMPTS),
        nextAttemptAt: row.next_attempt_at == null ? undefined : Number(row.next_attempt_at),
        progressCurrent: row.progress_current == null ? undefined : Number(row.progress_current),
        progressTotal: row.progress_total == null ? undefined : Number(row.progress_total),
        result, error: row.error ? String(row.error) : undefined,
    }
}

async function runRecoveredJob(
    kind: MemoryIndexJobKind,
    spaceId: string,
    fileName: string,
    signal: AbortSignal,
    reportProgress: (current: number, total: number) => void,
): Promise<unknown> {
    const space = getDb().prepare('SELECT folder_path FROM memory_spaces WHERE id = ?').get(spaceId) as { folder_path: string } | undefined
    if (!space?.folder_path) throw new Error('Memory space is no longer available')
    if (kind === 'reindex') {
        const { getAgentMemory } = await import('./agent-memory.js')
        const result = await getAgentMemory().reindexFile(space.folder_path, fileName, spaceId, { signal })
        return { success: true, chunksStored: result.chunkCount, fileName: result.fileName }
    }
    const { indexMemoryFileIntoKnowledge } = await import('./memory-knowledge-extraction.js')
    return {
        success: true,
        ...(await indexMemoryFileIntoKnowledge({
            folderPath: space.folder_path, spaceId, fileName, replaceExisting: true, signal,
            onExtractionProgress: reportProgress,
        })),
    }
}

function persistJob(job: MemoryIndexJobSnapshot): void {
    getDb().prepare(`
        INSERT INTO memory_index_jobs
            (id, kind, space_id, file_name, status, attempt, max_attempts, next_attempt_at,
             result_json, error, progress_current, progress_total, created_at, updated_at, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            status = excluded.status, attempt = excluded.attempt, max_attempts = excluded.max_attempts,
            next_attempt_at = excluded.next_attempt_at, result_json = excluded.result_json,
            error = excluded.error, progress_current = excluded.progress_current,
            progress_total = excluded.progress_total, updated_at = excluded.updated_at,
            started_at = COALESCE(memory_index_jobs.started_at, excluded.started_at),
            completed_at = excluded.completed_at
    `).run(
        job.id, job.kind, job.spaceId, job.fileName, job.status, job.attempt, job.maxAttempts,
        job.nextAttemptAt ?? null, job.result === undefined ? null : JSON.stringify(job.result), job.error || null,
        job.progressCurrent ?? null, job.progressTotal ?? null,
        job.createdAt, job.updatedAt, job.status === 'running' ? job.updatedAt : null,
        ['completed', 'cancelled', 'error', 'dead_letter'].includes(job.status) ? job.updatedAt : null,
    )
}

function snapshot<T>(job: MemoryIndexJob<T>): MemoryIndexJobSnapshot<T> {
    return {
        id: job.id, kind: job.kind, spaceId: job.spaceId, fileName: job.fileName,
        status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt,
        attempt: job.attempt, maxAttempts: job.maxAttempts, nextAttemptAt: job.nextAttemptAt,
        progressCurrent: job.progressCurrent, progressTotal: job.progressTotal,
        result: job.result, error: job.error,
    }
}

function emitJobUpdated(job: MemoryIndexJob): void {
    persistJob(job)
    getEventBus().emit('memory:job-updated', snapshot(job))
}

function isActive(job: MemoryIndexJobSnapshot): boolean {
    return job.status === 'queued' || job.status === 'running' || job.status === 'retrying'
}

function ensurePersistedJobsLoaded(): void {
    if (persistedJobsLoaded) return
    persistedJobsLoaded = true
    const rows = getDb().prepare(`
        SELECT * FROM memory_index_jobs
        WHERE status IN ('queued', 'running', 'retrying') OR updated_at >= ?
        ORDER BY created_at
    `).all(Date.now() - COMPLETED_TTL_MS) as Array<Record<string, unknown>>
    for (const row of rows) {
        const saved = persistedRowToSnapshot(row)
        const interrupted = saved.status === 'running' || saved.status === 'retrying'
        const controller = new AbortController()
        const job: MemoryIndexJob = {
            ...saved,
            status: interrupted ? 'error' : saved.status,
            maxAttempts: saved.status === 'queued' ? DEFAULT_MAX_ATTEMPTS : saved.maxAttempts,
            nextAttemptAt: undefined,
            error: interrupted ? 'Interrupted by server restart' : saved.error,
            controller, promise: Promise.resolve(),
            run: (signal, reportProgress) => runRecoveredJob(saved.kind, saved.spaceId, saved.fileName, signal, reportProgress),
        }
        jobs.set(job.id, job)
        if (interrupted) persistJob(job)
    }
    processMemoryIndexQueue()
}

function pruneJobs(): void {
    const now = Date.now()
    for (const [id, job] of jobs.entries()) {
        if (!isActive(job) && now - job.updatedAt > COMPLETED_TTL_MS) {
            jobs.delete(id)
            getDb().prepare('DELETE FROM memory_index_jobs WHERE id = ?').run(id)
        }
    }
}

export function startMemoryIndexJob<T>(opts: {
    kind: MemoryIndexJobKind
    spaceId: string
    fileName: string
    replaceExisting?: boolean
    run: (signal: AbortSignal, reportProgress: (current: number, total: number) => void) => Promise<T>
}): MemoryIndexJobSnapshot<T> {
    ensurePersistedJobsLoaded()
    pruneJobs()
    const existing = Array.from(jobs.values()).find(job =>
        isActive(job) && job.kind === opts.kind && job.spaceId === opts.spaceId && job.fileName === opts.fileName
    ) as MemoryIndexJob<T> | undefined
    if (existing) {
        if (!opts.replaceExisting) return snapshot(existing)
        existing.controller.abort()
        existing.status = 'cancelled'
        existing.updatedAt = Date.now()
        emitJobUpdated(existing)
    }

    const now = Date.now()
    const job: MemoryIndexJob<T> = {
        id: nanoid(), kind: opts.kind, spaceId: opts.spaceId, fileName: opts.fileName,
        status: 'queued', createdAt: now, updatedAt: now, attempt: 0,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        controller: new AbortController(), promise: Promise.resolve(), run: opts.run,
    }
    jobs.set(job.id, job)
    emitJobUpdated(job)
    processMemoryIndexQueue()
    return snapshot(job)
}

function processMemoryIndexQueue(): void {
    const now = Date.now()
    for (const job of jobs.values()) {
        if (job.status !== 'retrying' || (job.nextAttemptAt || 0) > now) continue
        job.status = 'queued'
        job.nextAttemptAt = undefined
        emitJobUpdated(job)
    }
    const runningCount = Array.from(jobs.values()).filter(job => job.status === 'running').length
    const queuedJobs = Array.from(jobs.values())
        .filter(job => job.status === 'queued')
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, Math.max(0, MAX_RUNNING_JOBS - runningCount))
    for (const job of queuedJobs) startQueuedJob(job)
}

function startQueuedJob<T>(job: MemoryIndexJob<T>): void {
    if (job.status !== 'queued') return
    if (job.controller.signal.aborted) {
        job.status = 'cancelled'
        job.updatedAt = Date.now()
        emitJobUpdated(job)
        processMemoryIndexQueue()
        return
    }
    job.status = 'running'
    job.attempt++
    job.nextAttemptAt = undefined
    job.updatedAt = Date.now()
    emitJobUpdated(job)

    const reportProgress = (current: number, total: number): void => {
        if (job.status !== 'running' || job.controller.signal.aborted) return
        job.progressCurrent = Math.max(0, Math.floor(current))
        job.progressTotal = Math.max(job.progressCurrent, Math.floor(total))
        job.updatedAt = Date.now()
        emitJobUpdated(job)
    }

    job.promise = job.run(job.controller.signal, reportProgress)
        .then((result) => {
            if (job.controller.signal.aborted) job.status = 'cancelled'
            else {
                job.status = 'completed'
                job.result = result
                job.error = undefined
            }
        })
        .catch((err: unknown) => {
            if (job.controller.signal.aborted || (err as Error | undefined)?.name === 'AbortError') {
                job.status = 'cancelled'
                job.error = undefined
            } else {
                job.error = (err as Error | undefined)?.message || 'Memory job failed'
                job.status = 'error'
            }
        })
        .finally(() => {
            job.updatedAt = Date.now()
            emitJobUpdated(job)
            processMemoryIndexQueue()
        })
}

export function cancelMemoryIndexJobsForFile(spaceId: string, fileName: string): void {
    ensurePersistedJobsLoaded()
    pruneJobs()
    for (const job of jobs.values()) {
        if (!isActive(job) || job.spaceId !== spaceId || job.fileName !== fileName) continue
        job.controller.abort()
        job.status = 'cancelled'
        job.updatedAt = Date.now()
        emitJobUpdated(job)
    }
    processMemoryIndexQueue()
}

export function cancelMemoryIndexJobsByKind(kind: MemoryIndexJobKind): void {
    ensurePersistedJobsLoaded()
    pruneJobs()
    for (const job of jobs.values()) {
        if (!isActive(job) || job.kind !== kind) continue
        job.controller.abort()
        job.status = 'cancelled'
        job.updatedAt = Date.now()
        emitJobUpdated(job)
    }
    processMemoryIndexQueue()
}

/** Cancel every queued, retrying, or running memory indexing/extraction job. */
export function cancelAllMemoryIndexJobs(): number {
    ensurePersistedJobsLoaded()
    pruneJobs()
    let cancelled = 0
    for (const job of jobs.values()) {
        if (!isActive(job)) continue
        job.controller.abort()
        job.status = 'cancelled'
        job.updatedAt = Date.now()
        emitJobUpdated(job)
        cancelled++
    }
    processMemoryIndexQueue()
    return cancelled
}

export function listMemoryIndexJobs(spaceId?: string): MemoryIndexJobSnapshot[] {
    ensurePersistedJobsLoaded()
    pruneJobs()
    return Array.from(jobs.values())
        .filter(job => !spaceId || job.spaceId === spaceId)
        .map(job => snapshot(job))
        .sort((a, b) => b.createdAt - a.createdAt)
}

export function getMemoryIndexJob(id: string): MemoryIndexJobSnapshot | undefined {
    ensurePersistedJobsLoaded()
    pruneJobs()
    const job = jobs.get(id)
    return job ? snapshot(job) : undefined
}

export function cancelMemoryIndexJob(id: string): MemoryIndexJobSnapshot | undefined {
    ensurePersistedJobsLoaded()
    pruneJobs()
    const job = jobs.get(id)
    if (!job) return undefined
    if (isActive(job)) {
        job.controller.abort()
        job.status = 'cancelled'
        job.updatedAt = Date.now()
        emitJobUpdated(job)
        processMemoryIndexQueue()
    }
    return snapshot(job)
}
