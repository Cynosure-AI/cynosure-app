import { describe, expect, test, vi } from 'vitest'
import { enqueueCoalescedTrigger } from './trigger-queue.js'

function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((done, fail) => {
        resolve = done
        reject = fail
    })
    return { promise, resolve, reject }
}

async function flushQueue(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('coalesced trigger queue', () => {
    test('coalesces bursts into one pending run using the latest runner', async () => {
        const gate = deferred()
        const calls: string[] = []
        enqueueCoalescedTrigger('job', async () => {
            calls.push('first')
            await gate.promise
        })
        enqueueCoalescedTrigger('job', async () => { calls.push('stale') })
        enqueueCoalescedTrigger('job', async () => { calls.push('latest') })

        expect(calls).toEqual(['first'])
        gate.resolve()
        await flushQueue()
        expect(calls).toEqual(['first', 'latest'])
    })

    test('runs different trigger keys independently', async () => {
        const gate = deferred()
        const calls: string[] = []
        enqueueCoalescedTrigger('slow', async () => {
            calls.push('slow')
            await gate.promise
        })
        enqueueCoalescedTrigger('fast', async () => { calls.push('fast') })

        await flushQueue()
        expect(calls).toEqual(['slow', 'fast'])
        gate.resolve()
        await flushQueue()
    })

    test('cleans up a failed queue so the key can run again', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        enqueueCoalescedTrigger('failure', async () => { throw new Error('boom') })
        await flushQueue()
        const recovered = vi.fn()
        enqueueCoalescedTrigger('failure', recovered)
        await flushQueue()

        expect(errorSpy).toHaveBeenCalledWith(
            '[trigger-queue] Unhandled queue error for failure:',
            expect.objectContaining({ message: 'boom' }),
        )
        expect(recovered).toHaveBeenCalledOnce()
        errorSpy.mockRestore()
    })
})
