/**
 * Document parser utility – uses officeparser to extract structured content
 * from office documents (docx, pptx, xlsx, odt, odp, ods, pdf, rtf)
 * and converts the AST to Markdown for LLM consumption.
 */
import AdmZip from 'adm-zip'
import { parseOffice, type OfficeContentNode, type OfficeAttachment } from 'officeparser'
import { getDb } from '../../db/database.js'

/** File extensions that officeparser can handle */
const PARSEABLE_EXTENSIONS = new Set([
    '.docx', '.pptx', '.xlsx',
    '.odt', '.odp', '.ods',
    '.pdf', '.rtf'
])

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
    if (filename.toLowerCase().endsWith('.docx')) {
        const docxMarkdown = parseDocxToMarkdown(buffer)
        if (docxMarkdown) return docxMarkdown
    }

    const { ocrEnabled: ocr, ocrLanguage } = getParserConfig()
    const ast = await parseOffice(buffer, {
        outputErrorToConsole: false,
        extractAttachments: ocr,
        ocr,
        ocrLanguage,
    })

    const lines: string[] = []

    // Convert content nodes to markdown
    for (const node of ast.content) {
        const md = nodeToMarkdown(node)
        if (md) lines.push(md)
    }

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

// ─── DOCX → Markdown Conversion ─────────────────────────────────

type DocxStyles = {
    headingLevels: Map<string, number>
    listStyles: Set<string>
}

function parseDocxToMarkdown(buffer: Buffer): string {
    try {
        const zip = new AdmZip(buffer)
        const documentXml = getZipText(zip, 'word/document.xml')
        if (!documentXml) return ''

        const styles = parseDocxStyles(getZipText(zip, 'word/styles.xml'))
        const relationships = parseDocxRelationships(getZipText(zip, 'word/_rels/document.xml.rels'))
        const lines: string[] = []

        for (const block of readDocxBodyBlocks(documentXml)) {
            if (block.startsWith('<w:p')) {
                const line = docxParagraphToMarkdown(block, styles, relationships)
                if (line) lines.push(line)
            } else if (block.startsWith('<w:tbl')) {
                const table = docxTableToMarkdown(block)
                if (table) lines.push(table)
            }
        }

        return normalizeMarkdownSpacing(lines).trim()
    } catch (err) {
        console.warn('[document-parser] DOCX structure parse failed, falling back to officeparser:', err)
        return ''
    }
}

function getZipText(zip: AdmZip, entryName: string): string {
    const entry = zip.getEntry(entryName)
    return entry ? entry.getData().toString('utf8') : ''
}

function parseDocxStyles(stylesXml: string): DocxStyles {
    const styleNames = new Map<string, string>()
    const basedOn = new Map<string, string>()
    const outlineLevels = new Map<string, number>()
    const listStyles = new Set<string>()

    for (const style of stylesXml.match(/<w:style\b[\s\S]*?<\/w:style>/g) || []) {
        if (!/\bw:type="paragraph"/.test(style)) continue

        const id = readAttr(style, 'styleId')
        if (!id) continue

        const name = readTagAttr(style, 'w:name', 'val')
        if (name) styleNames.set(id, name)

        const parent = readTagAttr(style, 'w:basedOn', 'val')
        if (parent) basedOn.set(id, parent)

        const outline = readTagAttr(style, 'w:outlineLvl', 'val')
        if (outline !== undefined) outlineLevels.set(id, Number.parseInt(outline, 10) + 1)

        if (/\blist\b/i.test(name || '') || style.includes('<w:numPr>')) listStyles.add(id)
    }

    const headingLevels = new Map<string, number>()
    for (const id of styleNames.keys()) {
        const level = resolveHeadingLevel(id, styleNames, basedOn, outlineLevels, new Set())
        if (level) headingLevels.set(id, level)
    }

    return { headingLevels, listStyles }
}

function resolveHeadingLevel(
    id: string,
    styleNames: Map<string, string>,
    basedOn: Map<string, string>,
    outlineLevels: Map<string, number>,
    seen: Set<string>
): number | undefined {
    if (seen.has(id)) return undefined
    seen.add(id)

    const outline = outlineLevels.get(id)
    if (outline) return clampHeadingLevel(outline)

    const named = styleNames.get(id)?.match(/^heading\s+([1-6])$/i)
    if (named) return Number.parseInt(named[1], 10)

    const parent = basedOn.get(id)
    return parent ? resolveHeadingLevel(parent, styleNames, basedOn, outlineLevels, seen) : undefined
}

function parseDocxRelationships(relsXml: string): Map<string, string> {
    const relationships = new Map<string, string>()
    for (const rel of relsXml.match(/<Relationship\b[^>]*\/?>/g) || []) {
        const id = readAttr(rel, 'Id')
        const target = readAttr(rel, 'Target')
        if (id && target) relationships.set(id, decodeXml(target))
    }
    return relationships
}

