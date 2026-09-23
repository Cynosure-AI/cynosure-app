import { app } from 'electron'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

const LINUX_DESKTOP_FILE = 'com.cynosure.desktop'

function linuxAutostartPath(): string {
    const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
    return join(configDir, 'autostart', LINUX_DESKTOP_FILE)
}

function desktopExecPath(): string {
    // AppImage executables inside the mount point disappear after the app exits.
    return process.env.APPIMAGE || process.execPath
}

function desktopExecValue(path: string): string {
    return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
}

export function isAutostartEnabled(): boolean {
    if (process.platform === 'linux') return existsSync(linuxAutostartPath())
    return app.getLoginItemSettings().openAtLogin
}

export function setAutostartEnabled(enabled: boolean): void {
    if (process.platform === 'linux') {
        const file = linuxAutostartPath()
        if (enabled) {
            mkdirSync(dirname(file), { recursive: true })
            writeFileSync(file, [
                '[Desktop Entry]',
                'Type=Application',
                'Name=Cynosure',
                `Exec=${desktopExecValue(desktopExecPath())}`,
                'Terminal=false',
                'X-GNOME-Autostart-enabled=true',
                ''
            ].join('\n'))
        } else if (existsSync(file)) {
            unlinkSync(file)
        }
        return
    }

    app.setLoginItemSettings({ openAtLogin: enabled })
}
