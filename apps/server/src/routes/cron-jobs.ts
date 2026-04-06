import type { FastifyInstance } from 'fastify'
import { CronExpressionParser } from 'cron-parser'
import {
    listCronJobs,
    getCronJob,
    createCronJob,
    updateCronJob,
    deleteCronJob,
    scheduleCronJob,
    unscheduleCronJob,
    getActiveCronRuns,
    type CronJobData,
} from '../core/triggers/cron-scheduler.js'
import { getAgent } from '../core/agents/agent-files.js'

function getNextRunAt(schedule: string): number | null {
    try {
        const expr = CronExpressionParser.parse(schedule)
        return expr.next().getTime()
    } catch {
        return null
    }
}

export async function registerCronJobRoutes(app: FastifyInstance): Promise<void> {
    // GET /api/cron-jobs — list all cron jobs with agent info
    app.get('/', async () => {
        const jobs = listCronJobs()
        const activeRuns = new Set(getActiveCronRuns().map(r => r.jobId))

        return jobs.map((job) => {
            const agent = getAgent(job.agentId)
            return {
                ...job,
                agentName: agent?.name || 'Unknown',
                agentIconUrl: agent?.iconUrl || null,
                isRunning: activeRuns.has(job.id),
                nextRunAt: job.enabled ? getNextRunAt(job.schedule) : null,
            }
        })
    })

    // POST /api/cron-jobs — create a new cron job
    app.post<{ Body: { name?: string; agentId: string; schedule: string; prompt: string; enabled?: boolean; oneOff?: boolean; modelOverride?: string; providerOverride?: string } }>('/', async (req, reply) => {
        const { name, agentId, schedule, prompt, enabled, oneOff, modelOverride, providerOverride } = req.body
        if (!agentId || !schedule) {
            reply.code(400)
            return { error: 'agentId and schedule are required' }
        }
        const agent = getAgent(agentId)
        if (!agent) {
            reply.code(404)
            return { error: 'Agent not found' }
        }
        const job = createCronJob({ name, agentId, schedule, prompt: prompt || '', enabled, oneOff, modelOverride, providerOverride })
        if (job.enabled) scheduleCronJob(job.id)
        return job
    })

    // PUT /api/cron-jobs/:id — update a cron job
    app.put<{ Params: { id: string }; Body: { name?: string; schedule?: string; prompt?: string; enabled?: boolean; oneOff?: boolean; modelOverride?: string; providerOverride?: string } }>('/:id', async (req, reply) => {
        const job = updateCronJob(req.params.id, req.body)
        if (!job) {
            reply.code(404)
            return { error: 'Cron job not found' }
        }
        // Reschedule (will unschedule if now disabled)
        if (job.enabled) {
            scheduleCronJob(job.id)
        } else {
            unscheduleCronJob(job.id)
        }
        return job
    })

    // DELETE /api/cron-jobs/:id — delete a cron job
    app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
        unscheduleCronJob(req.params.id)
        const deleted = deleteCronJob(req.params.id)
        if (!deleted) {
            reply.code(404)
            return { error: 'Cron job not found' }
        }
        return { success: true }
    })
}
