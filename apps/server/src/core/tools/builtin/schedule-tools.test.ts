import { describe, expect, test } from 'vitest'
import { isScheduleToolName, makeScheduleTools, oneOffCronExpression, SCHEDULE_TOOL_NAMES } from './schedule-tools.js'

describe('schedule built-in tools', () => {
    test('exposes an agent-scoped CRUD toolset with explicit mutation hints', () => {
        const tools = makeScheduleTools({ agentId: 'agent-1' })
        expect(tools.map((tool) => tool.name)).toEqual(SCHEDULE_TOOL_NAMES)
        expect(tools.find((tool) => tool.name === 'schedule_list')?.annotations?.readOnlyHint).toBe(true)
        expect(tools.find((tool) => tool.name === 'schedule_delete')?.annotations?.destructiveHint).toBe(true)
        for (const tool of tools) {
            expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false })
            expect(tool.annotations).toEqual(expect.objectContaining({
                readOnlyHint: expect.any(Boolean),
                destructiveHint: expect.any(Boolean),
                idempotentHint: expect.any(Boolean),
                openWorldHint: expect.any(Boolean),
            }))
            expect(tool.execution?.readOnly).toBe(tool.annotations?.readOnlyHint)
        }
    })

    test('does not offer automatic in-app notifications for scheduled runs', () => {
        const tools = makeScheduleTools({ agentId: 'agent-1' })
        const create = tools.find((tool) => tool.name === 'schedule_create')
        const update = tools.find((tool) => tool.name === 'schedule_update')

        expect(create?.parameters.properties).not.toHaveProperty('notify')
        expect(update?.parameters.properties).not.toHaveProperty('notify')
    })

    test('identifies only built-in schedule tool names', () => {
        expect(SCHEDULE_TOOL_NAMES.every(isScheduleToolName)).toBe(true)
        expect(isScheduleToolName('memory_create')).toBe(false)
    })

    test('rejects agentless scheduling when no Free Chat execution snapshot is available', async () => {
        const tools = makeScheduleTools({ agentId: '__agentless__' })

        for (const tool of tools) {
            const response = await tool.execute({})
            expect(response).toMatchObject({
                success: false,
                error: expect.stringMatching(/require either an agent or a Free Chat execution configuration/i),
            })
        }
    })

    test('accepts a Free Chat execution snapshot as agentless scheduling context', async () => {
        const [create] = makeScheduleTools({
            agentId: '__agentless__',
            executionConfig: {
                allowedTools: ['builtin::schedule_create'],
                subAgents: [],
                memoryCategoryIds: [],
                systemPrompt: 'Keep this configuration.',
                model: 'model-at-scheduling-time',
                providerId: 'provider-at-scheduling-time',
                thinkingEnabled: true,
                reasoningEffort: 'high',
                autoToolRouting: false,
                autoMemory: false,
                autoRouterProviderId: 'router-provider-at-scheduling-time',
                autoRouterModel: 'router-model-at-scheduling-time',
            },
        })

        const response = await create.execute({})
        expect(response).toMatchObject({
            success: false,
            error: expect.stringMatching(/name and prompt are required/i),
        })
    })

    test('converts a timezone-qualified future instant to server-local cron fields', () => {
        const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
        future.setSeconds(0, 0)
        const converted = oneOffCronExpression(future.toISOString())
        expect(converted.runAt).toBe(future.getTime())
        expect(converted.schedule).toBe(
            `${future.getMinutes()} ${future.getHours()} ${future.getDate()} ${future.getMonth() + 1} *`,
        )
    })

    test('rejects ambiguous, past, and sub-minute runAt values', () => {
        expect(() => oneOffCronExpression('2027-01-02T09:00:00')).toThrow(/timezone/)
        expect(() => oneOffCronExpression('2020-01-02T09:00:00Z')).toThrow(/future/)
        expect(() => oneOffCronExpression('2099-01-02T09:00:30Z')).toThrow(/whole minute/)
    })

    test('rejects dates whose year cannot be represented safely by cron', () => {
        const distant = new Date()
        distant.setFullYear(distant.getFullYear() + 2)
        distant.setSeconds(0, 0)
        expect(() => oneOffCronExpression(distant.toISOString())).toThrow(/too far/)
    })
})
