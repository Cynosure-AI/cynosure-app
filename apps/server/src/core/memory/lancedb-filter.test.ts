import { describe, expect, test } from 'vitest'
import { andLanceDbFilters, lanceDbEqFilter, lanceDbInFilter, lanceDbStringLiteral } from './lancedb-filter.js'

describe('LanceDB filter construction', () => {
  test('escapes quote characters in user-controlled values', () => {
    expect(lanceDbStringLiteral("owner's notes")).toBe("'owner''s notes'")
    expect(lanceDbEqFilter('categoryId', "a' OR 1=1 --")).toBe("categoryId = 'a'' OR 1=1 --'")
  })

  test('does not create an unbounded IN filter from an empty scope', () => {
    expect(lanceDbInFilter('categoryId', [])).toBeUndefined()
    expect(andLanceDbFilters(undefined, 'categoryId = \'default\'')).toBe("categoryId = 'default'")
  })
})
