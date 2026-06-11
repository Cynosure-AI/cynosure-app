import { nanoid } from 'nanoid'

export type MemoryIndexJobKind = 'reindex' | 'entity-index'
export type MemoryIndexJobStatus = 'running' | 'completed' | 'cancelled' | 'error'

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
}

const jobs = new Map<string, MemoryIndexJob>()
const COMPLETED_TTL_MS = 5 * 60 * 1000

function snapshot<T>(job: MemoryIndexJob<T>): MemoryIndexJobSnapshot<T> {
    const { controller: _controller, promise: _promise, ...data } = job
    return data
}

function isActive(job: MemoryIndexJobSnapshot): boolean {
    return job.status === 'running'
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
    run: (signal: AbortSignal) => Promise<T>
}): MemoryIndexJobSnapshot<T> {
    pruneJobs()
    const existing = Array.from(jobs.values()).find(job =>
        job.status === 'running' &&
        job.kind === opts.kind &&
        job.spaceId === opts.spaceId &&
        job.fileName === opts.fileName
    ) as MemoryIndexJob<T> | undefined
    if (existing) return snapshot(existing)

    const now = Date.now()
    const controller = new AbortController()
    const job: MemoryIndexJob<T> = {
        id: nanoid(),
        kind: opts.kind,
        spaceId: opts.spaceId,
        fileName: opts.fileName,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        controller,
        promise: Promise.resolve(),
    }

    job.promise = opts.run(controller.signal)
        .then((result) => {
            if (controller.signal.aborted) {
                job.status = 'cancelled'
            } else {
                job.status = 'completed'
                job.result = result
            }
        })
        .catch((err: unknown) => {
            if (controller.signal.aborted || (err as Error | undefined)?.name === 'AbortError') {
                job.status = 'cancelled'
                job.error = undefined
            } else {
                job.status = 'error'
                job.error = (err as Error | undefined)?.message || 'Memory job failed'
            }
        })
        .finally(() => {
            job.updatedAt = Date.now()
        })

    jobs.set(job.id, job)
    return snapshot(job)
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
    if (job.status === 'running') {
        job.controller.abort()
        job.updatedAt = Date.now()
    }
    return snapshot(job)
}
