import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { expect, test, vi } from 'vitest'
import { addClient, removeClient, broadcast } from './ws.js'

test('Dream run updates reach activity clients without conversation subscriptions', () => {
    const client = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, send: vi.fn() })
    const socket = client as unknown as WebSocket
    addClient(socket)
    try {
        broadcast('memory:dream-updated', { id: 'run', status: 'running' })
        expect(client.send).toHaveBeenCalledWith(JSON.stringify({ event: 'memory:dream-updated', data: { id: 'run', status: 'running' } }))
    } finally {
        removeClient(socket)
    }
})
