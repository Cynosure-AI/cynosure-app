import type { ToolDefinition, ToolResult } from '../../gateway/providers/base.provider.js'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { getDb } from '../../../db/database.js'
import { getAgentMemory } from '../../memory/agent-memory.js'
import { getMemoryParser, type RetrievedChunk } from '../../memory/parser.js'
import { buildMemoryFolderFilter as buildScopeFilter, getDefaultMemoryFolder, getMemoryFolderDirectoryPath, type MemoryFolderRef } from '../../memory/memory-folder-scope.js'
import { ensureMemoryFolderPath, folderPathForDirectory } from '../../memory/memory-folder-directories.js'
import { readTextFile, writeTextFile, fileExists, resolveUniqueFileName, deleteFile } from '../../memory/memory-file-manager.js'
import { cancelMemoryIndexJobsForFile } from '../../memory/memory-index-jobs.js'
import {
    parseMemoryDocumentRef,
} from '../../memory/memory-reference.js'
import type { MemoryRevisionContext } from '../../memory/memory-revisions.js'

const memoryDocumentMutationTails = new Map<string, Promise<void>>()

async function withMemoryDocumentLock<T>(documentId: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const key = documentId.trim()
    const prior = memoryDocumentMutationTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const tail = prior.catch(() => undefined).then(() => held)
    memoryDocumentMutationTails.set(key, tail)
    await prior.catch(() => undefined)
    try {
        signal?.throwIfAborted()
        return await operation()
    } finally {
        release()
        if (memoryDocumentMutationTails.get(key) === tail) memoryDocumentMutationTails.delete(key)
    }
}

async function reindexMemoryFile(
    folderId: string,
    fileName: string,
    signal?: AbortSignal,
    revisionContext?: MemoryRevisionContext,
): Promise<{ chunkCount: number; revision: number; contentHash: string; documentId: string; documentRef: string }> {
    const directoryPath = getMemoryFolderDirectoryPath(folderId)
    if (!directoryPath) throw new Error('Memory folder has no directory configured')
    cancelMemoryIndexJobsForFile(folderId, fileName)
    const memory = getAgentMemory()
    const result = await memory.reindexFile(directoryPath, fileName, folderId, { signal, revisionContext })
    const ref = memory.getDocumentReference(folderId, result.fileName)
    if (!ref) throw new Error('Memory was indexed but its document reference could not be loaded')
    return { chunkCount: result.chunkCount, revision: ref.revisionNumber, contentHash: ref.revision, documentId: ref.documentId, documentRef: ref.documentRef }
}

export const MEMORY_READ_TOOL_NAMES = [
    'memory_search',
] as const

export const MEMORY_WRITE_TOOL_NAMES = [
    'memory_create',
    'memory_patch',
    'memory_delete',
] as const

export const MEMORY_TOOL_NAMES = [
    ...MEMORY_READ_TOOL_NAMES,
    ...MEMORY_WRITE_TOOL_NAMES,
] as const

export type MemoryReadToolName = (typeof MEMORY_READ_TOOL_NAMES)[number]
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number]

export function isMemoryToolName(toolName: string): toolName is MemoryToolName {
    return (MEMORY_TOOL_NAMES as readonly string[]).includes(toolName)
}

export function isMemoryReadToolName(toolName: string): toolName is MemoryReadToolName {
    return (MEMORY_READ_TOOL_NAMES as readonly string[]).includes(toolName)
}

export interface MemoryToolOptions {
    /** Vector-store filter covering all selected memory folders, e.g. `folderId IN ('...', '...')`. */
    folderFilter?: string
    /** Selected memory folders for write tools and read disambiguation. */
    assignedFolders?: MemoryFolderRef[]
    revisionContext?: MemoryRevisionContext
    /** Optional background-curator guards; the mutation guard runs under the document lock. */
    onDocumentRead?: (documentId: string, revision: string) => void
    beforeDocumentMutation?: (documentId: string, content: string) => void
    /** Called after a document has been successfully created or updated. */
    onDocumentMutated?: (documentId: string) => void
}

function clampToolNumber(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.max(min, Math.min(max, value))
}

function cleanToolString(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function pickToolString(params: unknown, keys: string[]): string {
    if (!params || typeof params !== 'object') return ''
    const obj = params as Record<string, unknown>
    for (const key of keys) {
        const value = cleanToolString(obj[key])
        if (value) return value
    }
    return ''
}

function getKnownMemoryFolders(): MemoryFolderRef[] {
    try {
        const db = getDb()
        const rows = db
            .prepare('SELECT id, name, directory_path, is_uncategorized FROM memory_folders ORDER BY is_uncategorized DESC, directory_path ASC')
            .all() as { id: string; name: string; directory_path: string; is_uncategorized: number }[]
        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            folderPath: row.is_uncategorized === 1 ? '' : folderPathForDirectory(row.directory_path),
        }))
    } catch {
        return []
    }
}

