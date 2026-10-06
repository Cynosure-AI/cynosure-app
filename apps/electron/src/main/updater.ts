import { app, BrowserWindow, ipcMain, net } from 'electron'
import electronUpdater, { type ProgressInfo, type UpdateInfo } from 'electron-updater'

// Releases are published on GitHub. CYNOSURE_UPDATE_URL can point at a self-hosted
// generic feed (a directory holding latest*.yml, installers, and CHANGELOG.md) instead.
const GITHUB_OWNER = 'Cynosure-AI'
const GITHUB_REPO = 'cynosure-app'

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
let genericFeedUrl: string | undefined

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
    if (/Cannot find latest(?:-linux|-mac)?\.yml|No published versions on GitHub|Unable to find latest version on GitHub|404 Not Found/i.test(message)) {
        return 'Update information is not available on the server yet.'
    }
    if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/i.test(message)) {
        return 'The update server could not be reached. Check your internet connection and try again.'
    }
    return message || 'The update server could not be reached.'
}

async function fetchReleaseNotes(version: string): Promise<string | undefined> {
    if (genericFeedUrl) {
        const response = await net.fetch(new URL('CHANGELOG.md', genericFeedUrl).toString())
        return response.ok ? response.text() : undefined
    }

    // electron-updater reports GitHub release notes as rendered HTML; the API returns the Markdown body.
    const response = await net.fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/v${version}`,
        { headers: { Accept: 'application/vnd.github+json' } }
    )
    if (!response.ok) return undefined
    const release = await response.json() as { body?: string | null }
    return release.body ?? undefined
}

async function fetchChangelog(version: string): Promise<void> {
    try {
        const changelogMarkdown = (await fetchReleaseNotes(version))?.trim()
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

    const customFeedUrl = process.env.CYNOSURE_UPDATE_URL?.trim()
    if (customFeedUrl) {
        genericFeedUrl = customFeedUrl.replace(/\/?$/, '/')
        autoUpdater.setFeedURL({ provider: 'generic', url: genericFeedUrl })
    } else {
        autoUpdater.setFeedURL({ provider: 'github', owner: GITHUB_OWNER, repo: GITHUB_REPO })
    }
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
