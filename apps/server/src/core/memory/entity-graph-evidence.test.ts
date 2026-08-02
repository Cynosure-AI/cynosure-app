import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('a graph edge survives until its final supporting source is removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cynosure-graph-'))
  process.env.CYNOSURE_DATA_DIR = directory

  const { closeDb, getDb } = await import('../../db/database.js')
  const { EntityGraphStore } = await import('./entity-graph.js')
  try {
    const graph = new EntityGraphStore()
    const relation = {
      from: { name: 'Cynosure', type: 'project' as const },
      relation: 'uses',
      to: { name: 'LanceDB', type: 'technology' as const },
      confidence: 0.9,
      importance: 2 as const,
      evidence: 'The architecture document names LanceDB.',
    }
    const first = graph.upsertEdge(relation, 'memory', 'source-a')
    const second = graph.upsertEdge(relation, 'memory', 'source-b')
    assert.ok(first)
    assert.equal(second?.id, first?.id)

    assert.equal(graph.deleteEdgesBySourceId('source-b').edgesDeleted, 0)
    assert.ok(graph.getEdge(first!.id))
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS count FROM entity_graph_edge_evidence WHERE edge_id = ?').get(first!.id) as { count: number }).count,
      1,
    )

    assert.equal(graph.deleteEdgesBySourceId('source-a').edgesDeleted, 1)
    assert.equal(graph.getEdge(first!.id), null)
  } finally {
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    await rm(directory, { recursive: true, force: true })
  }
})
