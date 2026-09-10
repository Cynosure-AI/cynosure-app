import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
    AGENT_MEMORY_FOLDER_NAME,
    isIgnoredMemoryFolderName,
    runFolderModelCleanupOnce,
    validateRelativePath,
} from './memory-space-folders.js'

describe('memory space folders', () => {
    let dataDir: string

    beforeEach(() => {
        dataDir = mkdtempSync(join(tmpdir(), 'cynosure-memory-folders-'))
        process.env.CYNOSURE_DATA_DIR = dataDir
    })

    afterEach(() => {
        delete process.env.CYNOSURE_DATA_DIR
        rmSync(dataDir, { recursive: true, force: true })
    })

    test('allows only the reserved .agents root among hidden memory folders', () => {
        expect(validateRelativePath('.agents/research_assistant')).toBe('.agents/research_assistant')
        expect(isIgnoredMemoryFolderName(AGENT_MEMORY_FOLDER_NAME, true)).toBe(false)
        expect(() => validateRelativePath('.private/notes')).toThrow(/reserved/)
        expect(() => validateRelativePath('shared/.private')).toThrow(/reserved/)
    })

    test('migrates the legacy agents folder and keeps memory-space IDs intact', async () => {
        const db = new Database(':memory:')
        db.exec(`
            CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
            CREATE TABLE memory_spaces (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                folder_path TEXT NOT NULL DEFAULT '',
                sort_order INTEGER NOT NULL DEFAULT 0,
                is_default INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
        `)
        db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)')
            .run('memory.folder_model_v1', '{}')

        const memoryRoot = join(dataDir, 'data', 'memories')
        const legacyRoot = join(memoryRoot, 'agents')
        const legacyAgent = join(legacyRoot, 'research_assistant')
        mkdirSync(legacyAgent, { recursive: true })
        db.prepare(`
            INSERT INTO memory_spaces (id, name, folder_path, created_at)
            VALUES (?, ?, ?, ?), (?, ?, ?, ?)
        `).run(
            'agent-root', 'agents', legacyRoot, 1,
            'agent-space', 'research_assistant', legacyAgent, 1,
        )

        await runFolderModelCleanupOnce(db)

        const currentRoot = join(memoryRoot, AGENT_MEMORY_FOLDER_NAME)
        expect(existsSync(legacyRoot)).toBe(false)
        expect(existsSync(join(currentRoot, 'research_assistant'))).toBe(true)
        expect(db.prepare('SELECT folder_path FROM memory_spaces WHERE id = ?').pluck().get('agent-root')).toBe(currentRoot)
        expect(db.prepare('SELECT folder_path FROM memory_spaces WHERE id = ?').pluck().get('agent-space')).toBe(join(currentRoot, 'research_assistant'))
        db.close()
    })
})
