import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { getAppDataDir, getDefaultMemorySpaceDir } from '../core/data-dir.js'
import { createStableMemoryDocumentRef } from '../core/memory/memory-reference.js'

let db: Database.Database | null = null

function migrateBuiltInToolKey(key: string): string {
  if (!key.startsWith('builtin::')) return key
  const name = key.slice('builtin::'.length)
  const category = name.startsWith('memory_') || name.startsWith('knowledge_')
    ? 'memory'
    : name.startsWith('schedule_')
      ? 'scheduling'
      : name === 'create_app_notification' || name === 'notify_user_on_channel'
        ? 'notifications'
        : 'utility'
  return `builtin:${category}::${name}`
}

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
    // Queued chat messages survive restarts, but never resume work unexpectedly.
    db.prepare("UPDATE queued_chat_messages SET status = 'paused'").run()
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
      .run(defaultSpaceId, 'Default', 'Default memory folder for general knowledge and notes', defaultFolderPath, 0, 1, now)
    return
  }

  database.prepare("UPDATE memory_spaces SET name = ?, description = ?, folder_path = ?, is_default = 1 WHERE id = ?")
    .run('Default', 'Default memory folder for general knowledge and notes', defaultFolderPath, defaultSpaceId)
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
      last_read_at INTEGER,
      last_context_tokens INTEGER,
      execution_config_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agent_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_ma_workspace ON conversations(ma_workspace_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(pinned, updated_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_title_nocase ON conversations(title COLLATE NOCASE);

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
      video_urls_json TEXT,
      agent_id TEXT,
      ma_codename TEXT,
      ma_agent_name TEXT,
      ma_invocation_id TEXT,
      memory_sources_json TEXT,
      thinking TEXT,
      audio_urls_json TEXT,
      structured_content_json TEXT,
      context_tokens INTEGER,
      generated_media INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

    CREATE TABLE IF NOT EXISTS queued_chat_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      delivery TEXT NOT NULL DEFAULT 'next' CHECK(delivery IN ('next', 'steer')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'paused')),
      position INTEGER NOT NULL,
      run_json TEXT NOT NULL DEFAULT '{}',
      image_urls_json TEXT,
      audio_urls_json TEXT,
      file_artifacts_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_queued_chat_messages_conversation
      ON queued_chat_messages(conversation_id, position, created_at);

    CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      original_path TEXT,
      text_path TEXT,
      size_bytes INTEGER,
      text_bytes INTEGER,
      chunk_count INTEGER,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments(message_id);
    CREATE INDEX IF NOT EXISTS idx_message_attachments_conversation ON message_attachments(conversation_id);

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
      ma_invocation_id TEXT,
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

    CREATE TABLE IF NOT EXISTS tool_router_tool_embeddings (
      tool_name TEXT NOT NULL,
      embedding_provider_id TEXT NOT NULL DEFAULT '',
      embedding_model TEXT NOT NULL,
      embedding_dimensions INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tool_name, embedding_provider_id, embedding_model, embedding_dimensions)
    );
    CREATE INDEX IF NOT EXISTS idx_tool_router_tool_embeddings_updated ON tool_router_tool_embeddings(updated_at);

    CREATE TABLE IF NOT EXISTS auxiliary_model_usage (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auxiliary_model_usage_created ON auxiliary_model_usage(created_at);
    CREATE INDEX IF NOT EXISTS idx_auxiliary_model_usage_kind ON auxiliary_model_usage(kind);

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
      internal_name TEXT NOT NULL DEFAULT '',
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
      scheduled_at INTEGER,
      delivered_at INTEGER,
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
      execution_config_json TEXT NOT NULL DEFAULT '{}',
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
      document_id TEXT NOT NULL DEFAULT '',
      document_ref TEXT NOT NULL DEFAULT '',
      space_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
      chunk_count INTEGER NOT NULL DEFAULT 0,
      last_indexed_at INTEGER NOT NULL DEFAULT 0,
      knowledge_extracted_at INTEGER NOT NULL DEFAULT 0,
      tags_json TEXT NOT NULL DEFAULT '[]',
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

    -- Source documents and their revisions remain the
    -- authority; every entity, assertion, and search projection is derived
    -- from a versioned indexing run and can be rebuilt without data loss.
    CREATE TABLE IF NOT EXISTS memory_knowledge_index_runs (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      space_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      source_id TEXT NOT NULL,
      pipeline_version TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      extractor_provider_id TEXT NOT NULL DEFAULT '',
      extractor_model TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'staging'
        CHECK(status IN ('staging', 'active', 'retired', 'failed')),
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      activated_at INTEGER,
      search_projection_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(search_projection_status IN ('pending', 'ready', 'error')),
      search_projection_error TEXT,
      error TEXT,
      UNIQUE(document_id, content_hash, pipeline_version)
    );
    CREATE INDEX IF NOT EXISTS idx_mkir_document ON memory_knowledge_index_runs(document_id, status);
    CREATE INDEX IF NOT EXISTS idx_mkir_scope ON memory_knowledge_index_runs(space_id, status);

    CREATE TABLE IF NOT EXISTS memory_knowledge_text_units (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES memory_knowledge_index_runs(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      space_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      document_title TEXT NOT NULL DEFAULT '',
      section_path TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      UNIQUE(run_id, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS idx_mktu_revision ON memory_knowledge_text_units(document_id, content_hash, chunk_index);
    CREATE INDEX IF NOT EXISTS idx_mktu_scope ON memory_knowledge_text_units(space_id, file_name);

    CREATE TABLE IF NOT EXISTS memory_knowledge_entities (
      id TEXT PRIMARY KEY,
      namespace_id TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      identity_hint TEXT NOT NULL DEFAULT '',
      normalized_identity_hint TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'merged', 'retired')),
      merged_into_id TEXT REFERENCES memory_knowledge_entities(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mke_name ON memory_knowledge_entities(namespace_id, normalized_name, entity_type, status);
    CREATE INDEX IF NOT EXISTS idx_mke_identity ON memory_knowledge_entities(namespace_id, normalized_identity_hint, status);

    CREATE TABLE IF NOT EXISTS memory_knowledge_entity_aliases (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES memory_knowledge_entities(id) ON DELETE CASCADE,
      display_alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'extraction',
      confidence REAL NOT NULL DEFAULT 0.7,
      created_at INTEGER NOT NULL,
      UNIQUE(entity_id, normalized_alias)
    );
    CREATE INDEX IF NOT EXISTS idx_mkea_alias ON memory_knowledge_entity_aliases(normalized_alias);

    CREATE TABLE IF NOT EXISTS memory_knowledge_entity_resolution_decisions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES memory_knowledge_index_runs(id) ON DELETE CASCADE,
      surface TEXT NOT NULL,
      normalized_surface TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      identity_hint TEXT NOT NULL DEFAULT '',
      selected_entity_id TEXT REFERENCES memory_knowledge_entities(id),
      candidate_ids_json TEXT NOT NULL DEFAULT '[]',
      decision TEXT NOT NULL CHECK(decision IN ('created', 'resolved', 'ambiguous', 'rejected', 'manual')),
      confidence REAL NOT NULL DEFAULT 0,
      rationale TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mkerd_run ON memory_knowledge_entity_resolution_decisions(run_id);

    CREATE TABLE IF NOT EXISTS memory_knowledge_entity_mentions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES memory_knowledge_index_runs(id) ON DELETE CASCADE,
      text_unit_id TEXT NOT NULL REFERENCES memory_knowledge_text_units(id) ON DELETE CASCADE,
      entity_id TEXT REFERENCES memory_knowledge_entities(id),
      surface TEXT NOT NULL,
      normalized_surface TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      span_start INTEGER,
      span_end INTEGER,
      resolution_confidence REAL NOT NULL DEFAULT 0,
      resolution_status TEXT NOT NULL DEFAULT 'unresolved'
        CHECK(resolution_status IN ('resolved', 'ambiguous', 'unresolved', 'rejected', 'manual')),
      context_text TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      UNIQUE(run_id, text_unit_id, normalized_surface, entity_type, span_start)
    );
    CREATE INDEX IF NOT EXISTS idx_mkem_entity ON memory_knowledge_entity_mentions(entity_id);
    CREATE INDEX IF NOT EXISTS idx_mkem_surface ON memory_knowledge_entity_mentions(normalized_surface);

    CREATE TABLE IF NOT EXISTS memory_knowledge_predicates (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL UNIQUE,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      subject_types_json TEXT NOT NULL DEFAULT '[]',
      object_types_json TEXT NOT NULL DEFAULT '[]',
      inverse_predicate_id TEXT REFERENCES memory_knowledge_predicates(id),
      symmetric INTEGER NOT NULL DEFAULT 0,
      temporal INTEGER NOT NULL DEFAULT 0,
      cardinality TEXT NOT NULL DEFAULT 'many'
        CHECK(cardinality IN ('many', 'one_per_subject', 'one_per_pair')),
      contradiction_policy TEXT NOT NULL DEFAULT 'coexist'
        CHECK(contradiction_policy IN ('coexist', 'dispute', 'supersede_same_source')),
      managed INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_knowledge_assertions (
      id TEXT PRIMARY KEY,
      namespace_id TEXT NOT NULL,
      subject_entity_id TEXT NOT NULL REFERENCES memory_knowledge_entities(id),
      predicate_id TEXT NOT NULL REFERENCES memory_knowledge_predicates(id),
      object_entity_id TEXT REFERENCES memory_knowledge_entities(id),
      object_value_json TEXT,
      normalized_object_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('staging', 'active', 'superseded', 'disputed', 'retracted', 'retired')),
      importance INTEGER NOT NULL DEFAULT 1,
      valid_from INTEGER,
      valid_to INTEGER,
      observed_at INTEGER NOT NULL,
      superseded_by_id TEXT REFERENCES memory_knowledge_assertions(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK((object_entity_id IS NOT NULL) != (object_value_json IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_mka_subject ON memory_knowledge_assertions(namespace_id, subject_entity_id, predicate_id, status);
    CREATE INDEX IF NOT EXISTS idx_mka_object ON memory_knowledge_assertions(namespace_id, object_entity_id, status);
    CREATE INDEX IF NOT EXISTS idx_mka_predicate ON memory_knowledge_assertions(predicate_id, status);
    CREATE INDEX IF NOT EXISTS idx_mka_validity ON memory_knowledge_assertions(status, valid_from, valid_to);

    CREATE TABLE IF NOT EXISTS memory_knowledge_assertion_evidence (
      id TEXT PRIMARY KEY,
      assertion_id TEXT NOT NULL REFERENCES memory_knowledge_assertions(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES memory_knowledge_index_runs(id) ON DELETE CASCADE,
      text_unit_id TEXT NOT NULL REFERENCES memory_knowledge_text_units(id) ON DELETE CASCADE,
      quote TEXT NOT NULL,
      span_start INTEGER NOT NULL,
      span_end INTEGER NOT NULL,
      extractor_confidence REAL NOT NULL DEFAULT 0.5,
      entity_resolution_confidence REAL NOT NULL DEFAULT 0,
      source_trust REAL NOT NULL DEFAULT 1,
      entailment_score REAL,
      quote_verified INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      pipeline_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(assertion_id, run_id, text_unit_id, span_start, span_end)
    );
    CREATE INDEX IF NOT EXISTS idx_mkae_assertion ON memory_knowledge_assertion_evidence(assertion_id);
    CREATE INDEX IF NOT EXISTS idx_mkae_run ON memory_knowledge_assertion_evidence(run_id);
    CREATE INDEX IF NOT EXISTS idx_mkae_text_unit ON memory_knowledge_assertion_evidence(text_unit_id);

    CREATE TABLE IF NOT EXISTS memory_knowledge_assertion_corrections (
      id TEXT PRIMARY KEY,
      assertion_id TEXT NOT NULL REFERENCES memory_knowledge_assertions(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK(action IN ('update', 'retract')),
      prior_predicate_id TEXT,
      predicate_id TEXT,
      evidence_text TEXT,
      confidence REAL,
      importance INTEGER,
      rationale TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mkac_assertion ON memory_knowledge_assertion_corrections(assertion_id, created_at);

    CREATE TABLE IF NOT EXISTS memory_index_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      space_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK(status IN ('queued', 'running', 'retrying', 'completed', 'cancelled', 'error', 'dead_letter')),
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      next_attempt_at INTEGER,
      result_json TEXT,
      error TEXT,
      progress_current INTEGER,
      progress_total INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mij_queue ON memory_index_jobs(status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_mij_file ON memory_index_jobs(space_id, file_name, kind);

  `)

  // Migrations for existing databases
  const requiredSubagentSessionColumns = new Set([
    'invocation_id', 'conversation_id', 'agent_id', 'history_json', 'created_at', 'updated_at',
  ])
  const existingSubagentSessionColumns = new Set(
    (db.prepare("PRAGMA table_info('subagent_sessions')").all() as Array<{ name: string }>).map(({ name }) => name)
  )
  if (existingSubagentSessionColumns.size > 0
    && [...requiredSubagentSessionColumns].some((column) => !existingSubagentSessionColumns.has(column))) {
    // An early experimental build used this table name with an incompatible,
    // non-durable schema. It was never consumed by the released continuation
    // feature, so replace only that legacy table rather than guessing at data.
    db.exec('DROP TABLE subagent_sessions')
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS subagent_sessions (
      invocation_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      history_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subagent_sessions_conversation
      ON subagent_sessions(conversation_id, updated_at);
  `)

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
  addColumnIfMissing('messages', 'video_urls_json', 'TEXT')
  addColumnIfMissing('messages', 'ma_codename', 'TEXT')
  addColumnIfMissing('messages', 'ma_agent_name', 'TEXT')
  addColumnIfMissing('messages', 'ma_invocation_id', 'TEXT')
  addColumnIfMissing('messages', 'structured_content_json', 'TEXT')
  addColumnIfMissing('messages', 'generated_media', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('execution_steps', 'ma_invocation_id', 'TEXT')
  addColumnIfMissing('notifications', 'scheduled_at', 'INTEGER')
  addColumnIfMissing('notifications', 'delivered_at', 'INTEGER')
  db.prepare('UPDATE notifications SET delivered_at = created_at WHERE delivered_at IS NULL AND scheduled_at IS NULL').run()
  db.prepare("UPDATE mcp_servers SET original_name = name WHERE original_name IS NULL OR original_name = ''").run()

  // Tasks table: reused for durable top-level planning state.
  addColumnIfMissing('tasks', 'updated_at', 'INTEGER')
  db.prepare('UPDATE tasks SET updated_at = created_at WHERE updated_at IS NULL').run()

  addColumnIfMissing('memory_file_index', 'knowledge_extracted_at', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('memory_file_index', 'tags_json', "TEXT NOT NULL DEFAULT '[]'")
  addColumnIfMissing('memory_index_jobs', 'progress_current', 'INTEGER')
  addColumnIfMissing('memory_index_jobs', 'progress_total', 'INTEGER')
  addColumnIfMissing('memory_file_index', 'document_id', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('memory_knowledge_index_runs', 'search_projection_status', "TEXT NOT NULL DEFAULT 'pending'")
  addColumnIfMissing('memory_knowledge_index_runs', 'search_projection_error', 'TEXT')
  addColumnIfMissing('memory_knowledge_entity_mentions', 'note', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('memory_knowledge_assertion_evidence', 'note', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('memory_knowledge_text_units', 'tags_json', "TEXT NOT NULL DEFAULT '[]'")
  // v4 grounds extracted knowledge to complete source chunks. Purge legacy
  // verbatim quotes and model-authored confidence values during migration.
  db.prepare("UPDATE memory_knowledge_assertion_evidence SET quote = '', extractor_confidence = 1 WHERE quote != '' OR extractor_confidence != 1").run()
  db.prepare('UPDATE memory_knowledge_assertion_corrections SET confidence = NULL WHERE confidence IS NOT NULL').run()
  db.prepare("UPDATE memory_file_index SET document_id = lower(hex(randomblob(16))) WHERE document_id = ''").run()
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_mfi_document_id ON memory_file_index(document_id)')
  addColumnIfMissing('memory_file_index', 'document_ref', "TEXT NOT NULL DEFAULT ''")
  const documentsWithoutStableRefs = db.prepare(`
    SELECT document_id, file_name, created_at FROM memory_file_index WHERE document_ref = ''
  `).all() as Array<{ document_id: string; file_name: string; created_at: number }>
  const documentRefExists = db.prepare('SELECT 1 FROM memory_file_index WHERE document_ref = ?')
  const saveDocumentRef = db.prepare('UPDATE memory_file_index SET document_ref = ? WHERE document_id = ?')
  for (const document of documentsWithoutStableRefs) {
    let collisionAttempt = 0
    let documentRef: string
    do {
      documentRef = createStableMemoryDocumentRef(
        document.file_name,
        document.document_id,
        document.created_at,
        collisionAttempt++,
      )
    } while (documentRefExists.get(documentRef))
    saveDocumentRef.run(documentRef, document.document_id)
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_mfi_document_ref ON memory_file_index(document_ref) WHERE document_ref != ''")

  // Migrate persisted selections from the former mode-switching memory tools
  // to the operation-specific contracts. Preserve order and remove duplicates.
  const agentToolRows = db.prepare('SELECT id, tools_json FROM agents').all() as { id: string; tools_json: string }[]
  const updateAgentTools = db.prepare('UPDATE agents SET tools_json = ? WHERE id = ?')
  for (const row of agentToolRows) {
    try {
      const current = JSON.parse(row.tools_json || '[]') as unknown[]
      if (!Array.isArray(current)) continue
      const migrated = current.flatMap((key) => {
        if (key === 'builtin::memory_update') return [
          'builtin:memory::memory_append',
          'builtin:memory::memory_replace_range',
          'builtin:memory::memory_replace_all',
        ]
        if (key === 'builtin::memory_remove') return [
          'builtin:memory::memory_remove_range',
          'builtin:memory::memory_remove_all',
        ]
        return typeof key === 'string' ? [migrateBuiltInToolKey(key)] : []
      })
      const deduped = Array.from(new Set(migrated))
      if (JSON.stringify(deduped) !== JSON.stringify(current)) updateAgentTools.run(JSON.stringify(deduped), row.id)
    } catch { /* keep malformed legacy values untouched */ }
  }

  ensureDefaultMemorySpace(db)

  // Agent table: add columns for DB-only storage (migrating away from filesystem)
  addColumnIfMissing('agents', 'category', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('agents', 'sub_agents_json', "TEXT NOT NULL DEFAULT '[]'")
  addColumnIfMissing('agents', 'auto_approve_tools', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('agents', 'override_sub_agents', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('agents', 'auto_tool_routing', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('agents', 'tool_router_provider_id', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('agents', 'tool_router_model', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('agents', 'auto_memory', 'INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing('agents', 'memory_router_provider_id', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('agents', 'memory_router_model', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('agents', 'auto_router_provider_id', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('agents', 'auto_router_model', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('agents', 'thinking_enabled', 'INTEGER NOT NULL DEFAULT 1')
  addColumnIfMissing('agents', 'reasoning_effort', "TEXT NOT NULL DEFAULT 'medium'")
  addColumnIfMissing('agents', 'max_context_tokens', 'INTEGER')
  addColumnIfMissing('agents', 'sort_order', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('agents', 'tags_json', "TEXT NOT NULL DEFAULT '[]'")
  addColumnIfMissing('agents', 'favorite', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('agents', 'cron_prompt', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('agents', 'icon_data', 'BLOB')
  addColumnIfMissing('agents', 'icon_mime', 'TEXT')

  // Migrate codename → internal_name
  addColumnIfMissing('agents', 'internal_name', "TEXT NOT NULL DEFAULT ''")
  try {
    db.prepare("UPDATE agents SET internal_name = codename WHERE internal_name = '' AND codename != ''").run()
  } catch { /* codename column may not exist on fresh installs */ }

  // Trigger output channel support
  addColumnIfMissing('cron_jobs', 'output_channel_id', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('cron_jobs', 'output_target', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('cron_jobs', 'notification_mode', "TEXT NOT NULL DEFAULT 'always'")
  addColumnIfMissing('cron_jobs', 'notification_condition', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('cron_jobs', 'notify_in_app', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('cron_jobs', 'last_run_at', 'INTEGER')
  addColumnIfMissing('cron_jobs', 'execution_config_json', "TEXT NOT NULL DEFAULT '{}'")

  // Conversation unread tracking
  addColumnIfMissing('conversations', 'last_read_at', 'INTEGER')
  addColumnIfMissing('conversations', 'execution_config_json', "TEXT NOT NULL DEFAULT '{}'")

  // Split the former single built-in namespace into UI categories while
  // preserving tool selections stored in conversations and scheduled jobs.
  for (const table of ['conversations', 'cron_jobs'] as const) {
    const rows = db.prepare(`SELECT id, execution_config_json FROM ${table}`).all() as Array<{ id: string; execution_config_json: string }>
    const update = db.prepare(`UPDATE ${table} SET execution_config_json = ? WHERE id = ?`)
    for (const row of rows) {
      try {
        const config = JSON.parse(row.execution_config_json || '{}') as { allowedTools?: unknown }
        if (!Array.isArray(config.allowedTools)) continue
        const allowedTools = Array.from(new Set(config.allowedTools
          .filter((key): key is string => typeof key === 'string')
          .map(migrateBuiltInToolKey)))
        if (JSON.stringify(allowedTools) !== JSON.stringify(config.allowedTools)) {
          update.run(JSON.stringify({ ...config, allowedTools }), row.id)
        }
      } catch { /* keep malformed legacy values untouched */ }
    }
  }
  addColumnIfMissing('conversations', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'")
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
