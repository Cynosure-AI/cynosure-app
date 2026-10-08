import type { ToolDefinition } from '../../gateway/providers/base.provider.js'
import { CronExpressionParser } from 'cron-parser'
import type { ConversationExecutionConfig } from '@shared/types'
import { isDefaultChatAgent } from '../../agent/execution-preset.js'
import { describeCurrentDate } from '../../agent/pre-execution/prompt-smart-tags.js'

export interface ScheduleToolOptions {
    agentId: string
    executionConfig?: ConversationExecutionConfig
}

export const SCHEDULE_TOOL_NAMES = [
    'schedule_create',
    'schedule_list',
    'schedule_update',
    'schedule_delete',
] as const

export type ScheduleToolName = (typeof SCHEDULE_TOOL_NAMES)[number]

const SCHEDULE_TOOL_NAME_SET = new Set<string>(SCHEDULE_TOOL_NAMES)

export function isScheduleToolName(name?: string | null): name is ScheduleToolName {
    return Boolean(name && SCHEDULE_TOOL_NAME_SET.has(name))
}

function ownerAgentId(agentId: string): string {
    return isDefaultChatAgent({ id: agentId }) ? '' : agentId
}

function hasScheduleContext(opts: ScheduleToolOptions): boolean {
    return Boolean(ownerAgentId(opts.agentId) || opts.executionConfig)
}

function requireScheduleContext(opts: ScheduleToolOptions): ReturnType<typeof failure> | undefined {
    return hasScheduleContext(opts)
        ? undefined
        : failure('Scheduling tools require either an agent or a Free Chat execution configuration.')
}

function result(value: unknown) {
    return { success: true as const, output: JSON.stringify(value, null, 2) }
}

/** Results carry the exact time; descriptions can't without breaking the prompt cache. */
function serverTime(now = Date.now()): string {
    return new Date(now).toString()
}

function failure(message: string) {
    return { success: false as const, output: '', error: message }
}

/** Convert an exact, timezone-qualified instant into the server-local cron expression used by node-cron. */
export function oneOffCronExpression(runAt: string, now = Date.now()): { schedule: string; runAt: number } {
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(runAt.trim())) {
        throw new Error('runAt must be an ISO 8601 date-time with a timezone, for example 2026-08-19T09:00:00+02:00')
    }

    const date = new Date(runAt)
    const timestamp = date.getTime()
    if (!Number.isFinite(timestamp)) throw new Error('runAt is not a valid date-time')
    if (date.getSeconds() !== 0 || date.getMilliseconds() !== 0) {
        throw new Error('runAt must be aligned to a whole minute')
    }
    if (timestamp <= now) throw new Error(`runAt must be in the future; the server time is now ${serverTime(now)}`)

    const schedule = `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`
    const nextMatchingRun = CronExpressionParser.parse(schedule, { currentDate: new Date(now) }).next().getTime()
    if (nextMatchingRun !== timestamp) {
        throw new Error('runAt is too far in the future for a one-time cron job; choose a date within the next calendar occurrence')
    }

    return { schedule, runAt: timestamp }
}

/** A one-time run `minutes` from now, rounded up to the next whole minute. */
export function relativeOneOffCronExpression(minutes: number, now = Date.now()): { schedule: string; runAt: number } {
    if (!Number.isInteger(minutes) || minutes < 1) throw new Error('runInMinutes must be a whole number of at least 1')
    const runAt = Math.ceil((now + minutes * 60_000) / 60_000) * 60_000
    return oneOffCronExpression(new Date(runAt).toISOString(), now)
}

function resolveOneOff(input: { runAt?: string; runInMinutes?: number }): { schedule: string; runAt: number } | undefined {
    if (input.runInMinutes !== undefined) return relativeOneOffCronExpression(input.runInMinutes)
    if (input.runAt) return oneOffCronExpression(input.runAt)
    return undefined
}

function countDefined(...values: unknown[]): number {
    return values.filter((value) => value !== undefined && value !== '').length
}

const RUN_IN_MINUTES_PARAMETER = {
    type: 'integer',
    minimum: 1,
    description: 'For a one-time job relative to now, in whole minutes. Prefer this for delays such as "in 2 hours" (120).',
}

function createTool(opts: ScheduleToolOptions): ToolDefinition {
    return {
        name: 'schedule_create',
        execution: { readOnly: false },
        // Only the date goes in the description: it is rebuilt every turn, and a
        // changing description would invalidate the whole prompt cache.
        description: `Create a scheduled job using the current agent or Free Chat configuration. For a one-time run, use runInMinutes for a delay from now or runAt for a clock time; use schedule for a recurring cron expression. Today is ${describeCurrentDate()}; runAt and cron expressions are interpreted in that timezone unless runAt states an offset. The current configuration must already include any tools needed by the future task.`,
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Short user-facing name for the job.' },
                prompt: { type: 'string', description: 'Complete instructions the agent should execute at the scheduled time.' },
                runAt: { type: 'string', description: 'For a one-time job at a clock time: future ISO 8601 date-time including timezone, aligned to a whole minute.' },
                runInMinutes: RUN_IN_MINUTES_PARAMETER,
                schedule: { type: 'string', description: 'For a recurring job: cron expression, such as "0 15 * * *" for every day at 15:00.' },
            },
            required: ['name', 'prompt'],
            additionalProperties: false,
        },
        timeout: 5_000,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        execute: async (params: unknown) => {
            const contextFailure = requireScheduleContext(opts)
            if (contextFailure) return contextFailure
            const input = params as { name?: string; prompt?: string; runAt?: string; runInMinutes?: number; schedule?: string }
            if (!input.name?.trim() || !input.prompt?.trim()) return failure('name and prompt are required')
            if (countDefined(input.runAt, input.runInMinutes, input.schedule) !== 1) {
                return failure('Provide exactly one of runAt, runInMinutes or schedule')
            }

            const scheduler = await import('../../triggers/cron-scheduler.js')
            let schedule = input.schedule?.trim() || ''
            let oneOff = false
            let requestedRunAt: number | undefined
            try {
                const converted = resolveOneOff(input)
                if (converted) {
                    schedule = converted.schedule
                    requestedRunAt = converted.runAt
                    oneOff = true
                }
                if (!scheduler.isValidCronSchedule(schedule)) return failure('Invalid cron schedule')

                const job = scheduler.createCronJob({
                    name: input.name.trim(),
                    agentId: ownerAgentId(opts.agentId),
                    schedule,
                    prompt: input.prompt.trim(),
                    enabled: true,
                    oneOff,
                    executionConfig: ownerAgentId(opts.agentId) ? undefined : opts.executionConfig,
                })
                scheduler.scheduleCronJob(job.id)
                return result({
                    ...job,
                    requestedRunAt: requestedRunAt ? new Date(requestedRunAt).toISOString() : undefined,
                    serverTime: serverTime(),
                })
            } catch (error) {
                return failure((error as Error).message)
            }
        },
    }
}

