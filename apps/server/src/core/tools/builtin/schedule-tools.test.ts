import { describe, expect, test } from 'vitest'
import { makeScheduleTools, oneOffCronExpression, SCHEDULE_TOOL_NAMES } from './schedule-tools.js'

describe('schedule built-in tools', () => {
    test('exposes an agent-scoped CRUD toolset with explicit mutation hints', () => {
        const tools = makeScheduleTools({ agentId: 'agent-1' })
        expect(tools.map((tool) => tool.name)).toEqual(SCHEDULE_TOOL_NAMES)
        expect(tools.find((tool) => tool.name === 'schedule_list')?.annotations?.readOnlyHint).toBe(true)
        expect(tools.find((tool) => tool.name === 'schedule_delete')?.annotations?.destructiveHint).toBe(true)
        for (const tool of tools) {
            expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false })
        }
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
