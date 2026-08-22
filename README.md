# Cynosure

Open-source AI agent platform with tool use, memory, multi-provider LLM support, and messaging channel integrations. Run it in the browser or as a self-contained desktop app.

## Features

- **Multi-provider LLM support** — OpenAI, Anthropic, Google Gemini, Groq, Grok, Ollama, LM Studio, OpenRouter, Requesty, Mistral
- **Streaming chat** — Real-time token streaming with image/file attachments and voice input (local Whisper STT)
- **Tool system** — Built-in tools + [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) servers, discoverable via a built-in registry browser
- **Agents** — Reusable AI presets with custom system prompts, model selection, tool access, and sub-agent orchestration
- **Memory spaces** — RAG-powered knowledge retrieval with configurable embedding models, chunking, and OCR
- **Messaging channels** — Telegram, Discord, and Slack integrations so agents can respond remotely
- **Triggers** — Cron jobs for automated, unattended agent execution
- **Human-in-the-loop** — Granular approval gates for tool execution (per-tool, per-session, or always)
- **Desktop app** — Electron wrapper that bundles the server and UI into a single self-contained package (AppImage, deb, exe)
- **Backup & restore** — Export/import your entire configuration (agents, providers, memory, channels, etc.)

## Monorepo Structure

```
apps/
  server/    — Fastify API server: agent execution, tools, memory, channels
  web/       — Vue 3 SPA: chat UI, agent management, settings
  electron/  — Electron wrapper: bundles server + web as a desktop app
mcps/        — Built-in MCP tool servers (media converter, diagrams, weather, etc.)
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

- **Server API** → http://localhost:3099
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
pnpm build          # Build web + server; the server serves the built UI at /
pnpm --filter cynosure-server start

# Standalone server after build
# Web UI/API/docs are available from the same origin:
# http://localhost:3099, http://localhost:3099/api, http://localhost:3099/docs

# Electron desktop app
pnpm package:linux
pnpm package:win
pnpm package:mac
```

> **Electron packaging** runs a prepare script (`scripts/prepare-server-deps.mjs`) that
> resolves a flat copy of the server's native dependencies and rebuilds them against
> Electron's Node ABI. This makes the desktop app fully self-contained — no system
> Node.js installation is required.

> **After packaging** the native modules in the workspace may be built against Electron's
> ABI. To switch back to development, run:
>
> ```bash
> cd apps/server && npm run rebuild:native
> ```
