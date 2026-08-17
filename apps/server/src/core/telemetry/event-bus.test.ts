import { describe, expect, test, vi } from 'vitest'
import { EventBus } from './event-bus.js'

describe('EventBus', () => {
  test('isolates listener failures and continues notifying other listeners', () => {
    const bus = new EventBus()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const healthyListener = vi.fn()
    bus.on('task:update', () => { throw new Error('persistence unavailable') })
    bus.on('task:update', healthyListener)

    expect(() => bus.emit('task:update', { id: 'task' })).not.toThrow()
    expect(healthyListener).toHaveBeenCalledWith({ id: 'task' })
    expect(errorSpy).toHaveBeenCalledWith(
      '[event-bus] Handler failed for task:update:',
      expect.objectContaining({ message: 'persistence unavailable' }),
    )
    errorSpy.mockRestore()
  })
})
