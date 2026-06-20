import { nanoid } from 'nanoid'
import { getEventBus } from '../telemetry/event-bus.js'

export type MemoryIndexJobKind = 'reindex' | 'entity-index'
export type MemoryIndexJobStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'error'

export interface MemoryIndexJobSnapshot<T = unknown> {
    id: string
    kind: MemoryIndexJobKind
    spaceId: string
    fileName: string
    status: MemoryIndexJobStatus
    createdAt: number
    updatedAt: number
    result?: T
    error?: string
}

interface MemoryIndexJob<T = unknown> extends MemoryIndexJobSnapshot<T> {
    controller: AbortController
    promise: Promise<void>
    run: (signal: AbortSignal) => Promise<T>
}

const jobs = new Map<string, MemoryIndexJob>()
const COMPLETED_TTL_MS = 5 * 60 * 1000
const MAX_RUNNING_JOBS = 5

function snapshot<T>(job: MemoryIndexJob<T>): MemoryIndexJobSnapshot<T> {
    return {
        id: job.id,
        kind: job.kind,
        spaceId: job.spaceId,
        fileName: job.fileName,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        result: job.result,
        error: job.error,
    }
}

function emitJobUpdated(job: MemoryIndexJob): void {
    getEventBus().emit('memory:job-updated', snapshot(job))
}

function isActive(job: MemoryIndexJobSnapshot): boolean {
    return job.status === 'queued' || job.status === 'running'
}

function pruneJobs(): void {
    const now = Date.now()
    for (const [id, job] of jobs.entries()) {
        if (!isActive(job) && now - job.updatedAt > COMPLETED_TTL_MS) {
            jobs.delete(id)
        }
    }
}

export function startMemoryIndexJob<T>(opts: {
    kind: MemoryIndexJobKind
    spaceId: string
    fileName: string
    replaceExisting?: boolean
    run: (signal: AbortSignal) => Promise<T>
}): MemoryIndexJobSnapshot<T> {
    pruneJobs()
    const existing = Array.from(jobs.values()).find(job =>
        isActive(job) &&
        job.kind === opts.kind &&
        job.spaceId === opts.spaceId &&
        job.fileName === opts.fileName
    ) as MemoryIndexJob<T> | undefined
    if (existing) {
        if (!opts.replaceExisting) return snapshot(existing)
        existing.controller.abort()
        existing.status = 'cancelled'
        existing.updatedAt = Date.now()
        emitJobUpdated(existing)
    }

    const now = Date.now()
    const controller = new AbortController()
    const job: MemoryIndexJob<T> = {
        id: nanoid(),
        kind: opts.kind,
        spaceId: opts.spaceId,
        fileName: opts.fileName,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        controller,
        promise: Promise.resolve(),
        run: opts.run,
    }

    jobs.set(job.id, job)
    emitJobUpdated(job)
    processMemoryIndexQueue()

    return snapshot(job)
}

function processMemoryIndexQueue(): void {
    const runningCount = Array.from(jobs.values()).filter(job => job.status === 'running').length
    const availableSlots = Math.max(0, MAX_RUNNING_JOBS - runningCount)
    if (availableSlots === 0) return

    const queuedJobs = Array.from(jobs.values())
        .filter(job => job.status === 'queued')
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, availableSlots)

    for (const job of queuedJobs) {
        startQueuedJob(job)
    }
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
    job.updatedAt = Date.now()
    emitJobUpdated(job)

    job.promise = job.run(job.controller.signal)
        .then((result) => {
            if (job.controller.signal.aborted) {
                job.status = 'cancelled'
            } else {
                job.status = 'completed'
                job.result = result
            }
        })
        .catch((err: unknown) => {
            if (job.controller.signal.aborted || (err as Error | undefined)?.name === 'AbortError') {
                job.status = 'cancelled'
                job.error = undefined
            } else {
                job.status = 'error'
                job.error = (err as Error | undefined)?.message || 'Memory job failed'
            }
        })
        .finally(() => {
            job.updatedAt = Date.now()
            emitJobUpdated(job)
            processMemoryIndexQueue()
        })
}

export function cancelMemoryIndexJobsForFile(spaceId: string, fileName: string): void {
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

export function listMemoryIndexJobs(spaceId?: string): MemoryIndexJobSnapshot[] {
    pruneJobs()
    return Array.from(jobs.values())
        .filter(job => !spaceId || job.spaceId === spaceId)
        .map(job => snapshot(job))
        .sort((a, b) => b.createdAt - a.createdAt)
}

export function getMemoryIndexJob(id: string): MemoryIndexJobSnapshot | undefined {
    pruneJobs()
    const job = jobs.get(id)
    return job ? snapshot(job) : undefined
}

export function cancelMemoryIndexJob(id: string): MemoryIndexJobSnapshot | undefined {
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
