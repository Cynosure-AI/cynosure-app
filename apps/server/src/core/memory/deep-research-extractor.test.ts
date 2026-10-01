import { beforeEach, describe, expect, test, vi } from 'vitest'

const complete = vi.hoisted(() => vi.fn())

vi.mock('../gateway/gateway.js', () => ({
  getGateway: () => ({
    getProvider: () => undefined,
    getLastUsedProvider: () => ({ config: { id: 'provider', defaultModel: 'model' } }),
    complete,
  }),
}))

import { deepResearchContent, mergeDeepResearchChunkTags, normalizeKnowledgeTags } from './deep-research-extractor.js'

describe('Deep Research notes', () => {
  beforeEach(() => complete.mockReset())

  test('provides the whole document as context while keeping extraction tied to the target chunk', async () => {
    complete.mockResolvedValue({ content: JSON.stringify([
      { action: 'summary', summary: 'This chunk covers ACME revenue in Q2 2023.', source_chunk_index: 1 },
      { action: 'summary', summary: 'Wrong chunk.', source_chunk_index: 0 },
    ]) })
    const result = await deepResearchContent({
      documentContent: 'ACME Q2 2023 report. Revenue grew by 3%.',
      segments: [{ content: '<source_chunk index="1">Revenue grew by 3%.</source_chunk>', chunkIndexes: [1] }],
    })
    const request = complete.mock.calls[0][0]
    expect(request.messages[0].content).toContain('50-100 tokens')
    expect(request.messages[0].content).toContain('supported by the numbered source chunk itself')
    expect(request.messages[1].content).toContain('ACME Q2 2023 report.')
    expect(request.messages[2].content).toContain('<source_chunk index="1">')
    expect(result.chunkSummaries).toEqual([{ sourceChunkIndex: 1, summary: 'This chunk covers ACME revenue in Q2 2023.' }])
  })

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
        {
          action: 'summary',
          summary: 'Nora uses TypeScript for the project. Selene is its keynote speaker.',
          source_chunk_index: 4,
        },
      ]),
    })

    const result = await deepResearchContent({
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
    expect(result.chunkSummaries).toEqual([{
      sourceChunkIndex: 4,
      summary: 'Nora uses TypeScript for the project. Selene is its keynote speaker.',
    }])
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

    const result = await deepResearchContent({
      segments: [
        { content: '<source_chunk index="0">TypeScript planning.</source_chunk>', chunkIndex: 0, chunkIndexes: [0] },
        { content: '<source_chunk index="1">SQLite API design.</source_chunk>', chunkIndex: 1, chunkIndexes: [1] },
      ],
    })

    expect(result.chunkTags).toEqual([
      { sourceChunkIndex: 0, tags: ['typescript', 'project planning', 'api design'] },
      { sourceChunkIndex: 1, tags: ['project planning', 'sqlite', 'api design'] },
    ])
    expect(mergeDeepResearchChunkTags(result.chunkTags)).toEqual([
      'typescript', 'project planning', 'api design', 'sqlite',
    ])
    expect(normalizeKnowledgeTags(['Ｃｏｄｅｘ', ' codex ', '#Memory'])).toEqual(['codex', 'memory'])
  })

  test('extends a resumed result and checkpoints after each completed segment', async () => {
    complete.mockResolvedValue({
      content: JSON.stringify([{ action: 'tags', tags: ['new chunk'], source_chunk_index: 1 }]),
    })
    const onCheckpoint = vi.fn()
    const onProgress = vi.fn()

    const result = await deepResearchContent({
      segments: [{ content: '<source_chunk index="1">New.</source_chunk>', chunkIndex: 1, chunkIndexes: [1] }],
      initialResult: { relations: [], mentions: [], chunkTags: [{ sourceChunkIndex: 0, tags: ['saved chunk'] }] },
      onCheckpoint,
      onProgress,
    })

    expect(result.chunkTags).toEqual([
      { sourceChunkIndex: 0, tags: ['saved chunk'] },
      { sourceChunkIndex: 1, tags: ['new chunk'] },
    ])
    expect(onCheckpoint).toHaveBeenCalledWith(result)
    expect(onProgress).toHaveBeenCalledWith(1, 1)
  })
})
