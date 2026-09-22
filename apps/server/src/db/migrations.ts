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
        description: 'Store provider-neutral chat content beside legacy media columns',
        up: (db) => {
            db.exec('ALTER TABLE messages ADD COLUMN content_blocks_json TEXT')
        },
    },
    {
        version: 8,
        description: 'Persist ordered canonical chat events for replay',
        up: (db) => db.exec(`
            CREATE TABLE chat_events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                execution_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                item_id TEXT,
                payload_json TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX idx_chat_events_conversation_sequence
                ON chat_events(conversation_id, sequence);
            CREATE UNIQUE INDEX idx_chat_events_item
                ON chat_events(conversation_id, item_id) WHERE event_type = 'item.appended';
        `),
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
