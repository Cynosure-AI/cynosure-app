/**
 * Text matching shared by the memory and file edit tools. Models often render
 * typographic quotes, dashes, non-breaking spaces, or decomposed Unicode
 * differently from the source; matching folds those variants while keeping a
 * safe mapping back to offsets in the original text.
 */

export interface NormalizedPatchText {
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
export function normalizePatchText(source: string): NormalizedPatchText {
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
