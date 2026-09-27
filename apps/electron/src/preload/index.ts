import { contextBridge, ipcRenderer } from 'electron'

// Use synchronous IPC so the port is available immediately when the renderer reads it.
// This avoids race conditions with async resolution during WebSocket setup.
const serverPort: number = ipcRenderer.sendSync('get-server-port')

contextBridge.exposeInMainWorld('electron', {
    platform: process.platform,
    serverPort,
    chooseFileAccessDirectory: (): Promise<string | null> => ipcRenderer.invoke('file-access:choose-directory'),
    // Reliable UI prefs persistence (bypasses Electron's LevelDB localStorage quirks)
    getUiPrefs: (): Record<string, string> => ipcRenderer.sendSync('get-ui-prefs'),
    setUiPrefs: (prefs: Record<string, string>) => ipcRenderer.sendSync('set-ui-prefs', prefs),
    getGlobalHotkey: () => ipcRenderer.invoke('global-hotkey:get'),
    setGlobalHotkey: (accelerator: string) => ipcRenderer.invoke('global-hotkey:set', accelerator),
    getAutostart: () => ipcRenderer.invoke('autostart:get'),
    setAutostart: (enabled: boolean) => ipcRenderer.invoke('autostart:set', enabled),
    onNewChatRequested: (listener: () => void) => {
        const handler = () => listener()
        ipcRenderer.on('desktop:new-chat', handler)
        return () => ipcRenderer.removeListener('desktop:new-chat', handler)
    },
    quitApp: () => ipcRenderer.invoke('app:quit'),
    getUpdateState: () => ipcRenderer.invoke('updater:get-state'),
    checkForUpdates: () => ipcRenderer.invoke('updater:check'),
    downloadUpdate: () => ipcRenderer.invoke('updater:download'),
    installUpdate: () => ipcRenderer.invoke('updater:install'),
    onUpdateState: (listener: (state: unknown) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state)
        ipcRenderer.on('updater:state', handler)
        return () => ipcRenderer.removeListener('updater:state', handler)
    },
})
