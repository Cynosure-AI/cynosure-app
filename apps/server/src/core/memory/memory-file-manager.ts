/**
 * Memory File Manager
 *
 * Handles file I/O for memory spaces. Each memory space is backed by a folder
 * on disk. Markdown files in the folder are the source-of-truth for content.
 * SQLite + LanceDB serve only as the retrieval index.
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, copyFileSync } from 'fs'
import { basename, join, extname } from 'path'

// ---------------------------------------------------------------------------
// Extension sets
// ---------------------------------------------------------------------------

/** Extensions that can be read as plain text without parsing. */
export const PLAIN_TEXT_EXTENSIONS = new Set(['.md', '.txt'])

/** Extensions that require parsing (officeparser / pdf) before indexing. */
export const PARSEABLE_DOC_EXTENSIONS = new Set([
    '.docx', '.pptx', '.xlsx',
    '.odt', '.odp', '.ods',
    '.pdf', '.rtf',
])

/** All extensions supported for indexing (text or parseable). */
export const ALL_SUPPORTED_EXTENSIONS = new Set([
    ...PLAIN_TEXT_EXTENSIONS,
    ...PARSEABLE_DOC_EXTENSIONS,
])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryFileInfo {
    fileName: string
    filePath: string
    size: number
    modifiedAt: number
    extension: string
    /** File type is supported for indexing */
    supported: boolean
    /** File can be read directly as text (no parsing step needed) */
    textDirect: boolean
}

export interface MemoryFileRevisionInfo {
    fileName: string
    revisionName: string
    size: number
    createdAt: number
}

// ---------------------------------------------------------------------------
// Folder helpers
// ---------------------------------------------------------------------------

export function ensureFolder(folderPath: string): void {
    mkdirSync(folderPath, { recursive: true })
}

