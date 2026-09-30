import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { expect, test, vi } from 'vitest'
import { addClient, removeClient, broadcast, startToolRegistryUpdates } from './ws.js'

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


test('registry changes reach chat menus and coalesce a batch of discoveries', async () => {
    const { ToolRegistry } = await import('./core/tools/tool-registry.js')
    const registry = new ToolRegistry()
    const client = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, send: vi.fn() })
    const socket = client as unknown as WebSocket
    addClient(socket)
    const stop = startToolRegistryUpdates()
    try {
        for (const name of ['first', 'second']) {
            registry.register({ name, description: name, parameters: {}, timeout: 1000,
                execute: async () => ({ success: true, output: '' }) }, { id: 'mcp:installed', label: 'Installed' })
        }
        await Promise.resolve()
        expect(client.send).toHaveBeenCalledTimes(1)
        expect(client.send).toHaveBeenCalledWith(JSON.stringify({ event: 'tools:registry-changed', data: {} }))
        registry.unregisterByNamespace('mcp:installed')
        await Promise.resolve()
        expect(client.send).toHaveBeenCalledTimes(2)
        stop()
        registry.register({ name: 'later', description: '', parameters: {}, timeout: 1000,
            execute: async () => ({ success: true, output: '' }) })
        await Promise.resolve()
        expect(client.send).toHaveBeenCalledTimes(2)
    } finally {
        stop()
        removeClient(socket)
    }
})
