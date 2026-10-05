import cron, { type ScheduledTask } from 'node-cron'
import { CronExpressionParser } from 'cron-parser'
import { nanoid } from 'nanoid'
import { getDb } from '../../db/database.js'
import { getAgent } from '../agents/agent-store.js'
import { runTriggerExecution } from './trigger-runner.js'
import { getChannelManager } from '../channels/channel-manager.js'
import { cancelPendingCoalescedTriggers, enqueueCoalescedTrigger } from './trigger-queue.js'
import { resolveChannelTarget } from './channel-target-resolver.js'
import { getGateway } from '../gateway/gateway.js'
import { cancelPostActions, generateTitle } from '../agent/post-execution.js'
import { getEventBus } from '../telemetry/event-bus.js'
import type { AgentExecutorResult } from '../agent/agent-executor.js'
import type { ConversationExecutionConfig } from '@shared/types'
import { parseExecutionConfig } from '../chat/run-config.js'

type CronNotificationMode = 'always' | 'conditional'

type BroadcastFn = (event: string, data: unknown) => void

let broadcast: BroadcastFn = () => { }

/** In-memory map: jobId → scheduled task */
const tasks = new Map<string, ScheduledTask>()
const scheduledInfo = new Map<string, { jobId: string; agentId: string; schedule: string; scheduledSince: number }>()
let missedRunSweep: NodeJS.Timeout | null = null
let acceptingRuns = false

/** Tracks cron jobs that are actively executing right now: jobId → run info */
const activeCronRuns = new Map<string, { jobId: string; agentId: string; conversationId: string; startedAt: number }>()

/** Abort controllers for currently-executing cron runs */
const activeCronAbortControllers = new Map<string, AbortController>()
const activeCronCompletions = new Map<string, Promise<void>>()

// ─── DB row shape ──────────────────────────────────────────

export interface CronJobRow {
    id: string
    name: string
    agent_id: string
    schedule: string
    prompt: string
    enabled: number
    one_off: number
    output_channel_id: string
    notification_mode: string
    notification_condition: string
    created_at: number
    updated_at: number
    last_run_at: number | null
    execution_config_json: string
}

export interface CronJobData {
    id: string
    name: string
    agentId: string
    schedule: string
    prompt: string
    enabled: boolean
    oneOff: boolean
    outputChannelId: string
    notificationMode: CronNotificationMode
    notificationCondition: string
    createdAt: number
    updatedAt: number
    lastRunAt: number | null
    executionConfig: ConversationExecutionConfig | null
}

export function isValidCronSchedule(schedule: string): boolean {
    return Boolean(schedule.trim()) && cron.validate(schedule)
}

