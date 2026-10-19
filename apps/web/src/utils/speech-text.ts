/**
 * Turn assistant Markdown into text worth speaking, and cut it into sentences
 * so speech can start before a reply has finished streaming.
 */

/** Sentences longer than this are split at a comma or space so the first audio arrives quickly. */
const MAX_SENTENCE_LENGTH = 280

/** Words whose trailing period does not end a sentence (English and German). */
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|approx|Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|No|z\.B|d\.h|u\.a|bzw|ca|usw|Nr|evtl|ggf|inkl|vgl|[A-Z])\.$/

const FENCE = /^(```|~~~)/
const TABLE_ROW = /^\|.*\|$/
const TABLE_DIVIDER = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/

/** Speakable plain text from Markdown: code, tables, URLs and emoji are left out. */
export function toSpeakableText(markdown: string): string {
    const text = markdown
        .replace(/\r\n?/g, '\n')
        .replace(/(^|\n)\s*(```|~~~)[\s\S]*?(?:\n\s*\2[^\n]*|$)/g, '\n')
        .replace(/<[^>\n]+>/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/\S+/g, ' ')

    const lines: string[] = []
    for (const raw of text.split('\n')) {
        const trimmed = raw.trim()
        if (!trimmed || TABLE_ROW.test(trimmed) || TABLE_DIVIDER.test(trimmed) || RULE.test(trimmed)) continue
        let line = trimmed
            .replace(/^#{1,6}\s+/, '')
            .replace(/^(?:>\s?)+/, '')
            .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
            .replace(/^\[[ xX]\]\s+/, '')
            .replace(/\*\*|__|~~|[*`#]/g, '')
            .replace(/_/g, ' ')
            .replace(/\p{Extended_Pictographic}️?/gu, '')
            .replace(/\s+/g, ' ')
            .trim()
        if (!line || !/[\p{L}\p{N}]/u.test(line)) continue
        // Headings and list items rarely end in punctuation; a period gives the voice a pause.
        if (!/[.!?…:;,]$/.test(line)) line += '.'
        lines.push(line)
    }
    return lines.join(' ')
}

function endsWithAbbreviation(text: string): boolean {
    return ABBREVIATION.test(text)
}

function splitLong(sentence: string): string[] {
    const parts: string[] = []
    let rest = sentence
    while (rest.length > MAX_SENTENCE_LENGTH) {
        const window = rest.slice(0, MAX_SENTENCE_LENGTH)
        const comma = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '))
        const cut = comma > MAX_SENTENCE_LENGTH / 3 ? comma + 1 : window.lastIndexOf(' ')
        if (cut <= 0) break
        parts.push(rest.slice(0, cut).trim())
        rest = rest.slice(cut).trim()
    }
    if (rest) parts.push(rest)
    return parts
}

/** Split plain text into sentences, keeping abbreviations and decimals intact. */
export function splitSentences(text: string): string[] {
    const sentences: string[] = []
    let start = 0
    const boundary = /[.!?…]+["'”’)\]]*(?=\s)/g
    for (let match = boundary.exec(text); match; match = boundary.exec(text)) {
        const end = match.index + match[0].length
        if (endsWithAbbreviation(text.slice(start, end))) continue
        const sentence = text.slice(start, end).trim()
        if (sentence) sentences.push(sentence)
        start = end
    }
    const tail = text.slice(start).trim()
    if (tail) sentences.push(tail)
    return sentences.flatMap(splitLong)
}

/**
 * Where a streaming Markdown buffer can be cut without breaking a sentence,
 * a code block or a table row: after a finished line, or after a sentence end
 * that is already followed by whitespace.
 */
export function lastSpeakableCut(buffer: string): number {
    let cut = 0
    let inFence = false
    let lineStart = 0
    for (let i = 0; i < buffer.length; i++) {
        const char = buffer[i]
        if (char === '\n') {
            if (FENCE.test(buffer.slice(lineStart, i).trim())) inFence = !inFence
            if (!inFence) cut = i + 1
            lineStart = i + 1
            continue
        }
        if (inFence || !/[.!?…]/.test(char) || !/\s/.test(buffer[i + 1] ?? '')) continue
        const line = buffer.slice(lineStart, i + 1).trimStart()
        if (line.startsWith('|') || FENCE.test(line) || endsWithAbbreviation(line)) continue
        cut = i + 1
    }
    return cut
}

/** Collects streamed Markdown and hands out whole sentences as they complete. */
export class SpeechStreamChunker {
    private buffer = ''

    push(delta: string): string[] {
        this.buffer += delta
        const cut = lastSpeakableCut(this.buffer)
        if (cut === 0) return []
        const ready = this.buffer.slice(0, cut)
        this.buffer = this.buffer.slice(cut)
        return splitSentences(toSpeakableText(ready))
    }

    flush(): string[] {
        const rest = this.buffer
        this.buffer = ''
        return splitSentences(toSpeakableText(rest))
    }

    reset(): void {
        this.buffer = ''
    }
}
