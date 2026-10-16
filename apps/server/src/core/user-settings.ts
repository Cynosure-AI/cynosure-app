import { getDb } from '../db/database.js'

const USER_PROFILE_KEY = 'userProfile'
export const MAX_USER_NAME_LENGTH = 100
export const MAX_USER_INSTRUCTIONS_LENGTH = 4_000

export interface UserSettings {
    name: string
    avatarUrl: string | null
    /** Standing instructions included in every chat run. */
    instructions: string
}

const EMPTY_SETTINGS: UserSettings = { name: '', avatarUrl: null, instructions: '' }

export function getUserSettings(): UserSettings {
    const row = getDb()
        .prepare('SELECT value_json FROM settings WHERE key = ?')
        .get(USER_PROFILE_KEY) as { value_json: string } | undefined

    if (!row) return { ...EMPTY_SETTINGS }

    try {
        const value = JSON.parse(row.value_json) as Partial<UserSettings>
        return {
            name: typeof value.name === 'string' ? value.name : '',
            avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl : null,
            instructions: typeof value.instructions === 'string' ? value.instructions : '',
        }
    } catch {
        return { ...EMPTY_SETTINGS }
    }
}

export function saveUserSettings(input: Partial<UserSettings>): UserSettings {
    const current = getUserSettings()
    const next: UserSettings = {
        name: input.name === undefined ? current.name : input.name.trim().slice(0, MAX_USER_NAME_LENGTH),
        avatarUrl: input.avatarUrl === undefined ? current.avatarUrl : input.avatarUrl,
        instructions: input.instructions === undefined
            ? current.instructions
            : input.instructions.trim().slice(0, MAX_USER_INSTRUCTIONS_LENGTH),
    }

    getDb()
        .prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)')
        .run(USER_PROFILE_KEY, JSON.stringify(next))

    return next
}
