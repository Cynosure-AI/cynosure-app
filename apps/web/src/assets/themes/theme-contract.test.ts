import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const themes = ['light', 'dark', 'crimson', 'cyberpunk', 'emerald', 'industrial', 'monochrome', 'virtualboy']

function color(css: string, token: string): string {
  const matches = [...css.matchAll(new RegExp(`--${token}:\\s*(#[0-9a-f]{6})\\s*;`, 'gi'))]
  const value = matches.at(-1)?.[1]
  if (!value) throw new Error(`Missing hex color token ${token}`)
  return value
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
  const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}

function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (values[0]! + 0.05) / (values[1]! + 0.05)
}

describe('theme palette contract', () => {
  test.each(themes)('%s keeps components readable without utility overrides', theme => {
    const css = readFileSync(resolve(process.cwd(), 'src/assets/themes', `${theme}.css`), 'utf8')
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(withoutComments.match(/{/g)).toHaveLength(1)
    expect(withoutComments.match(/}/g)).toHaveLength(1)

    const surface = color(css, 'color-theme-800')
    for (const role of ['secondary', 'muted', 'faint']) {
      expect(contrast(color(css, `color-ink-${role}`), surface)).toBeGreaterThanOrEqual(4.5)
    }
    const onAccent = color(css, 'color-accent-on')
    for (const step of ['500', '600']) {
      expect(contrast(onAccent, color(css, `color-accent-${step}`))).toBeGreaterThanOrEqual(4.5)
    }
  })
})
