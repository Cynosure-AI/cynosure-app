# Open-Agent: Technical Summary

> Generated: 2026-03-23

---

## 1. Server (`/server`)

### Framework & Runtime

**Fastify** (v5) — _not Express_. Uses `@fastify/cors`, `@fastify/websocket`, `@fastify/swagger`, and `@fastify/multipart`. Runs under Node.js ESM modules (`"type": "module"`), developed with `tsx watch`, built with `tsc`.

### Architectural Patterns

The server uses a **singleton-service pattern** throughout. There is no DI container; every subsystem is obtained via a `get*()` factory function that lazily creates and caches a module-level instance:

- `getDb()` — SQLite singleton
- `getGateway()` — LLMGateway singleton
- `getToolRegistry()` — ToolRegistry singleton
- `getHITLGate()` — HITLGate singleton
- `getSandbox()` — Sandbox singleton
- `getMcpManager()`, `getMemoryAggregator()`, `getRAGStore()`, `getEventBus()` — same pattern

Routes are thin (Fastify plugin functions in `routes/`); all domain logic is in `core/`.

---

### Database Layer (`server/src/db/database.ts`)

- **better-sqlite3** — synchronous SQLite, WAL mode, foreign keys ON
- **Inline migration** — `runMigrations()` runs `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` add-column migrations every boot (no migration versioning tool)
- **SQLite tables**: `providers`, `conversations`, `messages`, `tasks`, `execution_logs`, `execution_steps`, `mcp_servers`, `tool_approvals`, `pending_hitl`, `settings`, `agents`, `channels`, `cron_jobs`, `file_watchers`, `agent_memory_spaces`, `memory_spaces`, `notifications`
- **Agents are NOT in SQLite** — they live as JSON config files on disk in `{appDataDir}/agents/{agentId}/` (managed by `server/src/core/agents/agent-files.ts`). The `AgentConfig` includes: `name`, `codename`, `description`, `category`, `providerId`, `model`, `tools`, `subAgents`, `getMemoriesAtStart`, `autoApproveTools`, `maxToolOutputChars`, `showInCarousel`, `favorite`, `createdAt`, `updatedAt`
- **Vector DB**: LanceDB (`@lancedb/lancedb`) for RAG/memory at `{appDataDir}/lancedb` (`server/src/core/memory/rag.ts`)

---

### `prepare-execution.ts` — Shared Pre-Action Builder

`server/src/core/agent/prepare-execution.ts`

Consolidates previously-duplicated preparation logic across all 7 trigger types. Called by: chat, cron, file-watcher, Telegram, Discord, Slack, sub-agent tools. Executes **6 sequential phases**:

```
1. Resolve tools from ToolRegistry by agent's tool-name list
2. Build sub-agent delegation tools (delegate_to_<codename>) — guarded by includeSubAgents flag
3. Hydrate built-in tool stubs with live context (agentId, conversationId, broadcast fn)
4. Resolve provider + model: override > agent config > active provider
5. Memory enrichment (if isFirstMessage && userQuery):
     → aggregate() → threshold filter → broadcast chat:memory-sources → system message
6. Construct system messages array (prompt + optional memory context)
```

Returns `PreparedExecution`. Callers still own: conversation history, AbortController, AgentExecutor construction, and post-execution persistence.

---

### `agent-executor.ts` — Core Execution Engine

`server/src/core/agent/agent-executor.ts`

The most complex class in the codebase (~450 lines). Implements the **agentic streaming loop** shared by all triggers.

**Phase 1** — Initial LLM streaming:

```typescript
const initialStream = gateway.streamComplete(
  { messages, model, tools, temperature, signal },
  providerId,
);
for await (const chunk of initialStream) {
  /* broadcast chunks */
}
if (!pendingToolCalls?.length) return immediately; // simple response path
```

**Phase 2** — Tool-calling loop (up to `maxRounds`, default 15):

