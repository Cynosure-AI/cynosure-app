import { app, BrowserWindow, shell, protocol, net, ipcMain, Tray, Menu, nativeImage, globalShortcut, screen } from 'electron'
import { spawn, execSync, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import ElectronStore from 'electron-store'
import appIcon from '../../build/icon.png?asset'
import trayProgressIcon from '../../build/tray_progress.png?asset'
import { checkForUpdates, initializeUpdater } from './updater'

// ── Configuration ──────────────────────────────────────────────────────────────

const PREFERRED_PORT = 3099
const CYNOSURE_DATA_DIR_NAME = 'cynosure'
const DEFAULT_QUICK_CHAT_SHORTCUT = 'Control+Space'
const QUICK_CHAT_SHORTCUT_KEY = 'quick-chat-shortcut'
const QUICK_CHAT_AGENT_KEY = 'quick-chat-agent-id'
const QUICK_CHAT_WIDTH = 480
const QUICK_CHAT_HEIGHT = 720

let serverPort = PREFERRED_PORT
let serverProcess: ChildProcess | null = null
let tray: Tray | null = null
let mainWindow: BrowserWindow | null = null
let quickChatWindow: BrowserWindow | null = null
let uiPrefsStore: ElectronStore<Record<string, string>> | null = null
let quickChatStore: ElectronStore<Record<string, string>> | null = null
let registeredQuickChatShortcut: string | null = null
let isQuitting = false
let activeTasks = 0
let trayWs: WebSocket | null = null

// ── Tray icon helpers ─────────────────────────────────────────────────────────

const trayNormalIcon = nativeImage.createFromPath(appIcon).resize({ width: 16, height: 16 })
const trayBusyIcon = nativeImage.createFromPath(trayProgressIcon).resize({ width: 16, height: 16 })

function updateTrayIcon(): void {
    if (!tray || isQuitting || tray.isDestroyed()) return
    tray.setImage(activeTasks > 0 ? trayBusyIcon : trayNormalIcon)
}

function connectTrayMonitor(): void {
    if (trayWs) return

    const wsUrl = `ws://127.0.0.1:${serverPort}/ws`
    const ws = new WebSocket(wsUrl)
    trayWs = ws

    ws.addEventListener('message', (ev: MessageEvent) => {
        try {
            const msg = JSON.parse(ev.data as string) as { event: string; data: { event?: string } }
            if (msg.event !== 'agent:execution-update') return
            const sub = msg.data?.event
            if (sub === 'task:started') {
                activeTasks++
                updateTrayIcon()
            } else if (sub === 'task:completed' || sub === 'task:error') {
                activeTasks = Math.max(0, activeTasks - 1)
                updateTrayIcon()
            }
        } catch {
            // ignore malformed messages
        }
    })

    ws.addEventListener('close', () => {
        trayWs = null
        activeTasks = 0
        updateTrayIcon()
        // Reconnect after a short delay unless quitting
        if (!isQuitting) setTimeout(connectTrayMonitor, 3000)
    })

    ws.addEventListener('error', () => {
        ws.close()
    })
}

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

if (process.platform === 'linux') {
    app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
    app.quit()
} else {
    app.on('second-instance', () => {
        const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
        if (!win || win.isDestroyed()) return

        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
    })
}

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
    if (process.env.CYNOSURE_DATA_DIR) {
        return process.env.CYNOSURE_DATA_DIR
    }

    const home = homedir()

    switch (process.platform) {
        case 'darwin':
            return join(home, 'Library', 'Application Support', CYNOSURE_DATA_DIR_NAME)
        case 'win32':
            return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), CYNOSURE_DATA_DIR_NAME)
        default:
            return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), CYNOSURE_DATA_DIR_NAME)
    }
}

