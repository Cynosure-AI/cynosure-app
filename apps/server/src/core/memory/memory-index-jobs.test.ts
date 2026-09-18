import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../../db/database.js'
import { cancelAllMemoryIndexJobs, cancelMemoryIndexJob, discardMemoryIndexJob, dismissMemoryIndexJobFailures, getMemoryIndexJob, latestResumableMemoryIndexJob, listMemoryIndexJobs, startMemoryIndexJob } from './memory-index-jobs.js'

let dataDir: string

beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cynosure-memory-jobs-test-'))
    process.env.CYNOSURE_DATA_DIR = dataDir
    getDb()
})

afterAll(() => {
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    rmSync(dataDir, { recursive: true, force: true })
})

describe('durable memory index jobs', () => {
    test('cancels all queued and running jobs together', async () => {
        const started = startMemoryIndexJob({
            kind: 'reindex',
            folderId: 'default',
            fileName: 'long-running.md',
            run: async (signal) => new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve(), { once: true })
            }),
        })

        expect(cancelAllMemoryIndexJobs()).toBe(1)
        expect(getMemoryIndexJob(started.id)?.status).toBe('cancelled')
    })

    test('persists progress updates while a job is running', async () => {
        const started = startMemoryIndexJob({
            kind: 'deep-research',
            folderId: 'default',
            fileName: 'progress.md',
            run: async (_signal, reportProgress) => {
                reportProgress(2, 4)
                return { indexed: true }
            },
        })

        await vi.waitFor(() => {
            expect(getMemoryIndexJob(started.id)?.status).toBe('completed')
        }, { timeout: 3_000, interval: 50 })

        const snapshot = getMemoryIndexJob(started.id)
        expect(snapshot).toMatchObject({ attempt: 1, maxAttempts: 1, progressCurrent: 2, progressTotal: 4, result: { indexed: true } })
        const persisted = getDb().prepare('SELECT status, attempt, progress_current, progress_total, result_json FROM memory_index_jobs WHERE id = ?').get(started.id) as Record<string, unknown>
        expect(persisted).toMatchObject({ status: 'completed', attempt: 1, progress_current: 2, progress_total: 4 })
        expect(JSON.parse(String(persisted.result_json))).toEqual({ indexed: true })
    })

    test('records the first failure without retrying', async () => {
        const run = vi.fn(async () => { throw new Error('provider failure') })
        const started = startMemoryIndexJob({
            kind: 'deep-research',
            folderId: 'default',
            fileName: 'failure.md',
            run,
        })

        await vi.waitFor(() => {
            expect(getMemoryIndexJob(started.id)?.status).toBe('error')
        }, { timeout: 1_000, interval: 25 })

        expect(run).toHaveBeenCalledTimes(1)
        expect(getMemoryIndexJob(started.id)).toMatchObject({ attempt: 1, maxAttempts: 1, error: 'provider failure' })
    })

    test('retains and explicitly discards a cancelled extraction checkpoint', async () => {
        const started = startMemoryIndexJob({
            kind: 'deep-research',
            folderId: 'default',
            fileName: 'resumable.md',
            run: async (signal, reportProgress) => {
                reportProgress(4, 7, { contentHash: 'same-revision', completedChunkIndexes: [0, 1, 2, 3] })
                await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
                return { indexed: true }
            },
        })
        await vi.waitFor(() => expect(getMemoryIndexJob(started.id)?.progressCurrent).toBe(4))

        cancelMemoryIndexJob(started.id)
        await vi.waitFor(() => expect(getMemoryIndexJob(started.id)?.status).toBe('cancelled'))
        const checkpoint = latestResumableMemoryIndexJob('default', 'resumable.md')
        expect(checkpoint).toMatchObject({
            id: started.id,
            progressCurrent: 4,
            progressTotal: 7,
            result: { resumeCheckpoint: { contentHash: 'same-revision', completedChunkIndexes: [0, 1, 2, 3] } },
        })

        // Recover checkpoints hidden by resume jobs created before checkpoint
        // handoff was made atomic.
        const emptyResume = startMemoryIndexJob({
            kind: 'deep-research', folderId: 'default', fileName: 'resumable.md',
            run: async (signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
        })
        cancelMemoryIndexJob(emptyResume.id)
        await vi.waitFor(() => expect(getMemoryIndexJob(emptyResume.id)?.status).toBe('cancelled'))
        expect(latestResumableMemoryIndexJob('default', 'resumable.md')?.id).toBe(started.id)

        const resumed = startMemoryIndexJob({
            kind: 'deep-research',
            folderId: 'default',
            fileName: 'resumable.md',
            resume: {
                current: checkpoint!.progressCurrent!,
                total: checkpoint!.progressTotal!,
                checkpoint: (checkpoint!.result as { resumeCheckpoint: unknown }).resumeCheckpoint,
            },
            run: async (signal) => new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve(), { once: true })
            }),
        })
        expect(getMemoryIndexJob(resumed.id)).toMatchObject({
            progressCurrent: 4,
            progressTotal: 7,
            result: checkpoint!.result,
        })

        cancelMemoryIndexJob(resumed.id)
        await vi.waitFor(() => expect(getMemoryIndexJob(resumed.id)?.status).toBe('cancelled'))
        expect(latestResumableMemoryIndexJob('default', 'resumable.md')?.id).toBe(resumed.id)

        expect(discardMemoryIndexJob(resumed.id)).toBe(true)
        expect(getMemoryIndexJob(started.id)).toBeUndefined()
        expect(getMemoryIndexJob(resumed.id)).toBeUndefined()
        expect(latestResumableMemoryIndexJob('default', 'resumable.md')).toBeUndefined()
    })

    test('dismisses failed jobs durably without touching active or resumable work', async () => {
        const failed = startMemoryIndexJob({
            kind: 'deep-research',
            folderId: 'dismiss-space',
            fileName: 'failed.md',
            run: async () => { throw new Error('lance schema mismatch') },
        })
        await vi.waitFor(() => expect(getMemoryIndexJob(failed.id)?.status).toBe('error'))

        const otherSpaceFailure = startMemoryIndexJob({
            kind: 'reindex',
            folderId: 'other-space',
            fileName: 'failed.md',
            run: async () => { throw new Error('other failure') },
        })
        await vi.waitFor(() => expect(getMemoryIndexJob(otherSpaceFailure.id)?.status).toBe('error'))

        const running = startMemoryIndexJob({
            kind: 'reindex',
            folderId: 'dismiss-space',
            fileName: 'running.md',
            run: async (signal) => new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve(), { once: true })
            }),
        })

        // Scoped dismissal only removes failures in the requested folder.
        expect(dismissMemoryIndexJobFailures('dismiss-space')).toBe(1)
        expect(getMemoryIndexJob(failed.id)).toBeUndefined()
        expect(getDb().prepare('SELECT id FROM memory_index_jobs WHERE id = ?').get(failed.id)).toBeUndefined()
        expect(getMemoryIndexJob(otherSpaceFailure.id)?.status).toBe('error')
        expect(getMemoryIndexJob(running.id)?.status).toBe('running')

        // An unscoped dismissal clears every remaining failure, including ones
        // left behind by earlier tests in this file.
        const remainingFailures = listMemoryIndexJobs().filter((job) => job.status === 'error').length
        expect(remainingFailures).toBeGreaterThanOrEqual(1)
        expect(dismissMemoryIndexJobFailures()).toBe(remainingFailures)
        expect(getMemoryIndexJob(otherSpaceFailure.id)).toBeUndefined()
        expect(listMemoryIndexJobs().filter((job) => job.status === 'error')).toHaveLength(0)

        cancelMemoryIndexJob(running.id)
        await vi.waitFor(() => expect(getMemoryIndexJob(running.id)?.status).toBe('cancelled'))
    })
})
