import { join } from 'path'
import { homedir } from 'os'

/**
 * Returns the root config directory for OpenAgent.
 *
 * Resolution order:
 * 1. OPENAGENT_DATA_DIR environment variable (set via --data-dir or .env)
 * 2. Platform-specific config directory:
 *    - Linux:   ~/.config/open-agent
 *    - macOS:   ~/Library/Application Support/open-agent
 *    - Windows: %APPDATA%/open-agent
 */
export function getDataDir(): string {
    if (process.env.OPENAGENT_DATA_DIR) {
        return process.env.OPENAGENT_DATA_DIR
    }

    const home = homedir()

    switch (process.platform) {
        case 'darwin':
            return join(home, 'Library', 'Application Support', 'open-agent')
        case 'win32':
            return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'open-agent')
        default:
            // Linux and other Unix — follow XDG convention
            return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'open-agent')
    }
}

/**
 * Returns the `data/` subdirectory inside the config root.
 * All persistent application data (sqlite, lancedb, agents, logs) lives here
 * to keep them grouped and separate from any Electron/OS cache files.
 */
export function getAppDataDir(): string {
    return join(getDataDir(), 'data')
}