function createKnownMemoryFoldersLoader(): () => MemoryFolderRef[] {
    let cached: MemoryFolderRef[] | undefined
    return () => {
        cached ??= getKnownMemoryFolders()
        return cached
    }
}

function formatFolders(folders: MemoryFolderRef[]): string {
    if (folders.length === 0) return 'No memory folders exist yet.'
    return folders.map(s => {
        const path = s.folderPath ? `, folder: ${s.folderPath}` : ', folder: Uncategorized'
        const description = s.description?.trim() ? ` — ${s.description.trim()}` : ''
        return `  - "${s.name}" (id: ${s.id}${path})${description}`
    }).join('\n')
}

function findSpaceByIdOrName(folders: MemoryFolderRef[], wanted: string): MemoryFolderRef | undefined {
    const normalized = wanted.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()
    return folders.find(s =>
        s.id === wanted ||
        s.name.toLowerCase() === wanted.toLowerCase() ||
        (s.folderPath || '').toLowerCase() === normalized ||
        (s.folderPath === '' && normalized === 'uncategorized')
    )
}

function makeScopeSummary(assignedFolders: MemoryFolderRef[]): string {
    if (assignedFolders.length === 0) {
        const uncategorizedFolder = getDefaultMemoryFolder()
        return uncategorizedFolder ? `Scope: all memory folders; writes default to "${uncategorizedFolder.name}".` : 'Scope: no memory folders.'
    }
    if (assignedFolders.length === 1) {
        const folder = assignedFolders[0]
        const description = folder.description?.trim() ? ` Description: ${folder.description.trim()}` : ''
        return `Scope: "${folder.name}" folder only.${description}`
    }
    const folders = assignedFolders.map((folder) => {
        const description = folder.description?.trim() ? ` — ${folder.description.trim()}` : ''
        return `"${folder.name}"${description}`
    })
    return `Scope: selected memory folders only (${folders.join('; ')}).`
}

function resolveReadableFolderFilter(
    assignedFolders: MemoryFolderRef[],
    baseFilter?: string,
    folderParam?: string,
    getKnownFolders: () => MemoryFolderRef[] = getKnownMemoryFolders,
): { filter?: string; folder?: MemoryFolderRef } | { error: string } {
    if (!folderParam?.trim()) {
        return { filter: assignedFolders.length > 0 ? buildScopeFilter(assignedFolders) : baseFilter }
    }

    const candidates = assignedFolders.length > 0 ? assignedFolders : getKnownFolders()
    const wanted = folderParam.trim()
    const match = findSpaceByIdOrName(candidates, wanted)
    if (!match) {
        const scopeLabel = assignedFolders.length > 0 ? 'selected memory folders' : 'existing memory folders'
        return {
            error: `Memory folder "${wanted}" was not found in ${scopeLabel}.\n${formatFolders(candidates)}`
        }
    }

    return { filter: buildScopeFilter([match]), folder: match }
}

/**
 * Resolve the target folder for a write operation, with smart name-based fallback.
 * Priority (when no explicit folder param):
 * 1. If title exists in exactly one selected folder → use that
 * 2. If exactly one folder is selected → use it
 * 3. If default folder exists → use it for unspecified writes
 * 4. If multiple folders are selected and no default exists → error
 * 5. If no folders exist → error
 */
