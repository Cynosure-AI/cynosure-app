import { app, BrowserWindow, ipcMain } from 'electron'
import electronUpdater, { type ProgressInfo, type UpdateInfo } from 'electron-updater'

const DEFAULT_UPDATE_URL = 'https://cometcms.banjocomet.com/media/cynosure/'

export type UpdateStatus =
    | 'unavailable'
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'up-to-date'
    | 'error'

export interface UpdateState {
    status: UpdateStatus
    currentVersion: string
    availableVersion?: string
    progress?: number
    transferred?: number
    total?: number
    message?: string
}

const { autoUpdater } = electronUpdater

let state: UpdateState = {
    status: app.isPackaged ? 'idle' : 'unavailable',
    currentVersion: app.getVersion(),
    message: app.isPackaged ? undefined : 'Updates are available in packaged desktop builds.'
}
let initialized = false

function publishState(patch: Partial<UpdateState>): void {
    state = { ...state, ...patch }
    for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('updater:state', state)
    }
}

function updateVersion(info: UpdateInfo): void {
    publishState({ availableVersion: info.version })
}

function updateProgress(progress: ProgressInfo): void {
    publishState({
        status: 'downloading',
        progress: Math.max(0, Math.min(100, progress.percent)),
        transferred: progress.transferred,
        total: progress.total,
        message: undefined
    })
}

function errorMessage(error: Error): string {
    const message = error.message.trim()
    if (/Cannot find latest(?:-linux|-mac)?\.yml|404 Not Found/i.test(message)) {
        return 'Update information is not available on the server yet.'
    }
    if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/i.test(message)) {
        return 'The update server could not be reached. Check your internet connection and try again.'
    }
    return message || 'The update server could not be reached.'
}

export function initializeUpdater(): void {
    if (initialized) return
    initialized = true

    ipcMain.handle('updater:get-state', () => state)
    ipcMain.handle('updater:check', async () => {
        if (!app.isPackaged) return state
        await checkForUpdates()
        return state
    })
    ipcMain.handle('updater:download', async () => {
        if (!app.isPackaged || state.status !== 'available') return state
        publishState({ status: 'downloading', progress: 0, message: undefined })
        try {
            await autoUpdater.downloadUpdate()
        } catch (error) {
            publishState({ status: 'error', message: errorMessage(error as Error) })
        }
        return state
    })
    ipcMain.handle('updater:install', () => {
        if (!app.isPackaged || state.status !== 'downloaded') return false
        // The updater invokes the platform installer and relaunches after it completes.
        // DEB installs may show an authentication prompt from the system package manager.
        autoUpdater.quitAndInstall(false, true)
        return true
    })

    if (!app.isPackaged) return

    const updateUrl = (process.env.CYNOSURE_UPDATE_URL || DEFAULT_UPDATE_URL).replace(/\/?$/, '/')
    autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl })
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false

    autoUpdater.on('checking-for-update', () => {
        publishState({ status: 'checking', progress: undefined, message: undefined })
    })
    autoUpdater.on('update-available', (info) => {
        updateVersion(info)
        publishState({ status: 'available', progress: undefined, message: undefined })
    })
    autoUpdater.on('update-not-available', (info) => {
        updateVersion(info)
        publishState({ status: 'up-to-date', progress: undefined, message: undefined })
    })
    autoUpdater.on('download-progress', updateProgress)
    autoUpdater.on('update-downloaded', (info) => {
        updateVersion(info)
        publishState({ status: 'downloaded', progress: 100, message: undefined })
    })
    autoUpdater.on('error', (error) => {
        publishState({ status: 'error', message: errorMessage(error) })
    })
}

export async function checkForUpdates(): Promise<void> {
    if (!app.isPackaged || state.status === 'checking' || state.status === 'downloading') return
    try {
        await autoUpdater.checkForUpdates()
    } catch (error) {
        publishState({ status: 'error', message: errorMessage(error as Error) })
    }
}