```
for each round:
  1. Optionally pause at HITLGate.requestApproval() — Promise that blocks until user clicks
  2. On HITL denial: inject denialReason into messages, stream revised LLM response, continue
  3. Save assistant tool-call message to DB (before tool execution for correct timestamp ordering)
  4. Execute tool calls via Sandbox (timeout enforcement via Promise.race)
  5. Truncate oversized outputs > maxToolOutputChars (16k default):
       — buffer full output; inject read_long_output tool dynamically
  6. Append assistant + tool results to currentMessages
  7. Stream next LLM round
  8. Emit step:status / step:executed to EventBus
```

Key configuration variants:

| Config       | Value                         | Effect                                                    |
| ------------ | ----------------------------- | --------------------------------------------------------- |
| `streamMode` | `'single'` (chat)             | One streamId, `stream-reset` between rounds               |
| `streamMode` | `'per-round'` (cron/triggers) | New streamId per round                                    |
| `hitl`       | `true`                        | Blocks between phases on user approval                    |
| `emitEvents` | `false`                       | Suppresses EventBus noise from nested sub-agent executors |
| `maxRounds`  | 15 (default)                  | Guards against infinite tool loops                        |

---

### `error-recovery.ts`

`server/src/core/agent/error-recovery.ts`

Two-level strategy:

- **L1 (retry < maxRetries=3)**: Retryable errors (timeout, ECONNREFUSED, 429, 503, tool errors) → append error to history and retry with "try a different approach"
- **L2 (escalate)**: Return `{ action: 'escalate', error }` for caller to handle

> **Note**: `isRetryable()` returns `true` as a default fallback — practically all errors are retried until `maxRetries` is exhausted.

---

### `hitl-gate.ts` — Human-in-the-Loop

`server/src/core/agent/hitl-gate.ts`

A **Promise-based suspend/resume** mechanism. When the executor reaches tool calls with HITL enabled:

```typescript
return new Promise<ApprovalResult>((resolve, reject) => {
  signal?.addEventListener("abort", onAbort, { once: true });
  this.eventBus.emit("hitl:request", {
    taskId,
    conversationId,
    toolCalls,
    resolve: (result) => {
      cleanup();
      resolve(result);
    },
  });
});
// Frontend: POST /agent/hitl/:taskId → eventBus.emit('hitl:response') → resolve()
```

- Tools prefixed `delegate_to_` are always auto-approved (sub-agent delegation bypasses HITL)
- Per-tool whitelisting stored in `tool_approvals` SQLite table
- Pending HITL persisted in `pending_hitl` table; cleared on server restart

---

### Channel Manager (`server/src/core/channels/channel-manager.ts`)

Singleton lifecycle manager for **Telegram, Discord, and Slack** integrations:

- `loadAll()` called at startup — starts all DB-enabled channels
- `startChannel(config)` — stops existing instance, instantiates typed provider, calls `provider.start()`
- Delegates to `TelegramChannel`, `DiscordChannel`, `SlackChannel` (each implements `ChannelProvider` from `base.channel.ts`)
- `getActiveExecutions()` / `cancelExecution()` — aggregates across all running providers
- All DB operations are synchronous (better-sqlite3)

---

### LLM Gateway (`server/src/core/gateway/gateway.ts`)

`LLMGateway` maintains a `Map<string, BaseLLMProvider>`. Supports **8 providers**:

| Provider   | Class                |
| ---------- | -------------------- |
| OpenAI     | `OpenAIProvider`     |
| Anthropic  | `AnthropicProvider`  |
| Gemini     | `GeminiProvider`     |
| LM Studio  | `LMStudioProvider`   |
| Grok       | `GrokProvider`       |
| Ollama     | `OllamaProvider`     |
| Groq       | `GroqProvider`       |
| OpenRouter | `OpenRouterProvider` |

All implement `BaseLLMProvider` with `complete()` and `streamComplete()`. The gateway routes to the named provider or falls back to `activeProviderId`.

---

### Tools & Triggers

**ToolRegistry** (`server/src/core/tools/tool-registry.ts`):

- Namespace-aware composite keys (`namespace::name`) support same-named tools from different MCP servers
- `resolveForExecution(names[])` maps an agent's tool-name list to hydrated `ToolDefinition[]`
- Ambiguity resolution: built-in wins over MCP, then first registered

