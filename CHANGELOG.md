# Changelog

All notable changes to Cynosure are documented in this file.

## [Unreleased] — Memory System 3.0

**Commit:** `01e1fdb0ed7fb01ef538433e61ea1e8e69786b8b` — _Merge branch 'rework/memory-system-3.0'_
**Author:** Andreas Hagen · **Date:** 2026-09-15
**Scope:** 35 files changed, 1483 insertions(+), 226 deletions(-)

This release reworks memory retrieval around **multi-representation chunks**: every
indexed chunk can now be searched through its raw text, a generated summary, its
keywords, and its extracted facts, while the raw chunk remains the single
authoritative piece of evidence returned to the model.

### Added

#### Memory analysis (summaries)

- Deep Research now extracts a **1–3 sentence summary per source chunk** in the
  source language, alongside the existing tags, entities, and relationships.
- New `summary` column on `memory_knowledge_text_units` (schema migration `v2`).
- Summaries are reused across document revisions when the chunk text hash is
  unchanged, so re-indexing does not pay for another model call.
- Extraction now fails with `MEMORY_ANALYSIS_SUMMARY_MISSING` if any chunk ends up
  without a summary, and resume checkpoints only count a chunk as complete once
  its summary is present.
- Pipeline/prompt versions bumped: `knowledge-v4.1.0 → knowledge-v4.2.0`,
  `deep-research-v5 → deep-research-v6`.

#### Multi-representation retrieval

- New `representationType` (`raw` | `summary` | `keywords` | `fact`) and
  `sourceChunkId` columns on vector tables, with automatic column backfill for
  existing tables.
- `withSearchAnalysis()` replaces `withSearchKeywords()`, writing summary and
  keywords into one replaceable retrieval surface without touching the embedded
  source text.
- New `collapseChunkRepresentations()` groups search-only hits back onto their
  authoritative raw chunk using reciprocal-rank contributions, so a chunk found
  through several representations ranks higher without mixing dense and BM25
  score scales.
- Retrieval now searches a 4× wider candidate pool before collapsing, and reports
  `matchedRepresentations`, `matchedBy`, `matchedFacts`, and `sourceChunkId` on
  every retrieved chunk.
- Fact projections are indexed as searchable statements (subject + predicate +
  object, plus the evidence note).

#### Memory file search

- New `GET /api/memory-folders/file-search` endpoint performing **cross-folder**
  search over file names, folder paths, tags, and chunk summaries, with
  `matchedFields` reporting which surface matched and a deterministic relevance
  ranking (exact name → prefix → name → tag → summary).
- The document list search box now switches to a global results table showing
  folder, path, modified date, and searchability; clicking a result opens the
  document in its own folder.

#### Document analysis sidebar

- New `GET /api/memory-folders/:id/files/:fileName/analysis` endpoint returning
  per-chunk summaries, tags, and extracted relationships/entities, with a
  `current` / `needs_refresh` / `not_analyzed` status.
- The memory document editor gained an **Analysis rail** (side-by-side on large
  screens, toggleable overlay on small ones) showing chunk summaries, tags, and
  extracted knowledge, plus a stale-analysis warning.
- `analysisStatus` added to file status responses; the Deep Research action now
  reads **"Refresh analysis"** with a refresh icon when analysis is stale.

#### Attachment upload progress

- Staging a chat attachment now streams `attachment:stage-progress` WebSocket
  events with chunk counts, and accepts an `AbortSignal`.
- The composer shows live `n / total chunks` progress and turns the remove button
  into a **Cancel** action while an upload is in flight.
- Aborted or failed staging cleans up the materialized files and any partially
  indexed chunks.

#### Background job failure visibility

- Failed and dead-lettered memory index jobs are surfaced in the document list
  with their error message, individually dismissible or clearable in bulk.
- New `DELETE /api/memory-folders/jobs/failures` endpoint (optionally scoped by
  `folderId`) permanently removes acknowledged failures so they do not
  reappear after a reload.

### Changed

- Folder actions (add subfolder, rename, delete) are grouped behind an ellipsis
  menu instead of three always-visible icon buttons.
- Deleting a folder now records its documents as deleted via
  `markMemoryFoldersDeleted()`, so folder cascades appear in document history.
- Memory file status is computed by a shared `listMemoryFiles()` helper, and
  "deep researched" now requires the analysis to be newer than the active
  knowledge run.
- `upsertFileIndex` is exported as `upsertMemoryFileIndex`; tags are no longer
  cleared on content change (stale analysis is tracked explicitly instead).
- Knowledge projections are marked as their own authoritative `raw` rows rather
  than search-only views.
- Retrieval timeline copy updated to describe representation-based search
  ("Searching memory representations", "Matched via raw + summary + fact").
- `post()` in the web HTTP client accepts an `AbortSignal`.

### Fixed

- LanceDB appends no longer fail when a batch omits metadata columns that exist
  in the table — defaults are backfilled per row.
- Memory file statistics no longer count summary/keyword/fact projections as
  separate chunks.
- Stale knowledge sources are no longer deleted on every content-hash change;
  refresh is driven by explicit analysis status.
- Aborted attachment uploads no longer leave orphaned files or chunks behind.

### Tests

- New integration test: `apps/server/tests/integration/memory/memory-folder-search.integration.test.ts`.
- Extended coverage for retrieval policy (`withSearchAnalysis`), revision
  cascades (`markMemoryFoldersDeleted`), deep-research extraction, knowledge
  indexing, and index jobs.
- New web tests for the analysis rail and the folder options menu.
