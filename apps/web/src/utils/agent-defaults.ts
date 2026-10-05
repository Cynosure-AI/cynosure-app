import type { AgentDefinition } from '@/api/types'

/** Behavior every newly created agent starts with, wherever it is created. */
export const NEW_AGENT_BEHAVIOR = {
  autoApproveTools: false,
  autoToolRouting: true,
  autoMemory: true,
  dreamingEnabled: true,
  generateTitle: true,
} as const satisfies Partial<AgentDefinition>
