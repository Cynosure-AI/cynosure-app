import { getDb } from '../db/database.js'

const KEY = 'providerModelFavorites'

export interface ModelFavorite {
    providerId: string
    model: string
    modelType: string
    label: string
}

export function getModelFavorites(): { favorites: ModelFavorite[]; initialized: boolean } {
    const row = getDb().prepare('SELECT value_json FROM settings WHERE key = ?')
        .get(KEY) as { value_json: string } | undefined
    if (!row) return { favorites: [], initialized: false }
    try {
        const favorites = JSON.parse(row.value_json)
        return { favorites: Array.isArray(favorites) ? favorites : [], initialized: true }
    } catch {
        return { favorites: [], initialized: true }
    }
}

export function saveModelFavorites(favorites: ModelFavorite[]): ModelFavorite[] {
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)')
        .run(KEY, JSON.stringify(favorites))
    return favorites
}
