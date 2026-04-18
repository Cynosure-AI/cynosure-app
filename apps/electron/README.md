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

1. The main process spawns the Fastify server as a child process on port 3099
2. Data is stored in Electron's `userData` directory via `CYNOSURE_DATA_DIR`
3. In **development**: loads the Vite dev server (`http://localhost:5173`)
4. In **production**: serves built web files via a custom `app://` protocol, with API/WS calls routed to `http://localhost:3099` via `VITE_API_URL`

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

- **Server port** is fixed at 3099 in the Electron wrapper. Changing it requires updating `SERVER_PORT` in `src/main/index.ts` and rebuilding the web with the updated `VITE_API_URL`.
- **Data directory** uses `app.getPath('userData')/data` which maps to platform-specific locations (e.g., `~/.config/cynosure-desktop/data` on Linux). This is separate from the standalone server's default directory (`~/.config/cynosure-server`).
- **MCP servers** are not bundled. They can be configured at runtime via the MCP settings page, pointing to MCPs installed on the user's system.
- **Auto-update** is not yet configured. Consider adding `electron-updater` and a GitHub Releases-based update feed.
