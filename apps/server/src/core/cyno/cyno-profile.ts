/**
 * Cyno, the default assistant. New chats start from this profile, and runs
 * without an agent use it. It lives in the settings table so it is shared by
 * every client and survives browser resets.
 */
import { getDb } from '../../db/database.js'
import type { AvatarConfig, CynoProfile, ReasoningEffort, SubAgentAssignmentDto } from '@shared/types'
import { AvatarConfigError, normalizeAvatarConfig } from '../agents/avatar-config.js'

const CYNO_PROFILE_KEY = 'cynoProfile'
const MAX_NAME_LENGTH = 60
const MAX_ICON_LENGTH = 2 * 1024 * 1024
const REASONING_EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export const DEFAULT_CYNO_SYSTEM_PROMPT = `
## Identity

You are **Cyno**, the user's assistant for getting things done. Move their work forward: answer, decide, draft, fix, or execute, whichever the request calls for.

## How you work

- Lead with the answer or the result. Add background only when it changes what the user would do next.
- Give your honest assessment, including when the user's plan has a flaw or a tradeoff they haven't raised. When there are options, recommend one rather than listing every possibility.
- When something is broken, find the cause before proposing a fix, and say so when a fix only treats the symptom.
- If a request is ambiguous and a wrong guess would be costly, ask one focused question. Otherwise make a sensible assumption, state it in a line, and proceed.
- Keep what you know separate from what you're inferring. Never invent facts, sources, or the results of actions you didn't take.

## Memory

{{selectedMemFolderNames}}
If memory folders are listed above, check them when the user mentions people, projects, past decisions or preferences, before answering or asking them to repeat themselves.

## Context

Current date: {{currentDate}}
`

/** Cyno's own face: a round crimson blob, so the default assistant reads as the default. */
export const DEFAULT_CYNO_AVATAR: AvatarConfig = { seed: null, hue: 18, tone: 0.7, shape: 'round' }

function isDefaultAvatar(avatar: AvatarConfig | null): boolean {
    return avatar === null || JSON.stringify(avatar) === JSON.stringify(DEFAULT_CYNO_AVATAR)
}

export function defaultCynoProfile(): CynoProfile {
    return {
        name: 'Cyno',
        iconUrl: null,
        avatar: { ...DEFAULT_CYNO_AVATAR },
        avatarSource: 'generated',
        systemPrompt: DEFAULT_CYNO_SYSTEM_PROMPT,
        providerId: '',
        model: '',
        tools: null,
        memoryFolders: null,
        subAgents: [],
        thinkingEnabled: true,
        reasoningEffort: 'medium',
        autoToolRouting: true,
        autoMemory: true,
        dreamingEnabled: true,
        updatedAt: 0,
    }
}

export class CynoProfileError extends Error {}

function stringList(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new CynoProfileError(`${field} must be a list of strings`)
    }
    return [...new Set(value as string[])]
}

