import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

let testDb: Database.Database

vi.mock('../../db/database.js', () => ({ getDb: () => testDb }))

import { EntityGraphStore } from './entity-graph.js'

beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    testDb.exec(`
        CREATE TABLE entity_graph_nodes (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, normalized_name TEXT NOT NULL, type TEXT NOT NULL,
            aliases_json TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 1,
            mention_count INTEGER NOT NULL DEFAULT 1, source_count INTEGER NOT NULL DEFAULT 1,
            first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, UNIQUE(normalized_name, type)
        );
        CREATE TABLE entity_graph_edges (
            id TEXT PRIMARY KEY, from_node_id TEXT NOT NULL REFERENCES entity_graph_nodes(id) ON DELETE CASCADE,
            to_node_id TEXT NOT NULL REFERENCES entity_graph_nodes(id) ON DELETE CASCADE, relation TEXT NOT NULL,
            importance INTEGER NOT NULL DEFAULT 1, confidence REAL NOT NULL DEFAULT 0.7,
            evidence TEXT NOT NULL DEFAULT '', source_kind TEXT NOT NULL DEFAULT 'conversation',
            source_id TEXT NOT NULL DEFAULT '', mention_count INTEGER NOT NULL DEFAULT 1,
            first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
            UNIQUE(from_node_id, relation, to_node_id)
        );
        CREATE TABLE entity_graph_edge_evidence (
            id TEXT PRIMARY KEY, edge_id TEXT NOT NULL REFERENCES entity_graph_edges(id) ON DELETE CASCADE,
            source_kind TEXT NOT NULL DEFAULT 'conversation', source_id TEXT NOT NULL DEFAULT '',
            source_document_id TEXT NOT NULL DEFAULT '', source_content_hash TEXT NOT NULL DEFAULT '',
            source_chunk_index INTEGER,
            evidence TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 0.7,
            mention_count INTEGER NOT NULL DEFAULT 1, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
            UNIQUE(edge_id, source_kind, source_id)
        );
        CREATE TABLE memory_file_index (
            document_id TEXT PRIMARY KEY, space_id TEXT NOT NULL, file_name TEXT NOT NULL,
            content_hash TEXT NOT NULL DEFAULT '', chunk_count INTEGER NOT NULL DEFAULT 0,
            last_indexed_at INTEGER NOT NULL DEFAULT 0, entity_indexed_at INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL, UNIQUE(space_id, file_name)
        );
    `)
})

afterEach(() => testDb.close())

describe('entity graph identity and provenance scope', () => {
    test('returns claim coordinates only while their source document version is current', () => {
        const graph = new EntityGraphStore()
        testDb.prepare(`
            INSERT INTO memory_file_index
                (document_id, space_id, file_name, content_hash, chunk_count, created_at)
            VALUES ('doc-1', 'space-a', 'people.md', 'hash-1', 3, 1)
        `).run()
        const edge = graph.upsertEdge({
            from: { name: 'John Smith', type: 'person' },
            relation: 'likes',
            to: { name: 'Apples', type: 'concept' },
            evidence: 'John Smith likes apples.',
            sourceDocumentId: 'doc-1',
            sourceContentHash: 'hash-1',
            sourceChunkIndex: 2,
        }, 'memory', 'memory:space-a:people.md')!

        const current = graph.walk([edge.fromNodeId], 1, 5, 0, { sourceIdPrefixes: ['memory:space-a:'] })
        expect(current.edges[0]).toMatchObject({
            sourceDocumentId: 'doc-1',
            sourceContentHash: 'hash-1',
            sourceChunkIndex: 2,
        })
        const formatted = graph.formatWalk(current)
        expect(formatted).toContain('Source: people.md, part 3.')
        expect(formatted).not.toContain('documentId=')
        expect(formatted).not.toContain('revision=')
        expect(formatted).not.toContain('hash-1')

        testDb.prepare("UPDATE memory_file_index SET content_hash = 'hash-2' WHERE document_id = 'doc-1'").run()
        const stale = graph.walk([edge.fromNodeId], 1, 5, 0, { sourceIdPrefixes: ['memory:space-a:'] })
        expect(stale.edges).toEqual([])
    })

    test('keeps same-named incompatible entity types separate and canonicalizes relation aliases', () => {
        const graph = new EntityGraphStore()
        const employment = graph.upsertEdge({
            from: { name: 'Alex', type: 'person' }, relation: 'works_for', to: { name: 'Acme', type: 'organization' },
        }, 'memory', 'memory:space-a:people.md')
        graph.upsertEdge({
            from: { name: 'Alex', type: 'project' }, relation: 'uses', to: { name: 'TypeScript', type: 'technology' },
        }, 'memory', 'memory:space-a:projects.md')

        expect(employment?.relation).toBe('works_at')
        const alexTypes = testDb.prepare("SELECT type FROM entity_graph_nodes WHERE normalized_name = 'alex' ORDER BY type").all() as Array<{ type: string }>
        expect(alexTypes.map(({ type }) => type)).toEqual(['person', 'project'])
    })

    test('returns and deletes only relationship evidence inside the selected source scope', () => {
        const graph = new EntityGraphStore()
        const relation = {
            from: { name: 'Cynosure', type: 'project' as const },
            relation: 'uses',
            to: { name: 'SQLite', type: 'technology' as const },
        }
        const edge = graph.upsertEdge({ ...relation, evidence: 'Allowed evidence' }, 'tool', 'memory:space-a:architecture.md')!
        graph.upsertEdge({ ...relation, evidence: 'Private evidence' }, 'tool', 'memory:space-b:private.md')

        const scoped = graph.list(20, 0, ['memory:space-a:'])
        expect(scoped.edges).toHaveLength(1)
        expect(scoped.edges[0].evidence).toBe('Allowed evidence')
        expect(scoped.edges[0].sourceIds).toEqual(['memory:space-a:architecture.md'])

        expect(graph.deleteEdgeEvidenceBySourcePrefixes(edge.id, ['memory:space-a:']).edgeDeleted).toBe(true)
        expect(graph.list(20, 0, ['memory:space-a:']).edges).toHaveLength(0)
        expect(graph.list(20, 0, ['memory:space-b:']).edges).toHaveLength(1)
    })
})
