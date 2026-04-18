/**
 * Utility functions to convert cron expressions to human-readable text
 * and build cron expressions from structured schedule options.
 */

export type CronFrequency = 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'

export interface CronParts {
    frequency: CronFrequency
    everyMinutes: number
    atMinute: number
    atHour: number
    weekday: number
    monthDay: number
    customExpr: string
}

const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const pad = (n: number) => String(n).padStart(2, '0')

/** Parse a cron expression into structured parts */
export function parseCronExpr(expr: string): CronParts {
    const defaults: CronParts = {
        frequency: 'daily', everyMinutes: 30, atMinute: 0,
        atHour: 9, weekday: 1, monthDay: 1, customExpr: ''
    }
    if (!expr) return defaults
    const parts = expr.trim().split(/\s+/)
    if (parts.length !== 5) return { ...defaults, frequency: 'custom', customExpr: expr }
    const [min, hr, dom, , dow] = parts

    const mEvery = min.match(/^\*\/(\d+)$/)
    if (mEvery && hr === '*' && dom === '*' && dow === '*')
        return { ...defaults, frequency: 'minutes', everyMinutes: parseInt(mEvery[1]) }
    if (/^\d+$/.test(min) && hr === '*' && dom === '*' && dow === '*')
        return { ...defaults, frequency: 'hourly', atMinute: parseInt(min) }
    if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === '*' && dow === '*')
        return { ...defaults, frequency: 'daily', atMinute: parseInt(min), atHour: parseInt(hr) }
    if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === '*' && /^\d$/.test(dow))
        return { ...defaults, frequency: 'weekly', atMinute: parseInt(min), atHour: parseInt(hr), weekday: parseInt(dow) }
    if (/^\d+$/.test(min) && /^\d+$/.test(hr) && /^\d+$/.test(dom) && dow === '*')
        return { ...defaults, frequency: 'monthly', atMinute: parseInt(min), atHour: parseInt(hr), monthDay: parseInt(dom) }

    return { ...defaults, frequency: 'custom', customExpr: expr }
}

/** Build a cron expression string from structured parts */
export function buildCronExpr(p: CronParts): string {
    switch (p.frequency) {
        case 'minutes': return `*/${p.everyMinutes} * * * *`
        case 'hourly': return `${p.atMinute} * * * *`
        case 'daily': return `${p.atMinute} ${p.atHour} * * *`
        case 'weekly': return `${p.atMinute} ${p.atHour} * * ${p.weekday}`
        case 'monthly': return `${p.atMinute} ${p.atHour} ${p.monthDay} * *`
        case 'custom': return p.customExpr
    }
}

/** Convert a cron expression (or parts) to a human-readable string */
export function cronToHuman(exprOrParts: string | CronParts): string {
    const p = typeof exprOrParts === 'string' ? parseCronExpr(exprOrParts) : exprOrParts
    switch (p.frequency) {
        case 'minutes': return `Every ${p.everyMinutes} min`
        case 'hourly': return `Hourly at :${pad(p.atMinute)}`
        case 'daily': return `Daily at ${pad(p.atHour)}:${pad(p.atMinute)}`
        case 'weekly': return `${WEEKDAY_LABELS[p.weekday]}s at ${pad(p.atHour)}:${pad(p.atMinute)}`
        case 'monthly': return `Monthly on day ${p.monthDay} at ${pad(p.atHour)}:${pad(p.atMinute)}`
        case 'custom': return p.customExpr || '—'
    }
}

export const WEEKDAYS = WEEKDAY_LABELS
export const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i)
export const MINUTE_OPTIONS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]
export const INTERVAL_MINUTES = [1, 2, 5, 10, 15, 20, 30, 45]

export const FREQUENCY_OPTIONS: { value: CronFrequency; label: string; icon: string }[] = [
    { value: 'minutes', label: 'Every X min', icon: 'lucide:timer' },
    { value: 'hourly', label: 'Hourly', icon: 'lucide:clock-1' },
    { value: 'daily', label: 'Daily', icon: 'lucide:calendar' },
    { value: 'weekly', label: 'Weekly', icon: 'lucide:calendar-days' },
    { value: 'monthly', label: 'Monthly', icon: 'lucide:calendar-range' },
    { value: 'custom', label: 'Custom', icon: 'lucide:terminal' }
]
