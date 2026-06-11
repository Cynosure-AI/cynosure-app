import { marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import java from 'highlight.js/lib/languages/java'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import php from 'highlight.js/lib/languages/php'
import ruby from 'highlight.js/lib/languages/ruby'
import plaintext from 'highlight.js/lib/languages/plaintext'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('java', java)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('c', cpp)
hljs.registerLanguage('csharp', csharp)
hljs.registerLanguage('cs', csharp)
hljs.registerLanguage('php', php)
hljs.registerLanguage('ruby', ruby)
hljs.registerLanguage('rb', ruby)
hljs.registerLanguage('plaintext', plaintext)
hljs.registerLanguage('text', plaintext)

marked.use(
    markedHighlight({
        emptyLangClass: 'hljs',
        langPrefix: 'hljs language-',
        highlight(code: string, lang: string) {
            let clean = code
                .replace(/<span\s+class="hljs-[^"]*">/g, '')
                .replace(/<\/span>/g, '')
            if (!/^(html|xml|svg|xhtml|htm)$/i.test(lang || '')) {
                clean = clean
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&apos;/g, "'")
                    .replace(/&nbsp;/g, ' ')
            }
            clean = clean
                .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)))
                .replace(/&#x([a-fA-F0-9]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
            if (lang && hljs.getLanguage(lang)) {
                return hljs.highlight(clean, { language: lang }).value
            }
            return hljs.highlightAuto(clean).value
        }
    })
)

marked.use({
    renderer: {
        link({ href, text }: { href: string; text: string }) {
            const safeHref = (href || '').replace(/["<>]/g, '')
            return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${text}</a>`
        },
        code({ text, lang, escaped }: { text: string; lang?: string; escaped?: boolean }) {
            const langLabel = (lang || '').split(/\s/)[0].replace(/[<>&"']/g, '')
            const codeContent = escaped ? text : text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            const langClass = langLabel ? `hljs language-${langLabel}` : 'hljs'
            const copyBtn = `<button class="code-copy-btn" title="Copy code"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>`
            const headerHtml = `<div class="code-header"><span>${langLabel}</span>${copyBtn}</div>`
            return `<div class="code-block-wrapper">${headerHtml}<pre><code class="${langClass}">${codeContent}</code></pre></div>`
        }
    }
})

marked.setOptions({ breaks: true })

/** Rewrite local filesystem paths in rendered media/link attributes to use the file-serving API. */
function rewriteLocalFilePaths(html: string): string {
    return html
      .replace(
        /(<img\s[^>]*\bsrc=["'])((?:file:\/\/)?\/[^"']+)(["'])/gi,
        (_match, before, src, after) => {
            const cleanPath = src.replace(/^file:\/\//, '')
            if (cleanPath.startsWith('/api/') || cleanPath.startsWith('/ws')) return _match
            return `${before}/api/files?path=${encodeURIComponent(cleanPath)}${after}`
        }
      )
      .replace(
        /(<a\s[^>]*\bhref=["'])((?:file:\/\/)?\/[^"']+\.(?:pdf|docx?|odt|rtf|txt|md))(["'])/gi,
        (_match, before, href, after) => {
            const cleanPath = href.replace(/^file:\/\//, '')
            if (cleanPath.startsWith('/api/') || cleanPath.startsWith('/ws')) return _match
            return `${before}/api/files?path=${encodeURIComponent(cleanPath)}${after}`
        }
      )
}

export function renderMarkdown(text: string): string {
    try {
        const html = marked.parse(text) as string
        return rewriteLocalFilePaths(html)
    } catch {
        return text
    }
}

export function handleMarkdownClick(e: MouseEvent): void {
    const btn = (e.target as HTMLElement).closest('.code-copy-btn') as HTMLElement | null
    if (!btn) return
    const wrapper = btn.closest('.code-block-wrapper')
    const code = wrapper?.querySelector('code')
    if (!code) return
    navigator.clipboard.writeText(code.textContent || '')
    btn.classList.add('copied')
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
    setTimeout(() => {
        btn.classList.remove('copied')
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>'
    }, 1500)
}
