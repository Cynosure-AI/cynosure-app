import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import ignore from 'ignore'
import { detectDocumentExtension, looksBinary } from '../utils/document-parser.js'

/** Same cap the composer applies to uploads from the user's device. */
export const MAX_PROJECT_FILE_BYTES = 20 * 1024 * 1024
const SEARCH_RESULT_LIMIT = 200
const SEARCH_SCAN_LIMIT = 20_000
/** Generated or vendored trees that would drown search results in a code project. */
const SEARCH_SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', '__pycache__', 'venv'])

const IMAGE_TYPES: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
}
const AUDIO_TYPES: Record<string, string> = {
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
    '.m4a': 'audio/mp4', '.aac': 'audio/aac',
}

export interface ProjectFileEntry {
    name: string
    /** Path relative to the project directory, with `/` separators. */
    path: string
    type: 'directory' | 'file'
    size?: number
}

export interface ProjectFileListing {
    /** Listed folder relative to the project directory; empty for the root. */
    path: string
    entries: ProjectFileEntry[]
    /** Search stopped before covering the whole project. */
    truncated?: boolean
}

export interface ProjectFileContent {
    kind: 'image' | 'audio' | 'file'
    /** Project-relative path, used as the attachment name so the model knows where the file lives. */
    name: string
    /** A data URL for images, audio and parseable documents; UTF-8 text otherwise. */
    content: string
}

export class ProjectFileError extends Error {
    constructor(readonly statusCode: number, message: string) {
        super(message)
        this.name = 'ProjectFileError'
    }
}

function toProjectPath(relative: string): string {
    return relative.split(path.sep).join('/')
}

/** Resolve `relative` inside the project directory, following symlinks, and refuse anything that escapes it. */
async function resolveInsideProject(rootPath: string, relative: string | undefined): Promise<{ base: string; target: string; relative: string }> {
    if (!rootPath) throw new ProjectFileError(400, 'This project has no project directory.')
    let base: string
    try {
        base = await fs.realpath(rootPath)
    } catch {
        throw new ProjectFileError(404, 'The project directory no longer exists.')
    }
    let target: string
    try {
        target = await fs.realpath(path.resolve(base, relative?.trim() || '.'))
    } catch {
        throw new ProjectFileError(404, 'That file or folder does not exist.')
    }
    const inside = path.relative(base, target)
    if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
        throw new ProjectFileError(403, 'That path is outside the project directory.')
    }
    return { base, target, relative: toProjectPath(inside) }
}

function sortEntries(entries: ProjectFileEntry[]): ProjectFileEntry[] {
    return entries.sort((a, b) => a.type === b.type
        ? a.path.localeCompare(b.path, undefined, { sensitivity: 'base', numeric: true })
        : a.type === 'directory' ? -1 : 1)
}

interface IgnoreScope {
    folder: string
    rules: ReturnType<typeof ignore>
}

/** Each .gitignore is relative to its own folder; deeper rules can override earlier ones. */
async function folderIgnoreScopes(base: string, folder: string, parents: IgnoreScope[]): Promise<IgnoreScope[]> {
    const source = await fs.readFile(path.join(base, folder, '.gitignore'), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return ''
        throw error
    })
    return source ? [...parents, { folder, rules: ignore({ ignorecase: false }).add(source) }] : parents
}

function isIgnored(entryPath: string, directory: boolean, scopes: IgnoreScope[]): boolean {
    let ignored = false
    for (const scope of scopes) {
        const relative = scope.folder ? entryPath.slice(scope.folder.length + 1) : entryPath
        const result = scope.rules.test(relative + (directory ? '/' : ''))
        if (result.ignored) ignored = true
        else if (result.unignored) ignored = false
    }
    return ignored
}

