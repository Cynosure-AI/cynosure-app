import { describe, expect, test } from 'vitest'
import { parseSnippet, rankItems, scoreMatch } from './command-palette'

describe('scoreMatch', () => {
  test('matches everything for an empty query', () => {
    expect(scoreMatch('  ', ['anything'])).toBeGreaterThan(0)
  })

  test('requires every term to match some field', () => {
    expect(scoreMatch('git hub', ['GitHub server', 'hub for git'])).toBeGreaterThan(0)
    expect(scoreMatch('git slack', ['GitHub server'])).toBe(0)
  })

  test('prefers exact, prefix and word-start matches over infix ones', () => {
    const exact = scoreMatch('notes', ['notes'])
    const prefix = scoreMatch('notes', ['notes agent'])
    const wordStart = scoreMatch('notes', ['daily notes'])
    const infix = scoreMatch('notes', ['keynotes'])
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(wordStart)
    expect(wordStart).toBeGreaterThan(infix)
  })

  test('weighs earlier fields above later ones', () => {
    expect(scoreMatch('mail', ['Mail', ''])).toBeGreaterThan(scoreMatch('mail', ['Other', 'Mail']))
  })
})

describe('rankItems', () => {
  const items = [
    { name: 'Research assistant', description: 'Finds papers' },
    { name: 'Coder', description: 'Writes research tooling' },
    { name: 'Researcher', description: '' },
    { name: 'Chef', description: 'Recipes' },
  ]

  test('filters non-matches, ranks by score and respects the limit', () => {
    const ranked = rankItems(items, 'research', (item) => [item.name, item.description], 2)
    expect(ranked.map((item) => item.name)).toEqual(['Research assistant', 'Researcher'])
  })

  test('keeps the original order when the query is empty', () => {
    const ranked = rankItems(items, '', (item) => [item.name], 10)
    expect(ranked).toEqual(items)
  })
})

describe('parseSnippet', () => {
  test('splits matched terms from plain text and collapses whitespace', () => {
    expect(parseSnippet('…use \u0002Docker\u0003\n\n and \u0002dock\u0003ers…')).toEqual([
      { text: '…use ', match: false },
      { text: 'Docker', match: true },
      { text: ' and ', match: false },
      { text: 'dock', match: true },
      { text: 'ers…', match: false },
    ])
  })

  test('returns plain text when nothing is marked', () => {
    expect(parseSnippet('plain text')).toEqual([{ text: 'plain text', match: false }])
  })
})