async function resolveTargetFolder(
    assignedFolders: MemoryFolderRef[],
    folderParam?: string,
    existingTitle?: string,
    getKnownFolders: () => MemoryFolderRef[] = getKnownMemoryFolders,
): Promise<{ folderId: string; folderName: string } | { error: string }> {
    // --- Explicit folder parameter provided ---
    if (folderParam?.trim()) {
        const wanted = folderParam.trim()
        const candidates = assignedFolders.length > 0 ? assignedFolders : getKnownFolders()
        const match = findSpaceByIdOrName(candidates, wanted)
        if (match) return { folderId: match.id, folderName: match.name }
        if (wanted.includes(':')) return { error: `Unknown memory folder ID "${wanted}".` }
        const normalized = wanted.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        const roots = assignedFolders.length > 0 ? assignedFolders : [getDefaultMemoryFolder()].filter(Boolean) as MemoryFolderRef[]
        const allowed = roots.some(root => !root.folderPath || normalized === root.folderPath || normalized.startsWith(`${root.folderPath}/`))
        if (!allowed) return { error: `Folder "${wanted}" is outside the granted memory folder trees.\n${formatFolders(roots)}` }
        try {
            const created = ensureMemoryFolderPath(getDb(), normalized)
            if (!assignedFolders.some(folder => folder.id === created.id)) {
                assignedFolders.push({ id: created.id, name: created.name, folderPath: normalized })
            }
            return { folderId: created.id, folderName: created.name }
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) }
        }
    }

    // --- No explicit folder parameter ---
    // For updates: try smart title-based resolution first
    if (existingTitle && assignedFolders.length > 0) {
        const mem = getAgentMemory()
        const counts = await Promise.all(
            assignedFolders.map(async (folder) => {
                const filter = buildScopeFilter([folder])
                try {
                    return await mem.countChunks(existingTitle, filter)
                } catch {
                    // Ignore errors in checking individual folders
                    return 0
                }
            })
        )
        const matchingFolders = assignedFolders.filter((_, i) => counts[i] > 0)

        if (matchingFolders.length === 1) {
            // Title exists in exactly one folder — use that
            return { folderId: matchingFolders[0].id, folderName: matchingFolders[0].name }
        }

        if (matchingFolders.length > 1) {
            // Title exists in multiple folders — need explicit selection
            const listing = matchingFolders.map(s => `  - "${s.name}" (id: ${s.id})`).join('\n')
            return { error: `Memory entry "${existingTitle}" exists in multiple folders. Please specify which to update using the 'folder' parameter:\n${listing}` }
        }
    }

    // --- Smart fallback logic ---
    // If exactly one folder is in scope, omitted "folder" writes target that folder.
    if (assignedFolders.length === 1) {
        return { folderId: assignedFolders[0].id, folderName: assignedFolders[0].name }
    }

    // Unspecified writes outside a single selected scope land in the root/Uncategorized memory folder.
    const uncategorizedFolder = getDefaultMemoryFolder()
    if (uncategorizedFolder) {
        return { folderId: uncategorizedFolder.id, folderName: uncategorizedFolder.name }
    }

    // Multiple selected folders but no default or unambiguous match → error
    if (assignedFolders.length > 1) {
        return { error: `Multiple memory folders are selected. Please specify which to write to using the 'folder' parameter.\nAvailable folders:\n${formatFolders(assignedFolders)}` }
    }

    // 4. No folders at all
    const existing = getKnownFolders()
    return {
        error:
            'No memory folder is selected for writes. Provide the target memory folder using the "folder" parameter, select one in the conversation, or assign one to the agent.\n' +
            `Existing memory folders:\n${formatFolders(existing)}`
    }
}

interface ResolvedMemoryDocument {
    documentId: string
    revision: string
    revisionNumber: number
    documentRef: string
    folderId: string
    folderName: string
    fileName: string
    directoryPath: string
}

function resolveMemoryFileRef(
    fileRef: string,
    assignedFolders: MemoryFolderRef[],
    getKnownFolders: () => MemoryFolderRef[],
): ResolvedMemoryDocument | { error: string } {
    const requested = typeof fileRef === 'string' ? fileRef.trim() : ''
    if (!requested) return { error: 'fileRef must be a non-empty stable identifier returned by memory_search.' }
    const parsedRef = parseMemoryDocumentRef(requested)
    const match = getDb().prepare(`
        SELECT document_id FROM memory_file_index
        WHERE document_id = ? OR document_ref = ?
        LIMIT 1
    `).get(requested, parsedRef ?? requested.toLowerCase()) as { document_id: string } | undefined
    const ref = match ? getAgentMemory().getDocumentReferenceById(match.document_id) : undefined
    if (!ref) return { error: 'No canonical memory file matches this fileRef. Run memory_search again to get a current identifier.' }
    if (assignedFolders.length > 0 && !assignedFolders.some((folder) => folder.id === ref.folderId)) {
        return { error: 'The referenced memory document is outside the selected memory-folder scope.' }
    }
    const folder = [...assignedFolders, ...getKnownFolders()].find((candidate) => candidate.id === ref.folderId)
    const directoryPath = getMemoryFolderDirectoryPath(ref.folderId)
    if (!folder || !directoryPath) return { error: 'The memory folder for the referenced document is unavailable.' }
    if (!fileExists(directoryPath, ref.fileName)) return { error: 'The referenced memory document no longer exists.' }
    return {
        documentId: ref.documentId,
        revision: ref.revision,
        revisionNumber: ref.revisionNumber,
        documentRef: ref.documentRef,
        folderId: ref.folderId,
        folderName: folder.name,
        fileName: ref.fileName,
        directoryPath,
    }
}

async function commitMemoryMutation(
    resolved: ResolvedMemoryDocument,
    previousContent: string,
    nextContent: string,
    signal?: AbortSignal,
    revisionContext?: MemoryRevisionContext,
): Promise<{ chunkCount: number; revision: number; contentHash: string; documentId: string; documentRef: string }> {
    signal?.throwIfAborted()
    writeTextFile(resolved.directoryPath, resolved.fileName, nextContent)
    let indexed: Awaited<ReturnType<typeof reindexMemoryFile>>
    try {
        indexed = await reindexMemoryFile(resolved.folderId, resolved.fileName, signal, revisionContext)
    } catch (err) {
        // Restore source and retrieval index together; a failed embedding call
        // must not leave disk and search representing different revisions.
        writeTextFile(resolved.directoryPath, resolved.fileName, previousContent)
        await reindexMemoryFile(resolved.folderId, resolved.fileName).catch(() => undefined)
        throw new Error(`Memory update failed and the previous content was restored: ${(err as Error).message}`)
    }
    return indexed
}

const CANONICAL_EXCERPT_CHARS = 8_000

