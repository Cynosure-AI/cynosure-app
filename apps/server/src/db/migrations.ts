import type Database from 'better-sqlite3'
import { BASELINE_SCHEMA } from './schema.js'

/**
 * A single, ordered schema change.
 *
 * Migrations are append-only: add a new entry with the next version number and
 * never edit or reorder one that has shipped. `PRAGMA user_version` records the
 * highest applied version, so each migration runs at most once per database.
 */
export interface SchemaMigration {
    version: number
    description: string
    up: (db: Database.Database) => void
}

/**
 * Ordered schema history.
 *
 * v1 is the frozen baseline in `schema.ts`. Future changes belong here as v2,
 * v3, … — both fresh and existing databases run the same `up` steps, so there
 * is exactly one code path to test and trust.
 *
 * Example:
 *   {
 *     version: 2,
 *     description: 'Add conversations.archived_at',
 *     up: (db) => db.exec('ALTER TABLE conversations ADD COLUMN archived_at INTEGER'),
 *   }
 */
const MIGRATIONS: SchemaMigration[] = [
    {
        version: 1,
        description: 'Baseline schema',
        up: (db) => db.exec(BASELINE_SCHEMA),
    },
    {
        version: 2,
        description: 'Add per-chunk memory analysis summaries',
        up: (db) => db.exec(`
            ALTER TABLE memory_knowledge_text_units
            ADD COLUMN summary TEXT NOT NULL DEFAULT ''
        `),
    },
    {
        version: 3,
        description: 'Rename the in-app notification tool',
        up: (db) => {
            for (const { table, column } of [
                { table: 'agents', column: 'tools_json' },
                { table: 'conversations', column: 'execution_config_json' },
                { table: 'cron_jobs', column: 'execution_config_json' },
            ]) {
                db.prepare(`
                    UPDATE ${table}
                    SET ${column} = replace(${column}, 'create_app_notification', 'notify_user_in_app')
                    WHERE ${column} LIKE '%create_app_notification%'
                `).run()
            }
        },
    },
    {
        version: 4,
        description: 'Remove agent tags',
        up: (db) => {
            const columns = db.pragma('table_info(agents)') as Array<{ name: string }>
            if (columns.some((column) => column.name === 'tags_json')) {
                db.exec('ALTER TABLE agents DROP COLUMN tags_json')
            }
        },
    },
    {
        version: 5,
        description: 'Persist staged attachment indexing progress',
        up: (db) => {
            const columns = new Set((db.pragma('table_info(staged_chat_attachments)') as Array<{ name: string }>).map((column) => column.name))
            const addColumn = (name: string, declaration: string) => {
                if (!columns.has(name)) db.exec(`ALTER TABLE staged_chat_attachments ADD COLUMN ${name} ${declaration}`)
            }
            addColumn('client_id', 'TEXT')
            addColumn('status', "TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('processing', 'ready', 'failed'))")
            addColumn('progress_current', 'INTEGER NOT NULL DEFAULT 0')
            addColumn('progress_total', 'INTEGER NOT NULL DEFAULT 0')
            addColumn('error', 'TEXT')
            addColumn('updated_at', 'INTEGER')
            db.exec('CREATE INDEX IF NOT EXISTS idx_staged_chat_attachments_status ON staged_chat_attachments(status, updated_at)')
        },
    },
    {
        version: 6,
        description: 'Add user-controlled auto-memory folder exclusions',
        up: (db) => {
            const columns = db.pragma('table_info(memory_folders)') as Array<{ name: string }>
            if (!columns.some((column) => column.name === 'auto_memory_excluded')) {
                db.exec(`
                    ALTER TABLE memory_folders
                    ADD COLUMN auto_memory_excluded INTEGER NOT NULL DEFAULT 0
                `)
            }

            // Preserve the behavior users had before exclusions became configurable.
            // Mark the named folder and its existing descendants; future folders are
            // governed only by this persisted setting.
            const rows = db.prepare('SELECT id, name, directory_path FROM memory_folders').all() as Array<{
                id: string
                name: string
                directory_path: string
            }>
            const legacyNames = new Set(['archive', 'subconscious', 'secret', 'hidden'])
            const excludedPaths = rows
                .filter((row) => legacyNames.has(row.name.toLowerCase()))
                .map((row) => row.directory_path.replace(/\\/g, '/').replace(/\/$/, ''))
            const update = db.prepare('UPDATE memory_folders SET auto_memory_excluded = 1 WHERE id = ?')
            for (const row of rows) {
                const path = row.directory_path.replace(/\\/g, '/').replace(/\/$/, '')
                if (excludedPaths.some((excluded) => path === excluded || path.startsWith(`${excluded}/`))) {
                    update.run(row.id)
                }
            }
        },
    },
    {
        version: 7,
        description: 'Persist ordered canonical chat events',
        up: (db) => db.exec(`
            CREATE TABLE IF NOT EXISTS chat_events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                execution_id TEXT NOT NULL,
                event_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chat_events_conversation_sequence
                ON chat_events(conversation_id, sequence);
        `),
    },
    {
        version: 8,
        description: 'Store provider-neutral message content blocks',
        up: (db) => {
            const columns = db.pragma('table_info(messages)') as Array<{ name: string }>
            if (!columns.some((column) => column.name === 'content_blocks_json')) {
                db.exec('ALTER TABLE messages ADD COLUMN content_blocks_json TEXT')
            }
            const contentBlocks = `(
                SELECT COALESCE(json_group_array(json(block)), '[]') FROM (
                    SELECT 0 AS bucket, 0 AS position, json_object('type', 'text', 'text', NEW.content) AS block
                    WHERE NEW.content <> ''
                    UNION ALL
                    SELECT 1, 0, json_object('type', 'reasoning', 'text', NEW.thinking)
                    WHERE NEW.thinking IS NOT NULL AND NEW.thinking <> ''
                    UNION ALL
                    SELECT 2, CAST(j.key AS INTEGER), json_object('type', 'image', 'artifactId', j.value, 'url', j.value)
                    FROM json_each(CASE WHEN json_valid(NEW.image_urls_json) THEN NEW.image_urls_json ELSE '[]' END) AS j
                    UNION ALL
                    SELECT 3, CAST(j.key AS INTEGER), json_object('type', 'video', 'artifactId', j.value, 'url', j.value)
                    FROM json_each(CASE WHEN json_valid(NEW.video_urls_json) THEN NEW.video_urls_json ELSE '[]' END) AS j
                    UNION ALL
                    SELECT 4, CAST(j.key AS INTEGER), json_object('type', 'audio', 'artifactId', j.value, 'url', j.value)
                    FROM json_each(CASE WHEN json_valid(NEW.audio_urls_json) THEN NEW.audio_urls_json ELSE '[]' END) AS j
                    UNION ALL
                    SELECT 5, 0, json_object('type', 'structured', 'value',
                        CASE WHEN json_valid(NEW.structured_content_json) THEN json(NEW.structured_content_json)
                            ELSE NEW.structured_content_json END)
                    WHERE NEW.structured_content_json IS NOT NULL
                    ORDER BY bucket, position
                )
            )`
            db.exec(`
                CREATE TRIGGER IF NOT EXISTS message_content_blocks_insert AFTER INSERT ON messages
                WHEN NEW.content_blocks_json IS NULL
                BEGIN
                    UPDATE messages SET content_blocks_json = ${contentBlocks} WHERE id = NEW.id;
                END;
                CREATE TRIGGER IF NOT EXISTS message_content_blocks_update
                AFTER UPDATE OF content, thinking, image_urls_json, video_urls_json, audio_urls_json, structured_content_json ON messages
                WHEN NEW.content_blocks_json IS OLD.content_blocks_json
                BEGIN
                    UPDATE messages SET content_blocks_json = ${contentBlocks} WHERE id = NEW.id;
                END;
            `)
            db.exec('UPDATE messages SET content = content WHERE content_blocks_json IS NULL')
        },
    },
    {
        version: 9,
        description: 'Keep message media and reasoning only in canonical content blocks',
        up: (db) => {
            db.exec('DROP TRIGGER IF EXISTS message_content_blocks_insert')
            db.exec('DROP TRIGGER IF EXISTS message_content_blocks_update')
            const columns = new Set((db.pragma('table_info(messages)') as Array<{ name: string }>).map((column) => column.name))
            for (const column of ['image_urls_json', 'video_urls_json', 'audio_urls_json', 'thinking', 'structured_content_json']) {
                if (columns.has(column)) db.exec(`ALTER TABLE messages DROP COLUMN ${column}`)
            }
        },
    },
    {
        version: 10,
        description: 'Use chat events as the sole persisted execution timeline',
        up: (db) => db.exec('DROP TABLE IF EXISTS execution_steps'),
    },
    {
        version: 11,
        description: 'Tag tool embedding caches with their generating profile',
        up: (db) => {
            for (const table of ['tool_router_embeddings', 'tool_router_tool_embeddings']) {
                const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>
                if (!columns.length) continue
                if (!columns.some((column) => column.name === 'profile_fingerprint')) {
                    db.exec(`ALTER TABLE ${table} ADD COLUMN profile_fingerprint TEXT NOT NULL DEFAULT ''`)
                }
            }
        },
    },
    {
        version: 12,
        description: 'Mark persisted assistant error messages',
        up: (db) => db.exec('ALTER TABLE messages ADD COLUMN is_error INTEGER NOT NULL DEFAULT 0'),
    },
    {
        version: 13,
        description: 'Name directory tools for their directory operations',
        up: (db) => {
            const renamed = new Map([
                ['file_list_directory', 'directory_list'],
                ['file_create_directory', 'directory_create'],
                ['file_merge', 'directory_merge'],
            ])
            const renameValue = (value: unknown): unknown => {
                if (typeof value === 'string') {
                    for (const [oldName, newName] of renamed) {
                        if (value === oldName) return newName
                        if (value === `builtin:files::${oldName}`) return `builtin:files::${newName}`
                    }
                    return value
                }
                if (Array.isArray(value)) return value.map(renameValue)
                if (value && typeof value === 'object') {
                    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, renameValue(entry)]))
                }
                return value
            }
            for (const { table, column } of [
                { table: 'agents', column: 'tools_json' },
                { table: 'conversations', column: 'execution_config_json' },
                { table: 'cron_jobs', column: 'execution_config_json' },
            ]) {
                const rows = db.prepare(`SELECT rowid, ${column} AS value FROM ${table}`).all() as Array<{ rowid: number; value: string }>
                const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`)
                for (const row of rows) {
                    if (![...renamed.keys()].some(name => row.value.includes(name))) continue
                    const original: unknown = JSON.parse(row.value)
                    const next = JSON.stringify(renameValue(original))
                    if (next !== row.value) update.run(next, row.rowid)
                }
            }
            for (const [oldName, newName] of renamed) {
                for (const prefix of ['', 'built_in_files__']) {
                    const oldApprovalName = `${prefix}${oldName}`
                    const newApprovalName = `${prefix}${newName}`
                    db.prepare('INSERT OR IGNORE INTO tool_approvals (tool_name, auto_approve) SELECT ?, auto_approve FROM tool_approvals WHERE tool_name = ?').run(newApprovalName, oldApprovalName)
                    db.prepare('DELETE FROM tool_approvals WHERE tool_name = ?').run(oldApprovalName)
                    db.prepare('INSERT OR IGNORE INTO session_tool_approvals (conversation_id, tool_name, created_at) SELECT conversation_id, ?, created_at FROM session_tool_approvals WHERE tool_name = ?').run(newApprovalName, oldApprovalName)
                    db.prepare('DELETE FROM session_tool_approvals WHERE tool_name = ?').run(oldApprovalName)
                }
                db.prepare('DELETE FROM tool_router_tool_embeddings WHERE tool_name = ?').run(oldName)
            }
        },
    },
    {
        version: 14,
        description: 'Merge user notification tools with app as the default channel',
        up: (db) => {
            const oldNames = ['notify_user_in_app', 'notify_user_on_channel', 'create_app_notification']
            const oldKeys = new Set(oldNames.flatMap(name => [name, `builtin::${name}`, `builtin:notifications::${name}`]))
            const renameTools = (tools: unknown[]): unknown[] => [...new Set(tools.map(tool =>
                typeof tool === 'string' && oldKeys.has(tool) ? 'builtin:notifications::notify_user' : tool,
            ))]
            for (const { table, column } of [
                { table: 'agents', column: 'tools_json' },
                { table: 'conversations', column: 'execution_config_json' },
                { table: 'cron_jobs', column: 'execution_config_json' },
            ]) {
                const rows = db.prepare(`SELECT rowid, ${column} AS value FROM ${table}`).all() as Array<{ rowid: number; value: string }>
                const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`)
                for (const row of rows) {
                    if (!row.value || !oldNames.some(name => row.value.includes(name))) continue
                    const value = JSON.parse(row.value) as unknown
                    if (column === 'tools_json' && Array.isArray(value)) {
                        update.run(JSON.stringify(renameTools(value)), row.rowid)
                    } else if (value && typeof value === 'object' && 'allowedTools' in value && Array.isArray(value.allowedTools)) {
                        value.allowedTools = renameTools(value.allowedTools)
                        update.run(JSON.stringify(value), row.rowid)
                    }
                }
            }
            for (const prefix of ['', 'built_in_notifications__']) {
                const approval = db.prepare('SELECT auto_approve FROM tool_approvals WHERE tool_name = ?')
                const app = approval.get(`${prefix}notify_user_in_app`) as { auto_approve: number } | undefined
                const channel = approval.get(`${prefix}notify_user_on_channel`) as { auto_approve: number } | undefined
                // An approval for app-only delivery must not silently authorize messaging channels.
                if (app || channel) {
                    db.prepare('INSERT OR IGNORE INTO tool_approvals (tool_name, auto_approve) VALUES (?, ?)')
                        .run(`${prefix}notify_user`, channel?.auto_approve === 1 && app?.auto_approve !== 0 ? 1 : 0)
                }
                db.prepare('INSERT OR IGNORE INTO session_tool_approvals (conversation_id, tool_name, created_at) SELECT conversation_id, ?, created_at FROM session_tool_approvals WHERE tool_name = ?')
                    .run(`${prefix}notify_user`, `${prefix}notify_user_on_channel`)
                for (const name of oldNames) {
                    db.prepare('DELETE FROM tool_approvals WHERE tool_name = ?').run(`${prefix}${name}`)
                    db.prepare('DELETE FROM session_tool_approvals WHERE tool_name = ?').run(`${prefix}${name}`)
                }
            }
            for (const name of oldNames) db.prepare('DELETE FROM tool_router_tool_embeddings WHERE tool_name = ?').run(name)
        },
    },
]

