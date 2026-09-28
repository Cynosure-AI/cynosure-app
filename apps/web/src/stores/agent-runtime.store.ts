import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '../api/client'
import type { ChatEvent } from '@shared/types'
import type { ChatExecutionState, PlanningState } from '../api/types'
import { isAutoManagedBuiltInToolName, isBuiltInNamespaceId } from '../utils/internal-tools'

export interface ToolNamespace {
  id: string
  label: string
  description?: string
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
  usesDefaultApproval: boolean
  namespace: ToolNamespace
  ambiguous: boolean
}

export interface ToolCallDisplay {
  id?: string
  name: string
  arguments: string
  annotations?: ToolBehaviorAnnotations
  fileAccess?: { path: string; folder: string; toolName: string }
}

export interface HITLRequest {
  taskId: string
  conversationId?: string
  toolCalls: ToolCallDisplay[]
}

export interface ExecutionStep {
  sequence?: number
  iteration: number
  status: string
  message?: string
  streamingChoosing?: string
  toolCalls?: ToolCallDisplay[]
  results?: { toolCallId?: string; name: string; success: boolean; output: string; error?: string; images?: string[]; invocationId?: string; structuredContent?: unknown }[]
  resultsAt?: number
  resultsSequence?: number
  timestamp: number
  updatedAt?: number
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
    return !(isBuiltInNamespaceId(tool.namespace.id) && isAutoManagedBuiltInToolName(tool.name))
  }

  // Per-conversation execution state for background support
  const executionConversationId = ref<string | null>(null)
  const executingConversationIds = ref<Set<string>>(new Set())
  /** Conversation-level kill latch. Only an explicit new send clears it. */
  const stoppedConversationIds = new Set<string>()
  const executionIdByConversation = new Map<string, string>()
  const stoppedExecutionIds = new Set<string>()
  const pendingNewConversationStarts = new Set<string>()
  /** The conversation the user is currently viewing — used to filter live events. */
  const activeViewConversationId = ref<string | null>(null)
  const stepsPerConversation = new Map<string, ExecutionStep[]>()
  const toolSequenceByStep = new Map<string, number>()
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

    syncToolApprovals(availableTools.value)

    const availableKeys = new Set(
      availableTools.value
        .filter((tool) => !(isBuiltInNamespaceId(tool.namespace.id) && isAutoManagedBuiltInToolName(tool.name)))
        .map((tool) => tool.key)
    )
    const filtered = selectedToolNames.value.filter((name) => availableKeys.has(name))

    // Keep only previously selected tools that still exist; default to none.
    selectedToolNames.value = filtered
  }

  function syncToolApprovals(tools: ToolInfo[]): void {
    const approvalMap: Record<string, boolean> = {}
    for (const tool of tools) {
      approvalMap[tool.executionName] = tool.autoApprove
    }
    toolApprovals.value = approvalMap
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
      sequence: typeof eventData.sequence === 'number' ? eventData.sequence : toolSequenceByStep.get(JSON.stringify([
        eventData.conversationId, taskId || null, eventData.iteration, eventData.maInvocationId || null,
      ])),
      iteration: eventData.iteration as number,
      status: eventData.status as string,
      message: eventData.message as string,
      timestamp: typeof eventData.timestamp === 'number' ? eventData.timestamp : Date.now(),
      taskId: taskId || undefined,
      maCodename: (eventData.maCodename as string) || undefined,
      maAgentName: (eventData.maAgentName as string) || undefined,
      maInvocationId: (eventData.maInvocationId as string) || undefined,
    }
  }

  function recordToolSequence(conversationId: string, sequence: number, taskId?: string, iteration?: number, invocationId?: string): void {
    if (!taskId || iteration === undefined) return
    const key = JSON.stringify([conversationId, taskId, iteration, invocationId || null])
    toolSequenceByStep.set(key, sequence)
    if (toolSequenceByStep.size > 1000) toolSequenceByStep.delete(toolSequenceByStep.keys().next().value!)
    for (const step of stepsPerConversation.get(conversationId) || []) {
      if (step.taskId === taskId && step.iteration === iteration && (step.maInvocationId || null) === (invocationId || null)) {
        step.sequence ??= sequence
      }
    }
    if (activeViewConversationId.value === conversationId) {
      for (const step of executionSteps.value) {
        if (step.taskId === taskId && step.iteration === iteration && (step.maInvocationId || null) === (invocationId || null)) {
          step.sequence ??= sequence
        }
      }
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
    if (step) Object.assign(step, patch, { updatedAt: Date.now() })
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
    if (step) Object.assign(step, patch, { updatedAt: Date.now() })
  }

  function patchToolStep(convId: string, taskId: string | undefined, iteration: number | undefined,
    preferredStatus: string, patch: Partial<ExecutionStep>, isForActiveView: boolean): void {
    const steps = isForActiveView ? executionSteps.value : stepsPerConversation.get(convId) || []
    const candidates = steps.filter((step) => step.taskId === taskId && step.iteration === iteration)
    const target = [...candidates].reverse().find((step) => step.status === preferredStatus) ?? candidates.at(-1)
    if (target) Object.assign(target, patch, { updatedAt: Date.now() })
  }

  function handleExecutionUpdate(data: { event: string; data: Record<string, unknown> }): void {
    const eventData = data.data
    const taskId = eventData.taskId as string | undefined
    const convId = eventData.conversationId as string | undefined
    if (!convId) return
    const executionId = eventData.executionId as string | undefined
    if (stoppedConversationIds.has(convId) || (executionId && stoppedExecutionIds.has(executionId))) return
    const currentExecutionId = executionIdByConversation.get(convId)
    if (executionId && currentExecutionId && executionId !== currentExecutionId) return

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
        if (step.sequence !== undefined) {
          const existingSteps = isForActiveView ? executionSteps.value : stepsPerConversation.get(convId) || []
          if (existingSteps.some((existing) => existing.sequence === step.sequence)) break
        }
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
          id?: string
          function?: { name: string; arguments: string }
          name?: string
          arguments?: string
          annotations?: ToolBehaviorAnnotations
        }>
        const mapped: ToolCallDisplay[] = (rawCalls || []).map((tc) => ({
          id: tc.id,
          name: tc.function?.name || tc.name || '',
          arguments: tc.function?.arguments || tc.arguments || '',
          annotations: tc.annotations,
        }))
        patchToolStep(convId, taskId, eventData.iteration as number | undefined, 'choosing-tools', { toolCalls: mapped }, isForActiveView)
        break
      }

      case 'step:executed':
        patchToolStep(convId, taskId, eventData.iteration as number | undefined, 'executing',
          {
            results: eventData.results as ExecutionStep['results'],
            resultsAt: typeof eventData.timestamp === 'number' ? eventData.timestamp : Date.now(),
            resultsSequence: typeof eventData.sequence === 'number' ? eventData.sequence : undefined,
          }, isForActiveView)
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

  function handleChatToolEvent(event: ChatEvent): void {
    const base = { conversationId: event.conversationId, executionId: event.executionId }
    if (event.type === 'execution-step') {
      handleExecutionUpdate({ event: 'step:status', data: { ...base,
        taskId: event.taskId, iteration: event.iteration, status: event.status,
        message: event.message, maCodename: event.maCodename, maAgentName: event.maAgentName,
        maInvocationId: event.invocationId, timestamp: event.createdAt, sequence: event.sequence,
      } })
    } else if (event.type === 'routing-decision') {
      recordToolSequence(event.conversationId, event.sequence, event.taskId, 0, event.parentInvocationId)
      handleExecutionUpdate({ event: 'step:tools-chosen', data: { ...base,
        taskId: event.taskId, iteration: 0, maInvocationId: event.parentInvocationId,
        maCodename: event.maCodename, maAgentName: event.maAgentName,
        toolCalls: event.entries.map((entry) => ({ name: entry.name, arguments: JSON.stringify(entry.details) })),
      } })
    } else if (event.type === 'tool-calls') {
      const item = event.items[0]
      if (!item) return
      recordToolSequence(event.conversationId, event.sequence, item.taskId, item.iteration, item.parentInvocationId)
      handleExecutionUpdate({ event: 'step:tools-chosen', data: { ...base,
        taskId: item.taskId, iteration: item.iteration, maInvocationId: item.parentInvocationId,
        toolCalls: event.items.map((call) => ({ id: call.callId, name: call.name, arguments: call.arguments })),
      } })
    } else if (event.type === 'tool-results') {
      const item = event.items[0]
      if (!item) return
      handleExecutionUpdate({ event: 'step:executed', data: { ...base,
        taskId: item.taskId, iteration: item.iteration, timestamp: event.createdAt, sequence: event.sequence,
        results: event.items.map((result) => ({
          toolCallId: result.callId, name: result.name, success: result.success, invocationId: result.invocationId,
          output: result.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join(''),
          images: result.content.flatMap((block) => block.type === 'image' ? [block.url] : []),
        })),
      } })
    }
  }

  function handlePlanningStateUpdated(data: unknown): void {
    const state = data as PlanningState | null
    if (!state?.conversationId) return
    if (stoppedConversationIds.has(state.conversationId)) return
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
      if (stoppedConversationIds.has(conversationId)) return
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

  /** Open a new execution generation. This is called only from an explicit send. */
  function prepareConversationExecution(conversationId: string): void {
    stoppedConversationIds.delete(conversationId)
    executionIdByConversation.delete(conversationId)
    pendingNewConversationStarts.add(conversationId)
    setConversationExecutionState(conversationId, true)
  }

  /** Permanently latch this conversation off until prepareConversationExecution. */
  function recordStoppedExecutionIds(executionIds: string[]): void {
    for (const executionId of executionIds) stoppedExecutionIds.add(executionId)
    while (stoppedExecutionIds.size > 200) {
      const oldest = stoppedExecutionIds.values().next().value
      if (oldest) stoppedExecutionIds.delete(oldest)
      else break
    }
  }

  /** Permanently latch this conversation off until prepareConversationExecution. */
  function stopConversationExecution(conversationId: string, executionIds: string[] = []): void {
    recordStoppedExecutionIds(executionIds)
    const currentExecutionId = executionIdByConversation.get(conversationId)
    if (currentExecutionId) recordStoppedExecutionIds([currentExecutionId])
    stoppedConversationIds.add(conversationId)
    pendingNewConversationStarts.delete(conversationId)
    setConversationExecutionState(conversationId, false)
    dismissHITLByConversation(conversationId)
  }

  function reconcileStoppedExecution(conversationId: string, executionIds: string[]): void {
    recordStoppedExecutionIds(executionIds)
    if (pendingNewConversationStarts.has(conversationId)) return
    stopConversationExecution(conversationId, executionIds)
  }

  function handleChatExecutionState(data: ChatExecutionState): void {
    if (data.state === 'running') {
      if (stoppedConversationIds.has(data.conversationId) || stoppedExecutionIds.has(data.executionId)) return
      executionIdByConversation.set(data.conversationId, data.executionId)
      pendingNewConversationStarts.delete(data.conversationId)
      setConversationExecutionState(data.conversationId, true)
      return
    }

    // A delayed terminal event from a killed generation must not terminate a
    // newer user-initiated send that is waiting to start.
    if (stoppedExecutionIds.has(data.executionId) && pendingNewConversationStarts.has(data.conversationId)) return
    const currentExecutionId = executionIdByConversation.get(data.conversationId)
    if (currentExecutionId && currentExecutionId !== data.executionId) return
    if (data.state === 'stopped') {
      stopConversationExecution(data.conversationId, [data.executionId])
      return
    }
    executionIdByConversation.delete(data.conversationId)
    pendingNewConversationStarts.delete(data.conversationId)
    setConversationExecutionState(data.conversationId, false)
  }

  function isConversationExecuting(conversationId: string | null | undefined): boolean {
    return Boolean(conversationId && executingConversationIds.value.has(conversationId))
  }

  function isConversationStopped(conversationId: string | null | undefined, executionId?: string): boolean {
    return Boolean(
      conversationId && (
        stoppedConversationIds.has(conversationId) ||
        (executionId && stoppedExecutionIds.has(executionId))
      )
    )
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
      isExecuting.value = executingConversationIds.value.has(conversationId)
      await loadStepsFromEvents(conversationId)
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

  async function loadStepsFromEvents(conversationId: string): Promise<void> {
    try {
      let after = 0
      for (;;) {
        const page = await api.chat.getEvents(conversationId, after)
        if (activeViewConversationId.value !== conversationId) return
        for (const event of page.events) handleChatToolEvent(event)
        if (!page.events.length || page.events.length < 1000 || page.events.at(-1)!.sequence >= page.latestSequence) break
        after = page.events.at(-1)!.sequence
      }
    } catch {
      // Conversation can still receive live events if history is unavailable.
    }
  }

  async function loadPlanningStateFromApi(conversationId: string): Promise<void> {
    try {
      const state = await api.chat.getPlanningState(conversationId)
      if (stoppedConversationIds.has(conversationId)) return
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
    syncToolApprovals,
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
    handleChatToolEvent,
    recordToolSequence,
    handlePlanningStateUpdated,
    clearExecution,
    clearConversationExecution,
    truncateConversationExecution,
    clearExecutionState,
    clearPlanningState,
    setConversationExecutionState,
    prepareConversationExecution,
    stopConversationExecution,
    reconcileStoppedExecution,
    handleChatExecutionState,
    isConversationExecuting,
    isConversationStopped,
    restoreForConversation,
    setActiveViewConversation,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAgentStore, import.meta.hot))
}
