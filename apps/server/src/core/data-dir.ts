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
 *
 * Under Vitest the platform fallback is refused: every path (SQLite, memories,
 * artifacts, logs) derives from here, so a test without its own data dir would
 * otherwise read and write the user's real installation.
 */
export function getDataDir(): string {
    if (process.env.CYNOSURE_DATA_DIR) {
        return process.env.CYNOSURE_DATA_DIR
    }

    if (process.env.VITEST) {
        throw new Error('Tests must set CYNOSURE_DATA_DIR; refusing to use the real data directory.')
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
 * Returns the root directory that contains all memory folders.
 * The root itself is the default memory folder. Sub-directories under this root
 * are additional memory folders/categories.
 */
export function getMemoryFoldersRootDir(): string {
    return join(getAppDataDir(), 'memories')
}

/**
 * Returns the default memory folder folder path.
 */
export function getDefaultMemoryFolderDir(): string {
    return getMemoryFoldersRootDir()
}