async function canonicalExcerptForResult(result: RetrievedChunk): Promise<{
    fileRef: string
    fileName: string
    folder: string
    revision: number
    content: string
    score: number
} | undefined> {
    if (!result.sourceFile || !result.folderId || result.chunkIndex == null) return undefined
    const mem = getAgentMemory()
    const ref = mem.getDocumentReference(result.folderId, result.sourceFile)
    const directoryPath = getMemoryFolderDirectoryPath(result.folderId)
    if (!ref || !directoryPath) return undefined

    let canonical: string
    try { canonical = readTextFile(directoryPath, result.sourceFile) } catch { return undefined }
    // Never present an excerpt with a revision belonging to different bytes.
    if (createHash('sha256').update(canonical).digest('hex') !== ref.revision) return undefined

    let sourceStart = result.sourceStart
    let sourceEnd = result.sourceEnd
    if (sourceStart == null || sourceEnd == null || canonical.slice(sourceStart, sourceEnd) !== result.text) {
        const chunks = await getMemoryParser().prepareChunks(canonical, result.sourceFile)
        const current = chunks[result.chunkIndex]
        if (!current || current.contentHash !== result.contentHash) return undefined
        sourceStart = current.sourceStart
        sourceEnd = current.sourceEnd
    }
    if (sourceStart == null || sourceEnd == null) return undefined

    const surrounding = Math.max(0, Math.floor((CANONICAL_EXCERPT_CHARS - (sourceEnd - sourceStart)) / 2))
    let excerptStart = Math.max(0, sourceStart - surrounding)
    let excerptEnd = Math.min(canonical.length, sourceEnd + surrounding)
    if (excerptStart > 0) {
        const boundary = canonical.indexOf('\n', excerptStart)
        if (boundary >= 0 && boundary < sourceStart) excerptStart = boundary + 1
    }
    if (excerptEnd < canonical.length) {
        const boundary = canonical.lastIndexOf('\n', excerptEnd)
        if (boundary > sourceEnd) excerptEnd = boundary
    }
    const folder = getDb().prepare('SELECT name FROM memory_folders WHERE id = ?').get(result.folderId) as { name: string } | undefined
    return {
        fileRef: ref.documentRef,
        fileName: ref.fileName,
        folder: folder?.name || result.folderId,
        revision: ref.revisionNumber,
        content: canonical.slice(excerptStart, excerptEnd),
        score: result.score,
    }
}

/** Search derived chunks, then return expanded text read from canonical files. */
export function makeMemorySearchTool(opts: MemoryToolOptions): ToolDefinition {
    const { folderFilter, assignedFolders = [] } = opts
    const getKnownFolders = createKnownMemoryFoldersLoader()
    return {
        name: 'memory_search',
        execution: { readOnly: true },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description:
            'Search canonical memory files using the derived hybrid retrieval index. ' +
            'Returns expanded canonical excerpts with a stable fileRef for memory_patch or memory_delete; revision tracking is handled internally. ' +
            'Retrieval chunk identifiers and boundaries are intentionally hidden. ' +
            'Selected memory folders are treated as one unified knowledge base — use the optional "folder" parameter to filter to a specific folder. ' +
            makeScopeSummary(assignedFolders),
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                query: { type: 'string', description: 'A descriptive search query to find relevant memories.' },
                limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum number of results to return (default: 5, max: 20).' },
                folder: { type: 'string', description: 'Optional memory folder name, relative path (e.g. "projects/acme"), or ID. This selects which folder to search; without it, all selected folders are searched.' }
            },
            required: ['query']
        },
        outputSchema: {
            type: 'object',
            required: ['results'],
            properties: {
                results: {
                    type: 'array',
                    items: {
                        type: 'object',
                        required: ['fileRef', 'fileName', 'revision', 'content'],
                        properties: {
                            fileRef: { type: 'string' },
                            fileName: { type: 'string' },
                            folder: { type: 'string' },
                            revision: { type: 'integer' },
                            content: { type: 'string' },
                            score: { type: 'number' },
                        },
                    },
                },
            },
        },
        timeout: 15_000,
        execute: async (params: unknown) => {
            const query = pickToolString(params, ['query', 'search_query', 'searchQuery', 'text'])
            if (!query) {
                return { success: false, output: 'A non-empty "query" string is required for memory_search.' }
            }
            const { limit, folder } = (params || {}) as { limit?: number; folder?: string }
            const resolvedScope = resolveReadableFolderFilter(assignedFolders, folderFilter, folder, getKnownFolders)
            if ('error' in resolvedScope) return { success: false, output: resolvedScope.error }
            const mem = getAgentMemory()

            const k = Math.floor(clampToolNumber(limit, 5, 1, 20))
            const results = await mem.recall(query, k, resolvedScope.filter)

            if (results.length === 0) {
                return { success: false, output: `No relevant memories found for this query${resolvedScope.folder ? ` in "${resolvedScope.folder.name}"` : ''}.` }
            }

            console.log(`[memory_search] Found ${results.length} indexed matches for query "${query.slice(0, 60)}" (limit=${k})`)
            const canonicalMatches = (await Promise.all(results.map(canonicalExcerptForResult)))
                .filter((result): result is NonNullable<typeof result> => Boolean(result))
            const canonicalResults = [...new Map(canonicalMatches.map(result => [
                `${result.fileRef}\u0000${result.content}`,
                result,
            ])).values()]
            if (canonicalResults.length === 0) {
                return { success: false, output: 'The search index matched memory, but no result still matched its canonical file. Retry after indexing completes.' }
            }
            for (const result of results) {
                if (!opts.onDocumentRead || !result.folderId || !result.sourceFile) continue
                const ref = mem.getDocumentReference(result.folderId, result.sourceFile)
                if (ref && canonicalResults.some(item => item.fileRef === ref.documentRef)) opts.onDocumentRead(ref.documentId, ref.revision)
            }
            const formatted = canonicalResults.map(result =>
                `[fileRef=${result.fileRef} fileName=${result.fileName} revision=${result.revision} folder=${result.folder} score=${(result.score * 100).toFixed(1)}%]\n${result.content}`
            ).join('\n\n---\n\n')
            return {
                success: true,
                output: `Showing ${canonicalResults.length} canonical memory excerpt${canonicalResults.length === 1 ? '' : 's'}:\n\n${formatted}`,
                structuredContent: { results: canonicalResults },
            }
        }
    }
}

