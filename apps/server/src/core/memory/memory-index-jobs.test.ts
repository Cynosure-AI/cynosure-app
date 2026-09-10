import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../../db/database.js'
import { cancelAllMemoryIndexJobs, cancelMemoryIndexJob, discardMemoryIndexJob, getMemoryIndexJob, latestResumableMemoryIndexJob, startMemoryIndexJob } from './memory-index-jobs.js'

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
            spaceId: 'default',
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
            kind: 'knowledge-extraction',
            spaceId: 'default',
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
            kind: 'knowledge-extraction',
            spaceId: 'default',
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
            kind: 'knowledge-extraction',
            spaceId: 'default',
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
            kind: 'knowledge-extraction', spaceId: 'default', fileName: 'resumable.md',
            run: async (signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
        })
        cancelMemoryIndexJob(emptyResume.id)
        await vi.waitFor(() => expect(getMemoryIndexJob(emptyResume.id)?.status).toBe('cancelled'))
        expect(latestResumableMemoryIndexJob('default', 'resumable.md')?.id).toBe(started.id)

        const resumed = startMemoryIndexJob({
            kind: 'knowledge-extraction',
            spaceId: 'default',
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
})
