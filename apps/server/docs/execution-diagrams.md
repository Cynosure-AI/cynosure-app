# OpenAgent Execution Diagrams

This document visualizes how agent execution, sub-agent delegation, tools, HITL, telemetry steps, and heartbeat runs work.

## 1) Agent Execution Lifecycle (Chat + Tools + HITL + Sub-Agents)

```mermaid
flowchart TD
    A[POST /api/chat/conversations/:id/send] --> B[Load conversation + history]
    B --> C[Build runtime context]
    C --> C1[Optional memory retrieval]
    C --> C2[Optional sub-agent prompt injection]
    C --> C3[Build tool list]
    C3 --> C31[Registry tools]
    C3 --> C32[Optional delegate_to_<codename> tools]
    C --> D[Create AgentExecutor streamMode single hitl true]

    D --> E[Phase 1: stream initial LLM response]
    E --> E1[Broadcast chat:stream-start/chunk/thinking/images]
    E --> F{Tool calls returned?}

    F -- No --> G[Broadcast chat:stream-end]
    G --> H[Persist final assistant message + usage + metadata]
    H --> I[Done]

    F -- Yes --> J[Emit task:started]
    J --> K[Loop each round up to maxRounds]

    K --> K1[Emit step:status choosing-tools]
    K1 --> K2[Emit step:tools-chosen]
    K2 --> L{HITL enabled?}

    L -- Yes --> M[Emit step:status awaiting-approval]
    M --> N{Approval granted?}
    N -- No --> N1[Emit step:hitl-denied]
    N1 --> N2[Append denied tool outputs to messages]
    N2 --> N3[Stream revised LLM round]
    N3 --> K

    N -- Yes --> O[Execute tool calls sequentially]
    L -- No --> O

    O --> O1[Tool resolver by name]
    O1 --> O2{Regular tool or delegate_to_<codename>?}
    O2 -- Regular --> O3[Execute tool, capture output/images]
    O2 -- Delegate --> P[Run sub-agent tool executor]

    P --> P1[Load assigned agent config]
    P1 --> P2[Build sub-agent AgentExecutor streamMode per-round]
    P2 --> P3[Run with sub-agent system+instructions]
    P3 --> P4[Return sub-agent final output as tool result]

    O3 --> Q[Emit step:executed]
    P4 --> Q

    Q --> R[Persist assistant tool-call msg + tool messages]
    R --> S[Append assistant+tool msgs into prompt state]
    S --> T[Stream next LLM round]
    T --> U{More tool calls?}
    U -- Yes --> K
    U -- No --> V[Emit task:completed]
    V --> W[Return final content/images/thinking]
```

## 2) Event + Timeline Persistence (Status, Tools, Results, Evaluation)

```mermaid
sequenceDiagram
    participant AE as AgentExecutor
    participant EB as EventBus
    participant IDX as setupExecutionStepPersistence
    participant DB as SQLite execution_steps
    participant WS as WebSocket broadcast
    participant UI as Timeline UI

    AE->>EB: step:status (iteration, status, message)
    EB->>WS: agent:execution-update
    WS->>UI: live execution update
    EB->>IDX: step:status
    IDX->>DB: INSERT execution_steps row

    AE->>EB: step:tools-chosen (toolCalls)
    EB->>IDX: step:tools-chosen
    IDX->>DB: UPDATE last row tool_calls_json

    AE->>EB: step:executed (results)
    EB->>IDX: step:executed
    IDX->>DB: UPDATE last row results_json

    Note over AE,DB: Some flows can emit step:evaluated / step:planned
    EB->>IDX: step:evaluated
    IDX->>DB: UPDATE last row evaluation_json

    UI->>DB: GET /api/chat/conversations/:id/steps
    DB-->>UI: persisted timeline survives reload
```

## 3) Heartbeat Scheduling + Run Lifecycle

```mermaid
flowchart TD
    A[Server startup] --> B[startHeartbeatScheduler broadcast]
    B --> C[listAgents]
    C --> D{Agent has heartbeatInterval > 0 and heartbeatPrompt?}
    D -- No --> C
    D -- Yes --> E[scheduleAgent agentId]

    E --> F[setInterval intervalMinutes]
    F --> G[Timer tick]
    G --> H[runHeartbeat agentId]

    H --> I[Validate agent + provider]
    I --> J[Create new heartbeat conversation origin=heartbeat]
    J --> K[Track activeHeartbeatRuns]
    K --> L[Build system prompt + heartbeat prompt + notification guidance]
    L --> M[Save/broadcast trigger user message]
    M --> N[Build tool list]
    N --> N1[create_notification tool]
    N --> N2[Agent configured registry tools]
    N --> O[Create AgentExecutor streamMode per-round hitl false]
    O --> P[executor.run messages]

    P --> Q{Tool call loop needed?}
    Q -- No --> R[Persist final assistant message]
    Q -- Yes --> S[Execute tools and continue rounds]
    S --> P

    R --> T[Update conversation updated_at]
    T --> U[Remove from activeHeartbeatRuns]

    P --> X{Error?}
    X -- Yes --> Y[Log + emit task:error]
    Y --> U
```

## 4) Sub-Agent Delegation Sequence (delegate*to*<codename>)

```mermaid
sequenceDiagram
    participant Main as Main AgentExecutor
    participant Tool as delegate_to_<codename>
    participant AF as Agent Files
    participant TR as Tool Registry
    participant Sub as Sub AgentExecutor
    participant LLM as Gateway Provider
    participant DB as SQLite messages
    participant WS as WebSocket

    Main->>Tool: execute instructions
    Tool->>AF: getAgent assignment.agentId
    Tool->>TR: resolve sub-agent tools
    Tool->>Sub: new AgentExecutor (per-round, emitEvents true, eventMeta maCodename)
    Sub->>WS: chat:stream-start/chunk/end per round
    Sub->>LLM: streamComplete with system+instructions
    loop tool rounds
      Sub->>TR: execute selected tool
      Sub->>DB: save assistant/tool interim messages
    end
    Sub-->>Tool: final content/images/thinking
    Tool->>DB: save sub-agent final assistant message
    Tool-->>Main: ToolResult output for parent context
    Main->>LLM: continue parent loop with tool result
```

## Notes

- Chat executions default to streamMode single so one stream id spans rounds with chat:stream-reset between rounds.
- Heartbeat and sub-agent executions use streamMode per-round to create a separate stream id per round.
- HITL approval is enabled in chat executor runs and disabled in heartbeat and sub-agent runs.
- Timeline persistence is event-driven through EventBus listeners that write execution_steps rows.