/**
 * Create a `memory_create` tool that lets the LLM store new memory entries.
 * Writes a Markdown file to the target folder and indexes it.
 */
export function makeMemoryCreateTool(opts: MemoryToolOptions): ToolDefinition {
    const { assignedFolders = [] } = opts
    const getKnownFolders = createKnownMemoryFoldersLoader()
    return {
        name: 'memory_create',
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        description:
            'Create a new memory entry with a title and content. ' +
            'Writes a Markdown file to the memory folder and indexes it for semantic retrieval. ' +
            'Use this to persistently store notes, findings, or any information worth remembering. ' +
            'If exactly one memory folder is selected, omit "folder" to write there; otherwise omitted "folder" writes to the default root memory folder. ' +
            'Provide "folder" to store in a specific selected folder.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'A descriptive title for the canonical memory file. The .md extension is appended automatically.' },
                content: { type: 'string', description: 'The Markdown text content to store in memory.' },
                folder: { type: 'string', description: 'The folder the new memory file goes into, specified by name, relative path (e.g. "projects/acme"), or ID. A new folder path is created automatically when it does not exist within a granted folder tree. Omit to write to the only selected folder, or to the default root folder when no single selected folder is in scope.' }
            },
            required: ['title', 'content']
        },
        timeout: 120_000,
        execute: async (params: unknown, signal?: AbortSignal) => {
            const { title, content, folder } = params as { title: string; content: string; folder?: string }

            const resolved = await resolveTargetFolder(assignedFolders, folder, undefined, getKnownFolders)
            if ('error' in resolved) return { success: false, output: resolved.error }

            // Ensure .md extension
            const fileName = title.endsWith('.md') ? title : `${title}.md`
            if (basename(fileName) !== fileName || fileName.startsWith('.') || !fileName.trim()) {
                return { success: false, output: 'The memory title must be a plain, visible file name without path separators.' }
            }
            const directoryPath = getMemoryFolderDirectoryPath(resolved.folderId)
            if (!directoryPath) {
                return { success: false, output: `Memory folder "${resolved.folderName}" has no directory configured. Cannot create memory.` }
            }

            const uniqueName = resolveUniqueFileName(directoryPath, fileName)
            signal?.throwIfAborted()
            writeTextFile(directoryPath, uniqueName, content)

            let indexed: Awaited<ReturnType<typeof reindexMemoryFile>>
            try {
                indexed = await reindexMemoryFile(resolved.folderId, uniqueName, signal, opts.revisionContext)
            } catch (err) {
                deleteFile(directoryPath, uniqueName)
                throw new Error(`Memory creation failed; the unindexed source file was removed: ${(err as Error).message}`)
            }
            opts.onDocumentMutated?.(indexed.documentId)

            return {
                success: true,
                output: `Memory "${uniqueName}" created and indexed in "${resolved.folderName}" (fileRef=${indexed.documentRef}, revision=${indexed.revision}, chunks=${indexed.chunkCount}).`
            }
        }
    }
}

export type MemoryPatchConflictReason =
    | 'file_not_found'
    | 'expected_context_not_found'
    | 'ambiguous_context'
    | 'invalid_patch'
    | 'patch_application_failed'

export type MemoryPatchApplication =
    | { status: 'success'; content: string; affectedRanges: Array<{ start: number; oldEnd: number; newEnd: number }> }
    | { status: 'conflict'; reason: MemoryPatchConflictReason; message: string; editIndex?: number; matchCount?: number; suggestedAnchor?: string }