function getAppDataDir(): string {
    return join(getDataDir(), 'data')
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

    protocol.handle('app', async (request) => {
        const url = new URL(request.url)
        let pathname = decodeURIComponent(url.pathname)

        // Proxy /api/ requests to the embedded server
        if (pathname.startsWith('/api/')) {
            const serverUrl = `http://127.0.0.1:${serverPort}${pathname}${url.search}`

            // On Windows, passing request.body (a ReadableStream) directly to
            // net.fetch is unreliable — the body can be silently dropped.
            // Buffer it first so POST/PUT/PATCH bodies are always forwarded.
            const hasBody = request.body !== null && request.method !== 'GET' && request.method !== 'HEAD'
            const body = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined

            return net.fetch(serverUrl, {
                method: request.method,
                headers: request.headers,
                body
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

function positionQuickChatWindow(win: BrowserWindow): void {
    const cursor = screen.getCursorScreenPoint()
    const { workArea } = screen.getDisplayNearestPoint(cursor)
    const margin = 12
    const x = Math.min(
        Math.max(cursor.x + margin, workArea.x + margin),
        workArea.x + workArea.width - QUICK_CHAT_WIDTH - margin
    )
    const y = Math.min(
        Math.max(cursor.y + margin, workArea.y + margin),
        workArea.y + workArea.height - QUICK_CHAT_HEIGHT - margin
    )

    win.setBounds({ x, y, width: QUICK_CHAT_WIDTH, height: QUICK_CHAT_HEIGHT }, false)
}

function createQuickChatWindow(): BrowserWindow {
    const win = new BrowserWindow({
        width: QUICK_CHAT_WIDTH,
        height: QUICK_CHAT_HEIGHT,
        minWidth: 360,
        minHeight: 480,
        show: false,
        title: 'Cynosure Quick Chat',
        autoHideMenuBar: true,
        icon: nativeImage.createFromPath(appIcon),
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            sandbox: false,
            additionalArguments: ['--cynosure-quick-chat']
        }
    })

    positionQuickChatWindow(win)
    win.once('ready-to-show', () => {
        win.show()
        win.focus()
    })
    win.on('closed', () => {
        quickChatWindow = null
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
            shell.openExternal(url)
        }
        return { action: 'deny' }
    })

    if (is.dev) {
        win.loadURL('http://localhost:5173/chat')
    } else {
        win.loadURL('app://cynosure/chat')
    }

    return win
}

function showQuickChatWindow(): void {
    if (!quickChatWindow || quickChatWindow.isDestroyed()) {
        quickChatWindow = createQuickChatWindow()
        return
    }

    positionQuickChatWindow(quickChatWindow)
    if (quickChatWindow.isMinimized()) quickChatWindow.restore()
    quickChatWindow.show()
    quickChatWindow.focus()
    const agentId = quickChatStore?.get(QUICK_CHAT_AGENT_KEY) || null
    quickChatWindow.webContents.send('quick-chat:new', agentId)
}

function registerQuickChatShortcut(accelerator: string): boolean {
    if (
        registeredQuickChatShortcut === accelerator
        && globalShortcut.isRegistered(accelerator)
    ) {
        return true
    }

    const previousShortcut = registeredQuickChatShortcut
    if (previousShortcut) globalShortcut.unregister(previousShortcut)

    try {
        const registered = globalShortcut.register(accelerator, showQuickChatWindow)
        if (registered) {
            registeredQuickChatShortcut = accelerator
            return true
        }
    } catch (error) {
        console.error('[electron] Failed to register quick chat shortcut:', error)
    }

    registeredQuickChatShortcut = null
    if (previousShortcut && previousShortcut !== accelerator) {
        try {
            if (globalShortcut.register(previousShortcut, showQuickChatWindow)) {
                registeredQuickChatShortcut = previousShortcut
            }
        } catch {
            // The previous shortcut may have become unavailable in the meantime.
        }
    }
    return false
}

function createTray(win: BrowserWindow): Tray {
    const newTray = new Tray(trayNormalIcon)

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
        icon: nativeImage.createFromPath(appIcon),
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            sandbox: false
        }
    })

    win.on('ready-to-show', () => win.show())
    win.on('closed', () => {
        if (mainWindow === win) mainWindow = null
        if (!isQuitting) {
            quickChatWindow?.destroy()
            app.quit()
        }
    })

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

        // F12 / Ctrl+Shift+I to toggle DevTools
        win.webContents.on('before-input-event', (_event, input) => {
            if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
                win.webContents.toggleDevTools()
            }
        })

    } else {
        win.loadURL('app://cynosure/')
    }



    return win
}

