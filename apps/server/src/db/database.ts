import Database from 'better-sqlite3'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { getAppDataDir, getDefaultMemoryFolderDir } from '../core/data-dir.js'

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
    // Queued chat messages survive restarts, but never resume work unexpectedly.
    db.prepare("UPDATE queued_chat_messages SET status = 'paused'").run()
  }
  return db
}

export function ensureDefaultMemoryFolder(database: Database.Database = getDb()): void {
  const uncategorizedCategoryId = 'uncategorized'
  const defaultFolderPath = getDefaultMemoryFolderDir()
  mkdirSync(defaultFolderPath, { recursive: true })

  const uncategorizedCategoryExists = database.prepare("SELECT id FROM memory_folders WHERE id = ?").get(uncategorizedCategoryId)
  if (!uncategorizedCategoryExists) {
    const now = Date.now()
    database.prepare("INSERT INTO memory_folders (id, name, description, directory_path, sort_order, is_uncategorized, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(uncategorizedCategoryId, 'Uncategorized', 'Memories that do not yet have a category', defaultFolderPath, 0, 1, now)
    return
  }

  database.prepare("UPDATE memory_folders SET name = ?, description = ?, directory_path = ?, is_uncategorized = 1 WHERE id = ?")
    .run('Uncategorized', 'Memories that do not yet have a category', defaultFolderPath, uncategorizedCategoryId)
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
      asset_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments(message_id);
    CREATE INDEX IF NOT EXISTS idx_message_attachments_conversation ON message_attachments(conversation_id);

    CREATE TABLE IF NOT EXISTS attachment_assets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, original_path TEXT NOT NULL, text_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL, text_bytes INTEGER NOT NULL, chunk_count INTEGER,
      metadata_json TEXT, created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staged_chat_attachments (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      artifact_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_staged_chat_attachments_conversation ON staged_chat_attachments(conversation_id);

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
      description TEXT NOT NULL DEFAULT '',
      original_name TEXT,
      custom_name TEXT,
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
      category TEXT NOT NULL DEFAULT '',
      sub_agents_json TEXT NOT NULL DEFAULT '[]',
      auto_approve_tools INTEGER NOT NULL DEFAULT 0,
      override_sub_agents INTEGER NOT NULL DEFAULT 0,
      auto_tool_routing INTEGER NOT NULL DEFAULT 0,
      tool_router_provider_id TEXT NOT NULL DEFAULT '',
      tool_router_model TEXT NOT NULL DEFAULT '',
      auto_memory INTEGER NOT NULL DEFAULT 1,
      memory_enabled INTEGER NOT NULL DEFAULT 1,
      dreaming_enabled INTEGER NOT NULL DEFAULT 1,
      memory_router_provider_id TEXT NOT NULL DEFAULT '',
      memory_router_model TEXT NOT NULL DEFAULT '',
      auto_router_provider_id TEXT NOT NULL DEFAULT '',
      auto_router_model TEXT NOT NULL DEFAULT '',
      thinking_enabled INTEGER NOT NULL DEFAULT 1,
      reasoning_effort TEXT NOT NULL DEFAULT 'medium',
      max_context_tokens INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      tags_json TEXT NOT NULL DEFAULT '[]',
      favorite INTEGER NOT NULL DEFAULT 0,
      cron_prompt TEXT NOT NULL DEFAULT '',
      icon_data BLOB,
      icon_mime TEXT,
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
      output_channel_id TEXT NOT NULL DEFAULT '',
      output_target TEXT NOT NULL DEFAULT '',
      notification_mode TEXT NOT NULL DEFAULT 'always',
      notification_condition TEXT NOT NULL DEFAULT '',
      last_run_at INTEGER,
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

    CREATE TABLE IF NOT EXISTS memory_folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      directory_path TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_uncategorized INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_file_index (
      document_id TEXT NOT NULL DEFAULT '',
      document_ref TEXT NOT NULL DEFAULT '',
      category_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
      chunk_count INTEGER NOT NULL DEFAULT 0,
      last_indexed_at INTEGER NOT NULL DEFAULT 0,
      deep_researched_at INTEGER NOT NULL DEFAULT 0,
      dreamed_at INTEGER NOT NULL DEFAULT 0,
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (category_id, file_name)
    );
    CREATE INDEX IF NOT EXISTS idx_mfi_category ON memory_file_index(category_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mfi_document_id ON memory_file_index(document_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mfi_document_ref ON memory_file_index(document_ref) WHERE document_ref != '';

    CREATE TABLE IF NOT EXISTS memory_documents (
      document_id TEXT PRIMARY KEY,
      document_ref TEXT NOT NULL UNIQUE,
      category_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      current_hash TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'deleted')),
      indexing_status TEXT NOT NULL DEFAULT 'pending' CHECK(indexing_status IN ('pending', 'indexed', 'error')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_memory_documents_category ON memory_documents(category_id, status);

    CREATE TABLE IF NOT EXISTS memory_document_revisions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES memory_documents(document_id) ON DELETE CASCADE,
      revision_number INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('ai', 'dream', 'user', 'filesystem', 'import', 'restore')),
      conversation_id TEXT,
      agent_id TEXT,
      message_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      UNIQUE(document_id, revision_number)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_revisions_document ON memory_document_revisions(document_id, revision_number DESC);

    CREATE TABLE IF NOT EXISTS agent_memory_folders (
      agent_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      PRIMARY KEY (agent_id, category_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ams_agent ON agent_memory_folders(agent_id);
    CREATE INDEX IF NOT EXISTS idx_ams_category ON agent_memory_folders(category_id);

    -- Source documents and their revisions remain the
    -- authority; every entity, assertion, and search projection is derived
    -- from a versioned indexing run and can be rebuilt without data loss.
    CREATE TABLE IF NOT EXISTS memory_knowledge_index_runs (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      category_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      source_id TEXT NOT NULL,
      pipeline_version TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      deep_research_provider_id TEXT NOT NULL DEFAULT '',
      deep_research_model TEXT NOT NULL DEFAULT '',
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
    CREATE INDEX IF NOT EXISTS idx_mkir_scope ON memory_knowledge_index_runs(category_id, status);

    CREATE TABLE IF NOT EXISTS memory_knowledge_text_units (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES memory_knowledge_index_runs(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      category_id TEXT NOT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_mktu_scope ON memory_knowledge_text_units(category_id, file_name);

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

    -- A monotonic ingestion sequence survives message deletion and SQLite rowid reuse.
    -- Only messages arriving after this feature is installed need eligibility tracking.
    CREATE TABLE IF NOT EXISTS dream_message_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE
    );
    CREATE TRIGGER IF NOT EXISTS dream_message_insert AFTER INSERT ON messages BEGIN
      INSERT INTO dream_message_events(message_id) VALUES (NEW.id);
    END;

    CREATE TABLE IF NOT EXISTS dream_progress (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      window_id TEXT NOT NULL,
      last_sequence INTEGER NOT NULL DEFAULT 0,
      message_offset INTEGER NOT NULL DEFAULT 0,
      skipped_sequence INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS dream_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      window_id TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_json TEXT NOT NULL,
      changes_json TEXT NOT NULL DEFAULT '[]',
      reviewed_count INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dream_runs_pending ON dream_runs(window_id, conversation_id, status);

    CREATE TABLE IF NOT EXISTS memory_index_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      category_id TEXT NOT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_mij_file ON memory_index_jobs(category_id, file_name, kind);

  `)

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

  ensureDefaultMemoryFolder(db)
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
