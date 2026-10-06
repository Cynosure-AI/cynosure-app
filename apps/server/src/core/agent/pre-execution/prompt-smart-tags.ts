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

// Minute precision keeps resolved prompts stable enough for provider prefix caching.
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
