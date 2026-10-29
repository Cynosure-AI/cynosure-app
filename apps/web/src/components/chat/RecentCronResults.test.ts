import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import RecentCronResults from './RecentCronResults.vue'

const mocks = vi.hoisted(() => ({ recentResults: vi.fn(), push: vi.fn() }))
vi.mock('../../api/client', () => ({ api: { cronJobs: { recentResults: mocks.recentResults } } }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))

const result = (id: string, content = 'Finished the scheduled check.') => ({
  conversationId: id, title: `Task ${id}`, agentId: null, content, completedAt: Date.now(),
})
const wrappers: ReturnType<typeof mount>[] = []
function render() {
  const wrapper = mount(RecentCronResults, {
    props: { introStartedAt: performance.now() },
    global: { stubs: { Icon: true, RouterLink: { template: '<a><slot /></a>' } } },
  })
  wrappers.push(wrapper)
  return wrapper
}

beforeEach(() => { vi.useFakeTimers(); mocks.recentResults.mockReset().mockResolvedValue([]) })
afterEach(() => { wrappers.forEach(wrapper => wrapper.unmount()); wrappers.length = 0; vi.useRealTimers() })

test('shows result previews with staggered delays and opens the saved conversation', async () => {
  mocks.recentResults.mockResolvedValue([result('1'), result('2'), result('3')])
  const wrapper = render()
  await flushPromises()
  const cards = wrapper.findAll('.cron-result-card')
  expect(cards).toHaveLength(3)
  expect(cards[0].text()).toContain('Finished the scheduled check.')
  const delays = cards.map(card => Number.parseFloat((card.element as HTMLElement).style.animationDelay))
  expect(delays[1] - delays[0]).toBeCloseTo(120, 0)
  expect(delays[2] - delays[1]).toBeCloseTo(120, 0)
  await cards[0].trigger('click')
  expect(mocks.push).toHaveBeenCalledWith({ name: 'conversation', params: { conversationId: '1' } })
})

test('keeps readable details and truncates long replies with an ellipsis', async () => {
  mocks.recentResults.mockResolvedValue([result('1', `## Daily report\n**Updates:** [details](https://example.com)\n${'Relevant information. '.repeat(50)}`)])
  const wrapper = render()
  await flushPromises()
  const preview = wrapper.get('.cron-result-preview').text()
  expect(preview).toContain('Daily report\nUpdates: details')
  expect(preview.length).toBeGreaterThan(520)
  expect(preview.length).toBeLessThanOrEqual(601)
  expect(preview.endsWith('…')).toBe(true)
})

test('hides empty history, refreshes results and preserves them on a transient failure', async () => {
  const wrapper = render()
  await flushPromises()
  expect(wrapper.find('section').exists()).toBe(false)
  mocks.recentResults.mockResolvedValue([result('new')])
  await vi.advanceTimersByTimeAsync(30_000)
  expect(wrapper.get('.cron-result-card').text()).toContain('Task new')
  mocks.recentResults.mockRejectedValue(new Error('Offline'))
  await vi.advanceTimersByTimeAsync(30_000)
  expect(wrapper.findAll('.cron-result-card')).toHaveLength(1)
  wrapper.unmount()
  const calls = mocks.recentResults.mock.calls.length
  await vi.advanceTimersByTimeAsync(30_000)
  expect(mocks.recentResults).toHaveBeenCalledTimes(calls)
})
