# Memory System

The Cynosure memory system provides agents with **durable, retrievable knowledge** that persists across conversations. It is composed of two fundamentally different subsystems that work together to give agents rich context:

1. **Vector/Semantic Memory** — chunked text stored in LanceDB, retrieved via hybrid (vector + FTS) search
2. **Entity Graph** — a structured knowledge graph of named entities and their relationships, stored in SQLite

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Vector / Semantic Memory (RAG)](#vector--semantic-memory-rag)
  - [Ingestion pipeline (chunk → embed → store)](#ingestion-pipeline)
  - [Hybrid Search (vector + FTS + RRF)](#hybrid-search)
  - [Optional LLM Reranker](#optional-llm-reranker)
  - [What is returned & how much](#what-is-returned--how-much)
  - [Memory Spaces & scoping](#memory-spaces--scoping)
- [Entity Graph](#entity-graph)
  - [Entity extraction](#entity-extraction)
  - [Graph storage & deduplication](#graph-storage--deduplication)
  - [Seed node search](#seed-node-search)
  - [Graph walk (traversal)](#graph-walk)
  - [What is returned & how much](#entity-graph-returned)
- [Memory Aggregator — combining both subsystems](#memory-aggregator)
  - [How they are coupled](#how-they-are-coupled)
  - [Formatting for prompt injection](#formatting-for-prompt-injection)
- [Auto Memory Routing](#auto-memory-routing)
- [Key files](#key-files)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        MemoryAggregator                              │
│  ┌──────────────────────────────┐   ┌──────────────────────────────┐ │
│  │      AgentMemory (RAG)       │   │    EntityGraphStore          │ │
│  │  ┌──────────┐ ┌───────────┐  │   │  ┌──────────┐ ┌───────────┐ │ │
│  │  │ Memory   │ │ LanceDB   │  │   │  │ SQLite   │ │ LLM-based │ │ │
│  │  │ Parser   │ │ (vector + │  │   │  │ (nodes + │ │ extraction│ │ │
│  │  │ (chunk)  │ │  FTS)     │  │   │  │  edges)  │ │ pipeline  │ │ │
│  │  └──────────┘ └───────────┘  │   │  └──────────┘ └───────────┘ │ │
│  └──────────────────────────────┘   └──────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
         ▲                                       ▲
         │                                       │
    ┌────┴────┐                           ┌──────┴──────┐
    │Embedding│                           │  Gateway    │
    │Provider │                           │  (LLM call) │
    └─────────┘                           └─────────────┘
```

**Key insight**: these two subsystems are **loosely coupled**. The entity graph is an _enrichment layer_ on top of semantic memory — the aggregator first retrieves vector chunks, then uses them to find relevant entities. One can function without the other.

---

## Vector / Semantic Memory (RAG)

### Ingestion pipeline

When a memory file is added or re-indexed, the pipeline is:

```
File on disk
    │
    ▼
Read & parse ────► If document (PDF, docx), convert to markdown
    │
    ▼
Chunk ────► RecursiveCharacterTextSplitter (markdown-aware)
    │           │ Default: 512 tokens per chunk, 64 token overlap
    │           │ Configurable via DB setting 'chunking'
    │           │ Heading-only chunks are merged forward
    │           ▼
    │    Produces N text chunks
    │
    ▼
Embed ────► EmbeddingProvider.embedBatch()
    │           │ Supports OpenAI-compatible APIs & Google Gemini
    │           │ Batches of 32, with retry (2 attempts, exponential backoff)
    │           │ Sliding-window pipeline: embed next batch concurrent with
    │           │   LanceDB write of previous batch
    │           ▼
    │    Produces N embedding vectors (default 1536-dim)
    │
    ▼
Store ────► RAGStore.addDocuments() into LanceDB table "permanent_memory"
                │ FTS index rebuilt 15s after last write (debounced)
                │ BTree index on spaceId for fast scoping
                ▼
         LanceDB row: { id, text, vector, source, sourceFile,
                        chunkIndex, spaceId, createdAt }
```

**Configurable chunk settings** (via `settings` table, key `'chunking'`):

| Setting        | Default | Description                           |
| -------------- | ------- | ------------------------------------- |
| `chunkSize`    | 512     | Target tokens per chunk               |
| `chunkOverlap` | 64      | Token overlap between adjacent chunks |

**Automatic retrieval setting** (via `settings` table, key `'memoryRetrieval'`):

| Setting       | Default | Description                                                        |
| ------------- | ------- | ------------------------------------------------------------------ |
| `resultCount` | 10      | Ranked memory chunks returned per automatic routing query (1–50). |

### Hybrid Search

Retrieval from LanceDB uses a **hybrid** approach combining two signals:

```python
hybridSearch(queryText):
    1. Embed queryText → queryVector (via EmbeddingProvider)
    2. Determine candidateCount:
         - If LLM reranker enabled: max(topK, configured candidateCount)
         - Otherwise: topK
    3. Run a native hybrid query:
       a. vector + FTS + RRF reranker
            → LanceDB native hybrid (cosine + BM25 merged via RRF)
            → Returns topK results
    4. Preserve the RRF relevance score that produced the hybrid rank
    5. Optionally pass through an external reranker
    6. Return topK ranked chunks
```

**The FTS (full-text search)** index uses LanceDB's built-in BM25 via `createIndex('text', { config: lancedb.Index.fts() })`. It is rebuilt:

- Eagerly after bulk deletes
- 15 seconds after the last write (debounced, to batch bulk uploads)
- Lazily on first search if stale

**Fallback**: If the hybrid query fails (missing FTS index), the system falls back to pure vector-only search.

### Optional LLM Reranker

The `MemoryReranker` can optionally improve ranking via an OpenRouter-compatible reranking endpoint:

| Setting          | Default                | Description                                                            |
| ---------------- | ---------------------- | ---------------------------------------------------------------------- |
| `enabled`        | false                  | Whether to use LLM reranking                                           |
| `model`          | `cohere/rerank-4-fast` | Allowed: cohere/rerank-v3.5, cohere/rerank-4-fast, cohere/rerank-4-pro |
| `candidateCount` | 50                     | How many hybrid results to fetch before reranking (min 3, max 100)     |
| `providerId`     | —                      | OpenRouter provider ID for reranking                                   |

When enabled, the pipeline is:

```
hybridSearch(topK=max(resultCount, candidateCount)) → rerank(query, candidates) → return resultCount
```

If reranking fails, it logs a warning and falls back to the raw hybrid ranking.

### What is returned & how much

**Default `topK = 3`** is used by `AgentMemory.recall()`, which is called by `MemoryAggregator.aggregate()`.

The `MemoryAggregator` allows callers to override via `permanentTopK`. Automatic routing uses the configurable `resultCount` (default 10) for each direct or contextual retrieval query, deduplicates the combined results, and selects up to 5 chunks for chat context.

Each `RetrievedChunk` contains:

```typescript
{
  id: string           // nanoid
  text: string         // The chunk content
  source: string       // Always "permanent"
  score: number        // Score that produced the rank (RRF fusion or reranker)
  rerankerScore?: number // If LLM reranker was used
  sourceFile?: string  // Filename in the memory space
  chunkIndex?: number  // Sequential index within the file
  spaceId?: string     // UUID of the memory space
  spaceName?: string   // Resolved human-readable name
  totalChunks?: number // Total chunks for this source file (enriched by aggregator)
  documentId?: string  // Stable source identity (enriched by aggregator)
  revision?: string    // SHA-256 revision of the indexed source
}
```

### Memory Spaces & scoping

All memory is scoped to **memory spaces** (UUIDs stored in `memory_spaces` SQLite table). Each space has:

- An `id` (UUID)
- A `name` (human-readable)
- A `folder_path` on disk where files live
- An `is_default` flag

Scoping is enforced via LanceDB `WHERE spaceId IN (...)` filters. The aggregator resolves scopes in this priority order:

1. Explicit `spaceIds[]` passed by caller
2. Agent's assigned spaces in `agent_memory_spaces` table
3. All spaces (fallback)

---

## Entity Graph

The entity graph stores **derived, source-grounded claims** as nodes (entities) and edges (relationships) in SQLite. Markdown documents are authoritative; the graph is a rebuildable index used to connect facts across documents.

### Entity types

| Type           | Description                      |
| -------------- | -------------------------------- |
| `person`       | Named individuals                |
| `place`        | Geographic locations             |
| `organization` | Companies, groups, teams         |
| `project`      | Named initiatives                |
| `event`        | Specific occurrences             |
| `date`         | Temporal references              |
| `technology`   | Tools, frameworks, languages     |
| `product`      | Commercial products              |
| `artifact`     | Documents, files, code artifacts |
| `concept`      | Abstract ideas                   |
| `other`        | Default fallback                 |

### Importance levels

| Level | Label     | Description                                               |
| ----- | --------- | --------------------------------------------------------- |
| 0     | temporary | Random / conversational / throwaway                       |
| 1     | minor     | Mildly interesting, probably not worth saving (default)   |
| 2     | useful    | Durable fact worth remembering                            |
| 3     | core      | Core fact about user, project, preference, goal, identity |

Importance is **auto-inferred** if not explicitly provided by the LLM:

- Source kind `memory` → level 2
- Relations like `prefers`, `works_at`, `lives_in`, `goal`, `working_on` → level 3
- Relations like `depends_on`, `part_of`, `located_in`, `created` → level 2
- Everything else → level 1

Node importance is **derived from edges**: a node's importance is the maximum importance of all edges connected to it.

Entity identities are canonical across the graph, but relationship claims retain per-source evidence. Agent-facing relationship tools enforce the selected memory-folder boundary against that evidence: an edge is visible or mutable only when at least one supporting source belongs to an allowed folder. This preserves cross-document identity without exposing claims from unrelated memory scopes. Manual relationship assertions are owned by a selected memory folder as well.

Common relation synonyms are normalized (for example, `works_for` and `employed_by` become `works_at`), and same-named entities with incompatible types are kept separate to reduce accidental identity merging.

### Entity extraction

Entity extraction is done by an **LLM call** (not by the embedding model). The pipeline:

```
Tagged structural chunks from an indexed memory document
    │
    ▼
LLM call via Gateway ────► System prompt instructs JSON output format
    │                          │ Extract named entities + relationships
    │                          │ Return array of { action, from, relation, to,
    │                          │   importance, confidence, evidence,
    │                          │   source_chunk_index }
    │                          │ action: "assert" or "delete"
    │                          ▼
    │                   Raw LLM response (up to 4096 tokens)
    │
    ▼
parseJsonArray() ────► Robust JSON extraction:
                          │ Strips markdown fences
                          │ Falls back to finding [ ] brackets
                          │ Attempts to salvage truncated JSON
                          │ Limits to 24 relations per extraction
    │
    ▼
For each relation:
  "assert" → EntityGraphStore.upsertEdge()
                │ upsertNode() for both endpoints (dedup by normalized name)
                │ upsertEdge(): if single-target relation (e.g. works_at),
                │   delete previous edge to different target
                │ Merge duplicate nodes if name collision detected
  "delete" → EntityGraphStore.deleteMatchingEdge()
```

Extraction sources:

- **Memory files**: automatically queued after the document and its RAG chunks have been indexed; the explicit entity-index routes remain available as repair/retry controls
- **Conversation turns**: are not automatically extracted into the document graph
- **Configuration**: provider/model configurable via DB setting `'memoryEntityExtraction'`

The graph uses the same structural chunks as RAG. Several tagged chunks are batched into extraction windows of at most about **8000 characters**, so large files need neither truncation nor one LLM call per small chunk. Every new evidence record stores the stable document ID, exact document content hash, and supporting chunk index. The hash is checked again when claims are published; stale claims are also suppressed at retrieval time.

Graph derivation is best-effort. A failed extraction never makes the authoritative document or its RAG chunks unavailable, and previously derived claims are invalidated before a changed document is re-extracted.

Legacy memory claims that lack document/content-hash provenance are retained in storage but are not returned as model context. Re-index existing memory documents once after upgrading to rebuild those claims with grounded provenance.

### Graph storage & deduplication

**Nodes** (`entity_graph_nodes`):

| Column                           | Description                                       |
| -------------------------------- | ------------------------------------------------- |
| `id`                             | nanoid (unique)                                   |
| `name`                           | Display name (as written)                         |
| `normalized_name`                | Lowercased, punctuation-stripped (used for dedup) |
| `type`                           | One of the 11 entity types                        |
| `aliases_json`                   | JSON array of alias strings                       |
| `importance`                     | 0–3                                               |
| `mention_count`                  | How many times seen                               |
| `source_count`                   | How many distinct sources mentioned it            |
| `first_seen_at` / `last_seen_at` | Timestamps                                        |

**Edges** (`entity_graph_edges`):

| Column                           | Description                                           |
| -------------------------------- | ----------------------------------------------------- |
| `id`                             | nanoid (unique)                                       |
| `from_node_id` / `to_node_id`    | FK to nodes                                           |
| `relation`                       | Normalized snake_case (e.g. `works_at`, `located_in`) |
| `importance`                     | 0–3                                                   |
| `confidence`                     | 0.1–1.0                                               |
| `evidence`                       | Short sentence justifying the fact                    |
| `source_kind`                    | `"memory"` or `"conversation"`                        |
| `source_id`                      | Source document ID or conversation ID                 |
| `mention_count`                  | How many times this edge was asserted                 |
| `first_seen_at` / `last_seen_at` | Timestamps                                            |

**Deduplication logic**:

- Nodes are deduplicated by `normalized_name` (case-insensitive, punctuation-ignored)
- Alias matching: `aliases_json` is searched with SQL `LIKE`
- When a new name matches multiple existing nodes, they are **merged**:
  - Aliases are unioned
  - Mention/source counts are summed
  - Edges are re-pointed to the survivor node
  - Duplicate edges (same from/relation/to) are merged (confidence maxed, mention counts summed)
- Single-target relations (e.g., `works_at`, `lives_in`, `reports_to`) replace the previous edge to a different target

### Seed node search

`findSeedNodes(text, extraTexts[], limit = 8)` — finds entity nodes relevant to a query:

1. **Tokenize** the query and extra texts into tokens of 3+ characters
2. **Exact match phase**: search `normalized_name` and `aliases_json` for exact token matches
3. **Scoring**: each node gets a composite score:
   - exact name match = +100
   - name contains query = +80
   - query contains name (≥3 chars) = +70
   - haystack contains name = +45
   - per-token: exact = +40, partial = +24, token-in-name = +18, prefix match = +8
4. **Fallback phase**: if no exact seeds found, search by prefix (first 3 chars of each token)
5. Returns top `limit` (default 8) nodes, sorted by score → mentionCount → lastSeenAt

### Graph walk

`walk(seedNodeIds, depth = 2, edgeLimit = 40)` — BFS traversal from seed nodes:

- Starts with seed node IDs
- At each depth level, fetches all edges where `from_node_id` OR `to_node_id` is in the frontier
- Adds new node IDs to the frontier for the next level
- Edges sorted by: confidence DESC, mention_count DESC, last_seen_at DESC
- Per-depth limit: `ceil(edgeLimit / depth)` with remaining budget on the last level
- Returns `{ seedNodes, nodes, edges }` — all unique, up to `edgeLimit` edges

### What is returned

A `GraphWalkResult` contains:

```typescript
{
  seedNodes: EntityNode[],   // The matched seed nodes (with origins hydrated)
  nodes: EntityNode[],       // All nodes reached by the walk
  edges: EntityEdge[],       // All edges traversed
}
```

Each `EntityNode` includes an `origins` field (up to 8) showing which sources contributed to it:

```typescript
{
  sourceKind: "memory" | "conversation",
  sourceId: string,
  label: string,        // Human-readable source name
  count: number,        // How many mentions from this source
  lastSeenAt: number
}
```

When formatted for prompt injection via `formatWalk()`, it produces:

```
## Entity Graph Context
- [core] Alice -> works_at -> Acme Corp. Evidence: Alice is the CEO of Acme Corp.
- [useful] Bob -> manages -> Alice. Evidence: Bob is Alice's direct manager.
```

---

## Memory Aggregator

**`MemoryAggregator.aggregate(query, opts?)`** is the main entry point that **combines both subsystems**.

### How they are coupled

The coupling is **loose but intentional**:

1. **Semantic search runs first** — retrieves up to `permanentTopK` (default 3; auto-routing uses the configurable retrieval count, default 10) chunks from LanceDB
2. **Deduplication**: chunks with the same content hash (or fully normalized text) are collapsed
3. **Chunk enrichment**: totalChunks, stable internal document ID, and the indexed source content hash are added
4. **Optional entity graph enrichment**: callers that set `includeGraph: true` (including automatic memory routing) run:

   ```
   graph.findSeedNodes(query, chunkTexts, 8) → seed nodes
   if seedNodes.length > 0:
       graph.focusedWalk(seedNodeIds, depth=1, edgeLimit=8) → bounded key facts
   ```

   - The seed search uses **both** the original query AND the retrieved chunk texts
   - The walk may cross into another document, but only inside the caller's authorized memory spaces
   - Each returned claim retains a source document and part number
   - If no seed nodes match, `graph` is `undefined` — the aggregator still returns semantic results
   - If the graph walk fails (e.g., DB error), it's caught and logged as a warning; semantic results are still returned

5. **Both results are returned** as `{ permanent: RetrievedChunk[], graph?: GraphWalkResult }`

**Important**: The entity graph enriches semantic memory, but does NOT replace it. You can have:

- Semantic results only (no entities matched)
- Graph results only (a query directly names a known entity even when no passage clears retrieval)
- Both combined (normal case)

### Formatting for model context

`format(memory)` produces evidence with source and Part metadata, plus one opaque model-facing `documentRef` when the source may be edited. The model passes this reference back unchanged and never handles document IDs or content hashes separately. Entity-graph-only context omits the reference because graph operations do not need it. Pre-execution wraps retrieved evidence in a lower-authority user-context message explicitly marked as untrusted data; retrieved documents are never promoted to system instructions.

```
## Relevant Knowledge
- [MemorySpaceName · filename.md · Part 1/3] Chunk text content here...
- [MemorySpaceName · filename.md · Part 2/3] More chunk text...

## Entity Graph Context
- [core] Entity A -> relation -> Entity B. Evidence: ...
```

---

## Auto Memory Routing

The `auto-memory-routing.ts` module decides **whether** and **how** to retrieve memory during a conversation turn.

1. **Gate check**: `shouldRouteMemory()` — currently always returns `true` if the feature is enabled
2. **Multi-query retrieval**: search with both the immediate user query and a recent-conversation-aware query (when they differ), then combine ranks with reciprocal-rank fusion
3. **Selection**: from the fused candidates, select up to 5 most relevant chunks (via LLM call)
4. **Graph supplement**: attach at most 8 focused, source-grounded one-hop claims from the selected memory spaces; agents can use `relationship_graph_search` for deeper inspection
5. **Format & inject**: selected evidence is added below system authority and marked as untrusted

### Mutation consistency

Mutation operations are exposed as separate tools rather than a mode-switching schema:

- `memory_append`
- `memory_replace_range`
- `memory_replace_all`
- `memory_remove_range`
- `memory_remove_all`

Reads return one opaque `documentRef`. Internally it resolves to a stable document ID and a prefix of the SHA-256 hash calculated from the file state that was read. Every mutation passes this reference back unchanged; the server serializes writes per document and rejects the operation if the authoritative file has changed. The Markdown file remains the sole authoritative document, and no edit history or stored document version is created. If indexing fails, the previous source and index are restored from the in-flight mutation state. Whole-document deletion archives the source in the memory folder's hidden `.trash` directory.

---

## Key files

| File                                                              | Purpose                                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/server/src/core/memory/agent-memory.ts`                     | `AgentMemory` class — file-backed operations, ingest, recall, delete |
| `apps/server/src/core/memory/parser.ts`                           | `MemoryParser` — chunking, embedding, retrieval pipeline             |
| `apps/server/src/core/memory/rag.ts`                              | `RAGStore` — LanceDB lifecycle, vector & hybrid search, FTS index    |
| `apps/server/src/core/memory/embedding.ts`                        | `EmbeddingProvider` — connects to OpenAI / Gemini for embeddings     |
| `apps/server/src/core/memory/reranker.ts`                         | `MemoryReranker` — optional OpenRouter-based reranking               |
| `apps/server/src/core/memory/entity-graph.ts`                     | `EntityGraphStore` — node/edge CRUD, dedup, extraction, walk         |
| `apps/server/src/core/memory/memory-entity-indexer.ts`            | Bridge: triggers entity extraction when memory files are indexed     |
| `apps/server/src/core/memory/memory-aggregator.ts`                | `MemoryAggregator` — combines RAG + entity graph                     |
| `apps/server/src/core/memory/memory-index-jobs.ts`                | Job tracking for async reindex/entity-index operations               |
| `apps/server/src/core/memory/memory-space-scope.ts`               | Memory space resolution & LanceDB filter construction                |
| `apps/server/src/core/memory/lancedb-filter.ts`                   | SQL filter builders for LanceDB WHERE clauses                        |
| `apps/server/src/core/memory/history.ts`                          | `HistoryStore` — conversation execution history (SQLite + JSONL)     |
| `apps/server/src/core/agent/pre-execution/auto-memory-routing.ts` | Per-turn decision logic for automatic memory retrieval               |
