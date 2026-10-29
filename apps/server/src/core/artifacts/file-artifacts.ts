import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { nanoid } from 'nanoid'
import { createHash } from 'node:crypto'
import { getDb } from '../../db/database.js'
import type { Database } from 'better-sqlite3'
import { releaseAttachmentAsset, retainAttachmentAsset } from './attachment-asset-references.js'
import { getAppDataDir } from '../data-dir.js'
import { isParseableDocument, parseDocument } from '../utils/document-parser.js'

export interface FileAttachmentInput {
    name: string
    content: string
}

export interface FileAttachmentArtifact {
    id: string
    name: string
    originalPath: string
    textPath: string
    sizeBytes: number
    textBytes: number
    assetId?: string
    /** Ref (att-N) the model uses to grep and read this attachment's text in its conversation. */
    sessionRef?: string
}

function getConversationFilesDir(conversationId: string): string {
    void conversationId
    const dir = join(getAppDataDir(), 'artifacts', 'attachment-assets')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
}

function safeFilename(name: string): string {
    const base = basename(name).replace(/[^A-Za-z0-9._-]/g, '_') || 'attachment'
    return `${Date.now()}-${nanoid()}-${base}`
}

function decodeAttachmentContent(file: FileAttachmentInput): { buffer: Buffer; text: string } {
    if (file.content.startsWith('data:')) {
        const commaIndex = file.content.indexOf(',')
        const data = commaIndex === -1 ? '' : file.content.slice(commaIndex + 1)
        const buffer = Buffer.from(data, 'base64')
        return { buffer, text: buffer.toString('utf8') }
    }

    const buffer = Buffer.from(file.content, 'utf8')
    return { buffer, text: file.content }
}

export async function materializeFileAttachment(
    file: FileAttachmentInput,
    conversationId: string,
): Promise<FileAttachmentArtifact> {
    const db = getDb()
    const { buffer, text } = decodeAttachmentContent(file)
    const contentHash = createHash('sha256').update(buffer).digest('hex')
    const existing = findAttachmentAsset(db, contentHash, buffer.byteLength)
    if (existing) return retainAttachmentAsset(db, { ...existing, id: nanoid(), name: file.name })

    let pending = pendingMaterializations.get(db)
    if (!pending) pendingMaterializations.set(db, pending = new Map())
    let job = pending.get(contentHash)
    const created = !job
    if (!job) {
        job = createAttachmentAsset(file, conversationId, buffer, text, contentHash)
        pending.set(contentHash, job)
    }
    let artifact: FileAttachmentArtifact | undefined
    try {
        artifact = await job
        return retainAttachmentAsset(db, { ...artifact, id: created ? artifact.id : nanoid(), assetId: artifact.id, name: file.name })
    } finally {
        if (pending.get(contentHash) === job) {
            pending.delete(contentHash)
            // The creation lease covers the gap before callers establish their own leases.
            if (artifact) releaseAttachmentAsset(artifact)
        }
    }
}

const pendingMaterializations = new WeakMap<Database, Map<string, Promise<FileAttachmentArtifact>>>()

interface AttachmentAssetRow {
    id: string; name: string; original_path: string; text_path: string
    size_bytes: number; text_bytes: number; content_hash: string | null
}

function findAttachmentAsset(db: Database, contentHash: string, sizeBytes: number): FileAttachmentArtifact | undefined {
    // Hash older assets lazily, so existing uploads participate without a startup file scan.
    const rows = db.prepare(`SELECT * FROM attachment_assets
        WHERE content_hash = ? OR (content_hash IS NULL AND size_bytes = ?)
        ORDER BY created_at`).all(contentHash, sizeBytes) as AttachmentAssetRow[]
    for (const row of rows) {
        if (!existsSync(row.original_path) || !existsSync(row.text_path)) continue
        let hash = row.content_hash
        if (!hash) {
            try { hash = createHash('sha256').update(readFileSync(row.original_path)).digest('hex') }
            catch { continue }
            db.prepare('UPDATE attachment_assets SET content_hash = ? WHERE id = ?').run(hash, row.id)
        }
        if (hash !== contentHash) continue
        return {
            id: row.id, assetId: row.id, name: row.name, originalPath: row.original_path,
            textPath: row.text_path, sizeBytes: row.size_bytes, textBytes: row.text_bytes,
        }
    }
}

async function createAttachmentAsset(
    file: FileAttachmentInput, conversationId: string, buffer: Buffer, text: string, contentHash: string,
): Promise<FileAttachmentArtifact> {
    const dir = getConversationFilesDir(conversationId)
    const id = nanoid()
    const filename = safeFilename(file.name)
    const originalPath = join(dir, filename)
    const textPath = join(dir, `${filename}.parsed.md`)

    let extractedText = text

    if (isParseableDocument(file.name) && file.content.startsWith('data:')) {
        try {
            extractedText = await parseDocument(buffer, file.name)
        } catch (err) {
            extractedText = `[Error parsing ${file.name}: ${err instanceof Error ? err.message : 'unknown error'}]`
        }
    }

    try {
        writeFileSync(originalPath, buffer)
        writeFileSync(textPath, extractedText, 'utf8')
        getDb().prepare(`INSERT INTO attachment_assets
            (id, name, original_path, text_path, size_bytes, text_bytes, content_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, file.name, originalPath, textPath, buffer.byteLength, Buffer.byteLength(extractedText, 'utf8'), contentHash, Date.now())
    } catch (error) {
        for (const path of [originalPath, textPath]) rmSync(path, { force: true })
        throw error
    }

    return retainAttachmentAsset(getDb(), {
        name: file.name,
        id,
        originalPath,
        textPath,
        sizeBytes: buffer.byteLength,
        textBytes: Buffer.byteLength(extractedText, 'utf8'),
    })
}

export async function materializeFileAttachments(
    files: FileAttachmentInput[],
    conversationId: string,
): Promise<FileAttachmentArtifact[]> {
    const artifacts: FileAttachmentArtifact[] = []
    try {
        for (const file of files) {
            artifacts.push(await materializeFileAttachment(file, conversationId))
        }
        return artifacts
    } catch (error) {
        for (const artifact of artifacts) releaseAttachmentAsset(artifact)
        throw error
    }
}

export function readFileAttachmentText(attachment: Partial<FileAttachmentArtifact> & { content?: string }): string | null {
    if (attachment.textPath && existsSync(attachment.textPath)) {
        try {
            return readFileSync(attachment.textPath, 'utf8')
        } catch {
            return null
        }
    }

    return typeof attachment.content === 'string' ? attachment.content : null
}
