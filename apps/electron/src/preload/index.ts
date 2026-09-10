import { contextBridge, ipcRenderer } from 'electron'

// Use synchronous IPC so the port is available immediately when the renderer reads it.
// This avoids race conditions with async resolution during WebSocket setup.
const serverPort: number = ipcRenderer.sendSync('get-server-port')
const isQuickChat = process.argv.includes('--cynosure-quick-chat')

contextBridge.exposeInMainWorld('electron', {
    platform: process.platform,
    serverPort,
    isQuickChat,
    getQuickChatAgentId: (): string | null => ipcRenderer.sendSync('quick-chat:get-agent-id'),
    setQuickChatAgentId: (agentId: string | null) => ipcRenderer.send('quick-chat:set-agent-id', agentId),
    getQuickChatShortcut: () => ipcRenderer.invoke('quick-chat:get-shortcut'),
    setQuickChatShortcut: (accelerator: string) => ipcRenderer.invoke('quick-chat:set-shortcut', accelerator),
    onQuickChatOpen: (listener: (agentId: string | null) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, agentId: string | null) => listener(agentId)
        ipcRenderer.on('quick-chat:new', handler)
        return () => ipcRenderer.removeListener('quick-chat:new', handler)
    },
    // Reliable UI prefs persistence (bypasses Electron's LevelDB localStorage quirks)
    getUiPrefs: (): Record<string, string> => ipcRenderer.sendSync('get-ui-prefs'),
    setUiPrefs: (prefs: Record<string, string>) => ipcRenderer.sendSync('set-ui-prefs', prefs),
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
