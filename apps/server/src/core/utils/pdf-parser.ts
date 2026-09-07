import { getDocumentProxy } from 'unpdf'

interface TextItem {
    str: string
    transform: number[]
    width: number
    hasEOL: boolean
}

interface Line {
    text: string
    size: number
    y: number
}

interface Bookmark {
    title: string
    items: Bookmark[]
}

/** Keep PDF content order: globally sorting coordinates interleaves columns. */
function toLines(items: TextItem[]): Line[] {
    const lines: Line[] = []
    let current: Line | undefined
    let previous: TextItem | undefined
    const flush = () => {
        if (current?.text.trim()) lines.push({ ...current, text: current.text.trim() })
        current = undefined
        previous = undefined
    }

    for (const item of items) {
        const size = Math.round(Math.hypot(item.transform[2], item.transform[3]) * 2) / 2
        const x = item.transform[4]
        const y = item.transform[5]
        if (current && Math.abs(y - current.y) > Math.max(2, current.size * 0.3)) flush()
        if (!current) current = { text: '', size, y }
        if (previous && current.text && !/\s$/.test(current.text) && !/^\s/.test(item.str)) {
            const gap = x - (previous.transform[4] + previous.width)
            if (gap > size * 0.15) current.text += ' '
        }
        current.text += item.str
        if (item.str.trim()) current.size = Math.max(current.size, size)
        previous = item
        if (item.hasEOL) flush()
    }
    flush()
    return lines
}

/**
 * unpdf supplies text geometry, not Markdown. Prefer bookmark hierarchy when
 * a complete line matches a bookmark; otherwise infer short, oversized headings.
 * Tables and visual styling are deliberately left as text rather than guessed.
 */
export async function parsePdfToMarkdown(buffer: Buffer): Promise<string> {
    // PDF.js may transfer its input. Copy so the attachment's original stays intact.
    const pdf = await getDocumentProxy(new Uint8Array(buffer))
    try {
        const headings = new Map<string, number>()
        const normalize = (text: string) => text.trim().replace(/\s+/g, ' ')
        const visit = (entries: Bookmark[], level: number): void => {
            for (const entry of entries) {
                headings.set(normalize(entry.title), Math.min(level, 6))
                visit(entry.items, level + 1)
            }
        }
        // Broken optional bookmarks must not prevent text extraction.
        const outline = await pdf.getOutline().catch(() => null)
        if (outline) visit(outline, 1)

        const pages: Line[][] = []
        const sizes = new Map<number, number>()
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
            const page = await pdf.getPage(pageNumber)
            try {
                const content = await page.getTextContent()
                const items = content.items.filter(item => 'str' in item)
                pages.push(toLines(items))
                for (const item of items) {
                    const size = Math.round(Math.hypot(item.transform[2], item.transform[3]) * 2) / 2
                    if (size > 0) sizes.set(size, (sizes.get(size) || 0) + item.str.trim().length)
                }
            } finally {
                page.cleanup()
            }
        }

        // Character-weighted mode prevents short titles from defining body size.
        const bodySize = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] || 0
        const headingSizes = [...new Set(pages.flat().filter(line =>
            line.text.length <= 160 && line.size >= bodySize * 1.2 && bodySize > 0,
        ).map(line => line.size))].sort((a, b) => b - a)

        const markdown = pages.map(lines => {
            const blocks: string[] = []
            let previous: Line | undefined
            let previousHeading = false
            for (const line of lines) {
                const inferred = line.text.length <= 160 ? headingSizes.indexOf(line.size) : -1
                const level = headings.get(normalize(line.text)) ?? (inferred >= 0 ? Math.min(inferred + 1, 6) : 0)
                const text = line.text.replace(/^[•◦▪●]\s*/, '- ')
                const isList = /^(?:[-*+] |\d+[.)] )/.test(text)
                if (blocks.length && (level || previousHeading || isList ||
                    (previous && Math.abs(previous.y - line.y) > Math.max(previous.size, line.size) * 1.8))) {
                    blocks.push('')
                }
                blocks.push(level ? `${'#'.repeat(level)} ${text}` : text)
                previous = line
                previousHeading = level > 0
            }
            return blocks.join('\n')
        }).filter(Boolean).join('\n\n').trim()

        if (!markdown) throw new Error('PDF contains no extractable text. Scanned PDFs require OCR before ingestion.')
        return markdown
    } finally {
        await pdf.loadingTask.destroy()
    }
}
