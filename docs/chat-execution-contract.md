# Chat and execution: target contract

This document describes the **merge target** for the chat refactor. PR #28 is a working branch; its dual-written columns and legacy WebSocket listeners must be removed before the refactor is considered complete.

## One source of truth

A conversation is an ordered stream of versioned `ChatEvent` records. Every event has `conversationId`, `executionId`, a conversation-scoped sequence, and a typed payload. The database allocates sequences inside the same transaction that appends an event. A transcript snapshot is the result of reducing those events in order. A persisted snapshot may cache that result at a known sequence, but it must be disposable and rebuilt from the log.

The canonical items are messages with `ContentBlock[]`, tool calls, tool results, and execution markers. Every item has a stable ID. Tool results refer to a call ID; delegated items refer to an invocation ID and parent invocation ID. The UI never matches tool activity to messages by timestamp.

Provider request messages are projections made immediately before each gateway call. They may contain inline image/audio bytes or provider-specific part types, but those parts are never stored as conversation data. The canonical blocks reference durable artifact IDs; the server resolves URLs and bytes at the adapter boundary.

## Lifecycle

1. The input boundary materializes attachments and appends the user message event.
2. Pre-execution stages emit typed decisions and diagnostics tied to the execution.
3. The selected execution strategy (chat, video, transcription, cron, or channel) emits the same start, delta, item, error/cancel, and completion contract.
4. The executor appends tool call and result items using their real call IDs. Subagents carry explicit parent and invocation IDs.
5. The server serves a snapshot and its sequence. The client subscribes and fetches events after that sequence, reducing both replayed and live events through one reducer. Stable item IDs make replay idempotent.

Debug capture records the exact gateway request/response at the provider boundary as execution diagnostics; it is not reconstructed from display messages.

## Migration and deletion

- Convert existing `messages` and `execution_steps` rows once into the versioned event log. Use the original row IDs and a deterministic order for equal timestamps. Record a migration version and verify counts and tool-call/result links before dropping old tables.
- Route every writer (chat route, executor, subagents, cron, channels, compaction) through a single append service. A write and its event must succeed or fail together. WebSocket broadcast does not write to the database.
- Convert provider history, metrics, search, fork/edit, backup/restore, attachments, and activity readers to canonical transcript queries. Old backup archives are converted at import time only.
- Replace `useChatStreaming`, the separate execution-step store, and `buildChatTimeline` timestamp reconstruction with one reducer and one canonical timeline renderer.
- Delete legacy media columns, `StoredMessageDto`, untyped chat WebSocket events, the old `execution_steps` table, and temporary dual-write code. No runtime fallback to an older schema remains.

## Completion checks

A reopened conversation and a live replay through the same sequence produce the same ordered items, media, tools, usage, and subagent groups. Cancellation and reconnect do not duplicate items. Edited/forked conversations retain valid references. Existing databases and backup archives migrate without losing attachments or tool history. Server/web typecheck, focused migration and replay tests, and end-to-end chat flows pass.
