# Chat Execution Pipeline

This document details the complete end-to-end flow from when a user sends a chat message through agent execution, memory retrieval, tool injection, orchestration, and post-processing.

---

## Architecture Overview

```
                         ┌──────────────────┐
                         │   HTTP / WS      │
                         │   Entry Points    │
                         └────────┬─────────┘
                                  │
                         ┌────────▼─────────┐
                         │  Chat Route      │
                         │  (routes/chat.ts)│
                         └────────┬─────────┘
                                  │
                         ┌────────▼─────────┐
                         │  planExecution() │
                         │  (execution-     │
                         │   planner.ts)    │
                         └────────┬─────────┘
                                  │
                  ┌───────────────┼────────────────┐
                  │               │                 │
          ┌───────▼──────┐ ┌─────▼──────┐ ┌───────▼────────┐
          │  prepare     │ │  prepare   │ │   prepare      │
          │  AgentExec() │ │  AgentExec │ │   AgentExec()  │
          │              │ │            │ │                │
          │  Tool        │ │  Memory    │ │   Prompt       │
          │  Resolution  │ │  Retrieval │ │   Assembly     │
          └───────┬──────┘ └─────┬──────┘ └───────┬────────┘
                  │               │                 │
                  └───────────────┼─────────────────┘
                                  │
                         ┌────────▼─────────┐
                         │  AgentExecutor   │
                         │  .run()          │
                         └────────┬─────────┘
                                  │
                  ┌───────────────┼────────────────┐
                  │               │                 │
          ┌───────▼──────┐ ┌─────▼──────┐ ┌───────▼────────┐
          │  Phase 1:    │ │  Phase 2:  │ │  Post-Exec     │
          │  Initial     │ │  Tool-     │ │  (title gen,   │
          │  LLM Stream  │ │  Calling   │ │  cleanup)      │
          │              │ │  Loop      │ │                │
          └──────────────┘ └────────────┘ └────────────────┘
```

---

## 1. Entry Points

### 1.1 HTTP Chat Route

**File:** `routes/chat.ts`

**Endpoint:** `POST /api/chat/conversations/:id/send`

The primary entry point for user messages. Accepts:

| Field                        | Type                  | Purpose                           |
| ---------------------------- | --------------------- | --------------------------------- |
| `content`                    | `string`              | The user's text message           |
| `imageDataUrls`              | `string[]`            | Base64-encoded images             |
| `audioDataUrls`              | `string[]`            | Base64-encoded audio              |
| `files`                      | `{ name, content }[]` | File attachments                  |
| `allowedTools`               | `string[]`            | Manual tool selection override    |
| `model` / `providerOverride` | `string`              | Model/provider override           |
| `systemPrompt`               | `string`              | Custom system prompt              |
| `subAgents`                  | `{ agentId }[]`       | Sub-agent delegation config       |
| `memorySpaceIds`             | `string[]`            | Memory scope override             |
| `autoToolRouting`            | `boolean`             | Enable smart tool routing         |
| `autoMemory`                 | `boolean`             | Enable auto-memory retrieval      |
| `thinkingEnabled`            | `boolean`             | Enable thinking/reasoning tokens  |
| `contextStrategy`            | `string`              | `"sliding-window"` or `"compact"` |

**Flow within the handler:**

1. **Artifact materialization** — Images and files are saved to disk, indexed for RAG
2. **Message composition** — User content is built as text parts, image URLs, audio URLs, and file context
3. **Conversation history** — Past messages are loaded from DB via `buildConversationHistory()`
4. **Resolve agent config** — The conversation's bound agent is looked up
5. **Resolve run flags** — Auto-memory flags are determined from agent config + request overrides
6. **Plan execution** — Calls `planExecution()` which orchestrates all pre-execution preparation
7. **Context window management** — Messages are trimmed or compacted to fit the model's context window
8. **Agent execution** — An `AgentExecutor` is created and `executor.run(messages)` is called
9. **Post-execution** — Assistant message is saved; title generation fires asynchronously

### 1.2 WebSocket (`ws.ts`)

Real-time streaming is handled via WebSocket. The `broadcast` function emits events to all connected UI clients throughout the execution lifecycle.

### 1.3 Trigger Entry

**File:** `triggers/trigger-runner.ts`

Cron jobs and event-driven automations bypass the HTTP route and use `runTriggerExecution()`. This function:

1. Creates a new conversation in the database
2. Calls the same `planExecution()` → `AgentExecutor.run()` pipeline
3. Returns the execution result to the caller

