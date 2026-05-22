import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { getAppDataDir, getDefaultMemorySpaceDir } from '../core/data-dir.js'

let db: Database.Database | null = null

function getDbPath(): string {
  const dbDir = join(getAppDataDir(), 'sqlite')
  mkdirSync(dbDir, { recursive: true })
  return join(dbDir, 'cynosure.db')
}

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(getDbPath())
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    createTables(db)
    // All pending HITL are void after a server restart — the executor promises are gone.
    db.prepare('DELETE FROM pending_hitl').run()
  }
  return db
}

export function ensureDefaultMemorySpace(database: Database.Database = getDb()): void {
  const defaultSpaceId = 'default'
  const defaultFolderPath = getDefaultMemorySpaceDir()
  mkdirSync(defaultFolderPath, { recursive: true })

  const defaultSpaceExists = database.prepare("SELECT id FROM memory_spaces WHERE id = ?").get(defaultSpaceId)
  if (!defaultSpaceExists) {
    const now = Date.now()
    database.prepare("INSERT INTO memory_spaces (id, name, description, folder_path, sort_order, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(defaultSpaceId, 'Default', 'Default memory space for general knowledge and notes', defaultFolderPath, 0, 1, now)
    return
  }

  database.prepare("UPDATE memory_spaces SET folder_path = ?, is_default = 1 WHERE id = ?")
    .run(defaultFolderPath, defaultSpaceId)
}

function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key_enc TEXT,
      default_model TEXT NOT NULL,
      config_json TEXT NOT NULL,
      is_last_used INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      agent_id TEXT,
      ma_workspace_id TEXT,
      origin TEXT NOT NULL DEFAULT 'chat',
      pinned INTEGER NOT NULL DEFAULT 0,
      last_context_tokens INTEGER,
      config_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agent_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_ma_workspace ON conversations(ma_workspace_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls_json TEXT,
      tool_call_id TEXT,
      provider TEXT,
      model TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      latency_ms INTEGER,
      image_urls_json TEXT,
      agent_id TEXT,
      memory_sources_json TEXT,
      thinking TEXT,
      audio_urls_json TEXT,
      file_attachments_json TEXT,
      context_tokens INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id),
      status TEXT NOT NULL DEFAULT 'pending',
      definition_json TEXT NOT NULL,
      result_json TEXT,
      iterations INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

    CREATE TABLE IF NOT EXISTS execution_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      iteration INTEGER,
      event_type TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_execution_logs_task ON execution_logs(task_id);

    CREATE TABLE IF NOT EXISTS execution_steps (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      task_id TEXT,
      iteration INTEGER NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      plan TEXT,
      tool_calls_json TEXT,
      results_json TEXT,
      evaluation_json TEXT,
      ma_codename TEXT,
      ma_agent_name TEXT,
      ma_phase TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_execution_steps_conversation ON execution_steps(conversation_id);

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '[]',
      env_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      icon_url TEXT,
      origin TEXT,
      env_hints_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_approvals (
      tool_name TEXT PRIMARY KEY,
      auto_approve INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS session_tool_approvals (
      conversation_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, tool_name)
    );
    CREATE INDEX IF NOT EXISTS idx_session_tool_approvals_conversation ON session_tool_approvals(conversation_id);

    CREATE TABLE IF NOT EXISTS tool_router_embeddings (
      namespace_id TEXT NOT NULL,
      embedding_provider_id TEXT NOT NULL DEFAULT '',
      embedding_model TEXT NOT NULL,
      embedding_dimensions INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (namespace_id, embedding_provider_id, embedding_model, embedding_dimensions)
    );
    CREATE INDEX IF NOT EXISTS idx_tool_router_embeddings_updated ON tool_router_embeddings(updated_at);

    CREATE TABLE IF NOT EXISTS pending_hitl (
      task_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      tool_calls_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_hitl_conversation ON pending_hitl(conversation_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      provider_id TEXT,
      model TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      tools_json TEXT NOT NULL DEFAULT '[]',
      temperature REAL,
      icon_url TEXT,
      codename TEXT NOT NULL DEFAULT '',
      memory_enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      conversation_id TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'info',
      read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_agent ON notifications(agent_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
    CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);

    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL,
      schedule TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      one_off INTEGER NOT NULL DEFAULT 0,
      model_override TEXT NOT NULL DEFAULT '',
      provider_override TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cron_jobs_agent ON cron_jobs(agent_id);

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channels_agent ON channels(agent_id);

    CREATE TABLE IF NOT EXISTS memory_spaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      folder_path TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_file_index (
      space_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
      chunk_count INTEGER NOT NULL DEFAULT 0,
      last_indexed_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (space_id, file_name)
    );
    CREATE INDEX IF NOT EXISTS idx_mfi_space ON memory_file_index(space_id);

    CREATE TABLE IF NOT EXISTS agent_memory_spaces (
      agent_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      PRIMARY KEY (agent_id, space_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ams_agent ON agent_memory_spaces(agent_id);
    CREATE INDEX IF NOT EXISTS idx_ams_space ON agent_memory_spaces(space_id);

  `)

  // Migrations for existing databases
  const addColumnIfMissing = (table: string, column: string, definition: string) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`) } catch { /* column already exists */ }
  }
  addColumnIfMissing('memory_spaces', 'sort_order', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('memory_spaces', 'is_default', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('memory_spaces', 'folder_path', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('mcp_servers', 'env_hints_json', 'TEXT')
  addColumnIfMissing('mcp_servers', 'description', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('mcp_servers', 'original_name', 'TEXT')
  addColumnIfMissing('mcp_servers', 'custom_name', 'TEXT')
  db.prepare("UPDATE mcp_servers SET original_name = name WHERE original_name IS NULL OR original_name = ''").run()

  // Tasks table: reused for durable top-level orchestrator state.
  addColumnIfMissing('tasks', 'updated_at', 'INTEGER')
  db.prepare('UPDATE tasks SET updated_at = created_at WHERE updated_at IS NULL').run()

  ensureDefaultMemorySpace(db)

  // Agent table: add columns for DB-only storage (migrating away from filesystem)
  addColumnIfMissing('agents', 'category', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('agents', 'sub_agents_json', "TEXT NOT NULL DEFAULT '[]'")
  addColumnIfMissing('agents', 'auto_approve_tools', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('agents', 'override_sub_agents', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('agents', 'auto_tool_routing', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('agents', 'tool_router_provider_id', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('agents', 'tool_router_model', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('agents', 'auto_memory', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('agents', 'memory_router_provider_id', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('agents', 'memory_router_model', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('agents', 'thinking_enabled', 'INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing('agents', 'max_context_tokens', 'INTEGER')
  addColumnIfMissing('agents', 'sort_order', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('agents', 'cron_prompt', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('agents', 'icon_data', 'BLOB')
  addColumnIfMissing('agents', 'icon_mime', 'TEXT')

  // Trigger output channel support
  addColumnIfMissing('cron_jobs', 'output_channel_id', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('cron_jobs', 'output_target', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('cron_jobs', 'last_run_at', 'INTEGER')
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
