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