export type MemoryPatchEdit =
    | { op: 'insert_before' | 'insert_after'; anchor: string; content: string }
    | { op: 'replace'; anchor: string; content: string }
    | { op: 'delete'; anchor: string }

interface NormalizedPatchText {
    text: string
    /** Maps normalized UTF-16 boundaries back to offsets in the original string. */
    sourceOffsets: number[]
    validBoundaries: Set<number>
}

/**
 * Build a comparison-only representation that tolerates common model rendering
 * differences while retaining a safe mapping to the canonical source. Newlines,
 * symbols, letters, and emoji ZWJ sequences otherwise remain significant.
 */
function normalizePatchText(source: string): NormalizedPatchText {
    let text = ''
    const sourceOffsets = [0]
    const validBoundaries = new Set<number>([0])
    let offset = 0

    while (offset < source.length) {
        const start = offset
        const first = String.fromCodePoint(source.codePointAt(offset)!)
        offset += first.length
        let cluster = first
        while (offset < source.length) {
            const next = String.fromCodePoint(source.codePointAt(offset)!)
            if (!/\p{Mark}/u.test(next) && next !== '\uFE0E' && next !== '\uFE0F') break
            cluster += next
            offset += next.length
        }

        const folded = cluster
            .normalize('NFC')
            .replace(/[\uFE0E\uFE0F]/gu, '')
            .replace(/[\u2018\u2019\u201A\u201B]/gu, "'")
            .replace(/[\u00AB\u00BB\u201C\u201D\u201E\u201F]/gu, '"')
            .replace(/[\u2010-\u2015\u2212]/gu, '-')
            .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu, ' ')

        const normalizedStart = text.length
        text += folded
        for (let index = 0; index < folded.length; index++) {
            sourceOffsets[normalizedStart + index + 1] = index === folded.length - 1 ? offset : start
        }
        validBoundaries.add(normalizedStart)
        validBoundaries.add(text.length)
        if (folded.length === 0) sourceOffsets[text.length] = offset
    }

    return { text, sourceOffsets, validBoundaries }
}

interface CanonicalLine { text: string; start: number; end: number; endWithNewline: number }

function canonicalLines(content: string): CanonicalLine[] {
    const lines: CanonicalLine[] = []
    let start = 0
    while (start < content.length) {
        const newline = content.indexOf('\n', start)
        const lineEnd = newline < 0 ? content.length : newline
        const end = newline >= 0 && content.charCodeAt(newline - 1) === 13 ? newline - 1 : lineEnd
        const text = content.slice(start, end)
        lines.push({ text, start, end, endWithNewline: newline < 0 ? end : newline + 1 })
        start = newline < 0 ? content.length : newline + 1
    }
    if (content.length === 0 || content.endsWith('\n')) {
        const end = content.length
        lines.push({ text: '', start: end, end, endWithNewline: end })
    }
    return lines
}

function findAnchorLines(content: string, anchor: string): CanonicalLine[] {
    if (!anchor || /\r|\n/.test(anchor)) return []
    const expected = normalizePatchText(anchor).text
    return canonicalLines(content).filter(line => normalizePatchText(line.text).text === expected)
}

function suggestCanonicalAnchor(content: string, anchor: string): string | undefined {
    const expected = normalizePatchText(anchor).text
    if (!expected || expected.length > 500) return undefined
    const lines = canonicalLines(content).filter(line => line.text.length > 0 && line.text.length <= 500)
    let best: { text: string; distance: number } | undefined
    for (const line of lines) {
        const candidate = normalizePatchText(line.text).text
        if (Math.abs(candidate.length - expected.length) > Math.max(8, Math.floor(expected.length * 0.2))) continue
        let previous = Array.from({ length: candidate.length + 1 }, (_, index) => index)
        for (let row = 1; row <= expected.length; row++) {
            const current = [row]
            for (let column = 1; column <= candidate.length; column++) {
                current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + (expected[row - 1] === candidate[column - 1] ? 0 : 1))
            }
            previous = current
        }
        const distance = previous[candidate.length]
        if (!best || distance < best.distance) best = { text: line.text, distance }
    }
    return best && best.distance <= Math.max(3, Math.floor(expected.length * 0.12)) ? best.text : undefined
}

function normalizeInsertedContent(value: string): string {
    return value.replace(/\r\n?/g, '\n')
}

function invalidMemoryEdit(editIndex: number, message: string): MemoryPatchApplication {
    return { status: 'conflict', reason: 'invalid_patch', editIndex, matchCount: 0, message }
}

