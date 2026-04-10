import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed } from 'vue'
import { api, type ExecutionStepRecord } from '../api/client'

export interface ToolNamespace {
  id: string
  label: string
}

export interface ToolInfo {
  name: string
  description: string
  autoApprove: boolean
  namespace: ToolNamespace
}

export interface ToolCallDisplay {
  name: string
  arguments: string
}

export interface HITLRequest {
  taskId: string
  conversationId?: string
  toolCalls: ToolCallDisplay[]
}

export interface ExecutionStep {
  iteration: number
  status: string
  message?: string
  streamingChoosing?: string
  toolCalls?: ToolCallDisplay[]
  results?: { name: string; success: boolean; output: string; error?: string; images?: string[] }[]
  timestamp: number
  /** Task ID — unique per AgentExecutor run, used to match update events to the correct step */
  taskId?: string
  /** Sub-agent codename (e.g. "researcher") */
  maCodename?: string
  /** Sub-agent display name */
  maAgentName?: string
  /** Orchestrator-level phase (planning, synthesizing, etc.) */
  maPhase?: string
}

export interface EventLogEntry {
  timestamp: number
  event: string
  data: Record<string, unknown>
}

export const useAgentStore = defineStore('agent', () => {
  const isExecuting = ref(false)
  const activeTaskId = ref<string | null>(null)
  const pendingHITL = ref<HITLRequest | null>(null)
  const executionSteps = ref<ExecutionStep[]>([])
  const toolApprovals = ref<Record<string, boolean>>({})

  const eventLog = ref<EventLogEntry[]>([])
  const availableTools = ref<ToolInfo[]>([])
  const selectedToolNames = ref<string[]>([])

  // Per-conversation execution state for background support
  const executionConversationId = ref<string | null>(null)
  const stepsPerConversation = new Map<string, ExecutionStep[]>()
  const eventsPerConversation = new Map<string, EventLogEntry[]>()

  const hasSteps = computed(() => executionSteps.value.length > 0)

  async function loadToolApprovals(): Promise<void> {
    toolApprovals.value = await api.agent.getToolApprovals()
  }

  async function loadTools(): Promise<void> {
    availableTools.value = await api.agent.listTools()

    // Sync approval state from server
    const approvalMap: Record<string, boolean> = {}
    for (const tool of availableTools.value) {
      approvalMap[tool.name] = tool.autoApprove
    }
    toolApprovals.value = approvalMap

    const availableNames = new Set(availableTools.value.map((tool) => tool.name))
    const availableKeys = new Set(availableTools.value.map((tool) => `${tool.namespace.id}::${tool.name}`))
    const filtered = selectedToolNames.value.filter(
      (name) => availableNames.has(name) || availableKeys.has(name)
    )

    // Keep only previously selected tools that still exist; default to none.
    selectedToolNames.value = filtered
  }

  function toggleTool(name: string): void {
    if (!availableTools.value.some((tool) => tool.name === name)) return

    if (selectedToolNames.value.includes(name)) {
      selectedToolNames.value = selectedToolNames.value.filter((n) => n !== name)
      return
    }

    selectedToolNames.value = [...selectedToolNames.value, name]
  }

  function selectAllTools(): void {
    selectedToolNames.value = availableTools.value.map((tool) => tool.name)
  }

  function clearSelectedTools(): void {
    selectedToolNames.value = []
  }

  function isToolSelected(name: string): boolean {
    return selectedToolNames.value.includes(name)
  }

  async function setToolApproval(toolName: string, autoApprove: boolean): Promise<void> {
    await api.agent.setToolApproval(toolName, autoApprove)
    toolApprovals.value = { ...toolApprovals.value, [toolName]: autoApprove }
  }

  function isToolAutoApproved(toolName: string): boolean {
    return toolApprovals.value[toolName] ?? false
  }

  function handleHITLRequest(data: HITLRequest): void {
    pendingHITL.value = data
  }

  function dismissHITL(): void {
    pendingHITL.value = null
  }

  async function respondHITL(approved: boolean, reason?: string, approvalType?: 'once' | 'session' | 'always'): Promise<void> {
    if (!pendingHITL.value) return
    const toolNames = [...new Set(pendingHITL.value.toolCalls.map(tc => tc.name))]
    await api.agent.respondHITL(
      pendingHITL.value.taskId,
      approved,
      reason,
      approvalType,
      pendingHITL.value.conversationId,
      toolNames
    )
    pendingHITL.value = null
  }

  function handleExecutionUpdate(data: { event: string; data: Record<string, unknown> }): void {
    const eventData = data.data
    const taskId = eventData.taskId as string | undefined
    const convId = eventData.conversationId as string | undefined

    // Log events
    eventLog.value.push({
      timestamp: Date.now(),
      event: data.event,
      data: eventData
    })
    if (eventLog.value.length > 200) {
      eventLog.value = eventLog.value.slice(-200)
    }

    // Also log to per-conversation events
    if (convId) {
      if (!eventsPerConversation.has(convId)) eventsPerConversation.set(convId, [])
      eventsPerConversation.get(convId)!.push({
        timestamp: Date.now(),
        event: data.event,
        data: eventData
      })
    }

    switch (data.event) {
      case 'task:started':
        // Sub-agent task:started should NOT reset overall execution state
        if (eventData.maCodename) break
        isExecuting.value = true
        activeTaskId.value = taskId || null
        if (convId) {
          executionConversationId.value = convId
        }
        // Don't clear executionSteps — pre-task steps (e.g. memory-retrieved) should survive.
        // Steps are cleared at message-send time instead.
        break

      case 'task:completed':
      case 'task:error':
        // Sub-agent completion doesn't stop overall execution
        if (eventData.maCodename) break
        isExecuting.value = false
        activeTaskId.value = null
        if (convId || executionConversationId.value) {
          const cid = convId || executionConversationId.value!
          stepsPerConversation.set(cid, [...executionSteps.value])
        }
        break

      case 'step:status':
        executionSteps.value.push({
          iteration: eventData.iteration as number,
          status: eventData.status as string,
          message: eventData.message as string,
          timestamp: Date.now(),
          taskId: taskId || undefined,
          maCodename: (eventData.maCodename as string) || undefined,
          maAgentName: (eventData.maAgentName as string) || undefined,
        })
        if (convId || executionConversationId.value) {
          const cid = convId || executionConversationId.value!
          stepsPerConversation.set(cid, [...executionSteps.value])
        }
        break

      case 'step:choosing-chunk':
        appendToLastStepByTask(taskId, 'streamingChoosing', eventData.chunk as string)
        break

      case 'step:tools-chosen': {
        const rawCalls = eventData.toolCalls as Array<{
          function?: { name: string; arguments: string }
          name?: string
          arguments?: string
        }>
        const mapped: ToolCallDisplay[] = (rawCalls || []).map((tc) => ({
          name: tc.function?.name || tc.name || '',
          arguments: tc.function?.arguments || tc.arguments || ''
        }))
        updateLastStepByTask(taskId, { toolCalls: mapped })
        break
      }

      case 'step:executed':
        updateLastStepByTask(taskId, {
          results: eventData.results as ExecutionStep['results']
        })
        break

    }
  }

  /** Find the last step matching the given taskId (or last step with no taskId when taskId is undefined). */
  function findLastStepByTask(taskId: string | undefined): ExecutionStep | undefined {
    const steps = executionSteps.value
    for (let i = steps.length - 1; i >= 0; i--) {
      if (taskId ? steps[i].taskId === taskId : !steps[i].taskId) return steps[i]
    }
    // Fallback to absolute last step
    return steps.length ? steps[steps.length - 1] : undefined
  }

  function updateLastStepByTask(taskId: string | undefined, patch: Partial<ExecutionStep>): void {
    const step = findLastStepByTask(taskId)
    if (step) Object.assign(step, patch)
  }

  function appendToLastStepByTask(taskId: string | undefined, field: 'streamingChoosing', chunk: string): void {
    const step = findLastStepByTask(taskId)
    if (step) step[field] = (step[field] || '') + chunk
  }

  function clearExecution(): void {
    executionSteps.value = []
    eventLog.value = []
    isExecuting.value = false
    activeTaskId.value = null
    pendingHITL.value = null
    executionConversationId.value = null
  }

  /** Reset execution control state without wiping accumulated step history.
   * Use this when starting a new turn so previous turns' tool-group cards
   * remain visible while the new turn executes. */
  function clearExecutionState(): void {
    isExecuting.value = false
    activeTaskId.value = null
    pendingHITL.value = null
    executionConversationId.value = null
  }

  async function restoreForConversation(conversationId: string): Promise<void> {
    const savedSteps = stepsPerConversation.get(conversationId)
    const savedEvents = eventsPerConversation.get(conversationId)

    if (savedSteps?.length) {
      executionSteps.value = [...savedSteps]
      eventLog.value = savedEvents ? [...savedEvents] : []
      isExecuting.value =
        executionConversationId.value === conversationId && isExecuting.value
    } else {
      // Try loading from DB (survives page reload)
      executionSteps.value = []
      eventLog.value = []
      isExecuting.value = false
      await loadStepsFromApi(conversationId)
    }

    // Always check DB for a pending HITL request — needed after a hard reload
    // (the live WS event will have been lost, but the DB entry persists until resolved)
    if (!pendingHITL.value) {
      loadHITLFromApi(conversationId)
    }
  }

  async function loadHITLFromApi(conversationId: string): Promise<void> {
    try {
      const pending = await api.chat.getPendingHITL(conversationId)
      if (pending) {
        pendingHITL.value = { taskId: pending.taskId, toolCalls: pending.toolCalls }
      }
    } catch {
      // ignore
    }
  }

  async function loadStepsFromApi(conversationId: string): Promise<void> {
    try {
      const rows = await api.chat.getExecutionSteps(conversationId)
      if (!rows.length) return
      // Only apply if still viewing same conversation
      if (executionSteps.value.length > 0) return
      const mapped: ExecutionStep[] = rows.map((r: ExecutionStepRecord) => ({
        iteration: r.iteration,
        status: r.status,
        message: r.message || undefined,
        toolCalls: r.toolCalls as ToolCallDisplay[] | undefined,
        results: r.results as ExecutionStep['results'],
        taskId: r.taskId || undefined,
        maCodename: r.maCodename || undefined,
        maAgentName: r.maAgentName || undefined,
        maPhase: r.maPhase || undefined,
        timestamp: r.createdAt,
      }))
      executionSteps.value = mapped
      stepsPerConversation.set(conversationId, mapped)
    } catch {
      // API not available or conversation has no steps — ignore
    }
  }

  return {
    isExecuting,
    activeTaskId,
    pendingHITL,
    executionSteps,
    toolApprovals,
    eventLog,
    availableTools,
    selectedToolNames,
    hasSteps,
    loadToolApprovals,
    loadTools,
    toggleTool,
    selectAllTools,
    clearSelectedTools,
    isToolSelected,
    setToolApproval,
    isToolAutoApproved,
    handleHITLRequest,
    dismissHITL,
    respondHITL,
    handleExecutionUpdate,
    clearExecution,
    clearExecutionState,
    restoreForConversation,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAgentStore, import.meta.hot))
}
