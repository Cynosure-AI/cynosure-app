export interface PromptSmartTagContext {
    agentId?: string
    agentName?: string
    agentInternalName?: string
    providerId?: string
    model?: string
    conversationId?: string
    now?: Date
}

type PromptSmartTagValues = Record<string, string>

const TAG_PATTERN = /\{\{\s*([a-zA-Z][\w.-]*)\s*\}\}/g

export function resolvePromptSmartTags(prompt: string, context: PromptSmartTagContext): string {
    if (!prompt) return prompt

    const values = buildPromptSmartTagValues(context)
    return prompt.replace(TAG_PATTERN, (match, tagName: string) => {
        const value = values[tagName]
        return value === undefined ? match : value
    })
}

function buildPromptSmartTagValues(context: PromptSmartTagContext): PromptSmartTagValues {
    const now = context.now ?? new Date()
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || 'UTC'
    const location = resolveLocation()

    return {
        currentDateTime: formatDateTime(now, locale, timezone),
        currentDate: formatDate(now, locale, timezone),
        currentTime: formatTime(now, locale, timezone),
        localDateTime: formatDateTime(now, locale, timezone),
        localDate: formatDate(now, locale, timezone),
        localTime: formatTime(now, locale, timezone),
        isoDateTime: now.toISOString(),
        isoDate: now.toISOString().slice(0, 10),
        isoTime: now.toISOString().slice(11, 19),
        timezone,
        locale,
        location,
        agentId: context.agentId || '',
        agentName: context.agentName || '',
        agentInternalName: context.agentInternalName || '',
        providerId: context.providerId || '',
        model: context.model || '',
        conversationId: context.conversationId || '',
    }
}

function formatDateTime(date: Date, locale: string, timeZone: string): string {
    return new Intl.DateTimeFormat(locale, {
        dateStyle: 'full',
        timeStyle: 'long',
        timeZone,
    }).format(date)
}

function formatDate(date: Date, locale: string, timeZone: string): string {
    return new Intl.DateTimeFormat(locale, {
        dateStyle: 'full',
        timeZone,
    }).format(date)
}

function formatTime(date: Date, locale: string, timeZone: string): string {
    return new Intl.DateTimeFormat(locale, {
        timeStyle: 'long',
        timeZone,
    }).format(date)
}

function resolveLocation(): string {
    return process.env.CYNOSURE_LOCATION
        || process.env.APP_LOCATION
        || process.env.USER_LOCATION
        || process.env.LOCATION
        || ''
}
