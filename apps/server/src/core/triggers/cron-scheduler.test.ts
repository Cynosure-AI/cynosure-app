import { describe, expect, test } from 'vitest'
import { composeCronNotificationBody, isValidCronSchedule } from './cron-scheduler.js'

describe('cron schedule validation', () => {
    test('accepts valid schedules and rejects empty or malformed schedules', () => {
        expect(isValidCronSchedule('*/5 * * * *')).toBe(true)
        expect(isValidCronSchedule('0 8 * * 1-5')).toBe(true)
        expect(isValidCronSchedule('')).toBe(false)
        expect(isValidCronSchedule('not a cron expression')).toBe(false)
    })
})

describe('cron notification body', () => {
    const briefing = `## Morning briefing\n\n${'Nintendo and AI headlines. '.repeat(20)}`

    test('includes a deliverable written alongside a tool call before a short wrap-up', () => {
        const body = composeCronNotificationBody(
            ['Let me search for the latest news.', briefing],
            'Briefing delivered above ✅ and the project brief is updated.',
        )
        expect(body).toBe(`${briefing.trim()}\n\nBriefing delivered above ✅ and the project brief is updated.`)
    })

    test('sends only the final reply when intermediate rounds were narration', () => {
        expect(composeCronNotificationBody(['Checking the feed…', ''], 'Nothing new today.')).toBe('Nothing new today.')
    })

    test('does not repeat a final reply that was also saved with a tool call', () => {
        expect(composeCronNotificationBody([briefing], briefing)).toBe(briefing.trim())
    })

    test('drops the empty-run placeholder when earlier rounds produced content', () => {
        expect(composeCronNotificationBody([briefing], '(completed)')).toBe(briefing.trim())
        expect(composeCronNotificationBody([], '(completed)')).toBe('(completed)')
    })
})
