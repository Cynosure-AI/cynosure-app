import { contextBridge, ipcRenderer } from 'electron'

// Use synchronous IPC so the port is available immediately when the renderer reads it.
// This avoids race conditions with async resolution during WebSocket setup.
const serverPort: number = ipcRenderer.sendSync('get-server-port')

contextBridge.exposeInMainWorld('electron', {
    platform: process.platform,
    serverPort,
    // Reliable UI prefs persistence (bypasses Electron's LevelDB localStorage quirks)
    getUiPrefs: (): Record<string, string> => ipcRenderer.sendSync('get-ui-prefs'),
    setUiPrefs: (prefs: Record<string, string>) => ipcRenderer.sendSync('set-ui-prefs', prefs),
})
