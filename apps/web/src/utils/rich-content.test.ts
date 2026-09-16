import { describe, expect, test } from 'vitest'
import { formatRichContent } from './rich-content'

describe('rich content formatting', () => {
  test('pretty-prints object and array JSON in a highlighted block', () => {
    expect(formatRichContent('{"ok":true,"items":[1,2]}')).toEqual({
      kind: 'json',
      language: 'json',
      markdown: '```json\n{\n  "ok": true,\n  "items": [\n    1,\n    2\n  ]\n}\n```',
    })
  })

  test('preserves markdown instead of wrapping it as code', () => {
    const formatted = formatRichContent('## Result\n\n- one\n- two')
    expect(formatted.kind).toBe('markdown')
    expect(formatted.markdown).toContain('## Result')
  })

  test('recognizes common programming and query languages', () => {
    expect(formatRichContent('const answer: number = 42').language).toBe('typescript')
    expect(formatRichContent('SELECT id FROM users').language).toBe('sql')
    expect(formatRichContent('def answer():\n    return 42').language).toBe('python')
  })

  test('leaves normal prose as text and does not treat JSON primitives as structures', () => {
    expect(formatRichContent('Operation completed successfully.')).toEqual({
      kind: 'text',
      markdown: 'Operation completed successfully.',
    })
    expect(formatRichContent('"hello"').kind).toBe('text')
  })
})
