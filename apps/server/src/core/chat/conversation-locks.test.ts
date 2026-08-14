import { describe, expect, test } from 'vitest'
import { withConversationLock } from './conversation-locks.js'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => { resolve = done })
    return { promise, resolve }
}

describe('conversation locks', () => {
    test('serializes sends for the same conversation', async () => {
        const firstGate = deferred<void>()
        const order: string[] = []
        const first = withConversationLock('same', async () => {
            order.push('first:start')
            await firstGate.promise
            order.push('first:end')
        })
        const second = withConversationLock('same', async () => {
            order.push('second:start')
        })

        await Promise.resolve()
        expect(order).toEqual(['first:start'])
        firstGate.resolve()
        await Promise.all([first, second])
        expect(order).toEqual(['first:start', 'first:end', 'second:start'])
    })

    test('continues the queue after a preceding send rejects', async () => {
        const first = withConversationLock('failure', async () => {
            throw new Error('send failed')
        })
        const second = withConversationLock('failure', async () => 'recovered')

        await expect(first).rejects.toThrow('send failed')
        await expect(second).resolves.toBe('recovered')
    })

    test('does not block unrelated conversations', async () => {
        const gate = deferred<void>()
        const blocked = withConversationLock('one', () => gate.promise)
        await expect(withConversationLock('two', async () => 'ready')).resolves.toBe('ready')
        gate.resolve()
        await blocked
    })
})
