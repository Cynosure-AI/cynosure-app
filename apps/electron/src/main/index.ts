import { app, BrowserWindow, shell, protocol, net, ipcMain, Tray, Menu, nativeImage } from 'electron'
import { spawn, execSync, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import ElectronStore from 'electron-store'
import appIcon from '../../build/icon.png?asset'

// ── Configuration ──────────────────────────────────────────────────────────────

const PREFERRED_PORT = 3099

let serverPort = PREFERRED_PORT
let serverProcess: ChildProcess | null = null
let tray: Tray | null = null
let isQuitting = false

// ── Find a free port ───────────────────────────────────────────────────────────

function findFreePort(preferred: number): Promise<number> {
    return new Promise((resolve) => {
        const srv = createServer()
        srv.listen(preferred, '127.0.0.1', () => {
            const addr = srv.address()
            srv.close(() => resolve(typeof addr === 'object' && addr ? addr.port : preferred))
        })
        srv.on('error', () => {
            srv.listen(0, '127.0.0.1', () => {
                const addr = srv.address()
                srv.close(() => resolve(typeof addr === 'object' && addr ? addr.port : preferred))
            })
        })
    })
}

// Register app:// as a privileged scheme (must happen before app.whenReady)
protocol.registerSchemesAsPrivileged([
    {
        scheme: 'app',
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true
        }
    }
])

// ── Path resolution ────────────────────────────────────────────────────────────

function resolveServerEntry(): string {
    if (is.dev) return join(__dirname, '../../../server/dist/index.js')
    return join(process.resourcesPath, 'server/dist/index.js')
}

function resolveServerDir(): string {
    if (is.dev) return join(__dirname, '../../../server')
    return join(process.resourcesPath, 'server')
}

function resolveWebDist(): string {
    if (is.dev) return join(__dirname, '../../../web/dist')
    return join(process.resourcesPath, 'web/dist')
}

function getDataDir(): string {
    return join(app.getPath('userData'), 'data')
}

// ── Node binary resolution ─────────────────────────────────────────────────────
// Native modules in the bundled server are rebuilt for Electron's ABI at
// package time (via @electron/rebuild). This makes the app fully self-contained
// — no system Node is required on the end-user's machine.
// We use Electron's own binary with ELECTRON_RUN_AS_NODE=1.

function resolveNodeBinary(): { bin: string; useElectronAsNode: boolean } {
    if (is.dev) {
        // In dev, native modules are compiled against the system Node
        return { bin: 'node', useElectronAsNode: false }
    }

    // Production: use Electron's own binary as a Node runtime.
    // Native modules have been rebuilt for Electron's ABI during packaging.
    console.log('[electron] Using Electron binary with ELECTRON_RUN_AS_NODE')
    return { bin: process.execPath, useElectronAsNode: true }
}

// ── Resolve full PATH from login shell ─────────────────────────────────────────

function getShellPath(): string {
    if (process.platform === 'win32') {
        return process.env.PATH || ''
    }
    try {
        const sh = process.env.SHELL || '/bin/bash'
        const result = execSync(`"${sh}" -ilc 'echo -n "$PATH"'`, {
            encoding: 'utf-8',
            timeout: 5000,
            env: { ...process.env }
        })
        return result.trim()
    } catch {
        return process.env.PATH || ''
    }
}

let resolvedPath: string | null = null

function getFullPath(): string {
    if (resolvedPath === null) {
        resolvedPath = getShellPath()
    }
    return resolvedPath
}

// ── Server lifecycle ───────────────────────────────────────────────────────────

function startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
        const entry = resolveServerEntry()
        const { bin: nodeBin, useElectronAsNode } = resolveNodeBinary()
        console.log('[electron] Starting server:', nodeBin, entry, 'on port', serverPort)

        // In dev, tsx is used for live TS import resolution.
        // In production, the server is compiled with proper .js extensions — no tsx needed.
        const args = is.dev
            ? ['--import', 'tsx', entry, '--port', String(serverPort)]
            : [entry, '--port', String(serverPort)]

        const env: Record<string, string | undefined> = {
            ...process.env,
            PATH: getFullPath(),
            CYNOSURE_DATA_DIR: getDataDir(),
            NODE_ENV: is.dev ? 'development' : 'production'
        }

        if (useElectronAsNode) {
            env.ELECTRON_RUN_AS_NODE = '1'
        }

        serverProcess = spawn(nodeBin, args, {
            cwd: resolveServerDir(),
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        })

        let resolved = false

        serverProcess.stdout?.on('data', (chunk: Buffer) => {
            console.log('[server]', chunk.toString().trim())
        })

        serverProcess.stderr?.on('data', (chunk: Buffer) => {
            console.error('[server:err]', chunk.toString().trim())
        })

        serverProcess.on('error', (err) => {
            console.error('[electron] Failed to spawn server:', err)
            if (!resolved) { resolved = true; reject(err) }
        })

        serverProcess.on('exit', (code) => {
            console.log(`[server] exited with code ${code}`)
            serverProcess = null
            if (!resolved) {
                resolved = true
                reject(new Error(`Server exited with code ${code} before becoming ready`))
            }
        })

        // Poll /api/health until server responds
        const pollInterval = setInterval(async () => {
            try {
                const res = await net.fetch(`http://127.0.0.1:${serverPort}/api/health`)
                if (res.ok && !resolved) {
                    resolved = true
                    clearInterval(pollInterval)
                    console.log('[electron] Server is ready')
                    resolve()
                }
            } catch {
                // not ready yet
            }
        }, 500)

        setTimeout(() => {
            if (!resolved) {
                resolved = true
                clearInterval(pollInterval)
                console.warn('[electron] Server startup timed out — proceeding anyway')
                resolve()
            }
        }, 30_000)
    })
}

