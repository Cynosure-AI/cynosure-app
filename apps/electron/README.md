# Cynosure Desktop

Electron wrapper that bundles the Cynosure server and web UI into a native desktop application.

## Architecture

```
electron/
  src/main/index.ts      ← Main process: spawns server, creates BrowserWindow
  src/preload/index.ts   ← Preload: exposes safe APIs to renderer
  electron.vite.config.ts
  electron-builder.yml   ← Packaging config (bundles server + web dist)
```

**How it works:**

1. The main process spawns the Fastify server as a child process, preferring port 3099
2. Data is stored in the shared Cynosure app data directory, matching the standalone server
3. In **development**: loads the Vite dev server (`http://localhost:5173`)
4. In **production**: serves built web files via a custom `app://` protocol, while API calls are proxied to the embedded server and WebSocket calls use the embedded server port from preload

## Prerequisites

- Node.js 20+
- `server/` and `web/` directories as siblings (the existing workspace layout)

## Development

During development, the Electron app loads the live Vite dev server — no rebuilding needed for server/web changes (HMR works normally).

```bash
# Terminal 1: Start server in dev mode
cd ../server && npm run dev

# Terminal 2: Start web dev server
cd ../web && npm run dev

# Terminal 3: Start Electron
cd ../electron && npm install && npm run dev
```

Electron will open a window pointing to `http://localhost:5173` with DevTools attached.
You do **not** need to rebuild server or web during development.

## Production Build

The `package` commands automatically rebuild server and web before packaging:

```bash
npm run package          # Build everything + package for current OS
npm run package:linux    # AppImage + .deb
npm run package:mac      # .dmg
npm run package:win      # NSIS installer
```

This runs `prebuild:deps` → builds electron main/preload → packages the app.

If you've already built server and web separately and just want to re-package:

```bash
npm run package:skip-deps
```

## Notes

- **Server port** prefers 3099 in the Electron wrapper and falls back to a free local port when needed. The renderer reads the selected port through preload for WebSocket connections.
- **Data directory** uses the same shared app data root as the standalone server (for example, `~/.config/cynosure/data` on Linux). Electron passes that root to the embedded server as `CYNOSURE_DATA_DIR`, and Electron UI prefs are stored in the same `data/` subdirectory so app state stays consistent across both runtimes. Set `CYNOSURE_DATA_DIR` to override the shared location.
- **MCP servers** are not bundled. They can be configured at runtime via the MCP settings page, pointing to MCPs installed on the user's system.
- **Auto-update** is not yet configured. Consider adding `electron-updater` and a GitHub Releases-based update feed.
