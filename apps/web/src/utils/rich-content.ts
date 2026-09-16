export type RichContentKind = 'json' | 'markdown' | 'code' | 'text'

export interface RichContentFormat {
  kind: RichContentKind
  markdown: string
  language?: string
}

function fenced(language: string, content: string): string {
  const fence = content.includes('```') ? '````' : '```'
  return `${fence}${language}\n${content}\n${fence}`
}

function formattedJson(value: unknown): string | null {
  if (typeof value !== 'string') {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return null
    }
  }

  try {
    const parsed = JSON.parse(value)
    if (parsed === null || typeof parsed !== 'object') return null
    return JSON.stringify(parsed, null, 2)
  } catch {
    return null
  }
}

function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|>\s|[-*+]\s|\d+[.)]\s|```)/.test(text)
    || /\[[^\]]+\]\([^\s)]+\)/.test(text)
    || /(^|\n)\|[^\n]+\|\s*(\n|$)/.test(text)
    || /(^|[^*])\*\*[^*\n]+\*\*/.test(text)
}

function detectCodeLanguage(text: string): string | null {
  if (/^#!.*\b(?:bash|sh|zsh)\b/.test(text) || /(^|\n)\s*(?:export\s+)?[A-Z_][A-Z0-9_]*=/.test(text)) return 'bash'
  if (/^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|WITH)\b/im.test(text) && /\b(?:FROM|INTO|TABLE|SET|AS)\b/i.test(text)) return 'sql'
  if (/^\s*(?:def|class)\s+\w+.*:|^\s*(?:from\s+\S+\s+)?import\s+/m.test(text)) return 'python'
  if (/^\s*(?:interface|type)\s+\w+|\b(?:const|let|var)\s+\w+\s*(?::[^=]+)?=|=>|\bfunction\s+\w+\s*\(/m.test(text)) {
    return /\binterface\s+\w+|\btype\s+\w+\s*=|:\s*(?:string|number|boolean|unknown)\b/.test(text) ? 'typescript' : 'javascript'
  }
  if (/^\s*(?:package\s+\w+|func\s+\w+\s*\()/m.test(text)) return 'go'
  if (/^\s*(?:use\s+\S+;|fn\s+\w+\s*\()/m.test(text)) return 'rust'
  if (/^\s*<\/?[a-z][^>]*>/i.test(text)) return 'html'
  if (/^\s*[.#]?[\w-]+\s*\{[^}]*\}/m.test(text)) return 'css'
  if (/^(?:[\w.-]+:\s+.+\n){2,}/m.test(text)) return 'yaml'
  return null
}

export function formatRichContent(value: unknown): RichContentFormat {
  const json = formattedJson(value)
  if (json !== null) return { kind: 'json', language: 'json', markdown: fenced('json', json) }

  const text = typeof value === 'string' ? value : String(value ?? '')
  const trimmed = text.trim()
  if (!trimmed) return { kind: 'text', markdown: '' }
  if (looksLikeMarkdown(trimmed)) return { kind: 'markdown', markdown: trimmed }

  const language = detectCodeLanguage(trimmed)
  if (language) return { kind: 'code', language, markdown: fenced(language, trimmed) }
  return { kind: 'text', markdown: trimmed }
}
