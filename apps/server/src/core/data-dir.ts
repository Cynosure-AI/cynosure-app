import { join } from 'path'
import { homedir } from 'os'

export const CYNOSURE_DATA_DIR_NAME = 'cynosure'

/**
 * Returns the root config directory for Cynosure.
 *
 * Resolution order:
 * 1. CYNOSURE_DATA_DIR environment variable (set via --data-dir or .env)
 * 2. Platform-specific config directory:
 *    - Linux:   ~/.config/cynosure
 *    - macOS:   ~/Library/Application Support/cynosure
 *    - Windows: %APPDATA%/cynosure
 */
export function getDataDir(): string {
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
            // Linux and other Unix — follow XDG convention
            return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), CYNOSURE_DATA_DIR_NAME)
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

/**
 * Returns the root directory that contains all memory category folders.
 * The root itself is the default memory category. Sub-directories under this root
 * are additional memory categories/categories.
 */
export function getMemoryCategoriesRootDir(): string {
    return join(getAppDataDir(), 'memories')
}

/**
 * Returns the default memory category folder path.
 */
export function getDefaultMemoryCategoryDir(): string {
    return getMemoryCategoriesRootDir()
}
