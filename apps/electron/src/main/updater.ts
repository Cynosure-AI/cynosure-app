import { app, BrowserWindow, ipcMain, net } from 'electron'
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
    changelogMarkdown?: string
}

const { autoUpdater } = electronUpdater

let state: UpdateState = {
    status: app.isPackaged ? 'idle' : 'unavailable',
    currentVersion: app.getVersion(),
    message: app.isPackaged ? undefined : 'Updates are available in packaged desktop builds.'
}
let initialized = false
let updateFeedUrl = DEFAULT_UPDATE_URL

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

async function fetchChangelog(version: string): Promise<void> {
    try {
        const response = await net.fetch(new URL('CHANGELOG.md', updateFeedUrl).toString())
        if (!response.ok) return

        const changelogMarkdown = (await response.text()).trim()
        if (!changelogMarkdown) return

        // A newer check may have completed while the changelog request was in flight.
        if (state.availableVersion !== version) return
        publishState({ changelogMarkdown })
    } catch {
        // Changelog details are optional and must not turn a valid update into an error.
    }
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

    updateFeedUrl = (process.env.CYNOSURE_UPDATE_URL || DEFAULT_UPDATE_URL).replace(/\/?$/, '/')
    autoUpdater.setFeedURL({ provider: 'generic', url: updateFeedUrl })
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false

    autoUpdater.on('checking-for-update', () => {
        publishState({ status: 'checking', progress: undefined, message: undefined, changelogMarkdown: undefined })
    })
    autoUpdater.on('update-available', (info) => {
        updateVersion(info)
        publishState({ status: 'available', progress: undefined, message: undefined })
        void fetchChangelog(info.version)
    })
    autoUpdater.on('update-not-available', (info) => {
        updateVersion(info)
        publishState({ status: 'up-to-date', progress: undefined, message: undefined, changelogMarkdown: undefined })
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