**Built-in tools** (`server/src/core/tools/built-in-tools.ts`):  
7 tools hydrated at execution time: `create_notification`, `memory_list_documents`, `memory_retrieve_chunks`, `memory_semantic_search`, `memory_create`, `memory_update`, `memory_ingest_document`. Registered as stubs in the registry; `hydrateBuiltInTools()` replaces stubs with closures capturing live agent context.

**MCP tools** (`server/src/core/tools/mcp/mcp-manager.ts`):  
`McpManager` connects to external processes via MCP SDK `StdioClientTransport`. Handles OAuth pending-auth flows, rewrites absolute file paths in tool output to `/api/files?path=…` URLs, saves base64 image responses to disk.

**Triggers**:

- _Cron_ (`server/src/core/triggers/cron-scheduler.ts`): `node-cron` tasks; in-memory `Map<jobId, ScheduledTask>`; cancellable via `AbortController`
- _File Watcher_ (`server/src/core/triggers/file-watcher.ts`): `chokidar` FSWatcher; per-watcher change-entry buffer; configurable `debounceMs` timer before dispatching to executor

**Sub-agent tools** (`server/src/core/agent/sub-agent-tools.ts`):  
`buildSubAgentTools()` creates a `delegate_to_<codename>` `ToolDefinition` for each sub-agent. Each tool's `execute()` fn spins up an inner `AgentExecutor` using `prepareAgentExecution({ includeSubAgents: false })` — the `false` flag is the only recursion guard.

---

### Post-Execution (`server/src/core/agent/post-execution.ts`)

Tracks in-flight follow-up LLM calls (e.g. title generation) per conversation:

- `startAction()` / `completeAction()` broadcast `chat:post-action` WS events
- `cancelPostActions()` — aborts all in-flight post-actions for a conversation
- `getAllActiveActions()` — allows frontend hard-reload to recover in-progress state

---

### WebSocket (`server/src/ws.ts`)

Simple broadcast fanout. `broadcast(event, data)` serialises to JSON and sends to all `OPEN` clients. Heartbeat pings every 30s; terminates unresponsive clients.

---

### Existing Tests

**Zero test files** — no `.test.ts` or `.spec.ts` files exist anywhere in the server project.

---

## 2. Web (`/web`)

### Framework

**Vue 3** + **Vite** (v7) + **TailwindCSS v4** + **Pinia** + **Vue Router v5**. Pure SPA (no SSR). TypeScript throughout, type-checked with `vue-tsc`.

Key dependencies:

- `@huggingface/transformers` — on-device Whisper STT in a Web Worker
- `marked` + `marked-highlight` + `highlight.js` — Markdown rendering
- `@iconify/vue` — icon library

---

### Stores (Pinia)

| Store               | File                                        | Complexity    |
| ------------------- | ------------------------------------------- | ------------- |
| `chat`              | `web/src/stores/chat.store.ts`              | **Very High** |
| `agent`             | `web/src/stores/agent.store.ts`             | **High**      |
| `agent-definitions` | `web/src/stores/agent-definitions.store.ts` | Low           |
| `provider`          | `web/src/stores/provider.store.ts`          | Low           |
| `preferences`       | `web/src/stores/preferences.store.ts`       | Low           |
| `notifications`     | `web/src/stores/notification.store.ts`      | Low           |

#### `chat.store.ts` (~880 lines)

The most complex file in the frontend. Key responsibilities:

- **Optimistic UI**: user message + streaming placeholder inserted before API response
- **Per-conversation stream buffers**: `streamBuffers: Map<conversationId, StreamBuffer>` — maintains streaming state when switching conversations mid-generation
- **`sendMessage()`**: lazy conversation creation, tools/model/provider resolution, sub-agent config serialization, title-generation preference integration
- **`handleStreamEvent()`**: dispatches 12+ WebSocket event types:
  - `chat:stream-start/chunk/thinking/images/end/reset`
  - `chat:memory-sources`, `chat:post-action`
  - `hitl:request`
  - `task:started/completed/error`, `step:status/tools-chosen/executed/hitl-denied/error`
