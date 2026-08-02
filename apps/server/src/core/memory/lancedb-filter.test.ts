import { describe, expect, test } from 'vitest'
import { andLanceDbFilters, lanceDbEqFilter, lanceDbInFilter, lanceDbStringLiteral } from './lancedb-filter.js'

describe('LanceDB filter construction', () => {
  test('escapes quote characters in user-controlled values', () => {
    expect(lanceDbStringLiteral("owner's notes")).toBe("'owner''s notes'")
    expect(lanceDbEqFilter('spaceId', "a' OR 1=1 --")).toBe("spaceId = 'a'' OR 1=1 --'")
  })

  test('does not create an unbounded IN filter from an empty scope', () => {
    expect(lanceDbInFilter('spaceId', [])).toBeUndefined()
    expect(andLanceDbFilters(undefined, 'spaceId = \'default\'')).toBe("spaceId = 'default'")
  })
})