/** Apply structured, line-addressed edits in memory. No content is returned on conflict. */
export function applyMemoryPatch(content: string, edits: MemoryPatchEdit[]): MemoryPatchApplication {
    if (!Array.isArray(edits) || edits.length === 0) return invalidMemoryEdit(0, 'edits must contain at least one edit operation.')
    let next = content
    const affectedRanges: Array<{ start: number; oldEnd: number; newEnd: number }> = []
    for (const [editIndex, edit] of edits.entries()) {
        if (!edit || typeof edit !== 'object' || !['insert_before', 'insert_after', 'replace', 'delete'].includes(edit.op) || typeof edit.anchor !== 'string' || !edit.anchor.trim()) {
            return invalidMemoryEdit(editIndex, 'Each edit needs a supported op and a non-empty, single-line anchor.')
        }
        const allowedKeys = edit.op === 'delete' ? ['op', 'anchor'] : ['op', 'anchor', 'content']
        if (Object.keys(edit).some(key => !allowedKeys.includes(key))) return invalidMemoryEdit(editIndex, `Unexpected fields for ${edit.op} edit.`)
        if (edit.op !== 'delete' && typeof edit.content !== 'string') return invalidMemoryEdit(editIndex, 'This edit operation requires string content.')
        if (/\r|\n/.test(edit.anchor)) return invalidMemoryEdit(editIndex, 'Anchors must be one complete line without newline characters.')
        const matches = findAnchorLines(next, edit.anchor)
        if (matches.length === 0) {
            return {
                status: 'conflict',
                reason: 'expected_context_not_found',
                editIndex,
                matchCount: 0,
                suggestedAnchor: suggestCanonicalAnchor(next, edit.anchor),
                message: 'The anchor did not match a complete canonical line. Matching tolerates Unicode normalization, emoji presentation selectors, typographic quote and dash variants, and non-breaking space variants; other characters remain exact. Copy the suggested canonical line if provided, or run memory_search again.',
            }
        }
        if (matches.length > 1) {
            return { status: 'conflict', reason: 'ambiguous_context', editIndex, matchCount: matches.length, message: 'The anchor matches multiple complete lines. Use a longer, unique line as the anchor.' }
        }
        const { start, end, endWithNewline } = matches[0]
        let replaceStart = start
        let replaceEnd = end
        let replacement = ''
        const inserted = edit.op === 'delete' ? '' : normalizeInsertedContent(edit.content)
        if (edit.op === 'insert_before') {
            replaceEnd = start
            replacement = `${inserted}\n`
        } else if (edit.op === 'insert_after') {
            replaceStart = endWithNewline
            replaceEnd = endWithNewline
            replacement = inserted ? `${endWithNewline === end ? '\n' : ''}${inserted}\n` : ''
        } else if (edit.op === 'replace') {
            replacement = inserted
        } else if (edit.op === 'delete') {
            if (endWithNewline > end) replaceEnd = endWithNewline
            else if (start > 0) replaceStart = start - (next.charCodeAt(start - 2) === 13 ? 2 : 1)
        }
        const oldEnd = replaceEnd
        next = next.slice(0, replaceStart) + replacement + next.slice(replaceEnd)
        affectedRanges.push({ start: replaceStart, oldEnd, newEnd: replaceStart + replacement.length })
    }
    return { status: 'success', content: next, affectedRanges }
}

function patchConflict(reason: MemoryPatchConflictReason, message: string, details?: { editIndex?: number; matchCount?: number; suggestedAnchor?: string }): ToolResult {
    const result = { status: 'conflict' as const, reason, message, ...details }
    return { success: false, output: JSON.stringify(result), structuredContent: result }
}

