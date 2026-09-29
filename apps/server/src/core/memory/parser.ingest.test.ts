import { beforeEach, expect, test, vi } from 'vitest'
import { MemoryParser } from './parser.js'

const mocks = vi.hoisted(() => ({
  embedBatch: vi.fn(), addDocuments: vi.fn(), deleteByIds: vi.fn(),
}))
vi.mock('./embedding.js', () => ({ getEmbeddingService: () => mocks }))
vi.mock('./rag.js', () => ({ getRAGStore: () => mocks }))
beforeEach(() => {
  mocks.embedBatch.mockReset().mockResolvedValue([{ vector: [1, 0], dimensions: 2, model: 'test', profileFingerprint: 'test' }])
  mocks.addDocuments.mockReset().mockResolvedValue(undefined)
  mocks.deleteByIds.mockReset().mockResolvedValue(undefined)
})

test('cancellation reaches the embedding provider and is not retried', async () => {
  const controller = new AbortController()
  mocks.embedBatch.mockImplementation((_texts, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })
  }))
  const ingest = new MemoryParser().ingest('attachments', 'Draft content', { source: 'conversation_attachment', sourceFile: 'draft' }, { signal: controller.signal })
  const rejected = expect(ingest).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(mocks.embedBatch).toHaveBeenCalled())
  controller.abort()
  await rejected
  expect(mocks.embedBatch).toHaveBeenCalledTimes(1)
  expect(mocks.embedBatch.mock.calls[0][1]).toBe(controller.signal)
  expect(mocks.addDocuments).not.toHaveBeenCalled()
})

test('cancellation during a write settles and rolls back its vectors', async () => {
  const controller = new AbortController()
  let finish!: () => void
  mocks.addDocuments.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  const ingest = new MemoryParser().ingest('attachments', 'Draft content', { source: 'conversation_attachment', sourceFile: 'draft' }, { signal: controller.signal })
  const rejected = expect(ingest).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(mocks.addDocuments).toHaveBeenCalled())
  controller.abort()
  finish()
  await rejected
  const documents = mocks.addDocuments.mock.calls[0][1] as Array<{ id: string }>
  expect(mocks.deleteByIds).toHaveBeenCalledWith('attachments', documents.map(doc => doc.id), { throwOnError: true })
})