---

## 2. Pre-Execution Planning

### 2.1 Execution Planner

**File:** `core/agent/pre-execution/execution-planner.ts`

The `planExecution()` function is the central orchestration hub that converts route requests into executor-ready plans.

```
planExecution(request)
  │
  ├─ Convert request to ExecutionPlanInput
  │
  ├─ Determine effective tool keys from:
  │   ├─ Agent config (resolvedAgent.tools)
  │   ├─ Request override (selectedToolKeys)
  │   ├─ Auto-routing mode (autoToolRouting)
  │   └─ All registered tools (fallback)
  │
  ├─ Build execution preset from agent or agentless config
  │   └─ presetFromAgent() or presetFromAgentless()
  │
  ├─ Call prepareAgentExecution() — resolves all layers in parallel
  │
  ├─ Check if model supports tool calls
  │   └─ gateway.modelSupportsToolCalls()
  │
  ├─ Apply planning if model supports tools + has visible tools
  │   └─ Creates/resumes planning run, injects planning todo tools
  │
  └─ Return PlannedExecution:
      ├─ tools: ToolDefinition[] (with planning tools if applicable)
      ├─ messages: ChatMessage[] (system prompts + conversation history)
      ├─ providerId, responseProvider, responseModel
      ├─ planningRunId (if planning enabled)
      └─ chatAgentName, chatAgentIconUrl
```

### 2.2 Prepare Agent Execution

**File:** `core/agent/prepare-execution.ts`

This is a thin assembler that calls all four pre-execution layers in a coordinated sequence.

```typescript
prepareAgentExecution(input)
  │
  ├─ resolveProviderAndModel()
  │   ├─ Override precedence: request → agent → last-used provider
  │   └─ If provider overridden without model, ignores agent's model
  │
  ├─ resolveTaskContextRouter()
  │   └─ Determines which provider/model to use for the auto-routing passes
  │
  ├─ buildTaskContext()
  │   └─ Uses an LLM call to build a compact task context including:
  │       ├─ toolQuery / memoryQuery
  │       ├─ systemContext (concise facts & intent)
  │       └─ focusAreas (capability labels)
  │
  ├─ resolveExecutionTools()
  │   ├─ Gets configured tools OR all available tools
  │   ├─ Applies auto-tool-routing (if enabled)
  │   ├─ Adds built-in memory tools (if runtime memory enabled)
  │   └─ Adds sub-agent delegation tools (if sub-agents configured)
  │
  ├─ appendTaskContextSystemMessage()
  │   └─ Injects task context as a system message
  │
  ├─ resolveSystemPromptMessages()
  │   ├─ Base system prompt (or override)
  │   ├─ Appends sub-agent prompt (if sub-agents present)
  │   └─ Appends system prompt suffix
  │
  └─ resolveMemorySystemMessages()
      └─ Applies auto-memory-routing (if enabled), returns memory context as system message
```

### 2.3 Provider/Model Resolution

**File:** `core/agent/pre-execution/execution-resolvers.ts`

- `resolveProviderAndModel()` — Deterministic resolution with override precedence
- `resolveRouterProviderModel()` — Separate resolution for the auto-routing LLM pass (can use a different provider/model)
- Supports special sentinel values `__agent_provider__` and `__agent_model__` for deferred resolution

---

## 3. Tool Resolution & Injection

### 3.1 Tool Registry

**File:** `core/tools/tool-registry.ts`

Tools are stored with composite keys: `namespaceId::toolName`. The registry:

- Handles same-named tools from different MCP servers
- Generates disambiguated execution names on collisions
- Provides `resolveForExecution(toolKeys)` to hydrate tool definitions
- Provides `listRegisteredTools()` and `getNamespaceMetadataForTools()`

### 3.2 Execution Tools

**File:** `core/agent/pre-execution/execution-tools.ts`

```typescript
resolveExecutionTools(input)
  │
  ├─ Determine routing mode
  │   └─ routingEnabled = preset.autoToolRouting || session autoToolRouting
  │
  ├─ Collect tool keys:
  │   ├─ If routing: all registered tools
  │   └─ If manual: configured tool keys from preset
  │
  ├─ Resolve tools from registry
  │
  ├─ Apply auto-tool-routing (if enabled):
  │   └─ Embedding-based pre-filter → LLM selection → ranked tool list
  │
  ├─ Inject memory tools (if runtime memory enabled):
  │   ├─ memory_list_documents
  │   ├─ memory_retrieve_chunks
  │   ├─ memory_semantic_search
  │   ├─ memory_create / memory_update
  │   ├─ memory_forget
  │   ├─ relationship_graph_search / relationship_graph_assert / relationship_graph_delete
  │
  ├─ Inject sub-agent delegation tools (if sub-agents configured):
  │   └─ spawn_subagent tool
  │
  └─ Deduplicate by name, return final tool list
```