/** The schema version this build produces and expects. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

export function getUserVersion(db: Database.Database): number {
    return db.pragma('user_version', { simple: true }) as number
}

export interface MigrationResult {
    from: number
    to: number
    applied: number[]
}

/**
 * Apply every migration after the database's recorded version.
 *
 * `migrations` is injectable so tests can drive the runner with synthetic
 * histories; production callers use the default.
 */
export function applySchemaMigrations(
    db: Database.Database,
    migrations: SchemaMigration[] = MIGRATIONS,
): MigrationResult {
    const target = migrations[migrations.length - 1]?.version ?? 0
    const from = getUserVersion(db)
    if (from > target) {
        throw new Error(
            `Database schema version ${from} was written by a newer version of Cynosure (this build supports ${target}). Update the app to open it.`,
        )
    }

    // v1 is the new authoritative baseline. Pre-versioning databases are not
    // compatible with it, so rebuild their schema instead of stamping a
    // partially upgraded layout as current.
    const rebuilding = from === 0 && hasUserObjects(db)
    if (rebuilding) resetUnversionedSchema(db)

    const ordered = [...migrations].sort((a, b) => a.version - b.version)
    const applied: number[] = []
    for (const migration of ordered) {
        if (migration.version <= from) continue
        db.transaction(() => {
            migration.up(db)
            db.pragma(`user_version = ${migration.version}`)
        })()
        applied.push(migration.version)
    }

    if (rebuilding) {
        console.info(`[db] Rebuilt an unversioned database at schema version ${getUserVersion(db)}`)
    }

    return { from, to: getUserVersion(db), applied }
}

function hasUserObjects(db: Database.Database): boolean {
    const row = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' LIMIT 1")
        .get()
    return Boolean(row)
}

function resetUnversionedSchema(db: Database.Database): void {
    const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1
    db.pragma('foreign_keys = OFF')
    try {
        db.transaction(() => {
            const objects = db.prepare(`
                SELECT type, name FROM sqlite_master
                WHERE type IN ('view', 'table') AND name NOT LIKE 'sqlite_%'
                ORDER BY CASE type WHEN 'view' THEN 0 ELSE 1 END
            `).all() as Array<{ type: 'table' | 'view'; name: string }>
            for (const object of objects) {
                const name = object.name.replace(/"/g, '""')
                db.exec(`DROP ${object.type.toUpperCase()} IF EXISTS "${name}"`)
            }
        })()
    } finally {
        if (foreignKeysEnabled) db.pragma('foreign_keys = ON')
    }
}
