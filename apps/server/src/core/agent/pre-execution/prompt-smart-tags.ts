export interface PromptSmartTagContext {
    userName?: string
    agentId?: string
    agentName?: string
    agentInternalName?: string
    providerId?: string
    model?: string
    conversationId?: string
    selectedMemFolderNames?: Array<string | { name: string; description?: string }>
    now?: Date
}

type PromptSmartTagValues = Record<string, string>

const TAG_PATTERN = /\{\{\s*([a-zA-Z][\w.-]*)\s*\}\}/g

/**
 * Time-of-day tags change every minute, so resolving them in the system prompt
 * would invalidate the provider prompt cache on almost every turn. They resolve
 * to a fixed pointer instead, and the time itself travels as turn-local context.
 */
const TURN_TIME_TAGS = new Set(['currentDateTime', 'currentTime', 'localDateTime', 'localTime', 'isoTime'])
const TURN_TIME_POINTER = '(see the latest [Current time] note)'

export function resolvePromptSmartTags(prompt: string, context: PromptSmartTagContext): string {
    if (!prompt) return prompt

    const values = buildPromptSmartTagValues(context)
    return prompt.replace(TAG_PATTERN, (match, tagName: string) => {
        if (TURN_TIME_TAGS.has(tagName)) return TURN_TIME_POINTER
        const value = values[tagName]
        return value === undefined ? match : value
    })
}

/** The current time for a prompt that uses time-of-day tags; null when it uses none. */
export function resolvePromptTimeContext(prompt: string, context: PromptSmartTagContext): string | null {
    if (!prompt) return null
    const usesTime = [...prompt.matchAll(TAG_PATTERN)].some(([, tagName]) => TURN_TIME_TAGS.has(tagName))
    if (!usesTime) return null

    const values = buildPromptSmartTagValues(context)
    return `[Current time]\nLocal: ${values.localDateTime}\nUTC: ${values.isoDate} ${values.isoTime}\n[/Current time]`
}

function buildPromptSmartTagValues(context: PromptSmartTagContext): PromptSmartTagValues {
    const now = context.now ?? new Date()
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || 'UTC'
    return {
        userName: context.userName || 'user',
        currentDateTime: formatDateTime(now, locale, timezone),
        currentDate: formatDate(now, locale, timezone),
        currentTime: formatTime(now, locale, timezone),
        localDateTime: formatDateTime(now, locale, timezone),
        localDate: formatDate(now, locale, timezone),
        localTime: formatTime(now, locale, timezone),
        isoDate: now.toISOString().slice(0, 10),
        isoTime: now.toISOString().slice(11, 19),
        timezone,
        locale,
        agentId: context.agentId || '',
        agentName: context.agentName || '',
        agentInternalName: context.agentInternalName || '',
        providerId: context.providerId || '',
        model: context.model || '',
        conversationId: context.conversationId || '',
        selectedMemFolderNames: formatSelectedMemoryFolderNames(context.selectedMemFolderNames),
    }
}

function formatSelectedMemoryFolderNames(folders: PromptSmartTagContext['selectedMemFolderNames']): string {
    const formatted = (folders ?? []).map((folder) => {
        const name = (typeof folder === 'string' ? folder : folder.name).trim()
        if (!name) return ''
        const description = typeof folder === 'string' ? '' : folder.description?.trim()
        return description ? `${name} (description: ${description})` : name
    }).filter(Boolean)
    const uniqueFolders = Array.from(new Set(formatted))
    return uniqueFolders.length
        ? `Provided Memory Folders are: ${uniqueFolders.join(', ')}`
        : ''
}

const MINUTE_PRECISION_TIME: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
}

function formatDateTime(date: Date, locale: string, timeZone: string): string {
    return new Intl.DateTimeFormat(locale, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        ...MINUTE_PRECISION_TIME,
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
        ...MINUTE_PRECISION_TIME,
        timeZone,
    }).format(date)
}
