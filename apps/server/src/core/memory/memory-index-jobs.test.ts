import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { closeDb, getDb } from '../../db/database.js'
import { cancelAllMemoryIndexJobs, cancelMemoryIndexJob, discardMemoryIndexJob, dismissMemoryIndexJobFailures, getMemoryIndexJob, listMemoryIndexJobs, startMemoryIndexJob } from './memory-index-jobs.js'

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
            kind: 'reindex',
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
            kind: 'reindex',
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

    test('discards a cancelled job explicitly', async () => {
        const started = startMemoryIndexJob({
            kind: 'reindex',
            folderId: 'default',
            fileName: 'discarded.md',
            run: async (signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
        })
        cancelMemoryIndexJob(started.id)
        await vi.waitFor(() => expect(getMemoryIndexJob(started.id)?.status).toBe('cancelled'))

        expect(discardMemoryIndexJob(started.id)).toBe(true)
        expect(getMemoryIndexJob(started.id)).toBeUndefined()
        expect(getDb().prepare('SELECT id FROM memory_index_jobs WHERE id = ?').get(started.id)).toBeUndefined()
    })

    test('dismisses failed jobs durably without touching active work', async () => {
        const failed = startMemoryIndexJob({
            kind: 'reindex',
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
