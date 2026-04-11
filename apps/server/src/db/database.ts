import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { getAppDataDir } from '../core/data-dir.js'
import { nanoid } from 'nanoid'

let db: Database.Database | null = null

function getDbPath(): string {
  const dbDir = join(getAppDataDir(), 'sqlite')
  mkdirSync(dbDir, { recursive: true })
  return join(dbDir, 'openagent.db')
}

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(getDbPath())
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    // All pending HITL are void after a server restart — the executor promises are gone.
    db.prepare('DELETE FROM pending_hitl').run()
  }
  return db
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key_enc TEXT,
      default_model TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

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
  `)

  // Add task_id column to execution_steps (migration for existing DBs)
  const stepCols = db.prepare("PRAGMA table_info(execution_steps)").all() as { name: string }[]
  if (!stepCols.some((c) => c.name === 'task_id')) {
    db.exec("ALTER TABLE execution_steps ADD COLUMN task_id TEXT")
  }

  // MCP servers table — drop legacy schema if columns don't match
  const mcpInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mcp_servers'").get() as { sql: string } | undefined
  if (mcpInfo && !mcpInfo.sql.includes('enabled')) {
    db.exec('DROP TABLE mcp_servers')
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '[]',
      env_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_approvals (
      tool_name TEXT PRIMARY KEY,
      auto_approve INTEGER NOT NULL DEFAULT 0
    );
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_hitl (
      task_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      tool_calls_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_hitl_conversation ON pending_hitl(conversation_id);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
  `)

  // Add image_urls_json column to messages (stores JSON array of data-URL strings)
  const msgCols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]
  if (!msgCols.some((c) => c.name === 'image_urls_json')) {
    db.exec("ALTER TABLE messages ADD COLUMN image_urls_json TEXT")
  }

  // Add agent_id column to messages (for MA sub-agent identity)
  if (!msgCols.some((c) => c.name === 'agent_id')) {
    db.exec("ALTER TABLE messages ADD COLUMN agent_id TEXT")
  }

  // Add memory_sources_json column to messages (persists retrieved memory sources)
  if (!msgCols.some((c) => c.name === 'memory_sources_json')) {
    db.exec("ALTER TABLE messages ADD COLUMN memory_sources_json TEXT")
  }

  // Add thinking column to messages (persists LLM thinking/reasoning blocks)
  if (!msgCols.some((c) => c.name === 'thinking')) {
    db.exec("ALTER TABLE messages ADD COLUMN thinking TEXT")
  }

  // Add audio_urls_json column to messages (stores JSON array of audio data-URL strings)
  if (!msgCols.some((c) => c.name === 'audio_urls_json')) {
    db.exec("ALTER TABLE messages ADD COLUMN audio_urls_json TEXT")
  }

  // Add file_attachments_json column to messages (stores JSON array of {name,type} for attached files)
  if (!msgCols.some((c) => c.name === 'file_attachments_json')) {
    db.exec("ALTER TABLE messages ADD COLUMN file_attachments_json TEXT")
  }

  // Agents table
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      provider_id TEXT,
      model TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      tools_json TEXT NOT NULL DEFAULT '[]',
      temperature REAL,
      memory_enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  // Add temperature column to agents if missing (migration for existing DBs)
  const agentCols = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[]
  if (!agentCols.some((c) => c.name === 'temperature')) {
    db.exec("ALTER TABLE agents ADD COLUMN temperature REAL")
  }
  if (!agentCols.some((c) => c.name === 'icon_url')) {
    db.exec("ALTER TABLE agents ADD COLUMN icon_url TEXT")
  }
  if (!agentCols.some((c) => c.name === 'codename')) {
    db.exec("ALTER TABLE agents ADD COLUMN codename TEXT NOT NULL DEFAULT ''")
  }

  // Add agent_id column to conversations
  const convCols = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[]
  if (!convCols.some((c) => c.name === 'agent_id')) {
    db.exec("ALTER TABLE conversations ADD COLUMN agent_id TEXT")
    db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agent_id)")
  }

  // Add ma_workspace_id column to conversations
  if (!convCols.some((c) => c.name === 'ma_workspace_id')) {
    db.exec("ALTER TABLE conversations ADD COLUMN ma_workspace_id TEXT")
    db.exec("CREATE INDEX IF NOT EXISTS idx_conversations_ma_workspace ON conversations(ma_workspace_id)")
  }

  // Add origin column to conversations (chat, heartbeat, webhook, etc.)
  if (!convCols.some((c) => c.name === 'origin')) {
    db.exec("ALTER TABLE conversations ADD COLUMN origin TEXT NOT NULL DEFAULT 'chat'")
  }

  // Add pinned column to conversations (0 = not pinned, 1 = pinned)
  if (!convCols.some((c) => c.name === 'pinned')) {
    db.exec("ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
  }

  // Add icon_url and origin column to mcp_servers
  const mcpCols = db.prepare("PRAGMA table_info(mcp_servers)").all() as { name: string }[]
  if (!mcpCols.some((c) => c.name === 'icon_url')) {
    db.exec("ALTER TABLE mcp_servers ADD COLUMN icon_url TEXT")
  }
  if (!mcpCols.some((c) => c.name === 'origin')) {
    db.exec("ALTER TABLE mcp_servers ADD COLUMN origin TEXT")
  }

  // Notifications table
  db.exec(`
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
  `)

  // Cron jobs table (decoupled from agent config)
  db.exec(`
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
  `)

  // Add name column to cron_jobs if missing (migration for existing DBs)
  const cronJobCols = db.prepare("PRAGMA table_info(cron_jobs)").all() as { name: string }[]
  if (!cronJobCols.some((c) => c.name === 'name')) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN name TEXT NOT NULL DEFAULT ''")
  }
  if (!cronJobCols.some((c) => c.name === 'model_override')) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN model_override TEXT NOT NULL DEFAULT ''")
  }
  if (!cronJobCols.some((c) => c.name === 'provider_override')) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN provider_override TEXT NOT NULL DEFAULT ''")
  }

  // Migrate legacy cron fields from agent.json files into cron_jobs table
  migrateLegacyCronJobs(db)

  // Drop legacy dashboard tables if they exist
  db.exec('DROP TABLE IF EXISTS dashboard_widgets')
  db.exec('DROP INDEX IF EXISTS idx_dashboard_widgets_agent')
  db.exec('DROP TABLE IF EXISTS dashboard_reports')
  db.exec('DROP INDEX IF EXISTS idx_dashboard_reports_agent')

  // Channels table
  db.exec(`
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
  `)

  // Memory spaces table
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_spaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `)

  // Agent ↔ Memory space join table
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_memory_spaces (
      agent_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      PRIMARY KEY (agent_id, space_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ams_agent ON agent_memory_spaces(agent_id);
    CREATE INDEX IF NOT EXISTS idx_ams_space ON agent_memory_spaces(space_id);
  `)

  // File watchers table
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_watchers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL,
      paths_json TEXT NOT NULL,
      ignore_patterns_json TEXT,
      prompt TEXT NOT NULL DEFAULT '',
      debounce_ms INTEGER NOT NULL DEFAULT 5000,
      enabled INTEGER NOT NULL DEFAULT 1,
      model_override TEXT NOT NULL DEFAULT '',
      provider_override TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_file_watchers_agent ON file_watchers(agent_id);
  `)

  // Fix mcp_mcp_ double prefix in tool names (tool_approvals + agent tools_json)
  fixDoubleMcpPrefix(db)
  // Strip legacy mcp_slug_ prefixes — tools are now registered by their bare name
  stripMcpToolPrefixes(db)
  // Strip slug__ collision prefixes — registry now uses bare names; prefixes
  // are only added at execution time when tools actually collide.
  stripSlugCollisionPrefixes(db)
}

function fixDoubleMcpPrefix(db: Database.Database): void {
  // Fix tool_approvals
  const approvals = db.prepare("SELECT tool_name FROM tool_approvals WHERE tool_name LIKE 'mcp\\_mcp\\_%' ESCAPE '\\'").all() as { tool_name: string }[]
  if (approvals.length > 0) {
    const update = db.prepare("UPDATE tool_approvals SET tool_name = ? WHERE tool_name = ?")
    const del = db.prepare("DELETE FROM tool_approvals WHERE tool_name = ?")
    for (const { tool_name } of approvals) {
      const fixed = tool_name.replace(/^mcp_mcp_/, 'mcp_')
      // Avoid conflict if the fixed name already exists
      const existing = db.prepare("SELECT 1 FROM tool_approvals WHERE tool_name = ?").get(fixed)
      if (existing) {
        del.run(tool_name)
      } else {
        update.run(fixed, tool_name)
      }
    }
  }

  // Fix agent tools_json arrays
  const agents = db.prepare("SELECT id, tools_json FROM agents").all() as { id: string; tools_json: string }[]
  const updateAgent = db.prepare("UPDATE agents SET tools_json = ? WHERE id = ?")
  for (const agent of agents) {
    try {
      const tools = JSON.parse(agent.tools_json) as string[]
      const fixed = tools.map((t) => t.replace(/^mcp_mcp_/, 'mcp_'))
      if (JSON.stringify(tools) !== JSON.stringify(fixed)) {
        updateAgent.run(JSON.stringify(fixed), agent.id)
      }
    } catch { /* skip malformed */ }
  }
}

/**
 * Strip the legacy `mcp_${slug}_` prefix from tool names in tool_approvals and
 * agents.tools_json. After this migration tools are stored as their bare names.
 */
function stripMcpToolPrefixes(db: Database.Database): void {
  // Replicate the sanitiseName logic from McpManager
  function sanitise(name: string): string {
    return name
      .toLowerCase()
      .replace(/^mcp[-_\s]+/i, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      || 'server'
  }

  const servers = db
    .prepare('SELECT name FROM mcp_servers')
    .all() as { name: string }[]

  if (servers.length === 0) return

  // Build list of slugs, longest first so greedy matching works correctly
  const slugs = servers
    .map((s) => sanitise(s.name))
    .sort((a, b) => b.length - a.length)

  function stripPrefix(toolName: string): string | null {
    if (!toolName.startsWith('mcp_')) return null
    for (const slug of slugs) {
      const prefix = `mcp_${slug}_`
      if (toolName.startsWith(prefix)) {
        return toolName.slice(prefix.length)
      }
    }
    return null
  }

  // Fix tool_approvals
  const approvals = db
    .prepare("SELECT tool_name, auto_approve FROM tool_approvals WHERE tool_name LIKE 'mcp\\_%' ESCAPE '\\'")
    .all() as { tool_name: string; auto_approve: number }[]

  if (approvals.length > 0) {
    const update = db.prepare('UPDATE tool_approvals SET tool_name = ? WHERE tool_name = ?')
    const del = db.prepare('DELETE FROM tool_approvals WHERE tool_name = ?')
    for (const { tool_name, auto_approve } of approvals) {
      const newName = stripPrefix(tool_name)
      if (!newName || newName === tool_name) continue
      const existing = db
        .prepare('SELECT auto_approve FROM tool_approvals WHERE tool_name = ?')
        .get(newName) as { auto_approve: number } | undefined
      if (existing) {
        // Keep whichever has auto_approve = 1; delete the other prefixed entry
        if (auto_approve === 1 && existing.auto_approve === 0) {
          del.run(newName)         // remove the unprefixed row so the PK is free
          update.run(newName, tool_name)  // rename prefixed → unprefixed
        } else {
          del.run(tool_name)       // existing unprefixed entry is fine, drop the old prefixed one
        }
      } else {
        update.run(newName, tool_name)
      }
    }
  }

  // Fix agent tools_json arrays
  const agents = db
    .prepare('SELECT id, tools_json FROM agents')
    .all() as { id: string; tools_json: string }[]
  const updateAgent = db.prepare('UPDATE agents SET tools_json = ? WHERE id = ?')
  for (const agent of agents) {
    try {
      const tools = JSON.parse(agent.tools_json) as string[]
      const fixed = tools.map((t) => {
        const n = stripPrefix(t)
        return n ?? t
      })
      if (JSON.stringify(tools) !== JSON.stringify(fixed)) {
        updateAgent.run(JSON.stringify(fixed), agent.id)
      }
    } catch { /* skip malformed */ }
  }
}

/**
 * Strip the `slug__` collision prefix from tool names in tool_approvals and
 * agents.tools_json.  The registry no longer adds these prefixes at registration
 * time; collisions are now resolved at execution time.
 */
function stripSlugCollisionPrefixes(db: Database.Database): void {
  // tool_approvals: rename slug__name → name (skip if bare name already exists)
  const approvals = db
    .prepare("SELECT tool_name FROM tool_approvals WHERE tool_name LIKE '%\\_\\_%' ESCAPE '\\'")
    .all() as { tool_name: string }[]

  if (approvals.length > 0) {
    const update = db.prepare('UPDATE tool_approvals SET tool_name = ? WHERE tool_name = ?')
    const del = db.prepare('DELETE FROM tool_approvals WHERE tool_name = ?')
    for (const { tool_name } of approvals) {
      const idx = tool_name.indexOf('__')
      if (idx <= 0) continue
      const bare = tool_name.slice(idx + 2)
      if (!bare) continue
      const existing = db
        .prepare('SELECT tool_name FROM tool_approvals WHERE tool_name = ?')
        .get(bare) as { tool_name: string } | undefined
      if (existing) {
        del.run(tool_name)  // bare already exists, just remove the prefixed entry
      } else {
        update.run(bare, tool_name)
      }
    }
  }

  // agents.tools_json: strip slug__name → name
  const agents = db
    .prepare('SELECT id, tools_json FROM agents')
    .all() as { id: string; tools_json: string }[]

  const updateAgent = db.prepare('UPDATE agents SET tools_json = ? WHERE id = ?')
  for (const agent of agents) {
    try {
      const tools = JSON.parse(agent.tools_json) as string[]
      const fixed = tools.map(t => {
        const idx = t.indexOf('__')
        return idx > 0 ? t.slice(idx + 2) : t
      })
      if (JSON.stringify(tools) !== JSON.stringify(fixed)) {
        updateAgent.run(JSON.stringify(fixed), agent.id)
      }
    } catch { /* skip malformed */ }
  }
}

/** Migrate legacy cron fields from agent.json files into the cron_jobs table (one-time) */
function migrateLegacyCronJobs(db: Database.Database): void {
  const agentsDir = join(getAppDataDir(), 'agents')
  if (!existsSync(agentsDir)) return

  const existingJobs = db.prepare('SELECT COUNT(*) as cnt FROM cron_jobs').get() as { cnt: number }
  if (existingJobs.cnt > 0) return // already migrated

  const dirs = readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory())
  const now = Date.now()

  for (const dir of dirs) {
    const configPath = join(agentsDir, dir.name, 'agent.json')
    if (!existsSync(configPath)) continue

    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      if (!config.cronSchedule) continue

      // Read CRON.md as the prompt
      const cronMdPath = join(agentsDir, dir.name, 'CRON.md')
      const prompt = existsSync(cronMdPath) ? readFileSync(cronMdPath, 'utf-8') : ''

      db.prepare(
        'INSERT INTO cron_jobs (id, agent_id, schedule, prompt, enabled, one_off, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(nanoid(), dir.name, config.cronSchedule, prompt, config.cronEnabled ? 1 : 0, config.cronOneOff ? 1 : 0, now, now)

      // Clean legacy fields from agent.json
      delete config.cronSchedule
      delete config.cronEnabled
      delete config.cronOneOff
      writeFileSync(configPath, JSON.stringify(config, null, 2))
    } catch { /* skip malformed configs */ }
  }
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