### 3.3 Auto Tool Routing

**File:** `core/agent/pre-execution/auto-tool-routing.ts`

**File:** `core/agent/tool-router.ts`

When `autoToolRouting` is enabled, the system intelligently selects which tools to make available:

1. **Embedding pre-filter** — MCP tool groups are ranked by embedding similarity to the user's query (top-K groups kept)
2. **LLM routing pass** — The router LLM selects relevant tools from the pre-filtered set, considering:
   - Tool names and descriptions
   - MCP namespace metadata
   - Preferred tool names (explicitly selected tools that must survive routing)
   - Previously used tool names
3. **Fallback** — If routing fails, local (non-MCP) tools are used

**Key constants:**

- `MCP_CANDIDATE_COUNT = 8` — Top K MCP groups by embedding similarity
- `MAX_ROUTED_TOOLS = 16` — Upper bound for selected tools
- `MIN_RELATIVE_TOOL_SCORE = 0.72` — Near-match threshold

### 3.4 Attachment Tools

**File:** `core/artifacts/attachment-rag.ts`

After planning, attachment tools (`attachment_search`, `attachment_retrieve_chunks`) are injected if the model supports tool calls and the conversation has indexed file attachments.

---

## 4. Memory System

### 4.1 Pre-Execution Memory Retrieval

**File:** `core/agent/pre-execution/execution-memory.ts`

**File:** `core/agent/pre-execution/auto-memory-routing.ts`

When `autoMemory` is enabled, memory is automatically retrieved before execution:

```
applyAutoMemoryRouting(input)
  │
  ├─ Build router query from current message + recent conversation turns
  │
  ├─ Call MemoryAggregator.aggregate(primaryQuery, {
  │     agentId,
  │     spaceIds,
  │     permanentTopK: 12
  │   })
  │
  ├─ If no results with primary query, retry with contextual query
  │
  ├─ Limit to MAX_SELECTED_MEMORIES (5) chunks
  │
  ├─ Format as system context string
  │
  └─ Return formatted memory or null
```

### 4.2 Memory Aggregator

**File:** `core/memory/memory-aggregator.ts`

The `MemoryAggregator` combines results from two memory stores:

| Store            | Technology       | Purpose                                      |
| ---------------- | ---------------- | -------------------------------------------- |
| Permanent Memory | LanceDB (vector) | Semantic search over stored knowledge chunks |
| Entity Graph     | In-memory graph  | Named entities and their relationships       |

**Fallback logic:**

1. If explicit space IDs provided → query only those spaces
2. If agent has explicit memory space assignments → query only those spaces
3. If agent has NO assignments or no scope → query all memory folders

**Scoring & deduplication:**

- Results are deduplicated by text similarity (first 100 chars)
- Each chunk is enriched with `totalChunks` for the same source file

### 4.3 Entity Indexing

**File:** `core/memory/memory-entity-indexer.ts`

A background indexing pipeline that:

- Watches memory folders for changes
- Extracts named entities from file content via LLM
- Updates the entity graph with new edges and relationships
- Syncs vector representations to LanceDB

### 4.4 Memory Scope

**File:** `core/memory/memory-space-scope.ts`

Memory spaces are the isolation boundaries. Each agent can be assigned to specific spaces or default to "all spaces."

### 4.5 Runtime Memory Tools

During execution, the agent can interact with memory via built-in tools:

- `memory_list_documents` — List files in memory spaces
- `memory_retrieve_chunks` — Get specific chunks by file reference
- `memory_semantic_search` — Query by semantic similarity
- `memory_create` / `memory_update` — Add or modify memory
- `memory_forget` — Delete memories
- `relationship_graph_search` — Find related relationships via graph traversal
- `relationship_graph_assert` / `relationship_graph_delete` — Manage relationships

---

## 6. Task Context System

**File:** `core/agent/pre-execution/task-context.ts`

Before execution begins, if any auto-routing mode is enabled, a lightweight "task context" LLM call builds a compact context summary. This LLM call uses a `set_task_context` tool to produce:

