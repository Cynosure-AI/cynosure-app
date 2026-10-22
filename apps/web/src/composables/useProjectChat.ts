import { useRouter } from 'vue-router'
import type { ProjectDto, ProjectTaskDto } from '@shared/types'
import { api } from '../api/client'
import { useChatStore, type PendingComposerFile } from '../stores/chat.store'
import { SK_CHAT_DRAFT_PREFIX } from '../utils/storage-keys'

/** Composer text that hands a board task to the agent. */
export function taskDraft(task: Pick<ProjectTaskDto, 'id' | 'title' | 'notes'>): string {
  return [
    `Work on the project task "${task.title}" (id=${task.id}).`,
    task.notes ? `\nNotes: ${task.notes}` : '',
    '\nMark it in_progress when you start and done when finished.',
  ].join('')
}

/** Composer source id of a task attachment; the composer reports these as used when it sends them. */
export const TASK_ATTACHMENT_SOURCE_PREFIX = 'task-attachment:'

export function taskAttachmentSourceId(projectId: string, attachmentId: string): string {
  return `${TASK_ATTACHMENT_SOURCE_PREFIX}${projectId}:${attachmentId}`
}

/** The task's attachments in composer form; files that can't be attached (e.g. unknown binaries) are skipped. */
async function loadTaskAttachments(projectId: string, taskId: string): Promise<PendingComposerFile[]> {
  const attachments = await api.projects.listTaskAttachments(projectId, taskId).catch(() => [])
  const files = await Promise.allSettled(attachments.map(async (attachment) => ({
    ...(await api.projects.taskAttachmentContent(projectId, taskId, attachment.id)),
    name: attachment.name,
    sourceId: taskAttachmentSourceId(projectId, attachment.id),
  })))
  return files.flatMap((file) => file.status === 'fulfilled' ? [file.value] : [])
}

export function useProjectChat() {
  const chatStore = useChatStore()
  const router = useRouter()

  /**
   * Open an empty chat inside a project, using the given agent or the
   * project's default agent. A draft, and the attachments of `taskId`, are
   * placed in the composer for review.
   */
  async function startProjectChat(project: ProjectDto, options: { agentId?: string | null; draft?: string; taskId?: string } = {}): Promise<void> {
    const agentId = options.agentId !== undefined ? options.agentId : project.defaultAgentId
    const attachments = options.taskId ? loadTaskAttachments(project.id, options.taskId) : Promise.resolve([])
    if (agentId !== undefined && agentId !== chatStore.activeAgentId) await chatStore.setActiveAgent(agentId)
    await chatStore.startNewChat({ projectId: project.id })
    chatStore.pendingComposerFiles = await attachments
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