function readDocxBodyBlocks(documentXml: string): string[] {
    const body = documentXml.match(/<w:body\b[\s\S]*?<\/w:body>/)?.[0] || documentXml
    return body.match(/<w:(?:p|tbl)\b[\s\S]*?<\/w:(?:p|tbl)>/g) || []
}

function docxParagraphToMarkdown(paragraphXml: string, styles: DocxStyles, relationships: Map<string, string>): string {
    const text = extractDocxParagraphText(paragraphXml, relationships).trim()
    const styleId = readTagAttr(paragraphXml, 'w:pStyle', 'val')
    const headingLevel = styleId ? styles.headingLevels.get(styleId) : undefined

    if (!text) return ''
    if (headingLevel) return `${'#'.repeat(clampHeadingLevel(headingLevel))} ${text}`

    const numbering = readDocxNumbering(paragraphXml)
    if (numbering || (styleId && styles.listStyles.has(styleId))) {
        const indent = '  '.repeat(numbering?.level || 0)
        return `${indent}- ${text}`
    }

    return text
}

function readDocxNumbering(paragraphXml: string): { level: number; numId?: string } | undefined {
    const numPr = paragraphXml.match(/<w:numPr\b[\s\S]*?<\/w:numPr>/)?.[0]
    if (!numPr) return undefined

    const level = Number.parseInt(readTagAttr(numPr, 'w:ilvl', 'val') || '0', 10)
    return {
        level: Number.isFinite(level) ? Math.max(0, level) : 0,
        numId: readTagAttr(numPr, 'w:numId', 'val'),
    }
}

function extractDocxParagraphText(paragraphXml: string, relationships: Map<string, string>): string {
    const parts: string[] = []
    let cursor = 0
    const hyperlinks = [...paragraphXml.matchAll(/<w:hyperlink\b[^>]*>[\s\S]*?<\/w:hyperlink>/g)]

    for (const hyperlink of hyperlinks) {
        const start = hyperlink.index || 0
        parts.push(extractDocxPlainText(paragraphXml.slice(cursor, start)))

        const hyperlinkXml = hyperlink[0]
        const label = extractDocxPlainText(hyperlinkXml).trim()
        const relationshipId = readAttr(hyperlinkXml, 'id')
        const anchor = readAttr(hyperlinkXml, 'anchor')
        const target = relationshipId ? relationships.get(relationshipId) : undefined

        if (label && target) parts.push(`[${label}](${target})`)
        else if (label && anchor) parts.push(`[${label}](#${anchor})`)
        else parts.push(label)

        cursor = start + hyperlinkXml.length
    }

    parts.push(extractDocxPlainText(paragraphXml.slice(cursor)))
    return compactInlineText(parts.join(''))
}

function extractDocxPlainText(xml: string): string {
    return xml
        .replace(/<w:tab\b[^>]*\/>/g, '\t')
        .replace(/<w:br\b[^>]*\/>/g, '\n')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, (_, text: string) => decodeXml(text))
        .replace(/<[^>]+>/g, '')
}

function docxTableToMarkdown(tableXml: string): string {
    const rows = (tableXml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [])
        .map(rowXml => (rowXml.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || [])
            .map(cellXml => compactInlineText(extractDocxPlainText(cellXml)).replace(/\n+/g, '<br>')))
        .filter(row => row.some(cell => cell.trim()))

    return rows.length ? rowsToMarkdownTable(rows) : ''
}

function normalizeMarkdownSpacing(lines: string[]): string {
    const out: string[] = []

    for (const line of lines) {
        const trimmed = line.trimEnd()
        if (!trimmed) continue

        const previous = out[out.length - 1]
        if (previous && shouldSeparateMarkdownBlocks(previous, trimmed)) out.push('')
        out.push(trimmed)
    }

    return out.join('\n')
}

function shouldSeparateMarkdownBlocks(previous: string, next: string): boolean {
    if (previous.startsWith('#') || next.startsWith('#')) return true
    if (previous.startsWith('|') || next.startsWith('|')) return true
    if (/^\s*- /.test(previous) && !/^\s*- /.test(next)) return true
    if (!/^\s*- /.test(previous) && /^\s*- /.test(next)) return true
    return false
}

function readTagAttr(xml: string, tagName: string, attrName: string): string | undefined {
    const tag = xml.match(new RegExp(`<${escapeRegex(tagName)}\\b[^>]*>`))?.[0]
    return tag ? readAttr(tag, attrName) : undefined
}

function readAttr(tagXml: string, attrName: string): string | undefined {
    const escaped = escapeRegex(attrName)
    const pattern = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${escaped}="([^"]*)"`)
    const value = tagXml.match(pattern)?.[1]
    return value === undefined ? undefined : decodeXml(value)
}

function compactInlineText(value: string): string {
    return value
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
}

function decodeXml(value: string): string {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function clampHeadingLevel(level: number): number {
    return Math.min(Math.max(level, 1), 6)
}

// ─── AST → Markdown Conversion ──────────────────────────────────

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
