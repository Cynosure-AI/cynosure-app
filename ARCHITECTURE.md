# Agent and chat execution flows

**Verified against the code on Sept 26, 2026.**

## Agent-backed chats and configuration snapshots

An agent is a reusable starting preset. Creating a conversation records its `agent_id` and initializes `execution_config_json` from the agent definition (model/provider, tools, subagents, prompt, reasoning and routing flags, and assigned memory folders). Free Chat uses the same conversation machinery with no agent ID and a default free-chat configuration.

The web UI loads the conversation's agent, then restores its conversation-specific execution config. On each send it passes the current UI choices in the run request. The server resolves the conversation's agent and builds an `ExecutionPreset` snapshot for that execution: configured tool keys and subagent assignments are copied, while per-chat choices such as model/provider, system prompt, auto-tool routing, and auto-memory are applied as overrides. The run therefore uses the submitted configuration even if the reusable agent definition is edited later; edits to the agent definition do not rewrite an existing conversation's saved config.

After planning/resolving the model, the server persists the effective conversation config, including resolved provider/model, so reopening the conversation restores its settings. Tools actually used by routing may also be persisted as sticky allowed tools for follow-up turns. The user can keep overrides scoped to the chat, reset them to the agent baseline, or explicitly apply them to the reusable agent. Free Chat has its own captured preset for UI choices.

```mermaid
flowchart TD
  A[Agent definition or Free Chat defaults] --> B[Create conversation with agent_id and initial config]
  B --> C[Restore conversation config in UI]
  C --> D[Send current UI choices with each turn]
  D --> E[Resolve agent and snapshot execution preset]
  E --> F[Plan and run turn]
  F --> G[Persist resolved conversation config]
```

## Auto memory router

Memory routing runs during pre-execution when auto memory is enabled and there is a text query. An explicit empty memory-folder selection suppresses retrieval; otherwise the selected/assigned folder scope and the agent identity constrain memory search. Free Chat has no agent-specific memory identity.

The router combines the current request with a short recent-conversation context and any planned query expansions. It retrieves memory chunks by hybrid search (dense embeddings plus BM25, fused by reciprocal rank), fuses the results of all queries, filters weak or duplicate matches, then selects context. Queries to instruction-tuned embedding models (Qwen3-Embedding, GTE-Qwen, BGE v1.5) carry the model's retrieval instruction; documents are embedded without one. LLM curation sees up to 20 candidates, each with its document title, section and last change, so a chunk from the middle of a note is still attributed to the note's subject. These knobs live in `retrieval-options.ts`, with each default backed by a `memory:eval` run. Depending on configuration, selection uses the memory reranker or a small LLM curation call. The curation step can reject weakly related evidence and request one bounded corrective retrieval. If curation is unavailable, ranked results are used as fallback. Selected evidence is inserted into the main model context as marked, untrusted retrieved context, with provenance attached for the UI. If the router fails, the turn continues without injected memory.

```mermaid
flowchart TD
  A[Current user request] --> B[Check auto-memory flag, query, and folder scope]
  B --> C[Build retrieval queries from request, recent turns, and expansions]
  C --> D[Hybrid search of scoped memory chunks; rerank results when enabled]
  D --> E[Fuse candidates and filter weak or duplicate matches]
  E --> F{Memory reranker enabled?}
  F -->|Yes| G[Use top-ranked memory candidates]
  F -->|No| H[LLM curates chunks]
  H --> I{Evidence sufficient or correction available?}
  I -->|No, one bounded retry| J[Run corrective retrieval]
  J --> D
  I -->|Yes| K[Format selected memory as untrusted context]
  G --> K
  K --> L[Attach provenance and add to main model context]
  E -->|No candidates| M[Continue without memory context]
  H -->|Curation failure| N[Use ranked fallback]
  N --> K
```

## Auto tool router