function rowToData(row: CronJobRow): CronJobData {
    let executionConfig: ConversationExecutionConfig | null = null
    if (!row.agent_id && row.execution_config_json && row.execution_config_json !== '{}') {
        try {
            const parsed = parseExecutionConfig(row.execution_config_json)
            if (parsed.providerId && parsed.model) executionConfig = parsed
        } catch {
            // Invalid or partial data is treated as an unavailable snapshot.
        }
    }
    return {
        id: row.id,
        name: row.name,
        agentId: row.agent_id,
        schedule: row.schedule,
        prompt: row.prompt,
        enabled: row.enabled === 1,
        oneOff: row.one_off === 1,
        outputChannelId: row.output_channel_id || '',
        notificationMode: row.notification_mode === 'conditional' ? 'conditional' : 'always',
        notificationCondition: row.notification_condition || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastRunAt: row.last_run_at ?? null,
        executionConfig,
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

export function createCronJob(input: { name?: string; agentId: string; schedule: string; prompt: string; enabled?: boolean; oneOff?: boolean; outputChannelId?: string; notificationMode?: string; notificationCondition?: string; executionConfig?: ConversationExecutionConfig }): CronJobData {
    const db = getDb()
    const id = nanoid()
    const now = Date.now()
    const notificationMode = input.notificationMode === 'conditional' ? 'conditional' : 'always'
    // Set lastRunAt to now so missed first runs are caught up after downtime
    db.prepare(
        'INSERT INTO cron_jobs (id, name, agent_id, schedule, prompt, enabled, one_off, output_channel_id, notification_mode, notification_condition, execution_config_json, created_at, updated_at, last_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, input.name || '', input.agentId, input.schedule, input.prompt, input.enabled !== false ? 1 : 0, input.oneOff ? 1 : 0, input.outputChannelId || '', notificationMode, input.notificationCondition || '', JSON.stringify(input.executionConfig ?? {}), now, now, now)
    return getCronJob(id)!
}

export function updateCronJob(id: string, input: { name?: string; agentId?: string; schedule?: string; prompt?: string; enabled?: boolean; oneOff?: boolean; outputChannelId?: string; notificationMode?: string; notificationCondition?: string }): CronJobData | undefined {
    const db = getDb()
    const existing = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id) as CronJobRow | undefined
    if (!existing) return undefined
    const now = Date.now()
    const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled
    const schedule = input.schedule !== undefined ? input.schedule : existing.schedule
    const notificationMode = input.notificationMode !== undefined
        ? (input.notificationMode === 'conditional' ? 'conditional' : 'always')
        : (existing.notification_mode === 'conditional' ? 'conditional' : 'always')
    const shouldResetLastRun = (existing.enabled !== 1 && enabled === 1) || schedule !== existing.schedule
    db.prepare(
        'UPDATE cron_jobs SET name = ?, agent_id = ?, schedule = ?, prompt = ?, enabled = ?, one_off = ?, output_channel_id = ?, notification_mode = ?, notification_condition = ?, updated_at = ?, last_run_at = ? WHERE id = ?'
    ).run(
        input.name !== undefined ? input.name : existing.name,
        input.agentId !== undefined ? input.agentId : existing.agent_id,
        schedule,
        input.prompt !== undefined ? input.prompt : existing.prompt,
        enabled,
        input.oneOff !== undefined ? (input.oneOff ? 1 : 0) : existing.one_off,
        input.outputChannelId !== undefined ? input.outputChannelId : (existing.output_channel_id || ''),
        notificationMode,
        input.notificationCondition !== undefined ? input.notificationCondition : (existing.notification_condition || ''),
        now,
        shouldResetLastRun ? now : existing.last_run_at,
        id
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

function getCronEvaluationContext(conversationId: string, result: AgentExecutorResult): string {
    const rows = getDb().prepare(
        'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 40'
    ).all(conversationId) as { role: string; content: string }[]

    const transcript = rows
        .map((row) => `${row.role}: ${row.content}`)
        .join('\n\n')
        .trim()
    const context = transcript || result.content.trim()

    return context.length > 24000
        ? `${context.slice(0, 12000)}\n\n[...middle omitted...]\n\n${context.slice(-12000)}`
        : context
}

async function shouldNotifyForCronJob(job: CronJobData, result: AgentExecutorResult, conversationId: string): Promise<boolean> {
    if (job.notificationMode !== 'conditional') return true

    const condition = job.notificationCondition.trim()
    if (!condition) return true

    const gateway = getGateway()
    const context = getCronEvaluationContext(conversationId, result)

    try {
        const evaluation = await gateway.complete({
            model: result.model || undefined,
            temperature: 0,
            maxTokens: 80,
            thinkingEnabled: false,
            messages: [
                {
                    role: 'system',
                    content: [
                        'You decide whether a cron job result should notify the user.',
                        'Return only JSON shaped exactly like {"notify":true} or {"notify":false}.',
                        'Base the decision only on the provided result and condition.',
                    ].join('\n'),
                },
                {
                    role: 'user',
                    content: [
                        `Condition: ${condition}`,
                        '',
                        'Cron job run context:',
                        context,
                    ].join('\n'),
                },
            ],
        }, result.provider || undefined)

        const jsonText = evaluation.content.match(/\{[\s\S]*\}/)?.[0] || evaluation.content
        const parsed = JSON.parse(jsonText) as { notify?: unknown }
        return parsed.notify === true
    } catch (err) {
        console.warn(`[cron] Job "${job.name || job.id}" (${job.id}) could not evaluate notification condition:`, (err as Error).message)
        // Failing open is safer for unattended jobs: an evaluator outage must
        // not silently suppress an otherwise configured notification.
        return true
    }
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

// ─── Run a cron job ────────────────────────────────────────

/** Run one cron turn for a specific job */
async function runCronJob(jobId: string, opts?: { force?: boolean; scheduledAt?: number }): Promise<void> {
    if (!acceptingRuns) return
    const job = getCronJob(jobId)
    if (!job || (!job.enabled && !opts?.force)) return

    const runStartedAt = Date.now()
    const scheduledAt = opts?.scheduledAt ?? runStartedAt
    const agent = job.agentId ? getAgent(job.agentId) : null
    if (!agent && !job.executionConfig) {
        if (!opts?.force) {
            getDb().prepare('UPDATE cron_jobs SET last_run_at = ? WHERE id = ?').run(scheduledAt, jobId)
        }
        console.warn(`[cron] Skipping job "${job.name || job.id}" (${job.id}) because its execution configuration is unavailable`)
        return
    }

    activeCronRuns.set(jobId, { jobId, agentId: job.agentId, conversationId: '', startedAt: Date.now() })

    const abortController = new AbortController()
    activeCronAbortControllers.set(jobId, abortController)
    let resolveCompletion!: () => void
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve })
    activeCronCompletions.set(jobId, completion)

    const now = new Date(runStartedAt)
    const scheduledDate = new Date(scheduledAt)
    const userContent = job.prompt
        ? `Scheduled cron job due at ${scheduledDate.toISOString()} and started at ${now.toISOString()}.\n\n${job.prompt}`
        : `Scheduled cron job due at ${scheduledDate.toISOString()} and started at ${now.toISOString()}. Execute your scheduled task as described in your instructions.`
    const titleSource = job.prompt.trim() || 'Execute scheduled task'

    try {
        const { conversationId, result } = await runTriggerExecution({
            agent,
            executionConfig: job.executionConfig ?? undefined,
            userContent,
            origin: 'cron',
            title: job.name.trim() || 'New Chat',
            systemPromptSuffix: '\nUse your tools to perform the scheduled task.',
            broadcast,
            signal: abortController.signal,
            logPrefix: '[cron]',
            onConversationCreated: (id) => {
                const run = activeCronRuns.get(jobId)
                if (run) run.conversationId = id
            },
        })

        abortController.signal.throwIfAborted()

        generateTitle({
            conversationId,
            userMessage: titleSource,
            assistantResponse: result.content,
            broadcast,
            providerId: result.provider || undefined,
            model: result.model || undefined,
        }).catch(() => { })

        const notificationAllowed = Boolean(job.outputChannelId) && result.content
            ? await shouldNotifyForCronJob(job, result, conversationId)
            : false
        abortController.signal.throwIfAborted()

        // Send result to configured output channel if set
        if (job.outputChannelId) {
            if (!result.content) {
                console.warn(`[cron] Job "${job.name || job.id}" (${job.id}) did not send output notification because the agent returned empty content`)
            } else {
                if (notificationAllowed) {
                    const target = resolveChannelTarget(job.outputChannelId)
                    if (target) {
                        const label = job.name?.trim() || 'Cron job'
                        await getChannelManager().queueNotification(job.outputChannelId, target, `**${label}:**\n${result.content}`)
                    } else {
                        console.warn(`[cron] Job "${job.name || job.id}" (${job.id}) did not send output notification because channel "${job.outputChannelId}" has no known target`)
                    }
                }
            }
        }

        // If one-off, disable the cron job after successful execution
        if (job.oneOff) {
            updateCronJob(jobId, { enabled: false })
            unscheduleCronJob(jobId)
        }
    } catch (err) {
        if ((err as Error).name === 'AbortError') return
        // Error already logged by trigger-runner
    } finally {
        if (!opts?.force) {
            getDb().prepare('UPDATE cron_jobs SET last_run_at = ? WHERE id = ?').run(scheduledAt, jobId)
        }
        activeCronRuns.delete(jobId)
        activeCronAbortControllers.delete(jobId)
        activeCronCompletions.delete(jobId)
        resolveCompletion()
    }
}

// ─── Scheduling ────────────────────────────────────────────

function getMissedRunAt(job: CronJobData, now = Date.now()): number | null {
    const floor = job.lastRunAt ?? job.createdAt
    if (!floor || floor >= now) return null

    try {
        const interval = CronExpressionParser.parse(job.schedule, { currentDate: new Date(now) })
        const latestFire = interval.prev().toDate().getTime()
        return latestFire > floor && latestFire <= now ? latestFire : null
    } catch {
        return null
    }
}

function enqueueMissedCronRuns(reason: 'startup' | 'sweep'): void {
    const now = Date.now()
    for (const job of listCronJobs()) {
        if (!job.enabled || !job.schedule || activeCronRuns.has(job.id)) continue

        const missedRunAt = getMissedRunAt(job, now)
        if (missedRunAt === null) continue

        console.log(`[cron] Missed execution for job "${job.name || job.id}" (${job.id}) from ${new Date(missedRunAt).toISOString()}, running now (${reason})`)
        enqueueCoalescedTrigger(`cron:${job.id}`, () => runCronJob(job.id, { scheduledAt: missedRunAt }))
    }
}

/** Schedule or reschedule a single cron job by its DB id */
export function scheduleCronJob(jobId: string): void {
    unscheduleCronJob(jobId)

    const job = getCronJob(jobId)
    if (!job || !job.enabled || !job.schedule) return

    if (!isValidCronSchedule(job.schedule)) {
        console.warn(`[cron] Invalid cron expression for job ${jobId}: ${job.schedule}`)
        return
    }

    const task = cron.schedule(job.schedule, () => {
        const scheduledAt = Date.now()
        enqueueCoalescedTrigger(`cron:${jobId}`, () => runCronJob(jobId, { scheduledAt }))
    })

    tasks.set(jobId, task)
    scheduledInfo.set(jobId, { jobId, agentId: job.agentId, schedule: job.schedule, scheduledSince: Date.now() })
}

/** Immediately enqueue a manual run for a cron job, bypassing its enabled state. */
export function triggerCronJobNow(jobId: string): void {
    enqueueCoalescedTrigger(`cron:${jobId}`, () => runCronJob(jobId, { force: true, scheduledAt: Date.now() }))
}

/** Cancel a running cron execution for a specific job. Returns true if cancelled. */
export function cancelCronRun(jobId: string): boolean {
    const controller = activeCronAbortControllers.get(jobId)
    if (controller) {
        const run = activeCronRuns.get(jobId)
        if (run?.conversationId) {
            getEventBus().emit('hitl:clear-conversation', { conversationId: run.conversationId })
            cancelPostActions(run.conversationId)
        }
        controller.abort()
        return true
    }
    return false
}

/** Cancel running cron work for the conversation opened by that run. */
export function cancelCronRunsByConversation(conversationId: string): string[] {
    const cancelledJobIds: string[] = []
    for (const run of activeCronRuns.values()) {
        if (run.conversationId === conversationId && cancelCronRun(run.jobId)) {
            cancelledJobIds.push(run.jobId)
        }
    }
    return cancelledJobIds
}

/** Cancel all current cron executions and any coalesced follow-up runs. */
export function cancelAllCronRuns(): number {
    let cancelled = cancelPendingCoalescedTriggers('cron:')
    for (const jobId of [...activeCronAbortControllers.keys()]) {
        if (cancelCronRun(jobId)) cancelled++
    }
    return cancelled
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

/** Initialize cron scheduling for all enabled jobs. Call once on server startup. */
export function startCronScheduler(broadcastFn: BroadcastFn): void {
    broadcast = broadcastFn
    acceptingRuns = true
    if (missedRunSweep) {
        clearInterval(missedRunSweep)
        missedRunSweep = null
    }

    const jobs = listCronJobs()
    const enabledJobIds = new Set(jobs.filter((job) => job.enabled && job.schedule).map((job) => job.id))
    for (const jobId of tasks.keys()) {
        if (!enabledJobIds.has(jobId)) unscheduleCronJob(jobId)
    }
    for (const job of jobs) {
        if (!job.enabled || !job.schedule) continue

        scheduleCronJob(job.id)
    }

    enqueueMissedCronRuns('startup')
    missedRunSweep = setInterval(() => enqueueMissedCronRuns('sweep'), 60_000)
}

/** Stop all cron tasks. */
export async function stopCronScheduler(): Promise<void> {
    acceptingRuns = false
    for (const [, task] of tasks) {
        task.stop()
    }
    tasks.clear()
    scheduledInfo.clear()
    if (missedRunSweep) {
        clearInterval(missedRunSweep)
        missedRunSweep = null
    }
    for (const controller of activeCronAbortControllers.values()) {
        controller.abort()
    }
    await Promise.allSettled(Array.from(activeCronCompletions.values()))
}