- **Sub-agent discrimination**: checks `eventData.maCodename` on `task:completed` to avoid resetting main execution state when a sub-agent finishes
- **`primaryStreamId` / `primaryStreamAgent`**: tracks the orchestrator's stream identity so `cancelStream()` always targets the right executor regardless of sub-agent streams
- **`retryFromMessage()` / `editMessage()`**: truncates DB history then replays `sendMessage()`
- **`cancelStream()`**: eagerly resets UI state; falls back from `primaryStreamId → conversationId` for post-reload cancellation
- **`postActionsMap: Map<conversationId, Set<string>>`** with `postActionsTrigger ref` as a reactivity workaround for Map watching

#### `agent.store.ts`

- `stepsPerConversation: Map<string, ExecutionStep[]>` / `eventsPerConversation` — per-conversation history survives tab switching
- `handleExecutionUpdate()` dispatches 10+ event types including sub-agent differentiation
- `respondHITL()` — sends approval/denial to server
- Tool selection state with `toggleTool()` / `selectAllTools()` + approval sync from server

---

### Composables

| Composable         | Purpose                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| `useSidebar`       | Module-singleton open/close state (settings panel)                          |
| `useChatSidebar`   | Chat panel open/close; auto-opens on wide viewport                          |
| `useProviderLogos` | Theme-aware provider logo URL map                                           |
| `useCronHuman`     | **Cron expression parser + builder (pure functions)**                       |
| `useWhisper`       | **On-device STT via Web Worker + HuggingFace transformers + MediaRecorder** |
| `useMcpServers`    | MCP server management composable                                            |

`useWhisper` manages: Web Worker lifecycle, MediaRecorder audio capture, multiple status states (`idle | loading | ready | recording | transcribing | error`), per-file download progress tracking, and model caching in localStorage.

`useCronHuman` exports `parseCronExpr()` / `buildCronExpr()` — pure regex-based functions that map 5-field cron expressions to/from structured `CronParts` covering 5 frequency patterns (minutes, hourly, daily, weekly, monthly, custom).

---

### Existing Tests

**Zero test files** — no `.test.ts`, `.spec.ts`, or `.spec.vue` files exist anywhere in the web project.

---

## 3. Most Critical Code to Test

### Server — Priority Order

#### 1. `AgentExecutor.run()` — Phase 2 tool loop

`server/src/core/agent/agent-executor.ts`

The entire agent behavior lives here. Risky branches:

- HITL approval flow (Promise blocks, then resolves/rejects)
- HITL denial: injects revised prompt, streams LLM response, continues loop
- `maxRounds` boundary — exits cleanly vs. mid-loop abort
- `signal.aborted` mid-loop at multiple checkpoints
- `streamMode: 'single'` vs `'per-round'` stream ID management
- `maxToolOutputChars` truncation + dynamic `read_long_output` tool injection
- Image collection across multiple rounds

#### 2. `prepareAgentExecution()` — provider/model resolution

`server/src/core/agent/prepare-execution.ts`

Called by every trigger. The chain `providerOverride → agent.providerId → activeProvider` plus `model === 'default' → activeProvider.config.defaultModel` fallback is easy to regress silently. Also: `includeSubAgents: false` propagation, memory enrichment gating on `isFirstMessage && userQuery`.

#### 3. `MemoryAggregator.aggregate()` — space filter construction

`server/src/core/memory/memory-aggregator.ts`

⚠️ **Security concern** — uses string interpolation to build a LanceDB filter clause:

```typescript
const quoted = rows
  .map((r) => `'${r.space_id.replace(/'/g, "''")}'`)
  .join(", ");
