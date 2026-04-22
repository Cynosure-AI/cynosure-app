/**
 * Converts standard Markdown to Telegram MarkdownV2 format.
 *
 * Key rules for MarkdownV2:
 * - These chars MUST be escaped outside formatting entities:
 *   _ * [ ] ( ) ~ ` > # + - = | { } . ! \
 * - Code blocks (```...```) and inline code (`...`) pass through unescaped
 * - **text** or *text* → *escaped_text* (bold)
 * - _text_ → _escaped_text_ (italic)
 * - ~~text~~ → ~escaped_text~ (strikethrough)
 * - [text](url) → [escaped_text](url) (link)
 * - > blockquote lines are preserved (native MarkdownV2 feature)
 * - GFM callouts [!NOTE], [!WARNING], etc. are converted to emoji labels
 */
export function formatTelegramMessage(text: string): string {
    const escapeChar = (c: string): string =>
        /[_*[\]()~`>#+=|{}.!\\-]/.test(c) ? '\\' + c : c

    const escapeStr = (s: string): string => [...s].map(escapeChar).join('')

    const out: string[] = []
    let i = 0
    const s = text

    while (i < s.length) {
        // Fenced code block: ```...```
        if (s.slice(i, i + 3) === '```') {
            const close = s.indexOf('```', i + 3)
            if (close >= 0) {
                out.push(s.slice(i, close + 3))
                i = close + 3
                continue
            }
        }

        // Inline code: `...`
        if (s[i] === '`') {
            const close = s.indexOf('`', i + 1)
            if (close > i) {
                out.push(s.slice(i, close + 1))
                i = close + 1
                continue
            }
        }

        // Bold: **text**
        if (s.slice(i, i + 2) === '**') {
            const close = s.indexOf('**', i + 2)
            if (close > i) {
                out.push('*' + escapeStr(s.slice(i + 2, close)) + '*')
                i = close + 2
                continue
            }
        }

        // Strikethrough: ~~text~~
        if (s.slice(i, i + 2) === '~~') {
            const close = s.indexOf('~~', i + 2)
            if (close > i) {
                out.push('~' + escapeStr(s.slice(i + 2, close)) + '~')
                i = close + 2
                continue
            }
        }

        // GFM callouts: [!NOTE], [!TIP], [!WARNING], [!CAUTION], [!IMPORTANT]
        if (s[i] === '[' && s[i + 1] === '!') {
            const closeB = s.indexOf(']', i + 2)
            if (closeB > i) {
                const label = s.slice(i + 2, closeB).toUpperCase()
                const emoji: Record<string, string> = {
                    NOTE: '📝', TIP: '💡', WARNING: '⚠️', CAUTION: '🚨', IMPORTANT: '❗',
                }
                if (emoji[label]) {
                    out.push(emoji[label] + ' ' + label)
                    i = closeB + 1
                    continue
                }
            }
        }

        // Link: [text](url)
        if (s[i] === '[') {
            const closeB = s.indexOf(']', i + 1)
            if (closeB > i && s[closeB + 1] === '(') {
                const closeP = s.indexOf(')', closeB + 2)
                if (closeP > closeB) {
                    const linkText = s.slice(i + 1, closeB)
                    const url = s.slice(closeB + 2, closeP)
                    out.push('[' + escapeStr(linkText) + '](' + url.replace(/[)\\]/g, '\\$&') + ')')
                    i = closeP + 1
                    continue
                }
            }
        }

        // Bold: *text* (single asterisk, not space/newline after)
        if (s[i] === '*' && s[i + 1] !== '*' && s[i + 1] !== ' ' && s[i + 1] !== '\n' && s[i + 1] !== undefined) {
            const close = s.indexOf('*', i + 1)
            if (close > i && !s.slice(i + 1, close).includes('\n')) {
                out.push('*' + escapeStr(s.slice(i + 1, close)) + '*')
                i = close + 1
                continue
            }
        }

        // Italic: _text_ (single underscore, not space after)
        if (s[i] === '_' && s[i + 1] !== '_' && s[i + 1] !== ' ' && s[i + 1] !== undefined) {
            const close = s.indexOf('_', i + 1)
            if (close > i && !s.slice(i + 1, close).includes('\n')) {
                out.push('_' + escapeStr(s.slice(i + 1, close)) + '_')
                i = close + 1
                continue
            }
        }

        // Blockquote: > at start of line — preserve as MarkdownV2 blockquote
        if (s[i] === '>' && (i === 0 || s[i - 1] === '\n')) {
            out.push('>')
            i++
            if (i < s.length && s[i] === ' ') i++ // skip optional space
            continue
        }

        // Default: escape the character
        out.push(escapeChar(s[i]))
        i++
    }

    return out.join('')
}
