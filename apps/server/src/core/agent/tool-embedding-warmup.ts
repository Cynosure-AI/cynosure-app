import { getEventBus } from '../telemetry/event-bus.js'
import { cancelMemoryIndexJob, startMemoryIndexJob, waitForMemoryIndexJob, type MemoryIndexJobSnapshot } from '../memory/memory-index-jobs.js'
import { planToolEmbeddingWarmup } from './tool-router.js'

/** Start after provider/registry initialization. Registry and model changes coalesce. */
export function startToolEmbeddingWarmup(): () => Promise<void> {
    const bus = getEventBus()
    let timer: ReturnType<typeof setTimeout> | undefined
    let jobId: string | undefined
    let revision = 0
    let stopped = false
    let sweepPaused = false

    const schedule = (): void => {
        if (stopped) return
        revision++
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
            timer = undefined
            if (stopped || jobId) return
            try {
                const plan = planToolEmbeddingWarmup()
                if (!plan.count) {
                    plan.prune()
                    return
                }
                const job = startMemoryIndexJob({
                    kind: 'tool-embeddings',
                    categoryId: 'tool-registry',
                    fileName: 'Tool capabilities',
                    run: async (signal, reportProgress) => {
                        let indexed = 0
                        let snapshotRevision: number
                        do {
                            signal.throwIfAborted()
                            snapshotRevision = revision
                            const plan = planToolEmbeddingWarmup()
                            try {
                                indexed += await plan.run(signal, reportProgress, () => !stopped && revision === snapshotRevision)
                            } catch (error) {
                                signal.throwIfAborted()
                                if (revision === snapshotRevision) throw error
                                // A failed request from the old model must not prevent warming its replacement.
                            }
                        } while (!stopped && revision !== snapshotRevision)
                        return { indexed }
                    },
                })
                jobId = job.id
            } catch (error) {
                console.warn('[tool-embeddings] Could not schedule warmup:', error)
            }
        }, 1_000)
        timer.unref()
    }

    const changed = (): void => {
        sweepPaused = false
        schedule()
    }
    const removeRegistryListener = bus.on('tools:registry-changed', changed)
    const removeEmbeddingListener = bus.on('embedding:configured', changed)
    const removeJobListener = bus.on('memory:job-updated', (data) => {
        const job = data as MemoryIndexJobSnapshot
        if (job.id !== jobId || ['queued', 'running', 'retrying'].includes(job.status)) return
        // Explicit cancellation and provider errors stay stopped until tools/config change.
        sweepPaused = job.status !== 'completed'
        if (sweepPaused && timer) {
            clearTimeout(timer)
            timer = undefined
        }
        if (job.status === 'cancelled') {
            void waitForMemoryIndexJob(job.id).then(() => {
                if (jobId === job.id) jobId = undefined
            })
        } else jobId = undefined
    })
    // Also repair evicted entries. A warm cache produces no job or embedding request.
    const sweep = setInterval(() => { if (!sweepPaused) schedule() }, 5 * 60_000)
    sweep.unref()
    schedule()

    return async () => {
        stopped = true
        if (timer) clearTimeout(timer)
        clearInterval(sweep)
        removeRegistryListener()
        removeEmbeddingListener()
        removeJobListener()
        if (jobId) {
            cancelMemoryIndexJob(jobId)
            await waitForMemoryIndexJob(jobId)
        }
    }
}
