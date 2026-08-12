import { getDb } from '../../db/database.js'

export interface MemoryRetrievalConfig {
  resultCount: number
}

const SETTINGS_KEY = 'memoryRetrieval'
const DEFAULT_CONFIG: MemoryRetrievalConfig = {
  resultCount: 10,
}

function normalizeConfig(config: Partial<MemoryRetrievalConfig> | undefined): MemoryRetrievalConfig {
  const resultCount = Number.isFinite(config?.resultCount)
    ? Math.round(config!.resultCount as number)
    : DEFAULT_CONFIG.resultCount

  return {
    resultCount: Math.min(50, Math.max(1, resultCount)),
  }
}

export function getMemoryRetrievalConfig(): MemoryRetrievalConfig {
  try {
    const row = getDb()
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value_json: string } | undefined
    if (!row) return { ...DEFAULT_CONFIG }
    return normalizeConfig(JSON.parse(row.value_json) as Partial<MemoryRetrievalConfig>)
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveMemoryRetrievalConfig(config: Partial<MemoryRetrievalConfig>): MemoryRetrievalConfig {
  const normalized = normalizeConfig(config)
  getDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)')
    .run(SETTINGS_KEY, JSON.stringify(normalized))
  return normalized
}