When enabled, and the turn has a text query and configured tools, routing first asks a small LLM selector which tool namespaces/toolsets are needed (up to the router's namespace limit). It then filters to those namespaces and routes individual tools using embeddings and relevance ranking; lexical matching is the fallback if embedding/routing fails. Small selected namespaces may be included whole within size limits. Explicitly preferred tools, tools already used, and tools referenced by recent tool calls are preserved. A runtime tool-search/expansion tool remains available to discover additional MCP capabilities.

The resulting tool list is passed to the main assistant execution. Routing chooses which tools are exposed for the turn; tool approval policy still applies when the assistant calls them. With routing disabled, the configured/static tool policy is used instead.

```mermaid
flowchart TD
  A[Current user request and configured tool catalog] --> B{Auto routing enabled and query/tools present?}
  B -->|No| C[Use configured or static tool policy]
  B -->|Yes| D[LLM selects relevant namespaces/toolsets]
  D --> E[Keep tools from selected namespaces]
  E --> F[Preserve preferred, previously used, and recent-call tools]
  F --> G[Embedding prefilter for MCP groups]
  G --> H[Rank candidate tools by request relevance]
  H --> I{Embedding/routing available?}
  I -->|No| J[Lexical fallback]
  I -->|Yes| K[Include ranked tools and small selected toolsets]
  J --> L[Add runtime tool search/expansion]
  K --> L
  C --> M[Expose resulting tools to main assistant]
  L --> M
  M --> N[Approval policy applies when a tool is called]
```

## Subagent sessions and continuation

Subagents are delegated tool runs, not separate user-facing conversations. The orchestrator can spawn only agents assigned to it. `spawn_subagent` creates a unique invocation ID and a private transcript containing the supplied task/context (and optionally a referenced attachment); it does not automatically copy the parent transcript. The subagent runs with its own model, prompt, tools, memory settings, and bounded execution/round limits.

**A subagent can be continued.** The orchestrator calls `continue_subagent` with the returned invocation ID and a follow-up. The server loads the saved private transcript for that invocation and conversation, appends the new follow-up, and runs the same subagent again. Successful runs update that transcript, so the next continuation sees the earlier delegated exchanges. Continuation is scoped to the parent conversation and succeeds only while the original agent remains assigned and available. It does not resume an interrupted in-memory executor; it starts another executor from the durable transcript. The parent can pass new context explicitly.

## Image, video, and audio in chat

These capabilities use the same conversation, message history, and chat send endpoint; they are not separate conversation types. A user can attach supported image/audio inputs to ordinary turns, and generated media is saved as conversation artifacts and rendered in the chat transcript. Provider/model capabilities decide which execution path handles a turn.

- **Image input:** attached images are included in the current user message for models that accept image input.
- **Image output:** when the selected model is identified as a dedicated image-generation model, the send handler calls the image-generation API path and saves returned images as artifacts. A follow-up after a generated image can include that image as an edit reference.
- **Video output:** a model advertising video output uses the video-generation API path. Optional attached images can be supplied as frame/reference images; returned video is saved as an artifact.
- **Audio input/transcription:** attached audio is sent as audio content to a model that accepts audio input. Selecting a transcription-output model instead invokes the dedicated transcription path and requires an audio attachment. Voice recording in the browser also has a local Whisper speech-to-text path that transcribes into the composer.

Thus image/video generation and dedicated transcription are specialized branches inside the normal chat send flow. Ordinary multimodal input remains part of the main model turn. The exact path depends on the selected model's advertised modalities and provider support; a model that does not support an attachment modality is surfaced as unsupported by the UI/provider path.

## What a memory document contains

The saved Markdown file is the source of truth. A memory folder (the UI's category/scope) organizes the document and limits which agents or chats can retrieve it. Indexing splits the document into chunks and keeps, per chunk, the original text, its source position, and a search text that prefixes the chunk with its document title and section path. That search text is embedded and BM25-indexed, so every chunk carries its document context; retrieval returns the original chunk as evidence. Embeddings and the lexical index are rebuildable; the Markdown and its revision history remain authoritative.

```mermaid
flowchart TD
  A[Memory folder / category] --> B[Authoritative Markdown document]
  B --> C[Document identity, revision, and content hash]
  B --> D[Split into indexed text chunks]
  D --> E[Chunk text with source position]
  D --> F[Search text: document title + section path + chunk]
  F --> G[Dense embedding]
  F --> H[BM25 lexical index]
```

A knowledge graph with LLM-extracted entities, facts and per-chunk summaries existed until schema v18. `memory:eval` showed no measurable gain from it over hybrid retrieval with reranking or LLM curation, so it was removed; v18 drops its tables, and a one-time startup cleanup restores plain chunk search text in older indexes.

## Evaluating memory

`pnpm --filter cynosure-server memory:eval` measures the auto-memory pipeline on a frozen dataset kept in `<data dir>/evals/memory/` (it contains personal memory text, so it stays out of the repository). Cases are synthetic questions generated from real chunks (direct, paraphrased, other-language, two-chunk, and verified no-answer questions) plus labelled real turns. Gold evidence is stored as a verbatim quote and file, so cases stay valid after re-chunking.

`run` copies the data dir into a temporary snapshot per condition and runs the real `applyAutoMemoryRoutingWithEvidence` there, with folder watchers disabled. Conditions select reranker or LLM-curation selection, optionally run the task-context planner as production does (its output is cached per case), and override retrieval options. Snapshots of older installs get the same one-time analysis cleanup the server runs on startup. Reranker conditions are billed per rerank request, so the report counts and prices them separately. Each run records retrieval metrics from the curator's candidate pool, an LLM judge's verdict on whether the injected context supports the reference answer, the no-answer injection rate, fallbacks, latency, and model cost. The report includes paired sign tests against the first condition and a diff against the previous run; differences of a few cases are within curator/judge noise.

`--dataset fixture` runs the same pipeline against a committed fictional corpus (`apps/server/tests/memory-eval/`). The corpus is indexed into a cached install under the eval directory with the local embedding model. It covers relation chains, aggregation, superseded values and near-identical names, so it can be shared and runs without anyone's personal memory.

## Messaging channels

Telegram, Discord, and Slack share one agent-turn pipeline; the platform folders only translate between the platform SDK and it. A channel class implements `ChannelProvider` (`base.channel.ts`) and holds a `ChannelSessionState` keyed by the platform's conversation address, the "target": a Discord or Slack channel id, or a Telegram chat id. Per target it tracks the agent override, the last used agent, the turn lock, buffered media, and the reverse map from conversation to target.

For each inbound message the platform builds a `ChannelTransport`, which says how to reply, send, edit, send long text, send images, and show typing, with the platform's message length limits. It passes the transport to `receiveChannelMessage` (`channel-turn.ts`). That function runs commands immediately, holds media sent without text until the next text message, and otherwise runs one turn per target at a time. A turn creates or reuses the target's conversation, plans and executes the agent, and streams previews by editing messages. Tool status lines and HITL prompts go out in order through the turn's send queue. The final reply is split across messages when needed, the turn is persisted, and a title is generated for new conversations. Chat commands (`kill`, `stop`, `new`, `start`, switching agent by name) live in `channel-commands.ts`; platforms only supply bold syntax and the switch-back hint. HITL routing and resolution are shared too (`subscribeChannelHITL`, `resolveChannelHITL`), while the approval buttons themselves are platform-specific.

Adding a channel means adding its folder with a `ChannelProvider` class, a transport, a command style, and HITL buttons, then registering the class in `channel-manager.ts` and extending `ChannelType`.

## Code landmarks

- Conversation initialization and saved config: `apps/server/src/routes/conversations.ts`, `apps/server/src/core/chat/run-config.ts`
- UI overrides/restoration and send payload: `apps/web/src/composables/useChatAgentConfig.ts`, `apps/web/src/composables/useChatMessages.ts`
- Per-turn snapshot/planning: `apps/server/src/core/agent/execution-preset.ts`, `apps/server/src/core/agent/pre-execution/execution-planner.ts`
- Memory/tool routing: `apps/server/src/core/agent/pre-execution/auto-memory-routing.ts`, `apps/server/src/core/agent/pre-execution/auto-tool-routing.ts`, `apps/server/src/core/agent/tool-router.ts`
- Memory documents and retrieval: `apps/server/src/core/memory/parser.ts`, `apps/server/src/core/memory/rag.ts`, `apps/server/src/core/memory/memory-aggregator.ts`, `apps/server/src/db/schema.ts`
- Memory evaluation: `apps/server/src/scripts/memory-eval/cli.ts`, `apps/server/src/scripts/memory-eval/worker.ts`, `apps/server/src/core/memory/retrieval-evaluation.ts`
- Subagent spawn/continue: `apps/server/src/core/agent/sub-agent-tools.ts`
- Media dispatch and execution: `apps/server/src/routes/chat.ts`, `apps/server/src/core/chat/media-execution.ts`, `apps/web/src/composables/useWhisper.ts`
- Messaging channels: `apps/server/src/core/channels/channel-turn.ts`, `apps/server/src/core/channels/channel-session.ts`, `apps/server/src/core/channels/channel-commands.ts`, `apps/server/src/core/channels/channel-manager.ts`
