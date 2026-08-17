import { describe, expect, test } from 'vitest'
import { isValidCronSchedule } from './cron-scheduler.js'

describe('cron schedule validation', () => {
    test('accepts valid schedules and rejects empty or malformed schedules', () => {
        expect(isValidCronSchedule('*/5 * * * *')).toBe(true)
        expect(isValidCronSchedule('0 8 * * 1-5')).toBe(true)
        expect(isValidCronSchedule('')).toBe(false)
        expect(isValidCronSchedule('not a cron expression')).toBe(false)
    })
})
