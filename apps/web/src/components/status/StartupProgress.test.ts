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

  test('summarizes MCP progress and only lists servers needing attention', async () => {
    const progress = ref<ServerStartupProgress>({ phase: 'mcp', message: 'Connecting MCP servers…', elapsedMs: 12500,
      mcpServers: [
        { id: 'a', name: 'Files', status: 'connected', elapsedMs: 2400, toolCount: 3 },
        { id: 'b', name: 'Browser', status: 'connecting', elapsedMs: 11200 },
        { id: 'c', name: 'Mail', status: 'auth-required', elapsedMs: 4000 },
        { id: 'd', name: 'Offline', status: 'error', elapsedMs: 6000 },
        { id: 'e', name: 'Search', status: 'connecting', elapsedMs: 9000 },
        { id: 'f', name: 'Calendar', status: 'connecting', elapsedMs: 9000 },
      ] })
    state.progress = progress
    const wrapper = mount(StartupProgress)
    expect(wrapper.get('[data-testid="startup-count"]').text()).toBe('3/6')
    const waiting = wrapper.get('[data-testid="startup-waiting"]')
    expect(waiting.text()).toBe('Waiting on Browser, Search +111s')
    expect(waiting.attributes('title')).toBe('Browser · 11s\nSearch · 9s\nCalendar · 9s')
    // Connected servers are not listed individually.
    expect(wrapper.findAll('li').map(row => row.text())).toEqual(['Mailneeds authorization', 'Offlinecould not connect'])
    expect(wrapper.text()).toContain('1 connected · 1 needs auth · 1 failed · 12s')
    const bar = wrapper.get('[role="progressbar"]')
    const mcpProgress = Number(bar.attributes('aria-valuenow'))
    progress.value = { ...progress.value, phase: 'channels', message: 'Starting messaging channels…' }
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[role="status"]').text()).toBe('Starting messaging channels…')
    expect(wrapper.find('[data-testid="startup-count"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="startup-waiting"]').exists()).toBe(false)
    expect(Number(bar.attributes('aria-valuenow'))).toBeGreaterThan(mcpProgress)
  })
})
