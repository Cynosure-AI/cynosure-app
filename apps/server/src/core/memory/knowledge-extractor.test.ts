import { beforeEach, describe, expect, test, vi } from 'vitest'

const complete = vi.hoisted(() => vi.fn())

vi.mock('../gateway/gateway.js', () => ({
  getGateway: () => ({
    getProvider: () => undefined,
    getLastUsedProvider: () => ({ config: { id: 'provider', defaultModel: 'model' } }),
    complete,
  }),
}))

import { extractKnowledgeFromContent, mergeKnowledgeChunkTags, normalizeKnowledgeTags } from './knowledge-extractor.js'

describe('knowledge extractor notes', () => {
  beforeEach(() => complete.mockReset())

  test('keeps concise notes alongside chunk-grounded relationships and mentions', async () => {
    complete.mockResolvedValue({
      content: JSON.stringify([
        {
          action: 'assert',
          from: { name: 'Nora', type: 'person' },
          relation: 'uses',
          to: { name: 'TypeScript', type: 'technology' },
          note: 'Nora uses TypeScript for the project.',
          source_chunk_index: 4,
        },
        {
          action: 'mention',
          entity: { name: 'Selene', type: 'person' },
          note: 'Selene is named as the keynote speaker.',
          source_chunk_index: 4,
        },
      ]),
    })

    const result = await extractKnowledgeFromContent({
      segments: [{ content: '<source_chunk index="4">Nora uses TypeScript. Selene is the keynote speaker.</source_chunk>', chunkIndexes: [4] }],
    })

    expect(result.relations[0]).toMatchObject({
      relation: 'uses', sourceChunkIndex: 4,
      note: 'Nora uses TypeScript for the project.',
    })
    expect(result.mentions[0]).toMatchObject({
      sourceChunkIndex: 4,
      note: 'Selene is named as the keynote speaker.',
    })
    expect(result.chunkTags).toEqual([])
  })

  test('normalizes per-chunk tags and merges document keywords in chunk order', async () => {
    complete
      .mockResolvedValueOnce({
        content: JSON.stringify([
          { action: 'tags', tags: [' #TypeScript ', 'Project Planning', 'typescript', '...'], source_chunk_index: 0 },
          { action: 'tags', tags: ['API Design'], source_chunk_index: 0 },
        ]),
      })
      .mockResolvedValueOnce({
        content: JSON.stringify([
          { action: 'tags', tags: ['project planning', 'SQLite', 'API design'], source_chunk_index: 1 },
        ]),
      })

    const result = await extractKnowledgeFromContent({
      segments: [
        { content: '<source_chunk index="0">TypeScript planning.</source_chunk>', chunkIndex: 0, chunkIndexes: [0] },
        { content: '<source_chunk index="1">SQLite API design.</source_chunk>', chunkIndex: 1, chunkIndexes: [1] },
      ],
    })

    expect(result.chunkTags).toEqual([
      { sourceChunkIndex: 0, tags: ['typescript', 'project planning', 'api design'] },
      { sourceChunkIndex: 1, tags: ['project planning', 'sqlite', 'api design'] },
    ])
    expect(mergeKnowledgeChunkTags(result.chunkTags)).toEqual([
      'typescript', 'project planning', 'api design', 'sqlite',
    ])
    expect(normalizeKnowledgeTags(['Ｃｏｄｅｘ', ' codex ', '#Memory'])).toEqual(['codex', 'memory'])
  })
})
