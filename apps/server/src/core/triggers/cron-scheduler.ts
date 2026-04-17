import cron, { type ScheduledTask } from 'node-cron'
import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getGateway } from '../gateway/gateway.js'
import { getAgent } from '../agents/agent-files.js'
import { getEventBus } from '../telemetry/event-bus.js'
import { AgentExecutor } from '../agent/agent-executor.js'
import { prepareAgentExecution } from '../agent/prepare-execution.js'
import type { ChatMessage } from '../gateway/providers/base.provider.js'

type BroadcastFn = (event: string, data: unknown) => void

let broadcast: BroadcastFn = () => { }

/** In-memory map: jobId → scheduled task */
const tasks = new Map<string, ScheduledTask>()
const scheduledInfo = new Map<string, { jobId: string; agentId: string; schedule: string; scheduledSince: number }>()

/** Tracks cron jobs that are actively executing right now: jobId → run info */
const activeCronRuns = new Map<string, { jobId: string; agentId: string; conversationId: string; startedAt: number }>()

/** Abort controllers for currently-executing cron runs */
const activeCronAbortControllers = new Map<string, AbortController>()

// ─── DB row shape ──────────────────────────────────────────

export interface CronJobRow {
    id: string
    name: string
    agent_id: string
    schedule: string
    prompt: string
    enabled: number
    one_off: number
    model_override: string
    provider_override: string
    created_at: number
    updated_at: number
}

export interface CronJobData {
    id: string
    name: string
    agentId: string
    schedule: string
    prompt: string
    enabled: boolean
    oneOff: boolean
    modelOverride: string
    providerOverride: string
    createdAt: number
    updatedAt: number
}

function rowToData(row: CronJobRow): CronJobData {
    return {
        id: row.id,
        name: row.name,
        agentId: row.agent_id,
        schedule: row.schedule,
        prompt: row.prompt,
        enabled: row.enabled === 1,
        oneOff: row.one_off === 1,
        modelOverride: row.model_override || '',
        providerOverride: row.provider_override || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }
}

// ─── CRUD ──────────────────────────────────────────────────

export function listCronJobs(): CronJobData[] {
    const db = getDb()
    const rows = db.prepare('SELECT * FROM cron_jobs ORDER BY created_at DESC').all() as CronJobRow[]
    return rows.map(rowToData)
}

export function getCronJob(id: string): CronJobData | undefined {
    const db = getDb()
    const row = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id) as CronJobRow | undefined
    return row ? rowToData(row) : undefined
}

export function createCronJob(input: { name?: string; agentId: string; schedule: string; prompt: string; enabled?: boolean; oneOff?: boolean; modelOverride?: string; providerOverride?: string }): CronJobData {
    const db = getDb()
    const id = nanoid()
    const now = Date.now()
    db.prepare(
        'INSERT INTO cron_jobs (id, name, agent_id, schedule, prompt, enabled, one_off, model_override, provider_override, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, input.name || '', input.agentId, input.schedule, input.prompt, input.enabled !== false ? 1 : 0, input.oneOff ? 1 : 0, input.modelOverride || '', input.providerOverride || '', now, now)
    return getCronJob(id)!
}

export function updateCronJob(id: string, input: { name?: string; schedule?: string; prompt?: string; enabled?: boolean; oneOff?: boolean; modelOverride?: string; providerOverride?: string }): CronJobData | undefined {
    const db = getDb()
    const existing = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id) as CronJobRow | undefined
    if (!existing) return undefined
    const now = Date.now()
    db.prepare(
        'UPDATE cron_jobs SET name = ?, schedule = ?, prompt = ?, enabled = ?, one_off = ?, model_override = ?, provider_override = ?, updated_at = ? WHERE id = ?'
    ).run(
        input.name !== undefined ? input.name : existing.name,
        input.schedule !== undefined ? input.schedule : existing.schedule,
        input.prompt !== undefined ? input.prompt : existing.prompt,
        input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled,
        input.oneOff !== undefined ? (input.oneOff ? 1 : 0) : existing.one_off,
        input.modelOverride !== undefined ? input.modelOverride : existing.model_override,
        input.providerOverride !== undefined ? input.providerOverride : existing.provider_override,
        now, id
    )
    return getCronJob(id)
}

export function deleteCronJob(id: string): boolean {
    const db = getDb()
    const result = db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(id)
    return result.changes > 0
}

export function getCronJobsForAgent(agentId: string): CronJobData[] {
    const db = getDb()
    const rows = db.prepare('SELECT * FROM cron_jobs WHERE agent_id = ? ORDER BY created_at DESC').all(agentId) as CronJobRow[]
    return rows.map(rowToData)
}

// ─── Runtime info ──────────────────────────────────────────

export interface ActiveCronRun {
    jobId: string
    agentId: string
    conversationId: string
    startedAt: number
}

/** Return info about cron jobs that are currently executing. */
export function getActiveCronRuns(): ActiveCronRun[] {
    return Array.from(activeCronRuns.values())
}

/** Return all scheduled job IDs (in-memory). */
export function getScheduledJobIds(): string[] {
    return Array.from(scheduledInfo.keys())
}

// ─── Run a cron job ────────────────────────────────────────

