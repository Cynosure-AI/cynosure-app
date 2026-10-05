import Database from 'better-sqlite3'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Copy the live data dir into a throwaway config root so evaluation can mutate
 * indexes and run the real pipeline without touching the user's data or a
 * running server. Returns the root to use as CYNOSURE_DATA_DIR.
 */
export async function createSnapshot(liveAppDataDir: string, opts: { parentDir?: string } = {}): Promise<string> {
  const root = mkdtempSync(join(opts.parentDir || tmpdir(), 'cynosure-memory-eval-'))
  const data = join(root, 'data')
  mkdirSync(join(data, 'sqlite'), { recursive: true })

  // The backup API produces a consistent copy even while the server writes (WAL).
  const live = new Database(join(liveAppDataDir, 'sqlite', 'cynosure.db'), { readonly: true, fileMustExist: true })
  try {
    await live.backup(join(data, 'sqlite', 'cynosure.db'))
  } finally {
    live.close()
  }

  for (const table of ['permanent_memory.lance', 'memory_knowledge_v2.lance']) {
    const source = join(liveAppDataDir, 'lancedb', table)
    if (existsSync(source)) cpSync(source, join(data, 'lancedb', table), { recursive: true })
  }
  // Indexes are the evaluation target; markdown only needs to exist so folder
  // listing and document references resolve inside the snapshot.
  const liveMemories = join(liveAppDataDir, 'memories')
  if (existsSync(liveMemories)) cpSync(liveMemories, join(data, 'memories'), { recursive: true })

  const db = new Database(join(data, 'sqlite', 'cynosure.db'))
  try {
    db.prepare('UPDATE memory_folders SET directory_path = replace(directory_path, ?, ?)').run(liveMemories, join(data, 'memories'))
    const escaped = db.prepare('SELECT count(*) AS n FROM memory_folders WHERE directory_path != \'\' AND directory_path NOT LIKE ?')
      .get(`${join(data, 'memories')}%`) as { n: number }
    if (escaped.n > 0) throw new Error(`${escaped.n} memory folder(s) point outside the snapshot; refusing to evaluate`)
  } finally {
    db.close()
  }
  return root
}

export function removeSnapshot(root: string): void {
  if (root.includes('cynosure-memory-eval-')) rmSync(root, { recursive: true, force: true })
}