// ── Custom protocol for serving web files in production ────────────────────────

function registerAppProtocol(): void {
    const webDist = resolveWebDist()

    protocol.handle('app', (request) => {
        const url = new URL(request.url)
        let pathname = decodeURIComponent(url.pathname)

        // Proxy /api/ requests to the embedded server
        if (pathname.startsWith('/api/')) {
            const serverUrl = `http://127.0.0.1:${serverPort}${pathname}${url.search}`
            return net.fetch(serverUrl, {
                method: request.method,
                headers: request.headers,
                body: request.body
            })
        }

        if (pathname === '/') pathname = '/index.html'
        const filePath = join(webDist, pathname)

        // SPA fallback
        if (!existsSync(filePath)) {
            return net.fetch(pathToFileURL(join(webDist, 'index.html')).toString())
        }
        return net.fetch(pathToFileURL(filePath).toString())
    })
}

// ── Window ─────────────────────────────────────────────────────────────────────

function createTray(win: BrowserWindow): Tray {
    const icon = nativeImage.createFromPath(appIcon)
    const trayIcon = icon.resize({ width: 16, height: 16 })
    const newTray = new Tray(trayIcon)

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Open',
            click: () => {
                win.show()
                win.focus()
            }
        },
        { type: 'separator' },
        {
            label: 'Close',
            click: () => {
                isQuitting = true
                app.quit()
            }
        }
    ])

    newTray.setToolTip('Cynosure')
    newTray.setContextMenu(contextMenu)
    newTray.on('click', () => {
        win.show()
        win.focus()
    })

    return newTray
}

function createWindow(): BrowserWindow {
    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        show: false,
        title: 'Cynosure',
        autoHideMenuBar: true,
        icon: appIcon,
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            sandbox: false
        }
    })

    win.on('ready-to-show', () => win.show())

    // Minimize (not close) hides to tray; pressing X actually quits the app
    win.on('minimize', () => {
        win.hide()
    })

    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
            shell.openExternal(url)
        }
        return { action: 'deny' }
    })

    if (is.dev) {
        const devUrl = 'http://localhost:5173'
        win.webContents.on('did-fail-load', (_event, errorCode, _desc, validatedURL) => {
            if (validatedURL === devUrl + '/' && errorCode === -102) {
                console.log('[electron] Web dev server not ready, retrying in 1s...')
                setTimeout(() => win.loadURL(devUrl), 1000)
            }
        })
        win.loadURL(devUrl)
        //win.webContents.openDevTools({ mode: 'detach' })
    } else {
        win.loadURL('app://cynosure/')
    }

    // F12 / Ctrl+Shift+I to toggle DevTools
    win.webContents.on('before-input-event', (_event, input) => {
        if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
            win.webContents.toggleDevTools()
        }
    })

    return win
}

// ── App lifecycle ──────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.cynosure.desktop')

    app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window)
    })

    // Resolve a free port first
    serverPort = await findFreePort(PREFERRED_PORT)
    console.log(`[electron] Using server port ${serverPort}`)

    // Expose the port to the renderer via synchronous IPC
    ipcMain.on('get-server-port', (event) => {
        event.returnValue = serverPort
    })

    // ── UI preferences persistence (electron-store) ──────────────────────────────────────
    // Chromium's LevelDB "Reusing old log" optimization causes sequence-number
    // conflicts across app restarts, making localStorage unreliable in Electron.
    // electron-store persists prefs to a plain JSON file in userData instead.
    const uiPrefsStore = new ElectronStore<Record<string, string>>({
        name: 'ui-prefs',
        cwd: getDataDir(),
    })

    ipcMain.on('get-ui-prefs', (event) => {
        event.returnValue = uiPrefsStore.store
    })

    ipcMain.on('set-ui-prefs', (event, prefs: Record<string, string>) => {
        uiPrefsStore.store = prefs
        event.returnValue = null
    })

    registerAppProtocol()

    // Start the server in the background — the UI handles reconnection. 
    // If server should start first, simply await it
    startServer().catch((err) => {
        console.error('[electron] Server failed to start:', err)
    })

    // Show the UI immediately — the web app's WebSocket logic will auto-connect
    // once the server is ready. This avoids a blank wait while MCPs load.
    const mainWindow = createWindow()
    tray = createTray(mainWindow)

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            const win = createWindow()
            tray = createTray(win)
        } else {
            mainWindow.show()
            mainWindow.focus()
        }
    })
})

// ── Robust server shutdown ─────────────────────────────────────────────────────

function killServer(): void {
    if (!serverProcess) return
    const pid = serverProcess.pid
    console.log(`[electron] Killing server process (pid=${pid})`)
    try {
        if (process.platform === 'win32' && pid) {
            execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' })
        } else {
            serverProcess.kill('SIGTERM')
        }
    } catch {
        // Process may already be dead
    }
    serverProcess = null
}

app.on('before-quit', () => {
    isQuitting = true
    tray?.destroy()
    killServer()
})
process.on('exit', killServer)
process.on('SIGINT', () => { killServer(); process.exit() })
process.on('SIGTERM', () => { killServer(); process.exit() })

app.on('window-all-closed', () => {
    // Tray keeps the app running only when the window was minimised (hidden).
    // If X was explicitly clicked the window is destroyed and we quit here.
    if (!isQuitting) app.quit()
})
