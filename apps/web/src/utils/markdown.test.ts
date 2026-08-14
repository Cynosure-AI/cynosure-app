import { afterEach, describe, expect, test, vi } from 'vitest'
import { handleMarkdownClick, renderMarkdown } from './markdown'

describe('markdown rendering', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  test('sanitizes executable HTML and unsafe links from model output', () => {
    const html = renderMarkdown([
      '<script>alert(1)</script>',
      '<img src="x" onerror="alert(2)">',
      '<a href="javascript:alert(3)" style="color:red">bad</a>',
      '<form><input value="secret"></form>',
    ].join('\n'))

    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('style=')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<input')
  })

  test('rewrites local image and document paths through the file-serving API', () => {
    const html = renderMarkdown([
      '![chart](</tmp/my chart.png>)',
      '[report](file:///tmp/report.pdf)',
      '![served](/api/files?path=already)',
    ].join('\n'))

    expect(html).toContain('/api/files?path=%2Ftmp%2Fmy%20chart.png')
    expect(html).toContain('/api/files?path=%2Ftmp%2Freport.pdf')
    expect(html).toContain('/api/files?path=already')
    expect(html).not.toContain('/api/files?path=%2Fapi%2F')
  })

  test('renders code blocks with a language label and copy control', () => {
    const html = renderMarkdown('```ts\nconst answer: number = 42\n```')

    expect(html).toContain('class="code-copy-btn"')
    expect(html).toContain('<span>ts</span>')
    expect(html).toContain('language-ts')
  })

  test('copies code and restores the button after feedback', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const container = document.createElement('div')
    container.innerHTML = '<div class="code-block-wrapper"><button class="code-copy-btn"></button><pre><code>copy me</code></pre></div>'
    document.body.appendChild(container)
    const button = container.querySelector('.code-copy-btn') as HTMLElement

    handleMarkdownClick({ target: button } as unknown as MouseEvent)

    expect(writeText).toHaveBeenCalledWith('copy me')
    expect(button.classList.contains('copied')).toBe(true)
    vi.advanceTimersByTime(1_500)
    expect(button.classList.contains('copied')).toBe(false)
    expect(button.innerHTML).toContain('<rect')
  })
})