| Field           | Purpose                                                       |
| --------------- | ------------------------------------------------------------- |
| `toolQuery`     | Action/capability terms for tool selection                    |
| `memoryQuery`   | Knowledge/entity terms for memory retrieval                   |

Each auto-routing layer (tools and memory) uses its dedicated query string for more precise selection.

---

## 7. Agent Executor

**File:** `core/agent/agent-executor.ts`

The `AgentExecutor` class implements the core tool-calling loop. It is used by chat, cron, and trigger execution paths.

### 7.1 Configuration

| Property            | Default                        | Description                                                 |
| ------------------- | ------------------------------ | ----------------------------------------------------------- |
| `gateway`           | required                       | LLM gateway instance                                        |
| `tools`             | required                       | Tool definitions available to the agent                     |
| `hitl`              | `false`                        | Require human approval for tool calls                       |
| `maxRounds`         | `50` (main) / `30` (sub-agent) | Maximum tool-calling rounds                                 |
| `thinkingEnabled`   | `true`                         | Enable reasoning tokens                                     |
| `saveMessages`      | `true`                         | Persist messages to DB                                      |
| `streamMode`        | `'single'`                     | `'single'` (one streamId) or `'per-round'` (new per round)  |
| `emitEvents`        | `true`                         | Emit EventBus execution step events                         |
| `contextStrategy`   | `'sliding-window'`             | Context window management strategy                          |
| `isPrimaryExecutor` | `false`                        | True for top-level executor that owns conversation progress |

### 7.2 Execution Loop

```
AgentExecutor.run(messages)
  │
  ╔══════════════════════════════════════════════════════╗
  ║ PHASE 1: INITIAL LLM STREAM                          ║
  ╚══════════════════════════════════════════════════════╝
  │
  ├─ Broadcast: chat:stream-start
  │
  ├─ consumeStream(createStream(messages))
  │   └─ Streams the LLM response (content + thinking + tool calls)
  │
  ├─ Collect: fullContent, fullThinking, toolCalls, usage
  │
  ├─ Broadcast: chat:stream-end (with usage, model, contextTokens)
  │
  ├─ If no tool calls → return result immediately
  │
  ╔══════════════════════════════════════════════════════╗
  ║ PHASE 2: TOOL-CALLING LOOP (max maxRounds iterations)║
  ╚══════════════════════════════════════════════════════╝
  │
  └─ for each round (while pendingToolCalls.length > 0):
       │
       ├─ [OPTIONAL] HITL Gate
       │   └─ If hitl enabled: pause for human approval of visible tool calls
       │
       ├─ Save assistant message (thinking + tool calls) to DB
       │
       ├─ Emit: step:status ('executing')
       │
       ├─ Execute tool calls in parallel
       │   ├─ Built-in tools: memory, notifications, planning
       │   ├─ MCP tools (via tool registry)
       │   ├─ Sub-agent delegation (spawns inner AgentExecutor)
       │   └─ Attachment tools (search indexed files)
       │
       ├─ Emit: step:executed (tool results + images)
       │
       ├─ Save tool-result messages to DB
       │
       ├─ Append tool results to message context
       │   └─ Multimodal content: text + image_data_urls for LLM vision
       │
       ├─ maybeTrimContext(currentMessages)
       │   └─ Applies sliding-window or compact strategy
       │
       ├─ Stream next LLM round with tool results
       │
       ├─ Collect: new content, thinking, toolCalls, usage
       │
       └─ [loop if new tool calls returned]
  │
  ╔══════════════════════════════════════════════════════╗
  ║ COMPLETION                                            ║
  ╚══════════════════════════════════════════════════════╝
  │
  ├─ Broadcast: chat:stream-end (final usage + contextTokens)
  ├─ Emit: task:completed
  └─ Return: AgentExecutorResult { content, thinking, usage,
       contextTokens, toolRounds, images, provider, model }
```

### 7.3 Context Window Management

**File:** `core/agent/context-trimmer.ts` & `core/agent/context-compactor.ts`

Two strategies:

| Strategy         | Behavior                                                                               |
| ---------------- | -------------------------------------------------------------------------------------- |
| `sliding-window` | Drops oldest messages when approaching context limit                                   |
| `compact`        | Uses an LLM call to summarize/compress older messages while preserving key information |

### 7.4 Stream Events

Throughout execution, real-time events are broadcast to UI clients:

| Event               | Payload                                                          | When                          |
| ------------------- | ---------------------------------------------------------------- | ----------------------------- |
| `chat:stream-start` | `{ streamId, conversationId, agentId, agentName, agentIconUrl }` | Before first LLM call         |
| `chat:stream-chunk` | Delta content/thinking                                           | During LLM streaming          |
| `chat:stream-end`   | `{ usage, model, contextTokens, images, contextWindow }`         | End of each stream round      |
| `chat:stream-error` | `{ error }`                                                      | On execution error            |
| `step:status`       | `{ taskId, conversationId, iteration, status, message }`         | Routing, executing steps      |
| `step:tools-chosen` | Tool call names + arguments                                      | When tools are selected       |
| `step:executed`     | Tool results (output, images, success)                           | After tool execution          |
| `task:started`      | `{ taskId, conversationId }`                                     | When tool-calling loop begins |
| `task:completed`    | `{ taskId, conversationId }`                                     | When tool-calling loop ends   |
| `task:error`        | `{ conversationId, error }`                                      | On execution error            |
| `chat:post-action`  | `{ conversationId, action, status }`                             | During post-execution actions |

---

## 8. Planning Layer

### 8.1 Planning State

**File:** `core/agent/planning-state.ts`

When the model supports tool calls AND has visible execution tools, planning is automatically enabled. The planning layer provides a visible todo list for multi-step work.

```typescript
interface PlanningState {
  runId: string;
  conversationId: string;
  status: "running" | "completed" | "cancelled" | "error";
  objective: string;
  items: PlanningTaskItem[]; // { id, title, status, note, updatedAt }
  currentTaskId?: string;
  result?: { summary?; error? };
}
```

**Planning tools injected into the agent:**

- `todo_write` — Create/replace visible todo list
- `todo_update` — Update one todo item by id or exact title

**Persistence:** Planning state survives conversation switches and page reloads via the `tasks` database table.

**Resume logic:** If an existing planning run exists with items and status `running`, the system resumes it rather than creating a new one. The previous run's task context is prepended to the new run.

### 8.2 Auto-Router & Task Context Integration

The task context system (`task-context.ts`) calls a router LLM to produce focused queries for each auto mode. The auto-router results feed into:

- Tool routing (specific action terms for tool selection)
- Memory routing (knowledge/entity terms for memory retrieval)

---

## 9. Sub-Agent System

### 9.1 Sub-Agent Tools

**File:** `core/agent/sub-agent-tools.ts`

Sub-agents are spawned via a `spawn_subagent` tool injected into the orchestrator's tool list. Each sub-agent has its own:

- **Tools** — Independent tool set from the sub-agent's config
- **Provider/Model** — Can use a different LLM than the orchestrator
- **System prompt** — Base prompt + suffix (`"You are a sub-agent..."`)
- **Memory scope** — Assigned or default memory spaces
- **Max rounds** — 30 (lower than main agent's 50)
- **Timeout** — 5 minutes per delegation

**Key behavior:**

- Sub-agents have **no conversation history** — everything must be passed in the `context` parameter
- Sub-agent execution creates `chat:subagent-stream-*` events (separate from the primary stream)
- Sub-agents do NOT emit EventBus timeline events by default (avoid pollution of parent timeline)
- Adding `includeSubAgents: false` prevents infinite delegation recursion

### 9.2 Sub-Agent Configuration

From `AgentConfig`:

```typescript
subAgents: [{ agentId: string }];
```

The agent store resolves `agentId` to full `AgentData`, and the internal name is used as the routing key for `spawn_subagent`.

---

## 10. Post-Execution

### 10.1 Post-Action Registry

**File:** `core/agent/post-execution.ts`

After the main execution completes, lightweight follow-up actions run asynchronously:

```typescript
Active actions tracked per conversation:
  ├─ 'title_generation' (default)
  └─ [extensible for future post-actions]

Managed via:
  ├─ startAction() / completeAction() — Track + broadcast progress
  ├─ cancelPostActions() — Abort all post-actions for a conversation
  ├─ getActiveActions() / getAllActiveActions() — Query current state
  └─ AbortController shared across all post-actions per conversation
```

**WebSocket events:** `chat:post-action` with `{ conversationId, action, status: 'started' | 'completed' }`

### 10.2 Title Generation

On the first exchange (when conversation title is `"New Chat"`), title generation fires:

1. Calls the LLM with the user message and assistant response
2. Generates a concise title (max 70 chars, 2–8 words)
3. Updates `conversations.title` in the database
4. Broadcasts `chat:title-updated` event

**Override:** If `generateTitle: false` is passed in the request, `buildFallbackTitle()` extracts a simple fallback title from the first few words of the user message.

**Provider/model:** Can be overridden via `titleProviderId` and `titleModel` in the request.

---

## 11. Artifacts System

### 11.1 Image Artifacts

**File:** `core/artifacts/image-artifacts.ts`

- User-uploaded data-URL images are saved to `{dataDir}/artifacts/{conversationId}/{id}.{ext}`
- Returned as HTTP URLs: `/api/files?path=...`
- Cleaned up when conversation is deleted

### 11.2 File Artifacts

**File:** `core/artifacts/file-artifacts.ts`

- User-uploaded files are saved to disk and indexed in the database
- Small files are inlined directly into the message context
- Large files are chunked and made searchable via attachment RAG

### 11.3 Attachment RAG

**File:** `core/artifacts/attachment-rag.ts`

- Large attachments are indexed separately from main memory
- `attachment_search` tool for semantic retrieval
- `attachment_retrieve_chunks` tool for fetching specific chunks
- Chunks are marked with `attachmentId` for isolation

---

## 12. Channels Integration

**File:** `core/channels/channel-manager.ts`

The Channel Manager runs Discord, Slack, and Telegram providers in the same process:

1. Incoming messages from external platforms create conversations
2. Messages are forwarded through the same `planExecution()` → `AgentExecutor.run()` pipeline
3. Results are sent back to the platform
4. Notifications are queued (serialized to avoid rate limits)
5. Channel commands are refreshed when agents change

---

## 13. Triggers & Cron

**File:** `core/triggers/trigger-runner.ts`

Cron jobs use `runTriggerExecution()` which:

1. Creates a conversation (no HTTP request needed)
2. Calls `planExecution()` with the trigger's agent config
3. Runs `AgentExecutor.run()` with the trigger message
4. Persists results and returns them

---

## 14. Data Flow Diagram (Complete)

```
┌─────────────────────────────────────────────────────────────────────┐
│  HTTP POST /api/chat/conversations/:id/send                         │
│  OR Trigger.runTriggerExecution()  OR ChannelManager.handleMessage() │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────────────┐
│  ROUTE HANDLER (routes/chat.ts)                                    │
│                                                                     │
│  ├─ materializeImageArtifacts()    ── data URLs → disk files       │
│  ├─ materializeFileAttachments()   ── file contents → disk + DB    │
│  ├─ indexConversationAttachment()  ── large files → RAG chunks     │
│  ├─ buildConversationHistory()     ── DB rows → ChatMessage[]      │
│  ├─ resolveChatRunFlags()          ── agent config → run flags     │
│  └─ planExecution()                ── next phase                   │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────────────┐
│  EXECUTION PLANNER (execution-planner.ts)                          │
│                                                                     │
│  ├─ Build ExecutionPlanInput from request                          │
│  ├─ Determine tool keys (manual, auto, or all)                     │
│  ├─ Build execution preset from agent or agentless config          │
│  └─ prepareAgentExecution()                                        │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────────────┐
│  PREPARE AGENT EXECUTION (prepare-execution.ts)                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  ALL RESOLVED IN PARALLEL (or coordinated sequence):        │   │
│  │                                                              │   │
│  │  ┌─────────────────────┐   ┌─────────────────────┐          │   │
│  │  │  Provider/Model     │   │  Task Context       │          │   │
│  │  │  Resolution         │   │  Builder            │          │   │
│  │  │  (execution-        │   │  (task-context.ts)  │          │   │
│  │  │   resolvers.ts)     │   │  ┌───────────────┐  │          │   │
│  │  └─────────────────────┘   │  │ Router LLM    │  │          │   │
│  │                            │  │ → toolQuery   │  │          │   │
│  │  ┌─────────────────────┐   │  │ → skillQuery  │  │          │   │
│  │  │  Tool Resolution    │   │  │ → memoryQuery │  │          │   │
│  │  │  (execution-        │   │  │ → systemCtx   │  │          │   │
│  │  │   tools.ts)         │   │  │ → focusAreas  │  │          │   │
│  │  │  ├─ Registry lookup │   │  └───────────────┘  │          │   │
│  │  │  ├─ Auto routing    │   └─────────────────────┘          │   │
│  │  │  │  (embed→LLM)    │                                     │   │
│  │  │  ├─ Memory tools    │   ┌─────────────────────┐          │   │
│  │  │  └─ Sub-agent tools│                                     │   │
│  │  └─────────────────────┘                                     │   │
│  │  ┌─────────────────────┐                                     │   │
│  │  │  Memory Retrieval   │                                     │   │
│  │  │  (execution-        │                                     │   │
│  │  │   memory.ts)        │                                     │   │
│  │  │  ├─ MemoryAggregator│                                     │   │
│  │  │  │  → LanceDB RAG   │   ┌─────────────────────┐          │   │
│  │  │  │  → Entity Graph  │   │  Prompt Assembly    │          │   │
│  │  │  └─ Format context  │   │  (execution-        │          │   │
│  │  └─────────────────────┘   │   prompts.ts)       │          │   │
│  │                            │  ├─ System prompt   │          │   │
│  │                            │  ├─ Sub-agent info  │          │   │
│  │                            │  ├─ Task context    │          │   │
│  │                            │  └─ Memory context  │          │   │
│  │                            └─────────────────────┘          │   │
│  └─────────────────────────────────────────────────────────────┘   │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────────────┐
│  EXECUTION PLANNER (continued)                                     │
│                                                                     │
│  ├─ Check: modelSupportsToolCalls()                                │
│  ├─ Apply planning if tool-capable:                                │
│  │   ├─ resumeOrCreatePlanningRun()                                │
│  │   ├─ Inject planning tools (todo_write, todo_update)            │
│  │   └─ Append PLANNING_SYSTEM_PROMPT                              │
│  └─ Return PlannedExecution                                        │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────────────┐
│  ROUTE HANDLER (continued)                                         │
│                                                                     │
│  ├─ Inject attachment tools (if model supports tool calls)         │
│  ├─ Append attachment system context (hidden)                      │
│  ├─ Append image artifacts system hint                             │
│  ├─ Persist chat config to DB                                      │
│  ├─ Fetch model context window size                                │
│  ├─ Apply context strategy:                                        │
│  │   ├─ 'compact' → applyCompactStrategy() (LLM summarization)    │
│  │   └─ 'sliding-window' → trimMessagesToContextLimit()           │
│  └─ Create AgentExecutor                                           │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────────────┐
│  AGENT EXECUTOR (agent-executor.ts)                                │
│                                                                     │
│  PHASE 1: Initial LLM Stream                                       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  createStream(messages)  →  consumeStream()                 │   │
│  │  Result: content + thinking + toolCalls + usage             │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  PHASE 2: Tool-Calling Loop (up to 50 iterations)                  │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  for each round:                                            │   │
│  │   ├─ [HITL] Await human approval (if enabled)                │   │
│  │   ├─ Save assistant message to DB                            │   │
│  │   ├─ executeToolCalls(pendingToolCalls)  ── in parallel     │   │
│  │   │   ├─ Built-in tools (memory, notifications, etc.)       │   │
│  │   │   ├─ MCP tools (via registry)                           │   │
│  │   │   ├─ Sub-agent delegation (new AgentExecutor)            │   │
│  │   │   └─ Attachment tools                                   │   │
│  │   ├─ Save tool results to DB                                 │   │
│  │   ├─ Append results to context                               │   │
│  │   ├─ maybeTrimContext()  ── sliding-window or compact       │   │
│  │   └─ streamLLMRound()  ── next LLM call with tool results   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  COMPLETION                                                        │
│  └─ Return AgentExecutorResult { content, thinking, usage, ... }   │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────────────────┐
│  ROUTE HANDLER (post-execution)                                    │
│                                                                     │
│  ├─ persistAutoRoutedUsedTools()  (if auto tool routing)          │
│  ├─ closePlanningRun()  (if planning active)                      │
│  ├─ Save final assistant message to DB with metadata:             │
│  │   ├─ content, thinking, image_urls_json, agent_id              │
│  │   ├─ provider, model, prompt_tokens, completion_tokens         │
│  │   ├─ context_tokens, latency_ms                                │
│  │   └─ created_at                                                │
│  ├─ Auto-generate title (fire-and-forget):                        │
│  │   ├─ If "New Chat" → generateTitle()                          │
│  │   │   └─ post-execution.ts → LLM call → DB update → broadcast │
│  │   └─ If disabled → buildFallbackTitle() (first words)         │
│  ├─ unregisterActiveChatExecution()                               │
│  └─ Return { streamId }                                           │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 15. Key Design Patterns

| Pattern                         | Location                          | Purpose                                                                |
| ------------------------------- | --------------------------------- | ---------------------------------------------------------------------- |
| **Unidirectional Dependencies** | All modules                       | Routes import core modules; core modules don't import routes           |
| **Broadcast Function**          | All streaming                     | Real-time WebSocket events to all connected UI clients                 |
| **Conversation Locks**          | `chat/conversation-locks.ts`      | Prevents concurrent execution on the same conversation                 |
| **Composite Tool Keys**         | `tools/tool-registry.ts`          | `namespaceId::toolName` enables same-name tools from different sources |
| **Pre-Execution Separation**    | `agent/pre-execution/`            | Tools, memory, and prompts resolved independently                      |
| **Planning Run ID**             | `agent/planning-state.ts`         | Persistent task tracking across tool-calling rounds and page reloads   |
| **Sub-agent Isolation**         | `agent/sub-agent-tools.ts`        | Each sub-agent has own tools, model, memory scope, and execution loop  |
| **Context Window Management**   | `agent/context-trimmer.ts`        | Sliding-window dropping or LLM-based compaction                        |
| **Router Embedding Cache**      | `agent/router-embedding-cache.ts` | Cached embeddings for MCP tool groups to avoid re-embedding            |
| **HITL Gate**                   | `agent/hitl-gate.ts`              | Human-in-the-loop approval for tool calls                              |
| **Post-Action Registry**        | `agent/post-execution.ts`         | Track/cancel async follow-up LLM calls (title gen, etc.)               |

---

## 16. Relevant Source Files

| File                                              | Purpose                                         |
| ------------------------------------------------- | ----------------------------------------------- |
| `routes/chat.ts`                                  | HTTP route handler for chat messages            |
| `core/chat/message-history.ts`                    | Builds conversation history from DB             |
| `core/chat/run-config.ts`                         | Normalizes run flags and config                 |
| `core/chat/conversation-locks.ts`                 | Prevents concurrent execution                   |
| `core/chat/attachment-settings.ts`                | Attachment text limits                          |
| `core/agent/pre-execution/execution-planner.ts`   | Central pre-execution planning                  |
| `core/agent/pre-execution/execution-tools.ts`     | Tool resolution and auto-routing                |
| `core/agent/pre-execution/auto-tool-routing.ts`   | Auto-routing for tools                          |
| `core/agent/tool-router.ts`                       | Embedding-based tool pre-filter + LLM selection |
| `core/agent/pre-execution/execution-memory.ts`    | Memory resolution                               |
| `core/agent/pre-execution/auto-memory-routing.ts` | Auto-routing for memory                         |
| `core/agent/pre-execution/execution-prompts.ts`   | System prompt assembly                          |
| `core/agent/pre-execution/execution-resolvers.ts` | Provider/model resolution                       |
| `core/agent/pre-execution/task-context.ts`        | Unified task context builder                    |
| `core/agent/prepare-execution.ts`                 | Thin assembler for all pre-execution layers     |
| `core/agent/agent-executor.ts`                    | Core tool-calling execution loop                |
| `core/agent/sub-agent-tools.ts`                   | Sub-agent delegation                            |
| `core/agent/planning-state.ts`                    | Planning todo management                        |
| `core/agent/post-execution.ts`                    | Post-execution actions (title gen)              |
| `core/agent/hitl-gate.ts`                         | Human-in-the-loop approval                      |
| `core/agent/context-trimmer.ts`                   | Sliding-window context trimming                 |
| `core/agent/context-compactor.ts`                 | LLM-based context compaction                    |
| `core/gateway/gateway.ts`                         | LLM provider gateway                            |
| `core/memory/memory-aggregator.ts`                | Aggregated memory retrieval                     |
| `core/memory/memory-entity-indexer.ts`            | Entity graph indexing pipeline                  |
| `core/tools/tool-registry.ts`                     | Tool registration and resolution                |
| `core/tools/builtin/planning-tools.ts`            | Planning todo built-in tools                    |
| `core/artifacts/image-artifacts.ts`               | Image artifact materialization                  |
| `core/artifacts/file-artifacts.ts`                | File artifact materialization                   |
| `core/artifacts/attachment-rag.ts`                | Attachment search and retrieval                 |
| `core/triggers/trigger-runner.ts`                 | Cron/trigger execution                          |
| `core/channels/channel-manager.ts`                | Discord/Slack/Telegram integration              |
