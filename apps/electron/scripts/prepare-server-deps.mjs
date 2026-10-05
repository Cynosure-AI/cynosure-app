/**
 * Creates a flat (non-symlinked) node_modules for the server, suitable for
 * bundling inside an Electron app.
 *
 * pnpm workspaces use symlinks that point outside the package directory,
 * which breaks when electron-builder copies them into an AppImage / deb.
 * `pnpm deploy --prod` with a hoisted linker installs exactly the lockfile
 * versions, with the workspace overrides applied, as a flat node_modules.
 *
 * No native rebuild for Electron is needed: the server's native modules
 * (better-sqlite3, sharp, lancedb) all ship N-API prebuilds, which load in
 * both system Node and Electron's runtime (ELECTRON_RUN_AS_NODE).
 */

import { existsSync, rmSync } from 'fs'
import { execSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const electronDir = join(__dirname, '..')
const targetDir = join(electronDir, '.server-deps')

if (existsSync(targetDir)) rmSync(targetDir, { recursive: true })

console.log('[prepare-server-deps] Deploying production dependencies (pnpm deploy) …')
execSync(
    `pnpm --filter cynosure-server deploy --prod --config.node-linker=hoisted "${targetDir}"`,
    { cwd: electronDir, stdio: 'inherit' },
)

console.log('[prepare-server-deps] Done — flat node_modules ready at', targetDir)
