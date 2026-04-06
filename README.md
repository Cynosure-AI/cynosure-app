# OpenAgent

Open-source AI agent platform with tool use, memory, multi-provider LLM support, and messaging channel integrations.

## Monorepo Structure

```
apps/
  server/    — Fastify API server: agent execution, tools, memory, channels
  web/       — Vue 3 SPA: chat UI, agent management, settings
  electron/  — Electron wrapper: bundles server + web as a desktop app
```

## Prerequisites

- **Node.js** ≥ 20
- **pnpm** — enabled via `corepack enable pnpm`

## Getting Started

```bash
# Install all dependencies
pnpm install

# Start server + web in parallel (dev mode)
pnpm dev
```

- **Server** → http://localhost:3099
- **Web UI** → http://localhost:5173
- **API docs** (Swagger) → http://localhost:3099/docs

### Individual Apps

```bash
pnpm dev:server     # Server only
pnpm dev:web        # Web UI only
pnpm dev:electron   # Electron app (starts web + electron)
```

> **Electron dev note:** The Electron app spawns the server from its compiled output.
> Build the server first before running electron in dev mode:
>
> ```bash
> pnpm build:server
> pnpm dev:electron
> ```

## Building

```bash
pnpm build          # Build server + web

# Electron desktop app
pnpm package:linux
pnpm package:win
pnpm package:mac
```

## Features

- **Multi-provider LLM gateway** — OpenAI, Anthropic, Google Gemini, Groq, Grok, Ollama, LM Studio, OpenRouter
- **Tool system** — Built-in tools + MCP server support (Smithery, Glama, custom)
- **Agent memory** — RAG-based long-term memory with LanceDB embeddings
- **Messaging channels** — Telegram, Discord, Slack
- **Triggers** — Cron jobs, file watchers, channel messages
- **Human-in-the-loop** — Approval gates for tool execution
- **Desktop app** — Electron wrapper for local deployment
