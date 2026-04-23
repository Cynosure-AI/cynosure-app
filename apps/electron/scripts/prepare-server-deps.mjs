/**
 * Creates a flat (non-symlinked) node_modules for the server, suitable for
 * bundling inside an Electron app.
 *
 * pnpm workspaces use symlinks that point outside the package directory,
 * which breaks when electron-builder copies them into an AppImage / deb.
 * This script:
 *   1. Runs `npm install --production` in an isolated directory (flat deps)
 *   2. Runs `@electron/rebuild` to recompile native modules (better-sqlite3)
 *      against Electron's ABI so the app is fully self-contained — no system
 *      Node required on the end-user's machine.
 */

import { mkdirSync, copyFileSync, existsSync, rmSync, readFileSync } from 'fs'
import { execSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverDir = join(__dirname, '../../server')
const targetDir = join(__dirname, '../.server-deps')
const electronDir = join(__dirname, '..')

// Resolve the Electron version from the installed package
function getElectronVersion() {
    // Walk up through node_modules to find electron's package.json
    const candidates = [
        join(electronDir, 'node_modules/electron/package.json'),
        join(electronDir, '../../node_modules/electron/package.json'),
    ]
    // Also check pnpm .pnpm directory
    const rootNM = join(electronDir, '../../node_modules/.pnpm')
    if (existsSync(rootNM)) {
        try {
            const entries = execSync(`ls -d ${rootNM}/electron@*/node_modules/electron/package.json 2>/dev/null`, {
                encoding: 'utf-8',
            }).trim().split('\n').filter(Boolean)
            candidates.push(...entries)
        } catch { /* ignore */ }
    }

    for (const p of candidates) {
        if (existsSync(p)) {
            const pkg = JSON.parse(readFileSync(p, 'utf-8'))
            if (pkg.version) return pkg.version
        }
    }
    throw new Error('Could not determine Electron version')
}

const electronVersion = getElectronVersion()
console.log(`[prepare-server-deps] Electron version: ${electronVersion}`)

// Clean previous build
if (existsSync(targetDir)) rmSync(targetDir, { recursive: true })
mkdirSync(targetDir, { recursive: true })

// Copy package.json so npm knows what to install
copyFileSync(join(serverDir, 'package.json'), join(targetDir, 'package.json'))

// Install production deps with npm — flat node_modules, no symlinks
console.log('[prepare-server-deps] Installing production dependencies (npm) …')
execSync('npm install --production', {
    cwd: targetDir,
    stdio: 'inherit',
})

// Rebuild native modules (better-sqlite3 etc.) for Electron's ABI
console.log('[prepare-server-deps] Rebuilding native modules for Electron …')
execSync(
    `npx @electron/rebuild --force --module-dir "${targetDir}" --version ${electronVersion}`,
    { cwd: electronDir, stdio: 'inherit' },
)

console.log('[prepare-server-deps] Done — flat node_modules ready at', targetDir)