/** Run one cron turn for a specific job */
async function runCronJob(jobId: string): Promise<void> {
    const job = getCronJob(jobId)
    if (!job || !job.enabled) return

    const agent = getAgent(job.agentId)
    if (!agent) return

    const gateway = getGateway()
    const db = getDb()

    const now = new Date()
    const conversationId = nanoid()
    const title = `Cron Job ${now.toLocaleString()}`
    db.prepare(
        'INSERT INTO conversations (id, title, agent_id, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(conversationId, title, job.agentId, 'cron', Date.now(), Date.now())

    activeCronRuns.set(jobId, { jobId, agentId: job.agentId, conversationId, startedAt: Date.now() })

    const abortController = new AbortController()
    activeCronAbortControllers.set(jobId, abortController)

    // Build user message: timestamp line + job-specific prompt (or generic fallback)
    const userContent = job.prompt
        ? `Scheduled cron job triggered at ${now.toISOString()}.\n\n${job.prompt}`
        : `Scheduled cron job triggered at ${now.toISOString()}. Execute your scheduled task as described in your instructions.`

    // Prepare execution: tools, memory, system prompt, provider/model
    const prepared = await prepareAgentExecution({
        agent,
        conversationId,
        broadcast,
        providerOverride: job.providerOverride || undefined,
        modelOverride: job.modelOverride || undefined,
        systemPromptSuffix: '\nUse your tools to perform the scheduled task.',
        userQuery: userContent,
        isFirstMessage: true,
    })

    const messages: ChatMessage[] = [
        ...prepared.systemMessages,
        { role: 'user', content: userContent }
    ]

    const triggerMsgId = nanoid()
    db.prepare(
        'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(triggerMsgId, conversationId, 'user', userContent, Date.now())

    broadcast('chat:new-message', {
        conversationId,
        message: { id: triggerMsgId, conversationId, role: 'user', content: userContent, createdAt: Date.now() }
    })

    const executor = new AgentExecutor({
        gateway,
        tools: prepared.tools,
        conversationId,
        broadcast,
        providerId: prepared.providerId,
        model: prepared.model,
        maxRounds: 10,
        thinkingEnabled: agent.thinkingEnabled !== false,
        streamMode: 'per-round',
        hitl: !agent.autoApproveTools,
        agentId: job.agentId,
        agentName: agent.name,
        agentIconUrl: agent.iconUrl || null,
        signal: abortController.signal,
    })

    try {
        const startMs = Date.now()
        const result = await executor.run(messages)

        const assistantMsgId = nanoid()
        const now = Date.now()
        db.prepare(
            'INSERT INTO messages (id, conversation_id, role, content, provider, model, prompt_tokens, completion_tokens, context_tokens, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(assistantMsgId, conversationId, 'assistant', result.content, prepared.providerId || null, prepared.model || null, result.usage?.promptTokens ?? null, result.usage?.completionTokens ?? null, result.contextTokens ?? null, now - startMs, now)

        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), conversationId)

        // If one-off, disable the cron job after successful execution
        if (job.oneOff) {
            updateCronJob(jobId, { enabled: false })
            unscheduleCronJob(jobId)
        }
    } catch (err) {
        if ((err as Error).name !== 'AbortError') {
            console.error(`[cron] Error running cron job ${jobId} for agent ${job.agentId}:`, (err as Error).message)
            try {
                const eventBus = getEventBus()
                eventBus.emit('task:error', { taskId: '', conversationId, error: (err as Error).message })
            } catch { /* ignore */ }
        }
    } finally {
        activeCronRuns.delete(jobId)
        activeCronAbortControllers.delete(jobId)
    }
}

// ─── Scheduling ────────────────────────────────────────────

/** Schedule or reschedule a single cron job by its DB id */
export function scheduleCronJob(jobId: string): void {
    unscheduleCronJob(jobId)

    const job = getCronJob(jobId)
    if (!job || !job.enabled || !job.schedule) return

    if (!cron.validate(job.schedule)) {
        console.warn(`[cron] Invalid cron expression for job ${jobId}: ${job.schedule}`)
        return
    }

    const task = cron.schedule(job.schedule, () => {
        runCronJob(jobId).catch((err) => {
            console.error(`[cron] Unhandled error for job ${jobId}:`, err)
        })
    })

    tasks.set(jobId, task)
    scheduledInfo.set(jobId, { jobId, agentId: job.agentId, schedule: job.schedule, scheduledSince: Date.now() })
}

/** Cancel a running cron execution for a specific job. Returns true if cancelled. */
export function cancelCronRun(jobId: string): boolean {
    const controller = activeCronAbortControllers.get(jobId)
    if (controller) {
        controller.abort()
        activeCronAbortControllers.delete(jobId)
        return true
    }
    return false
}

/** Remove a scheduled cron job */
export function unscheduleCronJob(jobId: string): void {
    const existing = tasks.get(jobId)
    if (existing) {
        existing.stop()
        tasks.delete(jobId)
        scheduledInfo.delete(jobId)
    }
}

/** Unschedule all cron jobs for a specific agent (e.g. when agent is deleted) */
export function unscheduleAllForAgent(agentId: string): void {
    for (const [jobId, info] of scheduledInfo) {
        if (info.agentId === agentId) {
            unscheduleCronJob(jobId)
        }
    }
}

/** Initialize cron scheduling for all enabled jobs. Call once on server startup. */
export function startCronScheduler(broadcastFn: BroadcastFn): void {
    broadcast = broadcastFn

    const jobs = listCronJobs()
    for (const job of jobs) {
        if (job.enabled && job.schedule) {
            scheduleCronJob(job.id)
        }
    }
}

/** Stop all cron tasks. */
export function stopCronScheduler(): void {
    for (const [, task] of tasks) {
        task.stop()
    }
    tasks.clear()
    scheduledInfo.clear()
    activeCronRuns.clear()
}