function listTool(opts: ScheduleToolOptions): ToolDefinition {
    return {
        name: 'schedule_list',
        description: 'List scheduled jobs owned by the current agent or by Free Chat. Use this before updating or deleting a job when its ID is unknown.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        timeout: 5_000,
        execution: { readOnly: true },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        execute: async () => {
            const contextFailure = requireScheduleContext(opts)
            if (contextFailure) return contextFailure
            const { getCronJobsForAgent } = await import('../../triggers/cron-scheduler.js')
            return result({ jobs: getCronJobsForAgent(ownerAgentId(opts.agentId)), serverTime: serverTime() })
        },
    }
}

function updateTool(opts: ScheduleToolOptions): ToolDefinition {
    return {
        name: 'schedule_update',
        execution: { readOnly: false },
        description: 'Update a scheduled job owned by this agent. Only supplied fields are changed. Use runInMinutes or runAt to turn it into a one-time job, or schedule to set a recurring cron expression.',
        parameters: {
            type: 'object',
            properties: {
                jobId: { type: 'string' },
                name: { type: 'string' },
                prompt: { type: 'string' },
                runAt: { type: 'string', description: 'Future ISO 8601 date-time including timezone, aligned to a whole minute.' },
                runInMinutes: RUN_IN_MINUTES_PARAMETER,
                schedule: { type: 'string', description: 'Recurring cron expression.' },
                enabled: { type: 'boolean' },
            },
            required: ['jobId'],
            additionalProperties: false,
        },
        timeout: 5_000,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        execute: async (params: unknown) => {
            const contextFailure = requireScheduleContext(opts)
            if (contextFailure) return contextFailure
            const input = params as { jobId?: string; name?: string; prompt?: string; runAt?: string; runInMinutes?: number; schedule?: string; enabled?: boolean }
            if (!input.jobId) return failure('jobId is required')
            if (countDefined(input.runAt, input.runInMinutes, input.schedule) > 1) {
                return failure('Provide at most one of runAt, runInMinutes or schedule')
            }

            const scheduler = await import('../../triggers/cron-scheduler.js')
            const existing = scheduler.getCronJob(input.jobId)
            if (!existing || existing.agentId !== ownerAgentId(opts.agentId)) return failure('Scheduled job not found')

            let schedule = input.schedule?.trim()
            let oneOff: boolean | undefined = input.schedule ? false : undefined
            try {
                const converted = resolveOneOff(input)
                if (converted) {
                    schedule = converted.schedule
                    oneOff = true
                }
                if (schedule !== undefined && !scheduler.isValidCronSchedule(schedule)) return failure('Invalid cron schedule')
                const job = scheduler.updateCronJob(input.jobId, {
                    name: input.name?.trim(),
                    prompt: input.prompt?.trim(),
                    schedule,
                    oneOff,
                    enabled: input.enabled,
                })
                if (!job) return failure('Scheduled job not found')
                if (job.enabled) scheduler.scheduleCronJob(job.id)
                else scheduler.unscheduleCronJob(job.id)
                return result({ ...job, serverTime: serverTime() })
            } catch (error) {
                return failure((error as Error).message)
            }
        },
    }
}

function deleteTool(opts: ScheduleToolOptions): ToolDefinition {
    return {
        name: 'schedule_delete',
        execution: { readOnly: false },
        description: 'Permanently delete a scheduled job owned by this agent.',
        parameters: {
            type: 'object',
            properties: { jobId: { type: 'string' } },
            required: ['jobId'],
            additionalProperties: false,
        },
        timeout: 5_000,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        execute: async (params: unknown) => {
            const contextFailure = requireScheduleContext(opts)
            if (contextFailure) return contextFailure
            const { getCronJob, unscheduleCronJob, deleteCronJob } = await import('../../triggers/cron-scheduler.js')
            const jobId = (params as { jobId?: string }).jobId
            if (!jobId) return failure('jobId is required')
            const existing = getCronJob(jobId)
            if (!existing || existing.agentId !== ownerAgentId(opts.agentId)) return failure('Scheduled job not found')
            unscheduleCronJob(jobId)
            deleteCronJob(jobId)
            return result({ deleted: true, jobId })
        },
    }
}

export function makeScheduleTools(opts: ScheduleToolOptions): ToolDefinition[] {
    return [createTool(opts), listTool(opts), updateTool(opts), deleteTool(opts)]
}
