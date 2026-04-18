/**
 * Creates a flat (non-symlinked) node_modules for the server, suitable for
 * bundling inside an Electron app.
 *
 * pnpm workspaces use symlinks that point outside the package directory,
 * which breaks when electron-builder copies them into an AppImage / deb.
 * This script runs `npm install --production` in an isolated directory
 * so every dependency is a real directory, not a symlink.
 */

import { mkdirSync, copyFileSync, existsSync, rmSync } from 'fs'
import { execSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverDir = join(__dirname, '../../server')
const targetDir = join(__dirname, '../.server-deps')

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

console.log('[prepare-server-deps] Done — flat node_modules ready at', targetDir)
