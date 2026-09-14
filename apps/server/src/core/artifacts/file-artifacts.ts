import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { nanoid } from 'nanoid'
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
    chunkCount?: number
    assetId?: string
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
    const dir = getConversationFilesDir(conversationId)
    const id = nanoid()
    const filename = safeFilename(file.name)
    const originalPath = join(dir, filename)
    const textPath = join(dir, `${filename}.parsed.md`)

    const { buffer, text } = decodeAttachmentContent(file)
    let extractedText = text

    if (isParseableDocument(file.name) && file.content.startsWith('data:')) {
        try {
            extractedText = await parseDocument(buffer, file.name)
        } catch (err) {
            extractedText = `[Error parsing ${file.name}: ${err instanceof Error ? err.message : 'unknown error'}]`
        }
    }

    writeFileSync(originalPath, buffer)
    writeFileSync(textPath, extractedText, 'utf8')

    return {
        name: file.name,
        id,
        originalPath,
        textPath,
        sizeBytes: buffer.byteLength,
        textBytes: Buffer.byteLength(extractedText, 'utf8'),
    }
}

export async function materializeFileAttachments(
    files: FileAttachmentInput[],
    conversationId: string,
): Promise<FileAttachmentArtifact[]> {
    const artifacts: FileAttachmentArtifact[] = []
    for (const file of files) {
        artifacts.push(await materializeFileAttachment(file, conversationId))
    }
    return artifacts
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