spaceFilter = `spaceId IN (${quoted})`; // injected directly into LanceDB filter
```

While `space_id` values originate from the DB (limited attack surface), this pattern is fragile. Needs: correctness tests (multi-space, no-space, single-space, space with single-quote in ID) and adversarial input tests.

#### 4. `HITLGate.requestApproval()` — Promise/AbortSignal race

`server/src/core/agent/hitl-gate.ts`

Two exit paths (resolve via `hitl:response` event vs. reject via `abort` signal) with cleanup logic that must not leak event listeners. Test: normal approval, normal denial, abort before approval, abort after approval starts.

#### 5. `ToolRegistry.resolveForExecution()` / `get()` — namespace collision

`server/src/core/tools/tool-registry.ts`

Silent ambiguity resolution (built-in wins, then first-registered) can silently route to the wrong tool. Test cases: unique name, ambiguous bare name (two MCP servers + builtin), composite key lookup, unregister + re-register.

#### 6. `buildSubAgentTools()` — recursion guard

`server/src/core/agent/sub-agent-tools.ts`

`includeSubAgents: false` in the inner `prepareAgentExecution()` call is the **only** thing preventing infinite delegation recursion. A regression here would cause unbounded executor nesting.

#### 7. `runMigrations()` — SQLite schema migrations

`server/src/db/database.ts`

Run-on-boot migrations with `ALTER TABLE` column checks. No versioning table — relies entirely on `PRAGMA table_info()` column existence checks. A failed silent migration leaves the DB in a broken state.

#### 8. `Sandbox.execute()` — tool timeout enforcement

`server/src/core/tools/sandbox.ts`

`Promise.race` between `tool.execute()` and an `AbortController`-based timeout. Test: normal execution, timeout fires before completion, tool throws error, timeout fires exactly at boundary.

---

### Web — Priority Order

#### 1. `chat.store.ts` — `handleStreamEvent()` sub-agent discrimination

The check `if (eventData.maCodename) break` on `task:completed` must hold. A regression resets `isExecuting` / `activeTaskId` while sub-agents are still running, breaking the cancel button and step timeline.

#### 2. `chat.store.ts` — `sendMessage()` model/provider resolution

The "don't propagate agent's own model to avoid overriding sub-agent models" logic and "if providerOverride without explicit model, use provider's defaultModel" fallback are both subtle and untested.

#### 3. `useCronHuman.ts` — `parseCronExpr()` / `buildCronExpr()`

Pure functions with zero side effects — the easiest high-value tests to write. Covers 5 frequency patterns; edge cases (invalid expressions, 4-field input, `*/0`, round-trip parse→build→parse) are all untested.

#### 4. `chat.store.ts` — `streamBuffers` multi-conversation streaming

When switching conversations while one is streaming, the buffer must be correctly re-hydrated in `selectConversation()`. The interaction between `streamBuffers`, `primaryStreamId`, streaming placeholder messages, and `isStreaming` state is complex and completely untested.

---

## 4. Dependency Snapshot

### Server Notable Dependencies

| Package                     | Version  | Purpose                           |
| --------------------------- | -------- | --------------------------------- |
| `fastify`                   | ^5.8.2   | HTTP framework                    |
| `better-sqlite3`            | ^12.6.2  | Synchronous SQLite                |
| `@lancedb/lancedb`          | ^0.26.2  | Vector DB for RAG                 |
| `@modelcontextprotocol/sdk` | ^1.27.1  | MCP client (stdio)                |
| `@anthropic-ai/sdk`         | ^0.78.0  | Anthropic provider                |
| `openai`                    | ^6.27.0  | OpenAI + Grok + LMStudio provider |
| `@google/genai`             | ^1.44.0  | Gemini provider                   |
| `node-cron`                 | ^4.2.1   | Cron scheduling                   |
| `chokidar`                  | ^5.0.0   | File system watching              |
| `discord.js`                | ^14.25.1 | Discord channel                   |
| `@slack/bolt`               | ^4.6.0   | Slack channel                     |
| `zod`                       | ^4.3.6   | Schema validation                 |
| `nanoid`                    | ^5.1.6   | ID generation                     |

**No test framework is installed** (`vitest`, `jest`, `mocha`, etc. are absent from both `dependencies` and `devDependencies`).

### Web Notable Dependencies

| Package                     | Version  | Purpose                  |
| --------------------------- | -------- | ------------------------ |
| `vue`                       | ^3.5.25  | UI framework             |
| `pinia`                     | ^3.0.4   | State management         |
| `vue-router`                | ^5.0.3   | Routing                  |
| `@huggingface/transformers` | ^3.8.1   | On-device Whisper STT    |
| `marked`                    | ^17.0.4  | Markdown rendering       |
| `highlight.js`              | ^11.11.1 | Code syntax highlighting |
| `tailwindcss`               | ^4.2.1   | CSS utility framework    |

**No test framework is installed** (`vitest`, `@vue/test-utils`, `jest`, etc. are absent).