/** Validate a partial update; unknown fields are ignored. */
function normalizeUpdate(input: Record<string, unknown>): Partial<CynoProfile> {
    const update: Partial<CynoProfile> = {}
    if (input.name !== undefined) {
        if (typeof input.name !== 'string' || !input.name.trim()) throw new CynoProfileError('Name must not be empty')
        update.name = input.name.trim().slice(0, MAX_NAME_LENGTH)
    }
    if (input.iconUrl !== undefined) {
        if (input.iconUrl !== null && (
            typeof input.iconUrl !== 'string'
            || input.iconUrl.length > MAX_ICON_LENGTH
            || !/^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,/i.test(input.iconUrl)
        )) {
            throw new CynoProfileError('Icon must be a supported image smaller than 2 MB, or null')
        }
        update.iconUrl = input.iconUrl as string | null
    }
    if (input.avatarSource !== undefined) {
        if (input.avatarSource !== 'image' && input.avatarSource !== 'generated') {
            throw new CynoProfileError("avatarSource must be 'image' or 'generated'")
        }
        update.avatarSource = input.avatarSource
    }
    if (input.avatar !== undefined) {
        try {
            update.avatar = normalizeAvatarConfig(input.avatar)
        } catch (error) {
            if (error instanceof AvatarConfigError) throw new CynoProfileError(error.message)
            throw error
        }
    }
    for (const field of ['systemPrompt', 'providerId', 'model'] as const) {
        if (input[field] === undefined) continue
        if (typeof input[field] !== 'string') throw new CynoProfileError(`${field} must be a string`)
        update[field] = input[field] as string
    }
    for (const field of ['thinkingEnabled', 'autoToolRouting', 'autoMemory', 'dreamingEnabled'] as const) {
        if (input[field] === undefined) continue
        if (typeof input[field] !== 'boolean') throw new CynoProfileError(`${field} must be true or false`)
        update[field] = input[field] as boolean
    }
    if (input.reasoningEffort !== undefined) {
        if (!REASONING_EFFORTS.includes(input.reasoningEffort as ReasoningEffort)) throw new CynoProfileError('Unknown reasoning effort')
        update.reasoningEffort = input.reasoningEffort as ReasoningEffort
    }
    if (input.tools !== undefined) update.tools = input.tools === null ? null : stringList(input.tools, 'tools')
    if (input.memoryFolders !== undefined) {
        update.memoryFolders = input.memoryFolders === null ? null : stringList(input.memoryFolders, 'memoryFolders')
    }
    if (input.subAgents !== undefined) {
        if (!Array.isArray(input.subAgents)) throw new CynoProfileError('subAgents must be a list')
        const ids = stringList(input.subAgents.map((item: unknown) =>
            item && typeof item === 'object' ? (item as SubAgentAssignmentDto).agentId : item), 'subAgents')
        update.subAgents = ids.map((agentId) => ({ agentId }))
    }
    return update
}

export function getCynoProfile(): CynoProfile {
    const defaults = defaultCynoProfile()
    const row = getDb().prepare('SELECT value_json FROM settings WHERE key = ?').get(CYNO_PROFILE_KEY) as { value_json: string } | undefined
    if (!row) return defaults
    try {
        // Stored values are re-validated so a hand-edited row cannot break runs.
        const stored = normalizeUpdate(JSON.parse(row.value_json) as Record<string, unknown>)
        const updatedAt = (JSON.parse(row.value_json) as { updatedAt?: unknown }).updatedAt
        // A stored null means "the default face", so a later default change reaches it.
        const avatar = stored.avatar ?? defaults.avatar
        // Profiles from before the explicit choice show their image if they have one.
        const avatarSource = stored.avatarSource ?? (stored.iconUrl ? 'image' : 'generated')
        return { ...defaults, ...stored, avatar, avatarSource, updatedAt: typeof updatedAt === 'number' ? updatedAt : 0 }
    } catch {
        return defaults
    }
}

/** Cyno's image when it is the chosen face, else null for the generated avatar. */
export function cynoDisplayIconUrl(profile: CynoProfile): string | null {
    return profile.avatarSource === 'image' ? profile.iconUrl : null
}

/** Apply a partial update. Throws CynoProfileError for invalid input. */
export function saveCynoProfile(input: Record<string, unknown>): CynoProfile {
    const update = normalizeUpdate(input)
    // Uploading an image picks it; removing it falls back to the generated avatar.
    if (update.iconUrl !== undefined && update.avatarSource === undefined) update.avatarSource = update.iconUrl ? 'image' : 'generated'
    const next: CynoProfile = { ...getCynoProfile(), ...update, updatedAt: Date.now() }
    const stored = { ...next, avatar: isDefaultAvatar(next.avatar) ? null : next.avatar }
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(CYNO_PROFILE_KEY, JSON.stringify(stored))
    return { ...next, avatar: next.avatar ?? { ...DEFAULT_CYNO_AVATAR } }
}
