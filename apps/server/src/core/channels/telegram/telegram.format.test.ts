import { describe, expect, test } from 'vitest'
import { formatTelegramHtml } from './telegram.format.js'

describe('formatTelegramHtml', () => {
    test('converts common Markdown to Telegram HTML', () => {
        expect(formatTelegramHtml('## Title\n\n**bold**, *italic*, ~~gone~~ and `a<b`'))
            .toBe('<b>Title</b>\n\n<b>bold</b>, <i>italic</i>, <s>gone</s> and <code>a&lt;b</code>')
    })

    test('keeps backticks and backslashes inside fenced code intact', () => {
        expect(formatTelegramHtml('```ts\nconst s = `x` + "\\\\"\n```'))
            .toBe('<pre><code class="language-ts">const s = `x` + "\\\\"</code></pre>')
    })

    test('renders lists, task items, and nested lists', () => {
        expect(formatTelegramHtml('- one\n- [x] done\n  - nested\n\n1. first\n2. second'))
            .toBe('• one\n☑ done\n  • nested\n\n1. first\n2. second')
    })

    test('renders tables as monospace blocks', () => {
        expect(formatTelegramHtml('| a | bb |\n|---|---|\n| 1 | 2 |'))
            .toBe('<pre>a │ bb\n──┼───\n1 │ 2</pre>')
    })

    test('escapes HTML and leaves unbalanced markers as text', () => {
        expect(formatTelegramHtml('<script> & **unclosed')).toBe('&lt;script&gt; &amp; **unclosed')
    })

    test('drops links with schemes Telegram rejects', () => {
        expect(formatTelegramHtml('[ok](https://a.com/?a=1&b=2) [bad](javascript:alert(1))'))
            .toBe('<a href="https://a.com/?a=1&amp;b=2">ok</a> bad')
    })

    test('converts GFM callouts inside blockquotes', () => {
        expect(formatTelegramHtml('> [!WARNING]\n> Careful')).toBe('<blockquote>⚠️ WARNING\nCareful</blockquote>')
    })
})
