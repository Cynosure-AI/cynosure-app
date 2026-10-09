import { useRouter } from 'vue-router'
import type { ProjectDto, ProjectTaskDto } from '@shared/types'
import { useChatStore } from '../stores/chat.store'
import { SK_CHAT_DRAFT_PREFIX } from '../utils/storage-keys'

/** Composer text that hands a board task to the agent. */
export function taskDraft(task: Pick<ProjectTaskDto, 'id' | 'title' | 'notes'>): string {
  return [
    `Work on the project task "${task.title}" (id=${task.id}).`,
    task.notes ? `\nNotes: ${task.notes}` : '',
    '\nMark it in_progress when you start and done when finished.',
  ].join('')
}

export function useProjectChat() {
  const chatStore = useChatStore()
  const router = useRouter()

  /**
   * Open an empty chat inside a project, using the given agent or the
   * project's default agent. A draft is placed in the composer for review.
   */
  async function startProjectChat(project: ProjectDto, options: { agentId?: string | null; draft?: string } = {}): Promise<void> {
    const agentId = options.agentId !== undefined ? options.agentId : project.defaultAgentId
    if (agentId !== undefined && agentId !== chatStore.activeAgentId) await chatStore.setActiveAgent(agentId)
    await chatStore.startNewChat({ projectId: project.id })
    if (options.draft) {
      try {
        localStorage.setItem(`${SK_CHAT_DRAFT_PREFIX}new:${chatStore.activeAgentId || 'default'}`, options.draft)
      } catch {
        // Drafts are a convenience; the chat still opens in the project.
      }
    }
    await router.push({ name: 'triggers-chat' })
  }

  return { startProjectChat }
}
