import { getDb } from '../db/database.js'

const USER_PROFILE_KEY = 'userProfile'

export interface UserSettings {
    name: string
    avatarUrl: string | null
}

export function getUserSettings(): UserSettings {
    const row = getDb()
        .prepare('SELECT value_json FROM settings WHERE key = ?')
        .get(USER_PROFILE_KEY) as { value_json: string } | undefined

    if (!row) return { name: '', avatarUrl: null }

    try {
        const value = JSON.parse(row.value_json) as Partial<UserSettings>
        return {
            name: typeof value.name === 'string' ? value.name : '',
            avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl : null,
        }
    } catch {
        return { name: '', avatarUrl: null }
    }
}

export function saveUserSettings(input: Partial<UserSettings>): UserSettings {
    const current = getUserSettings()
    const next: UserSettings = {
        name: input.name === undefined ? current.name : input.name.trim().slice(0, 100),
        avatarUrl: input.avatarUrl === undefined ? current.avatarUrl : input.avatarUrl,
    }

    getDb()
        .prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)')
        .run(USER_PROFILE_KEY, JSON.stringify(next))

    return next
}
