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
 * Prompts carry the date but never the time of day: a value that changes every
 * minute would invalidate the provider prompt cache on almost every turn. The
 * former time tags stay recognised so older prompts don't show raw tags.
 */
const RETIRED_TIME_TAGS = new Set(['currentTime', 'localTime', 'isoTime'])

export function resolvePromptSmartTags(prompt: string, context: PromptSmartTagContext): string {
    if (!prompt) return prompt

    const values = buildPromptSmartTagValues(context)
    return prompt.replace(TAG_PATTERN, (match, tagName: string) => {
        if (RETIRED_TIME_TAGS.has(tagName)) return ''
        const value = values[tagName]
        return value === undefined ? match : value
    })
}

/** Today's date with the server timezone, e.g. "Friday, October 9, 2026 (Europe/Berlin)". */
export function describeCurrentDate(now = new Date()): string {
    const { locale, timezone } = resolveLocaleAndTimezone()
    return `${formatDate(now, locale, timezone)} (${timezone})`
}

function resolveLocaleAndTimezone(): { locale: string; timezone: string } {
    const options = Intl.DateTimeFormat().resolvedOptions()
    return {
        locale: options.locale || 'en-US',
        timezone: options.timeZone || process.env.TZ || 'UTC',
    }
}

function buildPromptSmartTagValues(context: PromptSmartTagContext): PromptSmartTagValues {
    const now = context.now ?? new Date()
    const { locale, timezone } = resolveLocaleAndTimezone()
    const date = formatDate(now, locale, timezone)
    return {
        userName: context.userName || 'user',
        currentDate: date,
        localDate: date,
        // Former date/time tags now resolve to the date alone.
        currentDateTime: date,
        localDateTime: date,
        isoDate: now.toISOString().slice(0, 10),
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

function formatDate(date: Date, locale: string, timeZone: string): string {
    return new Intl.DateTimeFormat(locale, {
        dateStyle: 'full',
        timeZone,
    }).format(date)
}
