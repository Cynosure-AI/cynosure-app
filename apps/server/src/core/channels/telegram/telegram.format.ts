import { Lexer, type Token, type Tokens } from 'marked'

/**
 * Converts standard (GFM) Markdown to Telegram's HTML parse mode.
 *
 * HTML only needs `<`, `>` and `&` escaped, so unlike MarkdownV2 a stray or
 * unbalanced character can't make Telegram reject the whole message.
 * Mapping for constructs Telegram has no native entity for:
 * - Headings → bold line
 * - Lists → "•" / "1." prefixed lines, nested lists indented
 * - Tables → monospace <pre> block with padded columns
 * - Horizontal rules → a line of box-drawing characters
 * - GFM callouts [!NOTE], [!WARNING], etc. → emoji labels
 */
export function formatTelegramHtml(markdown: string): string {
    const html = renderBlocks(Lexer.lex(markdown, { gfm: true }))
    return html.trim() ? html : escapeHtml(markdown)
}

const CALLOUT_EMOJI: Record<string, string> = {
    NOTE: '📝', TIP: '💡', WARNING: '⚠️', CAUTION: '🚨', IMPORTANT: '❗',
}

/** Link schemes Telegram accepts in <a href>; anything else is rejected with a parse error. */
const SAFE_LINK = /^(https?|tg|mailto):/i

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(text: string): string {
    return escapeHtml(text).replace(/"/g, '&quot;')
}

function renderBlocks(tokens: Token[], separator = '\n\n'): string {
    return tokens.map(renderBlock).filter(Boolean).join(separator)
}

function renderBlock(token: Token): string {
    switch (token.type) {
        case 'heading':
            return `<b>${renderInline((token as Tokens.Heading).tokens)}</b>`
        case 'paragraph':
            return renderInline((token as Tokens.Paragraph).tokens)
        case 'text': {
            const t = token as Tokens.Text
            return t.tokens ? renderInline(t.tokens) : renderText(t.text)
        }
        case 'code': {
            const t = token as Tokens.Code
            const lang = t.lang?.match(/^[\w+-]+/)?.[0]
            const code = escapeHtml(t.text)
            return lang ? `<pre><code class="language-${lang}">${code}</code></pre>` : `<pre>${code}</pre>`
        }
        case 'blockquote':
            return `<blockquote>${renderBlocks((token as Tokens.Blockquote).tokens, '\n')}</blockquote>`
        case 'list':
            return renderList(token as Tokens.List, 0)
        case 'table':
            return renderTable(token as Tokens.Table)
        case 'hr':
            return '──────────'
        case 'space':
            return ''
        default:
            return escapeHtml(token.raw)
    }
}

function renderList(list: Tokens.List, depth: number): string {
    const indent = '  '.repeat(depth)
    const start = typeof list.start === 'number' ? list.start : 1
    return list.items.map((item, i) => {
        const marker = item.task ? (item.checked ? '☑' : '☐') : list.ordered ? `${start + i}.` : '•'
        const parts: string[] = []
        const nested: string[] = []
        for (const child of item.tokens) {
            if (child.type === 'list') nested.push(renderList(child as Tokens.List, depth + 1))
            else if (child.type !== 'checkbox') parts.push(renderBlock(child))
        }
        const body = parts.filter(Boolean).join('\n').replace(/\n/g, `\n${indent}   `)
        return [`${indent}${marker} ${body}`, ...nested].join('\n')
    }).join('\n')
}

function renderTable(table: Tokens.Table): string {
    const rows = [table.header.map(c => c.text), ...table.rows.map(r => r.map(c => c.text))]
    const widths = table.header.map((_, col) => Math.max(...rows.map(r => (r[col] ?? '').length)))
    const line = (cells: string[]) => cells.map((c, col) => (c ?? '').padEnd(widths[col])).join(' │ ').trimEnd()
    const divider = widths.map(w => '─'.repeat(w)).join('─┼─')
    const [header, ...body] = rows
    return `<pre>${escapeHtml([line(header), divider, ...body.map(line)].join('\n'))}</pre>`
}

function renderInline(tokens: Token[] | undefined): string {
    return (tokens ?? []).map(renderInlineToken).join('')
}

function renderInlineToken(token: Token): string {
    switch (token.type) {
        case 'strong':
            return `<b>${renderInline((token as Tokens.Strong).tokens)}</b>`
        case 'em':
            return `<i>${renderInline((token as Tokens.Em).tokens)}</i>`
        case 'del':
            return `<s>${renderInline((token as Tokens.Del).tokens)}</s>`
        case 'codespan':
            return `<code>${escapeHtml((token as Tokens.Codespan).text)}</code>`
        case 'br':
            return '\n'
        case 'link': {
            const t = token as Tokens.Link
            const label = renderInline(t.tokens)
            return SAFE_LINK.test(t.href) ? `<a href="${escapeAttr(t.href)}">${label}</a>` : label
        }
        case 'image': {
            const t = token as Tokens.Image
            const label = escapeHtml(t.text || t.href)
            return SAFE_LINK.test(t.href) ? `<a href="${escapeAttr(t.href)}">${label}</a>` : label
        }
        case 'text': {
            const t = token as Tokens.Text
            return t.tokens ? renderInline(t.tokens) : renderText(t.text)
        }
        case 'escape':
            return escapeHtml((token as Tokens.Escape).text)
        default:
            return escapeHtml(token.raw)
    }
}

function renderText(text: string): string {
    return escapeHtml(text).replace(/\[!(NOTE|TIP|WARNING|CAUTION|IMPORTANT)\]/gi, (_, label: string) => {
        const upper = label.toUpperCase()
        return `${CALLOUT_EMOJI[upper]} ${upper}`
    })
}