export function makeMemoryPatchTool(opts: MemoryToolOptions): ToolDefinition {
    const { assignedFolders = [] } = opts
    const getKnownFolders = createKnownMemoryFoldersLoader()
    return {
        name: 'memory_patch',
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Atomically apply structured edits to a canonical Markdown memory file. Each edit targets a unique complete line; anchors never use diff syntax, so Markdown bullets are ordinary text. Matching tolerates canonically equivalent Unicode, emoji presentation selectors, typographic quote and dash variants, and non-breaking space variants; other characters remain exact. Concurrent changes and revision tracking are handled internally. Use the fileRef returned by memory_search.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                fileRef: { type: 'string', description: 'Stable canonical file reference returned by memory_search (for example user-profile#4k8z2q).' },
                edits: {
                    type: 'array',
                    minItems: 1,
                    description: 'Ordered edit operations. Each anchor must exactly match one complete line from the canonical file. Example: {"op":"insert_before","anchor":"## Next section","content":"## New section\\n- A Markdown bullet"}. Apply all edits atomically; a conflict applies none.',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            op: { type: 'string', enum: ['insert_before', 'insert_after', 'replace', 'delete'] },
                            anchor: { type: 'string', description: 'A unique, complete, single line copied from memory_search results.' },
                            content: { type: 'string', description: 'Markdown text to insert or replace with; required except for delete.' },
                        },
                        required: ['op', 'anchor'],
                    },
                },
            },
            required: ['fileRef', 'edits'],
        },
        outputSchema: {
            type: 'object',
            required: ['status'],
            properties: {
                status: { type: 'string', enum: ['success', 'conflict'] },
                fileRef: { type: 'string' },
                previousRevision: { type: 'integer' },
                revision: { type: 'integer' },
                reason: { type: 'string' },
                editIndex: { type: 'integer' },
                matchCount: { type: 'integer' },
                suggestedAnchor: { type: 'string' },
                affectedRanges: { type: 'array' },
                message: { type: 'string' },
            },
        },
        timeout: 120_000,
        execute: async (params: unknown, signal?: AbortSignal) => {
            const input = (params || {}) as { fileRef: string; edits: MemoryPatchEdit[] }
            const initial = resolveMemoryFileRef(input.fileRef, assignedFolders, getKnownFolders)
            if ('error' in initial) return patchConflict('file_not_found', initial.error)
            return withMemoryDocumentLock(initial.documentId, signal, async () => {
                const resolved = resolveMemoryFileRef(input.fileRef, assignedFolders, getKnownFolders)
                if ('error' in resolved) return patchConflict('file_not_found', resolved.error)
                let current: string
                try { current = readTextFile(resolved.directoryPath, resolved.fileName) } catch {
                    return patchConflict('file_not_found', 'The canonical memory file could not be read.')
                }
                opts.beforeDocumentMutation?.(resolved.documentId, current)
                let applied = applyMemoryPatch(current, input.edits)
                if (applied.status === 'conflict') return patchConflict(applied.reason, applied.message, {
                    editIndex: applied.editIndex,
                    matchCount: applied.matchCount,
                    suggestedAnchor: applied.suggestedAnchor,
                })
                if (applied.content === current) {
                    const result = { status: 'success' as const, fileRef: resolved.documentRef, previousRevision: resolved.revisionNumber, revision: resolved.revisionNumber, affectedRanges: [] }
                    return { success: true, output: JSON.stringify(result), structuredContent: result }
                }
                // Catch canonical writes that occurred after validation but before
                // commit. Rebase only through the same strict unique-context rules.
                const latest = readTextFile(resolved.directoryPath, resolved.fileName)
                if (latest !== current) {
                    current = latest
                    applied = applyMemoryPatch(current, input.edits)
                    if (applied.status === 'conflict') return patchConflict(applied.reason, applied.message, {
                        editIndex: applied.editIndex,
                        matchCount: applied.matchCount,
                        suggestedAnchor: applied.suggestedAnchor,
                    })
                }
                try {
                    const indexed = await commitMemoryMutation(resolved, current, applied.content, signal, opts.revisionContext)
                    opts.onDocumentMutated?.(indexed.documentId)
                    const result = { status: 'success' as const, fileRef: indexed.documentRef, previousRevision: resolved.revisionNumber, revision: indexed.revision, affectedRanges: applied.affectedRanges }
                    return { success: true, output: JSON.stringify(result), structuredContent: result }
                } catch (error) {
                    return patchConflict('patch_application_failed', (error as Error).message)
                }
            })
        },
    }
}

/**
 * Create a `memory_delete` tool that archives a canonical memory file and
 * removes its derived retrieval index.
 */
export function makeMemoryDeleteTool(opts: MemoryToolOptions): ToolDefinition {
    const { assignedFolders = [] } = opts
    const getKnownFolders = createKnownMemoryFoldersLoader()
    return {
        name: 'memory_delete',
        execution: { readOnly: false },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Delete an entire canonical memory file. The source is archived in the memory folder trash, and its retrieval index is removed. Use the fileRef returned by memory_search. Use memory_patch instead when only part of a file is obsolete.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                fileRef: { type: 'string', description: 'Stable canonical file reference returned by memory_search (for example user-profile#4k8z2q).' },
            },
            required: ['fileRef'],
        },
        outputSchema: {
            type: 'object',
            required: ['status', 'fileRef', 'fileName', 'folder'],
            properties: {
                status: { type: 'string', enum: ['deleted'] },
                fileRef: { type: 'string' },
                fileName: { type: 'string' },
                folder: { type: 'string' },
            },
        },
        timeout: 120_000,
        execute: async (params: unknown, signal?: AbortSignal) => {
            const input = (params || {}) as { fileRef?: string }
            const initial = resolveMemoryFileRef(input.fileRef ?? '', assignedFolders, getKnownFolders)
            if ('error' in initial) return { success: false, output: initial.error }
            return withMemoryDocumentLock(initial.documentId, signal, async () => {
                const resolved = resolveMemoryFileRef(input.fileRef ?? '', assignedFolders, getKnownFolders)
                if ('error' in resolved) return { success: false, output: resolved.error }
                const current = readTextFile(resolved.directoryPath, resolved.fileName)
                opts.beforeDocumentMutation?.(resolved.documentId, current)
                signal?.throwIfAborted()
                cancelMemoryIndexJobsForFile(resolved.folderId, resolved.fileName)
                await getAgentMemory().deleteSourceFile(resolved.fileName, resolved.folderId)
                opts.onDocumentMutated?.(resolved.documentId)
                const result = {
                    status: 'deleted' as const,
                    fileRef: resolved.documentRef,
                    fileName: resolved.fileName,
                    folder: resolved.folderName,
                }
                return { success: true, output: JSON.stringify(result), structuredContent: result }
            })
        },
    }
}
