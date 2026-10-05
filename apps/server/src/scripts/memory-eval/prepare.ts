/**
 * Builds an indexed data dir from the committed fixture corpus, using the
 * app's own indexing. Spawned by the
 * memory:eval CLI with CYNOSURE_DATA_DIR pointing at an empty fixture root
 * whose data/memories already holds the corpus files.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

export interface PrepareJob {
  providers: Array<Record<string, unknown>>
  settings: Array<{ key: string; value_json: string }>
  manifestPath: string
  manifest: Record<string, unknown>
}

if (!process.env.CYNOSURE_DATA_DIR?.includes('fixture-') || process.env.CYNOSURE_DISABLE_MEMORY_WATCHERS !== '1') {
  throw new Error('memory-eval prepare must run in a fixture data dir with watchers disabled')
}

const job = JSON.parse(readFileSync(process.argv[2], 'utf8')) as PrepareJob
const { getDb } = await import('../../db/database.js')
const { loadSavedProviders } = await import('../../routes/providers.js')
const { loadEmbeddingServiceFromDb } = await import('../../core/memory/embedding.js')
const { getRAGStore } = await import('../../core/memory/rag.js')
const { getAgentMemory } = await import('../../core/memory/agent-memory.js')
const { getAllMemoryFolders, getMemoryFolderDirectoryPath } = await import('../../core/memory/memory-folder-scope.js')

// Provider credentials and model settings come from the live install; the
// fixture gets its own fresh schema from getDb().
const db = getDb()
for (const provider of job.providers) {
  const columns = Object.keys(provider)
  db.prepare(`INSERT OR REPLACE INTO providers (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map((column) => provider[column]))
}
for (const setting of job.settings) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)').run(setting.key, setting.value_json)
}
loadSavedProviders()
loadEmbeddingServiceFromDb()
await getRAGStore().initialize()

const files = getAllMemoryFolders().flatMap((folder) => {
  const directory = getMemoryFolderDirectoryPath(folder.id)
  if (!directory) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => ({ folderId: folder.id, directory, fileName: entry.name }))
})
if (!files.length) throw new Error('Fixture corpus contains no markdown files')

const memory = getAgentMemory()
let chunks = 0
for (const file of files) {
  chunks += (await memory.reindexFile(file.directory, file.fileName, file.folderId)).chunkCount
}
console.log(`[memory-eval] indexed ${files.length} fixture documents (${chunks} chunks)`)

writeFileSync(job.manifestPath, JSON.stringify({ ...job.manifest, documents: files.length, chunks, preparedAt: Date.now() }, null, 1))
process.exit(0)
