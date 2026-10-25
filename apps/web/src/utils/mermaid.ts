import type { Mermaid, MermaidConfig } from 'mermaid'

/** Rendered SVG keyed by theme and source, so re-rendered messages swap in diagrams without a flash. */
const svgCache = new Map<string, string>()
const SVG_CACHE_LIMIT = 200

let mermaidPromise: Promise<Mermaid> | null = null
let initializedTheme: string | null = null
// Mermaid renders through shared global state, so diagrams render one at a time.
let queue: Promise<void> = Promise.resolve()
let renderSeq = 0

function loadMermaid(): Promise<Mermaid> {
    // Mermaid is large; only fetch it once a diagram actually appears.
    mermaidPromise ??= import('mermaid').then((module) => module.default)
    return mermaidPromise
}

function currentThemeKey(): string {
    return document.documentElement.dataset.theme ?? 'default'
}

/** Resolve theme tokens to concrete colors, since Mermaid cannot read CSS variables. */
function themeVariables(): MermaidConfig['themeVariables'] {
    const probe = document.createElement('span')
    probe.style.display = 'none'
    document.body.appendChild(probe)
    const color = (token: string): string => {
        probe.style.color = `var(${token})`
        return getComputedStyle(probe).color
    }
    const surface = color('--color-theme-900')
    const vars = {
        darkMode: isDark(surface),
        fontFamily: getComputedStyle(document.body).fontFamily,
        background: surface,
        mainBkg: color('--color-theme-800'),
        primaryColor: color('--color-theme-800'),
        primaryTextColor: color('--color-theme-100'),
        primaryBorderColor: color('--color-accent-400'),
        nodeBorder: color('--color-accent-400'),
        secondaryColor: color('--color-theme-700'),
        tertiaryColor: color('--color-theme-800'),
        lineColor: color('--color-theme-400'),
        textColor: color('--color-theme-200'),
        titleColor: color('--color-theme-100'),
        clusterBkg: surface,
        clusterBorder: color('--color-theme-600'),
        edgeLabelBackground: surface,
        noteBkgColor: color('--color-theme-700'),
        noteTextColor: color('--color-theme-100'),
        noteBorderColor: color('--color-theme-600'),
    }
    probe.remove()
    return vars
}

function isDark(rgb: string): boolean {
    const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? []).map(Number)
    if (r === undefined || g === undefined || b === undefined) return true
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5
}

async function renderSvg(source: string, theme: string): Promise<string | null> {
    const mermaid = await loadMermaid()
    if (initializedTheme !== theme) {
        mermaid.initialize({
            startOnLoad: false,
            // Diagram source comes from model output; strict mode sanitizes labels and disables click handlers.
            securityLevel: 'strict',
            theme: 'base',
            themeVariables: themeVariables(),
        })
        initializedTheme = theme
    }
    if (!(await mermaid.parse(source, { suppressErrors: true }))) return null
    const { svg } = await mermaid.render(`mermaid-diagram-${++renderSeq}`, source)
    return svg
}

function showDiagram(block: HTMLElement, svg: string, theme: string): void {
    const target = block.querySelector('.mermaid-diagram')
    if (!target) return
    target.innerHTML = svg
    block.dataset.mermaidState = 'rendered'
    block.dataset.mermaidTheme = theme
    block.dataset.view ??= 'diagram'
}

/** Replace mermaid code blocks under `root` with rendered diagrams; invalid sources stay as code. */
export function renderMermaidBlocks(root: HTMLElement): Promise<void> {
    const theme = currentThemeKey()
    const blocks = Array.from(root.querySelectorAll<HTMLElement>('.mermaid-block'))
        .filter((block) => block.dataset.mermaidTheme !== theme
            && block.dataset.mermaidState !== 'error'
            && block.dataset.mermaidState !== 'pending')
    const pending: HTMLElement[] = []

    for (const block of blocks) {
        const cached = svgCache.get(`${theme}\n${block.querySelector('code')?.textContent ?? ''}`)
        if (cached) showDiagram(block, cached, theme)
        else {
            block.dataset.mermaidState = 'pending'
            pending.push(block)
        }
    }
    if (!pending.length) return queue

    queue = queue.then(async () => {
        for (const block of pending) {
            const raw = block.querySelector('code')?.textContent ?? ''
            const source = raw.trim()
            const key = `${theme}\n${raw}`
            let svg = svgCache.get(key) ?? null
            if (!svg) {
                try {
                    svg = source ? await renderSvg(source, theme) : null
                } catch {
                    svg = null
                }
                if (svg) {
                    if (svgCache.size >= SVG_CACHE_LIMIT) svgCache.delete(svgCache.keys().next().value!)
                    svgCache.set(key, svg)
                }
            }
            if (!block.isConnected) continue
            if (svg) showDiagram(block, svg, theme)
            else block.dataset.mermaidState = 'error'
        }
    })
    return queue
}
