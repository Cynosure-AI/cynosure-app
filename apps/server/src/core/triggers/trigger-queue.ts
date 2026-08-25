interface QueueState {
    running: boolean
    pending: boolean
    runner: () => Promise<void>
}

const queues = new Map<string, QueueState>()

/**
 * Enqueue a coalesced trigger run for a given key.
 * - If nothing is running for that key, start immediately.
 * - If a run is already in progress, mark it as pending (with the latest runner).
 *   Once the current run finishes, the pending run executes once — no matter how
 *   many times it was queued during the in-flight execution.
 */
export function enqueueCoalescedTrigger(key: string, runner: () => Promise<void>): void {
    const existing = queues.get(key)
    if (existing) {
        existing.pending = true
        existing.runner = runner
        return
    }

    const state: QueueState = { running: false, pending: false, runner }
    queues.set(key, state)
    void runQueue(key, state)
}

/** Drop pending follow-up runs without interrupting the runner already in flight. */
export function cancelPendingCoalescedTriggers(prefix?: string): number {
    let cancelled = 0
    for (const [key, state] of queues) {
        if (prefix && !key.startsWith(prefix)) continue
        if (!state.pending) continue
        state.pending = false
        cancelled++
    }
    return cancelled
}

async function runQueue(key: string, state: QueueState): Promise<void> {
    state.running = true
    try {
        do {
            state.pending = false
            try {
                await state.runner()
            } catch (err) {
                // A failed run must not discard work that arrived while it was
                // in flight. Log the failure and let the coalesced pending run
                // proceed with the latest runner.
                console.error(`[trigger-queue] Unhandled queue error for ${key}:`, err)
            }
        } while (state.pending)
    } finally {
        queues.delete(key)
    }
}
