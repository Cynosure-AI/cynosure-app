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

interface PageLines {
    height: number
    lines: Line[]
}

interface Bookmark {
    title: string
    items: Bookmark[]
}

const normalizeLine = (text: string): string => text.trim().replace(/\s+/g, ' ')

function repeatedMarginNoise(pages: PageLines[]): Set<string> {
    if (pages.length < 2) return new Set()
    const occurrences = new Map<string, Set<number>>()
    pages.forEach((page, pageIndex) => {
        for (const line of page.lines) {
            if (line.y > page.height * 0.88 || line.y < page.height * 0.12) {
                const text = normalizeLine(line.text)
                if (!text) continue
                const key = /^(?:page\s*)?\d+(?:\s*(?:of|\/)\s*\d+)?$/i.test(text) ? '<page-number>' : text
                const pageNumbers = occurrences.get(key) ?? new Set<number>()
                pageNumbers.add(pageIndex)
                occurrences.set(key, pageNumbers)
            }
        }
    })
    const minimumPages = Math.max(2, Math.ceil(pages.length * 0.6))
    return new Set([...occurrences].filter(([, pageNumbers]) => pageNumbers.size >= minimumPages).map(([text]) => text))
}

function isMarginNoise(line: Line, page: PageLines, noise: Set<string>): boolean {
    if (line.y <= page.height * 0.12 || line.y >= page.height * 0.88) {
        const text = normalizeLine(line.text)
        const key = /^(?:page\s*)?\d+(?:\s*(?:of|\/)\s*\d+)?$/i.test(text) ? '<page-number>' : text
        return noise.has(key)
    }
    return false
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
        const visit = (entries: Bookmark[], level: number): void => {
            for (const entry of entries) {
                headings.set(normalizeLine(entry.title), Math.min(level, 6))
                visit(entry.items, level + 1)
            }
        }
        // Broken optional bookmarks must not prevent text extraction.
        const outline = await pdf.getOutline().catch(() => null)
        if (outline) visit(outline, 1)

        const pages: PageLines[] = []
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
            const page = await pdf.getPage(pageNumber)
            try {
                const content = await page.getTextContent()
                const items = content.items.filter(item => 'str' in item)
                pages.push({ height: page.getViewport({ scale: 1 }).height, lines: toLines(items) })
            } finally {
                page.cleanup()
            }
        }

        const marginNoise = repeatedMarginNoise(pages)
        const sizes = new Map<number, number>()
        for (const page of pages) {
            for (const line of page.lines) {
                if (line.size > 0 && !isMarginNoise(line, page, marginNoise)) {
                    sizes.set(line.size, (sizes.get(line.size) || 0) + line.text.length)
                }
            }
        }
        // Character-weighted mode prevents short titles from defining body size.
        const bodySize = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] || 0
        const headingSizes = [...new Set(pages.flatMap(page => page.lines.filter(line =>
            !isMarginNoise(line, page, marginNoise) && line.text.length <= 160 && line.size >= bodySize * 1.2 && bodySize > 0,
        ).map(line => line.size)))].sort((a, b) => b - a)
        const markdown = pages.map(page => {
            const blocks: string[] = []
            let previous: Line | undefined
            let previousHeading = false
            for (const line of page.lines) {
                if (isMarginNoise(line, page, marginNoise)) continue
                const inferred = line.text.length <= 160 ? headingSizes.indexOf(line.size) : -1
                const level = headings.get(normalizeLine(line.text)) ?? (inferred >= 0 ? Math.min(inferred + 1, 6) : 0)
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