export function listFilesInFolder(folderPath: string): MemoryFileInfo[] {
    if (!existsSync(folderPath)) return []
    try {
        const entries = readdirSync(folderPath, { withFileTypes: true })
        return entries
            .filter(e => e.isFile())
            .map(e => {
                const filePath = join(folderPath, e.name)
                const stat = statSync(filePath)
                const ext = extname(e.name).toLowerCase()
                return {
                    fileName: e.name,
                    filePath,
                    size: stat.size,
                    modifiedAt: stat.mtimeMs,
                    extension: ext,
                    supported: ALL_SUPPORTED_EXTENSIONS.has(ext),
                    textDirect: PLAIN_TEXT_EXTENSIONS.has(ext),
                }
            })
            .sort((a, b) => a.fileName.localeCompare(b.fileName))
    } catch {
        return []
    }
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

export function computeFileHash(filePath: string): string {
    try {
        const content = readFileSync(filePath)
        return createHash('sha256').update(content).digest('hex')
    } catch {
        return ''
    }
}

/** Write UTF-8 text to a file in the given folder, creating the folder if needed. */
export function writeTextFile(folderPath: string, fileName: string, content: string): string {
    ensureFolder(folderPath)
    const filePath = join(folderPath, fileName)
    writeFileSync(filePath, content, 'utf-8')
    return filePath
}

/** Read a text file from a folder. Throws if not found. */
export function readTextFile(folderPath: string, fileName: string): string {
    return readFileSync(join(folderPath, fileName), 'utf-8')
}

export function listFileRevisions(folderPath: string, fileName: string): MemoryFileRevisionInfo[] {
    const cleanName = basename(fileName)
    const revisionsFolder = join(folderPath, '.revisions')
    if (!cleanName || !existsSync(revisionsFolder)) return []

    const dotIdx = cleanName.lastIndexOf('.')
    const base = dotIdx > 0 ? cleanName.slice(0, dotIdx) : cleanName
    const ext = dotIdx > 0 ? cleanName.slice(dotIdx) : ''
    const revisionPattern = new RegExp(`^${escapeRegExp(base)}-\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}${escapeRegExp(ext)}$`)

    try {
        return readdirSync(revisionsFolder, { withFileTypes: true })
            .filter((entry) => entry.isFile() && revisionPattern.test(entry.name))
            .map((entry) => {
                const filePath = join(revisionsFolder, entry.name)
                const stat = statSync(filePath)
                return {
                    fileName: cleanName,
                    revisionName: entry.name,
                    size: stat.size,
                    createdAt: stat.mtimeMs,
                }
            })
            .sort((a, b) => b.createdAt - a.createdAt || b.revisionName.localeCompare(a.revisionName))
    } catch {
        return []
    }
}

export function readFileRevision(folderPath: string, fileName: string, revisionName: string): string {
    const revision = basename(revisionName || '')
    const match = listFileRevisions(folderPath, fileName).some((item) => item.revisionName === revision)
    if (!revision || !match) {
        throw new Error('Revision not found')
    }
    return readFileSync(join(folderPath, '.revisions', revision), 'utf-8')
}

/** Delete a file from a folder. Returns true if the file existed. */
export function deleteFile(folderPath: string, fileName: string): boolean {
    const filePath = join(folderPath, fileName)
    if (!existsSync(filePath)) return false
    unlinkSync(filePath)
    return true
}

/** Copy a file into a target folder, overwriting if it already exists. */
export function copyFileToFolder(sourcePath: string, targetFolder: string, targetName: string): string {
    ensureFolder(targetFolder)
    const dest = join(targetFolder, targetName)
    copyFileSync(sourcePath, dest)
    return dest
}

/**
 * Back up a file to a `revisions/` subfolder before overwriting it.
 * The backup is named `<base>-<YYYY-MM-DD_HH-MM-SS>.<ext>`.
 * Returns the backup file path, or undefined if the source did not exist.
 */
export function backupToRevisions(folderPath: string, fileName: string): string | undefined {
    const sourcePath = join(folderPath, fileName)
    if (!existsSync(sourcePath)) return undefined

    const dotIdx = fileName.lastIndexOf('.')
    const base = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName
    const ext = dotIdx > 0 ? fileName.slice(dotIdx) : ''

    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
    const backupName = `${base}-${timestamp}${ext}`

    const revisionsFolder = join(folderPath, '.revisions')
    ensureFolder(revisionsFolder)
    const dest = join(revisionsFolder, backupName)
    copyFileSync(sourcePath, dest)
    return dest
}

/**
 * Move a file to the `revisions/` subfolder.
 * Used when imported binary/source documents are converted to canonical Markdown.
 */
export function moveToRevisions(folderPath: string, fileName: string): string | undefined {
    const sourcePath = join(folderPath, fileName)
    if (!existsSync(sourcePath)) return undefined

    const backupPath = backupToRevisions(folderPath, fileName)
    if (!backupPath) return undefined

    unlinkSync(sourcePath)
    return backupPath
}

export function toMarkdownFileName(fileName: string): string {
    const baseName = basename(fileName)
    const dotIdx = baseName.lastIndexOf('.')
    const base = dotIdx > 0 ? baseName.slice(0, dotIdx) : baseName
    return `${base}.md`
}

export function fileExists(folderPath: string, fileName: string): boolean {
    return existsSync(join(folderPath, fileName))
}

/**
 * Return a file name that does not yet exist in the folder.
 * If the name is taken, append (2), (3), … until a free slot is found.
 */
export function resolveUniqueFileName(folderPath: string, fileName: string): string {
    if (!fileExists(folderPath, fileName)) return fileName
    const dotIdx = fileName.lastIndexOf('.')
    const base = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName
    const ext = dotIdx > 0 ? fileName.slice(dotIdx) : ''
    let counter = 2
    let candidate = `${base} (${counter})${ext}`
    while (fileExists(folderPath, candidate)) {
        counter++
        candidate = `${base} (${counter})${ext}`
    }
    return candidate
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Markdown section replacement
// ---------------------------------------------------------------------------

/**
 * Replace (or append) a section in a markdown document identified by its
 * exact heading line (e.g. `## My Section`).
 *
 * - If the heading is found: replaces all content between that heading and the
 *   next heading of the same or higher level with `newSectionContent`.
 * - If the heading is not found: appends it as a new section at the end.
 */
export function replaceMarkdownSection(
    content: string,
    heading: string,
    newSectionContent: string,
): string {
    const lines = content.split('\n')
    const headingTrimmed = heading.trim()
    const headingLevel = (headingTrimmed.match(/^(#+)/)?.[1] ?? '##').length

    let headingLineIdx = -1
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === headingTrimmed) {
            headingLineIdx = i
            break
        }
    }

    if (headingLineIdx === -1) {
        // Append as new section
        return content.trimEnd() + '\n\n' + headingTrimmed + '\n\n' + newSectionContent.trim() + '\n'
    }

    // Find end of section (next heading of same or higher level)
    let endLineIdx = lines.length
    for (let i = headingLineIdx + 1; i < lines.length; i++) {
        const match = lines[i].match(/^(#+)\s/)
        if (match && match[1].length <= headingLevel) {
            endLineIdx = i
            break
        }
    }

    const before = lines.slice(0, headingLineIdx + 1)
    const after = lines.slice(endLineIdx)
    return [...before, '', newSectionContent.trim(), '', ...after].join('\n')
}
