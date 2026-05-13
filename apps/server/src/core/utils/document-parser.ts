/**
 * Document parser utility – uses officeparser to extract structured content
 * from office documents (docx, pptx, xlsx, odt, odp, ods, pdf, rtf)
 * and converts the AST to Markdown for LLM consumption.
 */
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
export async function parseDocument(buffer: Buffer, _filename: string): Promise<string> {
    const { ocrEnabled: ocr, ocrLanguage } = getParserConfig()
    const ast = await parseOffice(buffer, {
        outputErrorToConsole: false,
        extractAttachments: ocr,
        ocr,
        ocrLanguage,
    })

    const lines: string[] = []

    // Add metadata header if available
    const meta = ast.metadata
    if (meta) {
        const metaParts: string[] = []
        if (meta.title) metaParts.push(`**Title:** ${meta.title}`)
        if (meta.author) metaParts.push(`**Author:** ${meta.author}`)
        if (metaParts.length) {
            lines.push(metaParts.join(' | '))
            lines.push('')
        }
    }

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