// ── App lifecycle ──────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
    if (!hasSingleInstanceLock) return

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
    // electron-store persists prefs to a plain JSON file in the shared app data dir.
    uiPrefsStore = new ElectronStore<Record<string, string>>({
        name: 'ui-prefs',
        cwd: getAppDataDir(),
    })

    quickChatStore = new ElectronStore<Record<string, string>>({
        name: 'quick-chat-prefs',
        cwd: getAppDataDir(),
    })

    ipcMain.on('get-ui-prefs', (event) => {
        event.returnValue = uiPrefsStore?.store ?? {}
    })

    ipcMain.on('set-ui-prefs', (event, prefs: Record<string, string>) => {
        if (uiPrefsStore) uiPrefsStore.store = prefs
        event.returnValue = null
    })

    ipcMain.on('quick-chat:get-agent-id', (event) => {
        event.returnValue = quickChatStore?.get(QUICK_CHAT_AGENT_KEY) || null
    })

    ipcMain.on('quick-chat:set-agent-id', (_event, agentId: string | null) => {
        if (!quickChatStore) return
        if (agentId) quickChatStore.set(QUICK_CHAT_AGENT_KEY, agentId)
        else quickChatStore.delete(QUICK_CHAT_AGENT_KEY)
    })

    ipcMain.handle('quick-chat:get-shortcut', () => {
        const accelerator = quickChatStore?.get(QUICK_CHAT_SHORTCUT_KEY) || DEFAULT_QUICK_CHAT_SHORTCUT
        return {
            accelerator,
            registered: registeredQuickChatShortcut === accelerator
                && globalShortcut.isRegistered(accelerator)
        }
    })

    ipcMain.handle('quick-chat:set-shortcut', (_event, accelerator: string) => {
        const normalized = typeof accelerator === 'string' ? accelerator.trim() : ''
        if (!normalized) {
            return { ok: false, error: 'Enter a keyboard shortcut.' }
        }
        if (!registerQuickChatShortcut(normalized)) {
            return { ok: false, error: 'That shortcut is already in use or is not supported.' }
        }
        quickChatStore?.set(QUICK_CHAT_SHORTCUT_KEY, normalized)
        return { ok: true, accelerator: normalized }
    })

    initializeUpdater()

    registerAppProtocol()

    const configuredShortcut = quickChatStore?.get(QUICK_CHAT_SHORTCUT_KEY) || DEFAULT_QUICK_CHAT_SHORTCUT
    if (!registerQuickChatShortcut(configuredShortcut)) {
        console.warn(`[electron] Quick chat shortcut unavailable: ${configuredShortcut}`)
    }

    // Start the server in the background — the UI handles reconnection.
    // Once ready, connect the tray monitor WS to track active tasks.
    startServer()
        .then(() => connectTrayMonitor())
        .catch((err) => {
            console.error('[electron] Server failed to start:', err)
        })

    // Show the UI immediately — the web app's WebSocket logic will auto-connect
    // once the server is ready. This avoids a blank wait while MCPs load.
    mainWindow = createWindow()
    tray = createTray(mainWindow)

    // Check after the first window exists so the renderer receives every state change.
    void checkForUpdates()

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            mainWindow = createWindow()
            tray = createTray(mainWindow)
        } else {
            const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
            if (!win || win.isDestroyed()) return
            win.show()
            win.focus()
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
    trayWs?.close()
    trayWs = null
    tray?.destroy()
    globalShortcut.unregisterAll()
    registeredQuickChatShortcut = null
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
