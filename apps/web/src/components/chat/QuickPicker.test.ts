import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import QuickPicker from './QuickPicker.vue'

const mocks = vi.hoisted(() => ({
  setActiveAgent: vi.fn(),
  setLastUsed: vi.fn(),
  listConversationsPaginated: vi.fn(),
  chatStore: { activeAgentId: 'current' as string | null },
  agents: [
    { id: 'favorite', name: 'Favorite', description: '', internalName: 'favorite', iconUrl: null, favorite: true, providerId: 'provider' },
    { id: 'recent', name: 'Recent', description: '', internalName: 'recent', iconUrl: null, favorite: false, providerId: 'provider' },
    { id: 'other', name: 'Other', description: '', internalName: 'other', iconUrl: null, favorite: false, providerId: 'provider' },
  ],
}))

vi.mock('../../stores/chat.store', () => ({ useChatStore: () => ({ ...mocks.chatStore, setActiveAgent: mocks.setActiveAgent }) }))
vi.mock('../../stores/agent-definitions.store', () => ({ useAgentDefinitionsStore: () => ({ agents: mocks.agents, get: (id: string) => mocks.agents.find(agent => agent.id === id) }) }))
vi.mock('../../stores/provider.store', () => ({ useProviderStore: () => ({ setLastUsed: mocks.setLastUsed }) }))
vi.mock('../../api/client', () => ({ api: { chat: { listConversationsPaginated: mocks.listConversationsPaginated } } }))

describe('QuickPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listConversationsPaginated.mockResolvedValue({ items: [{ agent_id: 'recent' }] })
  })

  it('shows favorites, recent agents, Free Chat, and switches in place', async () => {
    const wrapper = mount(QuickPicker, { attachTo: document.body, global: { stubs: { Icon: true } } })
    expect(wrapper.get('[aria-label="Switch agent"]').element.parentElement?.classList.contains('absolute')).toBe(true)
    expect(wrapper.get('[aria-label="Switch agent"]').element.parentElement?.classList.contains('-bottom-2')).toBe(true)
    expect(wrapper.get('[aria-label="Switch agent"]').element.parentElement?.classList.contains('-right-2')).toBe(true)
    vi.spyOn(wrapper.get('[aria-label="Switch agent"]').element.parentElement!, 'getBoundingClientRect').mockReturnValue({ top: 200, bottom: 232, left: 100, right: 132 } as DOMRect)
    await wrapper.get('[aria-label="Switch agent"]').trigger('click')
    expect((document.body.querySelector('[aria-label="Quick agent picker"]') as HTMLElement).style.top).toBe('240px')
    await vi.waitFor(() => expect(document.body.textContent).toContain('Recently used'))
    const text = document.body.textContent ?? ''
    expect(text.indexOf('Favorites')).toBeLessThan(text.indexOf('Recently used'))
    expect(text.indexOf('Recently used')).toBeLessThan(text.indexOf('Other chats'))
    expect(text).toContain('Free Chat')
    const recent = [...document.body.querySelectorAll('button')].find(button => button.textContent?.includes('Recent'))
    recent?.click()
    await nextTick()
    expect(mocks.setActiveAgent).toHaveBeenCalledWith('recent')
    wrapper.unmount()
  })
})
