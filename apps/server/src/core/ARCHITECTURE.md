# Core Architecture

The execution stack is organized around a single direction of dependency:

1. Routes translate HTTP/channel events into execution requests.
2. Chat services normalize chat-specific state such as locks, active runs, history, attachments, and persisted session config.
3. The execution planner chooses the effective agent/free-chat preset and applies orchestration.
4. Pre-execution layers resolve the runtime pieces independently:
   - `execution-tools.ts` resolves configured tools, auto-routed MCP tools, runtime memory tools, sub-agent tools, and built-in hydration.
   - `execution-memory.ts` resolves automatic memory context and memory runtime enablement.
   - `execution-prompts.ts` composes the final system prompt messages.
5. `AgentExecutor` owns the provider stream/tool loop and persistence of execution-round messages.

Routes should not import from other routes. Shared runtime state belongs under `core/chat` or another core domain module.

Agent, chat, and trigger configuration should be resolved before calling `planExecution`. The planner receives normalized run options and is the only layer that should translate those options into executor-ready messages/tools.
