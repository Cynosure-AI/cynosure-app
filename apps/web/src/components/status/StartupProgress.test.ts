import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ServerStartupProgress } from '@shared/types'
import StartupProgress from './StartupProgress.vue'

const state = vi.hoisted(() => ({ progress: null as unknown }))
vi.mock('../../composables/useServerStartupError', () => ({
  useServerStartupError: () => ({ startupProgress: state.progress }),
}))

describe('StartupProgress', () => {
  beforeEach(() => { state.progress = ref<ServerStartupProgress | null>(null) })

  test('shows connection status before the server responds', () => {
    const wrapper = mount(StartupProgress)
    expect(wrapper.get('[role="status"]').text()).toBe('Connecting to server…')
    expect(wrapper.find('ul').exists()).toBe(false)
  })

  test('shows each parallel MCP result and updates the active stage', async () => {
    const progress = ref<ServerStartupProgress>({ phase: 'mcp', message: 'Connecting MCP servers…', elapsedMs: 12500,
      mcpServers: [
        { id: 'a', name: 'Files', status: 'connected', elapsedMs: 2400, toolCount: 3 },
        { id: 'b', name: 'Browser', status: 'connecting', elapsedMs: 11200 },
        { id: 'c', name: 'Mail', status: 'auth-required', elapsedMs: 4000 },
        { id: 'd', name: 'Offline', status: 'error', elapsedMs: 6000 },
      ] })
    state.progress = progress
    const wrapper = mount(StartupProgress)
    expect(wrapper.get('[data-testid="startup-count"]').text()).toBe('3/4')
    const rows = wrapper.findAll('li').map(row => row.text())
    // Only connecting servers past the slow threshold show their timer.
    expect(rows).toEqual(['FilesConnected', 'BrowserConnecting11s', 'MailAuthorization needed', 'OfflineCould not connect'])
    expect(wrapper.findAll('li')[0]!.attributes('title')).toBe('Files\nConnected · 2s · 3 tools')
    expect(wrapper.text()).toContain('1 connected · 1 needs auth · 1 failed · 12s')
    const bar = wrapper.get('[role="progressbar"]')
    const mcpProgress = Number(bar.attributes('aria-valuenow'))
    progress.value = { ...progress.value, phase: 'channels', message: 'Starting messaging channels…' }
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[role="status"]').text()).toBe('Starting messaging channels…')
    expect(wrapper.find('[data-testid="startup-count"]').exists()).toBe(false)
    expect(Number(bar.attributes('aria-valuenow'))).toBeGreaterThan(mcpProgress)
  })
})
