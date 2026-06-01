/**
 * Document parser utility – uses officeparser to extract structured content
 * from office documents (docx, pptx, xlsx, odt, odp, ods, pdf, rtf)
 * and converts the AST to Markdown for LLM consumption.
 */
import { parseOffice, type OfficeContentNode, type OfficeAttachment, type SupportedFileType } from 'officeparser'
import AdmZip from 'adm-zip'
import { getDb } from '../../db/database.js'

/** File extensions that officeparser can handle */
const PARSEABLE_EXTENSIONS = new Set([
    '.docx', '.pptx', '.xlsx',
    '.odt', '.odp', '.ods',
    '.pdf', '.rtf'
])

const DOCX_HEADING_STYLE_RE = /(?:^|[\s_-])heading\D*([1-6])(?:\D|$)|^h([1-6])$/i

/** Check if a filename has a parseable document extension */
export function isParseableDocument(filename: string): boolean {
    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
    return PARSEABLE_EXTENSIONS.has(ext)
}

/** Read the OCR enabled flag from DB settings. */
function getParserConfig(): { ocrEnabled: boolean; ocrLanguage: string } {
    try {
        const db = getDb()
        const row = db.prepare("SELECT value_json FROM settings WHERE key = 'documentParser'").get() as { value_json: string } | undefined
        if (row) {
            const cfg = JSON.parse(row.value_json) as { ocrEnabled?: boolean; ocrLanguage?: string }
            return { ocrEnabled: !!cfg.ocrEnabled, ocrLanguage: cfg.ocrLanguage || 'eng' }
        }
    } catch { /* DB not ready */ }
    return { ocrEnabled: false, ocrLanguage: 'eng' }
}

/** Parse a document buffer and return structured Markdown text */
export async function parseDocument(buffer: Buffer, filename: string): Promise<string> {
    const { ocrEnabled: ocr, ocrLanguage } = getParserConfig()
    const fileType = getFileType(filename)
    const ast = await parseOffice(buffer, {
        fileType,
        outputErrorToConsole: false,
        extractAttachments: ocr,
        ocr,
        ocrLanguage,
    })

    if (fileType === 'docx') {
        normalizeDocxHeadings(ast.content, extractDocxHeadingStyles(buffer))
    }
    clearDocumentMetadata(ast)

    const lines: string[] = []
    lines.push(await astToMarkdown(ast))

    // Append OCR text from image attachments
    if (ocr && ast.attachments?.length) {
        const ocrTexts = (ast.attachments as OfficeAttachment[])
            .filter(a => a.ocrText?.trim())
            .map(a => `**[OCR – ${a.name || 'image'}]:**\n${a.ocrText!.trim()}`)
        if (ocrTexts.length) {
            lines.push('')
            lines.push('---')
            lines.push('## Extracted Text from Images (OCR)')
            lines.push(...ocrTexts)
        }
    }

    return lines.join('\n\n')
}

// ─── AST → Markdown Conversion ──────────────────────────────────

type ParsedOfficeAst = Awaited<ReturnType<typeof parseOffice>>

function getFileType(filename: string): SupportedFileType | undefined {
    const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
    return PARSEABLE_EXTENSIONS.has(`.${ext}`) ? ext as SupportedFileType : undefined
}

async function astToMarkdown(ast: ParsedOfficeAst): Promise<string> {
    try {
        const result = await ast.to('md', {
            generateIds: false,
            includeCharts: false,
            includeFormatting: false,
            includeImages: false,
            mdConfig: {
                fallbackToHtml: false,
            },
            renderMetadata: false,
        })
        if (typeof result.value === 'string') {
            return normalizeMarkdown(result.value)
        }
    } catch (err) {
        console.warn('[document-parser] Native Markdown conversion failed, using AST fallback:', err)
    }

    return normalizeMarkdown(ast.content
        .map((node) => nodeToMarkdown(node))
        .filter(Boolean)
        .join('\n\n'))
}

function clearDocumentMetadata(ast: ParsedOfficeAst): void {
    const metadata = ast.metadata as Record<string, unknown> | undefined
    if (!metadata) return
    for (const key of Object.keys(metadata)) delete metadata[key]
}