/** List one folder of the project directory, folders first. */
export async function listProjectFolder(rootPath: string, relative?: string, showHidden = false): Promise<ProjectFileListing> {
    const { base, target, relative: folder } = await resolveInsideProject(rootPath, relative)
    if (!(await fs.stat(target)).isDirectory()) throw new ProjectFileError(400, 'That path is not a folder.')
    let scopes = await folderIgnoreScopes(base, '', [])
    // Also enforce ancestor rules when a folder is opened directly.
    let ancestor = ''
    for (const part of folder ? folder.split('/') : []) {
        ancestor = ancestor ? `${ancestor}/${part}` : part
        if (isIgnored(ancestor, true, scopes)) return { path: folder, entries: [] }
        scopes = await folderIgnoreScopes(base, ancestor, scopes)
    }
    const entries: ProjectFileEntry[] = []
    for (const entry of await fs.readdir(target, { withFileTypes: true })) {
        if (!showHidden && entry.name.startsWith('.')) continue
        const stat = await fs.stat(path.join(target, entry.name)).catch(() => null)
        if (!stat) continue
        const entryPath = folder ? `${folder}/${entry.name}` : entry.name
        if (isIgnored(entryPath, stat.isDirectory(), scopes)) continue
        if (stat.isDirectory()) entries.push({ name: entry.name, path: entryPath, type: 'directory' })
        else if (stat.isFile()) entries.push({ name: entry.name, path: entryPath, type: 'file', size: stat.size })
    }
    return { path: folder, entries: sortEntries(entries) }
}

/** Find files whose project-relative path contains `query`, respecting .gitignore in each folder. */
export async function searchProjectFiles(rootPath: string, query: string, showHidden = false): Promise<ProjectFileListing> {
    const { base } = await resolveInsideProject(rootPath, undefined)
    const needle = query.trim().toLowerCase()
    const results: ProjectFileEntry[] = []
    const queue = [{ folder: '', scopes: [] as IgnoreScope[] }]
    let scanned = 0
    let truncated = false
    while (queue.length) {
        const { folder, scopes: parents } = queue.shift()!
        const scopes = await folderIgnoreScopes(base, folder, parents)
        const entries = await fs.readdir(path.join(base, folder), { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
            if (!showHidden && entry.name.startsWith('.')) continue
            const entryPath = folder ? `${folder}/${entry.name}` : entry.name
            if (isIgnored(entryPath, entry.isDirectory(), scopes)) continue
            if (++scanned > SEARCH_SCAN_LIMIT || results.length >= SEARCH_RESULT_LIMIT) {
                truncated = true
                break
            }
            // Symlinks are not followed so a link cycle cannot stall the search.
            if (entry.isDirectory()) {
                if (!SEARCH_SKIPPED_DIRECTORIES.has(entry.name)) queue.push({ folder: entryPath, scopes })
            } else if (entry.isFile() && entryPath.toLowerCase().includes(needle)) {
                const stat = await fs.stat(path.join(base, entryPath)).catch(() => null)
                results.push({ name: entry.name, path: entryPath, type: 'file', size: stat?.size })
            }
        }
        if (truncated) break
    }
    return { path: '', entries: sortEntries(results), ...(truncated ? { truncated } : {}) }
}

/** Read a project file in the form the chat composer attaches it. */
export async function readProjectFile(rootPath: string, relative: string): Promise<ProjectFileContent> {
    if (!relative?.trim()) throw new ProjectFileError(400, 'Choose a file to attach.')
    const { target, relative: name } = await resolveInsideProject(rootPath, relative)
    const stat = await fs.stat(target)
    if (!stat.isFile()) throw new ProjectFileError(400, 'Choose a file, not a folder.')
    if (stat.size > MAX_PROJECT_FILE_BYTES) throw new ProjectFileError(413, 'Files larger than 20 MB cannot be attached.')

    return toAttachableContent(await fs.readFile(target), name)
}

/** Convert file bytes into the form the chat composer attaches; `name` decides the type by its extension. */
export function toAttachableContent(buffer: Buffer, name: string): ProjectFileContent {
    const extension = path.extname(name).toLowerCase()
    const dataUrl = (mime: string) => `data:${mime};base64,${buffer.toString('base64')}`
    if (IMAGE_TYPES[extension]) return { kind: 'image', name, content: dataUrl(IMAGE_TYPES[extension]) }
    if (AUDIO_TYPES[extension]) return { kind: 'audio', name, content: dataUrl(AUDIO_TYPES[extension]) }
    if (detectDocumentExtension(buffer, name)) return { kind: 'file', name, content: dataUrl('application/octet-stream') }
    if (looksBinary(buffer)) throw new ProjectFileError(415, 'Binary files cannot be attached.')
    return { kind: 'file', name, content: buffer.toString('utf8') }
}
