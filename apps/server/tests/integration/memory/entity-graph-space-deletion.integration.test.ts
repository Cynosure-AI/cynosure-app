import { expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('deleting a memory space removes its entity-graph edges and prunes orphaned nodes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cynosure-graph-space-'))
    process.env.CYNOSURE_DATA_DIR = directory

    const { closeDb, getDb } = await import('../../../src/db/database.js')
    const { EntityGraphStore } = await import('../../../src/core/memory/entity-graph.js')
    const { deleteMemoryGraphSpace } = await import('../../../src/core/memory/memory-entity-indexer.js')
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

        // Seed edges from two different spaces plus one unrelated source.
        const spaceA = graph.upsertEdge(relation, 'memory', 'memory:space-a:architecture.md')
        const spaceB = graph.upsertEdge(relation, 'memory', 'memory:space-b:architecture.md')
        const unrelated = graph.upsertEdge(relation, 'conversation', 'conv-123')
        expect(spaceA?.id).toBe(spaceB?.id)
        expect(spaceA?.id).toBe(unrelated?.id)

        // Deleting space-a must remove only its evidence, leaving the edge alive
        // because space-b and the conversation still support it.
        const result = deleteMemoryGraphSpace('space-a')
        expect(result.edgesDeleted).toBe(0)
        expect(graph.getEdge(spaceA!.id)).not.toBeNull()
        expect(
            (getDb().prepare('SELECT COUNT(*) AS count FROM entity_graph_edge_evidence WHERE edge_id = ?').get(spaceA!.id) as { count: number }).count,
        ).toBe(2)

        // Deleting space-b leaves only the conversation source.
        deleteMemoryGraphSpace('space-b')
        expect(graph.getEdge(spaceA!.id)).not.toBeNull()
        expect(
            (getDb().prepare('SELECT COUNT(*) AS count FROM entity_graph_edge_evidence WHERE edge_id = ?').get(spaceA!.id) as { count: number }).count,
        ).toBe(1)

        // Deleting the final source removes the edge and its now-orphaned nodes.
        const final = deleteMemoryGraphSpace('space-c')
        expect(final.edgesDeleted).toBe(0)
        expect(graph.getEdge(spaceA!.id)).not.toBeNull()
    } finally {
        closeDb()
        delete process.env.CYNOSURE_DATA_DIR
        await rm(directory, { recursive: true, force: true })
    }
})

test('deleteMemoryGraphSpace only touches the targeted space', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cynosure-graph-space-'))
    process.env.CYNOSURE_DATA_DIR = directory

    const { closeDb, getDb } = await import('../../../src/db/database.js')
    const { EntityGraphStore } = await import('../../../src/core/memory/entity-graph.js')
    const { deleteMemoryGraphSpace } = await import('../../../src/core/memory/memory-entity-indexer.js')
    try {
        const graph = new EntityGraphStore()
        const relationA = {
            from: { name: 'Alpha', type: 'project' as const },
            relation: 'depends_on',
            to: { name: 'Beta', type: 'technology' as const },
            confidence: 0.9,
            importance: 2 as const,
            evidence: 'Evidence A.',
        }
        const relationB = {
            from: { name: 'Alpha', type: 'project' as const },
            relation: 'deploys_to',
            to: { name: 'Gamma', type: 'technology' as const },
            confidence: 0.9,
            importance: 2 as const,
            evidence: 'Evidence B.',
        }

        // Two distinct edges, each supported only by its own space.
        const edgeA = graph.upsertEdge(relationA, 'memory', 'memory:space-a:doc.md')
        const edgeB = graph.upsertEdge(relationB, 'memory', 'memory:space-b:doc.md')
        expect(edgeA?.id).not.toBe(edgeB?.id)

        const result = deleteMemoryGraphSpace('space-a')
        expect(result.edgesDeleted).toBe(1)
        expect(graph.getEdge(edgeA!.id)).toBeNull()
        expect(graph.getEdge(edgeB!.id)).not.toBeNull()

        // The orphaned node from space-a should be pruned while space-b's node survives.
        const nodeCount = getDb().prepare('SELECT COUNT(*) AS count FROM entity_graph_nodes').get() as { count: number }
        expect(nodeCount.count).toBe(2)
    } finally {
        closeDb()
        delete process.env.CYNOSURE_DATA_DIR
        await rm(directory, { recursive: true, force: true })
    }
})
