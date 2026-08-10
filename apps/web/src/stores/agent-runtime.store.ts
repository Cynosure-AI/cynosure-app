import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '../api/client'
import type { ExecutionStepRecord, PlanningState } from '../api/types'
import { isAutoManagedBuiltInToolName } from '../utils/internal-tools'

export interface ToolNamespace {
  id: string
  label: string
}

export interface ToolBehaviorAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface ToolInfo {
  key: string
  name: string
  executionName: string
  description: string
  parameters: Record<string, unknown>
  annotations?: ToolBehaviorAnnotations
  autoApprove: boolean
  namespace: ToolNamespace
  ambiguous: boolean
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
  /** Sub-agent internal name (e.g. "researcher") */
  maCodename?: string
  /** Sub-agent display name */
  maAgentName?: string
  /** Unique id for one sub-agent spawn invocation. */
  maInvocationId?: string
  /** Orchestrator-level phase (planning, synthesizing, etc.) */
  maPhase?: string
}

export const useAgentStore = defineStore('agent', () => {
  const isExecuting = ref(false)
  const activeTaskId = ref<string | null>(null)
  /** Queue of pending HITL requests. Multiple subagents can each enqueue one simultaneously. */
  const hitlQueue = ref<HITLRequest[]>([])
  const activeHITLQueue = computed<HITLRequest[]>(() => {
    const convId = activeViewConversationId.value
    if (!convId) return hitlQueue.value.filter((request) => !request.conversationId)
    return hitlQueue.value.filter((request) => !request.conversationId || request.conversationId === convId)
  })
  /** The first pending HITL request for the currently viewed conversation. */
  const pendingHITL = computed<HITLRequest | null>(() => activeHITLQueue.value[0] ?? null)
  const executionSteps = ref<ExecutionStep[]>([])
  const planningState = ref<PlanningState | null>(null)
  const toolApprovals = ref<Record<string, boolean>>({})

  const availableTools = ref<ToolInfo[]>([])
  const selectedToolNames = ref<string[]>([])

  function isSelectableTool(tool: ToolInfo): boolean {
    return !(tool.namespace.id === 'builtin' && isAutoManagedBuiltInToolName(tool.name))
  }

  // Per-conversation execution state for background support
  const executionConversationId = ref<string | null>(null)
  const executingConversationIds = ref<Set<string>>(new Set())
  /** The conversation the user is currently viewing — used to filter live events. */
  const activeViewConversationId = ref<string | null>(null)
  const stepsPerConversation = new Map<string, ExecutionStep[]>()
  const planningPerConversation = new Map<string, PlanningState | null>()

  /** Set of conversation IDs currently blocking on a HITL tool-approval request. */
  const awaitingHITLConvIds = ref<Set<string>>(new Set())
  /** Maps taskId → conversationId so we can clear the set when HITL is resolved by taskId. */
  const hitlTaskToConv = new Map<string, string>()

  /** Keep Maps bounded to avoid memory leaks in long-lived sessions. */
  const MAX_CACHED_CONVERSATIONS = 50
  function pruneConversationCache(): void {
    while (stepsPerConversation.size > MAX_CACHED_CONVERSATIONS) {
      const oldest = stepsPerConversation.keys().next().value
      if (oldest !== undefined) stepsPerConversation.delete(oldest)
      else break
    }
    while (planningPerConversation.size > MAX_CACHED_CONVERSATIONS) {
      const oldest = planningPerConversation.keys().next().value
      if (oldest !== undefined) planningPerConversation.delete(oldest)
      else break
    }
  }

  const hasSteps = computed(() => executionSteps.value.length > 0)
  const hasPlanningTasks = computed(() => Boolean(planningState.value?.items.length))
  const activeConversationIsExecuting = computed(() => {
    const conversationId = activeViewConversationId.value
    return Boolean(conversationId && executingConversationIds.value.has(conversationId))
  })
  const liveExecutionConversationIds = computed(() => Array.from(executingConversationIds.value))

  async function loadToolApprovals(): Promise<void> {
    toolApprovals.value = await api.agent.getToolApprovals()
  }

  async function loadTools(): Promise<void> {
    availableTools.value = await api.agent.listTools()

    // Sync approval state from server
    const approvalMap: Record<string, boolean> = {}
    for (const tool of availableTools.value) {
      approvalMap[tool.executionName] = tool.autoApprove
    }
    toolApprovals.value = approvalMap

    const availableKeys = new Set(
      availableTools.value
        .filter((tool) => !(tool.namespace.id === 'builtin' && isAutoManagedBuiltInToolName(tool.name)))
        .map((tool) => tool.key)
    )
    const filtered = selectedToolNames.value.filter((name) => availableKeys.has(name))

    // Keep only previously selected tools that still exist; default to none.
    selectedToolNames.value = filtered
  }

  function toggleTool(name: string): void {
    if (!availableTools.value.some((tool) => tool.key === name && isSelectableTool(tool))) return

    if (selectedToolNames.value.includes(name)) {
      selectedToolNames.value = selectedToolNames.value.filter((n) => n !== name)
      return
    }

    selectedToolNames.value = [...selectedToolNames.value, name]
  }

  function selectAllTools(): void {
    selectedToolNames.value = availableTools.value.filter(isSelectableTool).map((tool) => tool.key)
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
    // Avoid duplicate entries for the same taskId
    if (!hitlQueue.value.some(h => h.taskId === data.taskId)) {
      hitlQueue.value = [...hitlQueue.value, data]
    }
    if (data.conversationId) {
      awaitingHITLConvIds.value = new Set([...awaitingHITLConvIds.value, data.conversationId])
      if (data.taskId) hitlTaskToConv.set(data.taskId, data.conversationId)
    }
  }

  /** Remove a HITL request by taskId — used when resolved externally or via WS event. */
  function dismissHITLByTaskId(taskId?: string): void {
    if (!taskId) return
    hitlQueue.value = hitlQueue.value.filter(h => h.taskId !== taskId)
    const convId = hitlTaskToConv.get(taskId)
    if (convId) {
      // Only clear the awaiting indicator if no remaining requests exist for this conversation
      if (!hitlQueue.value.some(h => h.conversationId === convId)) {
        awaitingHITLConvIds.value.delete(convId)
        awaitingHITLConvIds.value = new Set(awaitingHITLConvIds.value)
      }
      hitlTaskToConv.delete(taskId)
    }
  }

  function dismissHITLByConversation(conversationId?: string): void {
    if (!conversationId) return
    const removedTaskIds = hitlQueue.value
      .filter((request) => request.conversationId === conversationId)
      .map((request) => request.taskId)
    if (!removedTaskIds.length && !awaitingHITLConvIds.value.has(conversationId)) return

    hitlQueue.value = hitlQueue.value.filter((request) => request.conversationId !== conversationId)
    for (const taskId of removedTaskIds) {
      hitlTaskToConv.delete(taskId)
    }
    awaitingHITLConvIds.value.delete(conversationId)
    awaitingHITLConvIds.value = new Set(awaitingHITLConvIds.value)
  }

  async function respondHITL(approved: boolean, reason?: string, approvalType?: 'once' | 'session' | 'always', overrideToolNames?: string[]): Promise<void> {
    if (!pendingHITL.value) return
    const toolNames = overrideToolNames || [...new Set(pendingHITL.value.toolCalls.map(tc => tc.name))]
    const convId = pendingHITL.value.conversationId
    const taskId = pendingHITL.value.taskId
    await api.agent.respondHITL(
      taskId,
      approved,
      reason,
      approvalType,
      convId,
      toolNames
    )
    // Remove this specific request from the queue
    hitlQueue.value = hitlQueue.value.filter(h => h.taskId !== taskId)
    if (taskId) hitlTaskToConv.delete(taskId)
    // Only clear awaitingHITLConvIds for this conversation if no more requests remain for it
    if (convId && !hitlQueue.value.some(h => h.conversationId === convId)) {
      awaitingHITLConvIds.value.delete(convId)
      awaitingHITLConvIds.value = new Set(awaitingHITLConvIds.value)
    }
  }

  /** Build an ExecutionStep from a raw WS event payload. */
  function buildStep(eventData: Record<string, unknown>, taskId?: string): ExecutionStep {
    return {
      iteration: eventData.iteration as number,
      status: eventData.status as string,
      message: eventData.message as string,
      timestamp: Date.now(),
      taskId: taskId || undefined,
      maCodename: (eventData.maCodename as string) || undefined,
      maAgentName: (eventData.maAgentName as string) || undefined,
      maInvocationId: (eventData.maInvocationId as string) || undefined,
    }
  }

  /** Find the last step matching a taskId in an arbitrary steps array (for background caching). */
  function findLastStepInArray(steps: ExecutionStep[], taskId: string | undefined): ExecutionStep | undefined {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (taskId ? steps[i].taskId === taskId : !steps[i].taskId) return steps[i]
    }
    return steps.length ? steps[steps.length - 1] : undefined
  }

  /** Find the last step matching the given taskId (or last step with no taskId when taskId is undefined). */
  function findLastStepByTask(taskId: string | undefined): ExecutionStep | undefined {
    const steps = executionSteps.value
    for (let i = steps.length - 1; i >= 0; i--) {
      if (taskId ? steps[i].taskId === taskId : !steps[i].taskId) return steps[i]
    }
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

  /** Shared logic for task completion / error events. */
  function onTaskEnd(isForActiveView: boolean, convId: string | undefined, maCodename: string | undefined): void {
    if (maCodename) return // Sub-agent completion doesn't stop overall execution
    if (convId) {
      executingConversationIds.value.delete(convId)
      executingConversationIds.value = new Set(executingConversationIds.value)
    }
    if (isForActiveView) {
      isExecuting.value = false
      activeTaskId.value = null
    }
    // Clear any awaiting-HITL indicator for this conversation
    if (convId && awaitingHITLConvIds.value.has(convId)) {
      awaitingHITLConvIds.value.delete(convId)
      awaitingHITLConvIds.value = new Set(awaitingHITLConvIds.value)
    }
    if (convId || executionConversationId.value) {
      const cid = convId || executionConversationId.value!
      if (isForActiveView) {
        stepsPerConversation.set(cid, [...executionSteps.value])
      }
      pruneConversationCache()
    }
  }

  /** Apply a step patch to the last step of a background conversation. */
  function patchBgStep(convId: string, taskId: string | undefined, patch: Partial<ExecutionStep>): void {
    const bgSteps = stepsPerConversation.get(convId)
    if (!bgSteps?.length) return
    const step = findLastStepInArray(bgSteps, taskId)
    if (step) Object.assign(step, patch)
  }

  function handleExecutionUpdate(data: { event: string; data: Record<string, unknown> }): void {
    const eventData = data.data
    const taskId = eventData.taskId as string | undefined
    const convId = eventData.conversationId as string | undefined
    if (!convId) return

    const viewingConvId = activeViewConversationId.value
    if (viewingConvId && convId !== viewingConvId && !executingConversationIds.value.has(convId)) {
      return
    }
    // Only treat an event as "active view" when it targets the currently
    // open conversation. If no chat is open (viewingConvId = null), background
    // conversation events should not flip UI execution state.
    const isForActiveView = Boolean(viewingConvId && convId === viewingConvId)

    switch (data.event) {
      case 'task:started':
        if (eventData.maCodename) break
        if (convId) {
          executingConversationIds.value = new Set([...executingConversationIds.value, convId])
        }
        if (isForActiveView) {
          isExecuting.value = true
          activeTaskId.value = taskId || null
        }
        if (convId) executionConversationId.value = convId
        break

      case 'task:completed':
      case 'task:error':
        onTaskEnd(isForActiveView, convId, eventData.maCodename as string | undefined)
        break

      case 'step:status': {
        const step = buildStep(eventData, taskId)
        const previousStep = isForActiveView
          ? findLastStepByTask(taskId)
          : convId ? findLastStepInArray(stepsPerConversation.get(convId) || [], taskId) : undefined
        if (step.status === 'executing' && previousStep?.iteration === step.iteration && previousStep.toolCalls?.length) {
          step.toolCalls = previousStep.toolCalls
        }
        if (isForActiveView) executionSteps.value.push(step)
        const cid = convId || executionConversationId.value
        if (cid) {
          if (isForActiveView) {
            stepsPerConversation.set(cid, [...executionSteps.value])
          } else {
            const bgSteps = stepsPerConversation.get(cid) || []
            bgSteps.push(step)
            stepsPerConversation.set(cid, bgSteps)
          }
        }
        break
      }

      case 'step:choosing-chunk':
        if (isForActiveView) {
          appendToLastStepByTask(taskId, 'streamingChoosing', eventData.chunk as string)
        }
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
        if (isForActiveView) {
          updateLastStepByTask(taskId, { toolCalls: mapped })
        } else if (convId) {
          patchBgStep(convId, taskId, { toolCalls: mapped })
        }
        break
      }

      case 'step:executed':
        if (isForActiveView) {
          updateLastStepByTask(taskId, { results: eventData.results as ExecutionStep['results'] })
        } else if (convId) {
          patchBgStep(convId, taskId, { results: eventData.results as ExecutionStep['results'] })
        }
        break

      case 'step:hitl-denied':
        if (isForActiveView) {
          updateLastStepByTask(taskId, { status: 'denied' })
        } else if (convId) {
          patchBgStep(convId, taskId, { status: 'denied' })
        }
        break
    }
  }

  function handlePlanningStateUpdated(data: unknown): void {
    const state = data as PlanningState | null
    if (!state?.conversationId) return
    planningPerConversation.set(state.conversationId, state)
    pruneConversationCache()
    if (activeViewConversationId.value === state.conversationId) {
      planningState.value = state
    }
  }

  function clearExecution(): void {
    executionSteps.value = []
    planningState.value = null
    isExecuting.value = false
    activeTaskId.value = null
    executionConversationId.value = null
  }

  function clearConversationExecution(conversationId: string): void {
    stepsPerConversation.delete(conversationId)
    planningPerConversation.delete(conversationId)
    dismissHITLByConversation(conversationId)
    setConversationExecutionState(conversationId, false)
    if (activeViewConversationId.value === conversationId) {
      executionSteps.value = []
      planningState.value = null
      isExecuting.value = false
      activeTaskId.value = null
    }
    if (executionConversationId.value === conversationId) {
      executionConversationId.value = null
    }
  }

  function truncateConversationExecution(conversationId: string, createdAt: number): void {
    const cachedSteps = stepsPerConversation.get(conversationId) || []
    const remainingSteps = cachedSteps.filter((step) => step.timestamp < createdAt)
    if (remainingSteps.length) {
      stepsPerConversation.set(conversationId, remainingSteps)
    } else {
      stepsPerConversation.delete(conversationId)
    }

    planningPerConversation.delete(conversationId)
    dismissHITLByConversation(conversationId)
    setConversationExecutionState(conversationId, false)

    if (activeViewConversationId.value === conversationId) {
      executionSteps.value = executionSteps.value.filter((step) => step.timestamp < createdAt)
      planningState.value = null
      isExecuting.value = false
      activeTaskId.value = null
    }
    if (executionConversationId.value === conversationId) {
      executionConversationId.value = null
    }
  }

  /** Set which conversation the user is currently viewing.
   * Execution events for other conversations will be cached but not shown. */
  function setActiveViewConversation(conversationId: string | null): void {
    activeViewConversationId.value = conversationId
    if (!conversationId) {
      executionSteps.value = []
      planningState.value = null
      isExecuting.value = false
      activeTaskId.value = null
      return
    }
    executionSteps.value = [...(stepsPerConversation.get(conversationId) || [])]
    planningState.value = planningPerConversation.get(conversationId) ?? null
    isExecuting.value = executingConversationIds.value.has(conversationId)
  }

  /** Reset execution control state without wiping accumulated step history.
   * Use this when starting a new turn so previous turns' tool-group cards
   * remain visible while the new turn executes. */
  function clearExecutionState(): void {
    isExecuting.value = false
    activeTaskId.value = null
    executionConversationId.value = null
  }

  function clearPlanningState(): void {
    planningState.value = null
  }

  function setConversationExecutionState(conversationId: string, executing: boolean, taskId?: string | null): void {
    if (executing) {
      executionConversationId.value = conversationId
      executingConversationIds.value = new Set([...executingConversationIds.value, conversationId])
      if (activeViewConversationId.value === conversationId) {
        isExecuting.value = true
        activeTaskId.value = taskId || activeTaskId.value
      }
      return
    }

    if (executionConversationId.value === conversationId) {
      executionConversationId.value = null
    }
    executingConversationIds.value.delete(conversationId)
    executingConversationIds.value = new Set(executingConversationIds.value)
    if (activeViewConversationId.value === conversationId) {
      isExecuting.value = false
      activeTaskId.value = null
    }
  }

  function isConversationExecuting(conversationId: string | null | undefined): boolean {
    return Boolean(conversationId && executingConversationIds.value.has(conversationId))
  }

  async function restoreForConversation(conversationId: string): Promise<void> {
    const savedSteps = stepsPerConversation.get(conversationId)
    if (planningPerConversation.has(conversationId)) {
      planningState.value = planningPerConversation.get(conversationId) ?? null
    } else {
      planningState.value = null
    }

    if (savedSteps?.length) {
      executionSteps.value = [...savedSteps]
      isExecuting.value = executingConversationIds.value.has(conversationId)
    } else {
      // Try loading from DB (survives page reload)
      executionSteps.value = []
      isExecuting.value = false
      await loadStepsFromApi(conversationId)
    }

    // Always check DB for pending HITL requests — needed after a hard reload
    // (live WS events are lost on reload, but DB entries persist until resolved)
    if (!hitlQueue.value.some(h => h.conversationId === conversationId)) {
      await loadHITLFromApi(conversationId)
    }

    await loadPlanningStateFromApi(conversationId)
  }

  async function loadHITLFromApi(conversationId: string): Promise<void> {
    try {
      const rows = await api.chat.getPendingHITL(conversationId)
      if (!rows.length) return
      let changed = false
      for (const pending of rows) {
        if (!hitlQueue.value.some(h => h.taskId === pending.taskId)) {
          hitlQueue.value = [...hitlQueue.value, { taskId: pending.taskId, toolCalls: pending.toolCalls, conversationId }]
          if (pending.taskId) hitlTaskToConv.set(pending.taskId, conversationId)
          changed = true
        }
      }
      if (changed) {
        awaitingHITLConvIds.value = new Set([...awaitingHITLConvIds.value, conversationId])
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
      if (activeViewConversationId.value !== conversationId) return
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
        maInvocationId: r.maInvocationId || undefined,
        maPhase: r.maPhase || undefined,
        timestamp: r.createdAt,
      }))
      executionSteps.value = mapped
      stepsPerConversation.set(conversationId, mapped)
    } catch {
      // API not available or conversation has no steps — ignore
    }
  }

  async function loadPlanningStateFromApi(conversationId: string): Promise<void> {
    try {
      const state = await api.chat.getPlanningState(conversationId)
      planningPerConversation.set(conversationId, state)
      if (activeViewConversationId.value === conversationId) {
        planningState.value = state
      }
      pruneConversationCache()
    } catch {
      // API not available or no planning state — ignore
    }
  }

  return {
    isExecuting,
    activeTaskId,
    hitlQueue,
    activeHITLQueue,
    pendingHITL,
    executionSteps,
    planningState,
    toolApprovals,
    availableTools,
    selectedToolNames,
    hasSteps,
    hasPlanningTasks,
    activeConversationIsExecuting,
    liveExecutionConversationIds,
    loadToolApprovals,
    loadTools,
    toggleTool,
    selectAllTools,
    clearSelectedTools,
    isToolSelected,
    setToolApproval,
    isToolAutoApproved,
    handleHITLRequest,
    dismissHITLByTaskId,
    dismissHITLByConversation,
    respondHITL,
    awaitingHITLConvIds,
    handleExecutionUpdate,
    handlePlanningStateUpdated,
    clearExecution,
    clearConversationExecution,
    truncateConversationExecution,
    clearExecutionState,
    clearPlanningState,
    setConversationExecutionState,
    isConversationExecuting,
    restoreForConversation,
    setActiveViewConversation,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAgentStore, import.meta.hot))
}