function normalizeMarkdown(markdown: string): string {
    return markdown
        .replace(/^---\n[\s\S]*?\n---\n{0,2}/, '')
        .split('\n')
        .map((line) => stripHtmlTags(decodeBasicHtmlEntities(line.replace(/\s+\{#[^{}\s]+(?:\s+[^{}]+)?\}\s*$/, ''))))
        .filter((line) => {
            const trimmed = line.trim()
            if (!trimmed) return true
            if (/^[-_*=\s]{3,}$/.test(trimmed)) return false
            return /[\p{L}\p{N}]/u.test(trimmed)
        })
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

function stripHtmlTags(text: string): string {
    return text
        .replace(/<\/(?:div|p|br|h[1-6]|li|ul|ol|table|tr)>/gi, ' ')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<\/?[a-z][^>]*>/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
}

function decodeBasicHtmlEntities(text: string): string {
    return text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
}

function extractDocxHeadingStyles(buffer: Buffer): Map<string, number> {
    try {
        const zip = new AdmZip(buffer)
        const entry = zip.getEntry('word/styles.xml')
        if (!entry) return new Map()

        const xml = entry.getData().toString('utf8')
        const styleBlocks = [...xml.matchAll(/<w:style\b[^>]*>[\s\S]*?<\/w:style>/g)]
            .map((match) => match[0])
        const candidates: Array<{ id: string; level: number | null; basedOn: string | null }> = []

        for (const block of styleBlocks) {
            const type = readXmlAttr(block, 'w:type')
            if (type && type !== 'paragraph') continue

            const id = readXmlAttr(block, 'w:styleId')
            if (!id) continue

            const outline = readXmlChildAttr(block, 'w:outlineLvl', 'w:val')
            const outlineLevel = outline == null ? null : clampHeadingLevel(Number(outline) + 1)
            const name = readXmlChildAttr(block, 'w:name', 'w:val') || ''
            const level = outlineLevel
                || headingLevelFromStyleId(id)
                || headingLevelFromStyleId(name)

            candidates.push({
                id,
                level,
                basedOn: readXmlChildAttr(block, 'w:basedOn', 'w:val'),
            })
        }

        const levels = new Map<string, number>()
        for (const candidate of candidates) {
            if (candidate.level) levels.set(candidate.id, candidate.level)
        }

        for (let pass = 0; pass < 3; pass++) {
            let changed = false
            for (const candidate of candidates) {
                if (levels.has(candidate.id) || !candidate.basedOn) continue
                const parentLevel = levels.get(candidate.basedOn)
                if (!parentLevel) continue
                levels.set(candidate.id, parentLevel)
                changed = true
            }
            if (!changed) break
        }

        return levels
    } catch (err) {
        console.warn('[document-parser] Failed to read DOCX heading styles; using parser headings only:', err)
        return new Map()
    }
}

function normalizeDocxHeadings(nodes: OfficeContentNode[], headingStyles: Map<string, number>): void {
    const hasStructuralStyles = headingStyles.size > 0

    for (const node of nodes) {
        if (node.children?.length) normalizeDocxHeadings(node.children, headingStyles)
        if (node.type !== 'paragraph' && node.type !== 'heading') continue

        const text = node.text?.trim()
        if (!text) continue

        const meta = node.metadata as Record<string, unknown> | undefined
        const style = typeof meta?.style === 'string' ? meta.style : ''
        const level = style
            ? headingStyles.get(style) || headingLevelFromStyleId(style)
            : null

        if (level) {
            node.type = 'heading'
            node.metadata = { ...(meta || {}), level }
            continue
        }

        if (node.type === 'heading' && hasStructuralStyles) {
            node.type = 'paragraph'
            if (meta) {
                delete meta.level
                if (!Object.keys(meta).length) node.metadata = undefined
            }
        }
    }
}

function readXmlAttr(xml: string, attrName: string): string | null {
    const unprefixed = attrName.replace(/^w:/, '')
    const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const escapedUnprefixed = unprefixed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return xml.match(new RegExp(`\\s(?:${escaped}|${escapedUnprefixed})="([^"]*)"`))?.[1] || null
}

function readXmlChildAttr(xml: string, tagName: string, attrName: string): string | null {
    const unprefixedTag = tagName.replace(/^w:/, '')
    const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const escapedUnprefixedTag = unprefixedTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const child = xml.match(new RegExp(`<(?:${escapedTag}|${escapedUnprefixedTag})\\b[^>]*/?>`))?.[0]
    return child ? readXmlAttr(child, attrName) : null
}

function headingLevelFromStyleId(style: string): number | null {
    const normalized = style.trim()
    const match = normalized.match(DOCX_HEADING_STYLE_RE)
    if (match) return clampHeadingLevel(Number(match[1] || match[2]))
    if (/^(?:title|titel)$/i.test(normalized)) return 1
    if (/^(?:subtitle|untertitel)$/i.test(normalized)) return 2
    return null
}

function clampHeadingLevel(level: number): number | null {
    if (!Number.isFinite(level)) return null
    return Math.max(1, Math.min(6, Math.floor(level)))
}

function nodeToMarkdown(node: OfficeContentNode, depth = 0): string {
    // Use 'any' for metadata access since the union type doesn't allow direct property access
    const meta = node.metadata as Record<string, unknown> | undefined
    switch (node.type) {
        case 'heading': {
            const level = Math.min((meta?.level as number) || 1, 6)
            return `${'#'.repeat(level)} ${node.text || ''}`
        }

        case 'paragraph':
        case 'text':
            return node.text || ''

        case 'list':
            return listItemToMarkdown(node)

        case 'table':
            return tableToMarkdown(node)

        case 'sheet':
            return sheetToMarkdown(node)

        case 'row':
            return rowToMarkdown(node)

        case 'cell':
            return cellText(node)

        case 'note':
            return `> **Note${meta?.noteType ? ` (${meta.noteType})` : ''}:** ${node.text || ''}`

        case 'image':
            return `[Image: ${meta?.altText || meta?.attachmentName || 'embedded image'}]`

        case 'chart':
            return `[Chart: ${meta?.attachmentName || 'embedded chart'}]`

        default:
            if (node.children?.length) {
                return node.children.map(child => nodeToMarkdown(child, depth + 1)).filter(Boolean).join('\n\n')
            }
            return node.text || ''
    }
}

function listItemToMarkdown(node: OfficeContentNode): string {
    const meta = node.metadata as Record<string, unknown> | undefined
    const indent = '  '.repeat((meta?.indentation as number) || 0)
    const isOrdered = meta?.listType === 'ordered'
    const idx = ((meta?.itemIndex as number) ?? 0) + 1
    const bullet = isOrdered ? `${idx}.` : '-'
    return `${indent}${bullet} ${node.text || ''}`
}

function tableToMarkdown(tableNode: OfficeContentNode): string {
    const rows = (tableNode.children || []).filter(r => r.type === 'row')
    if (!rows.length) return ''

    const tableRows = rows.map(rowToCells)

    if (!tableRows.length || !tableRows[0].length) return ''

    return rowsToMarkdownTable(tableRows)
}

function sheetToMarkdown(sheetNode: OfficeContentNode): string {
    const meta = sheetNode.metadata as Record<string, unknown> | undefined
    const sheetName = typeof meta?.sheetName === 'string' ? meta.sheetName : undefined
    const rows = (sheetNode.children || []).filter(r => r.type === 'row')
    const tableRows = rows.map(rowToCells).filter(r => r.some(cell => cell.trim()))
    const parts: string[] = []

    if (sheetName) parts.push(`## ${sheetName}`)
    if (tableRows.length) parts.push(rowsToMarkdownTable(tableRows))

    const nonRows = (sheetNode.children || [])
        .filter(child => child.type !== 'row')
        .map(child => nodeToMarkdown(child))
        .filter(Boolean)
    parts.push(...nonRows)

    return parts.join('\n\n')
}

function rowToMarkdown(rowNode: OfficeContentNode): string {
    return rowToCells(rowNode).filter(Boolean).join(' | ')
}

function rowToCells(rowNode: OfficeContentNode): string[] {
    const cells = (rowNode.children || []).filter(c => c.type === 'cell')
    const row: string[] = []

    for (const cell of cells) {
        const meta = cell.metadata as Record<string, unknown> | undefined
        const col = typeof meta?.col === 'number' ? meta.col : row.length
        row[col] = escapeTableCell(cellText(cell))
    }

    return row.map(cell => cell || '')
}

function cellText(cellNode: OfficeContentNode): string {
    if (cellNode.text?.trim()) return cellNode.text.trim()
    if (!cellNode.children?.length) return ''
    return cellNode.children.map(child => cellText(child)).join('').trim()
}

function rowsToMarkdownTable(tableRows: string[][]): string {
    const colCount = Math.max(...tableRows.map(r => r.length))
    const normalized = tableRows.map(r => {
        const copy = [...r]
        while (copy.length < colCount) copy.push('')
        return copy
    })

    const lines: string[] = []
    lines.push('| ' + normalized[0].join(' | ') + ' |')
    lines.push('| ' + normalized[0].map(() => '---').join(' | ') + ' |')
    for (let i = 1; i < normalized.length; i++) {
        lines.push('| ' + normalized[i].join(' | ') + ' |')
    }

    return lines.join('\n')
}

function escapeTableCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()
}
