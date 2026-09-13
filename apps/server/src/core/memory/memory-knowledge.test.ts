import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('./embedding.js', () => ({
    getEmbeddingProvider: () => ({
        embed: async () => { throw new Error('vector projection unavailable in unit test') },
        embedBatch: async () => { throw new Error('vector projection unavailable in unit test') },
    }),
}))

vi.mock('./rag.js', () => ({
    getRAGStore: () => ({
        search: async () => [],
        lexicalSearch: async () => [],
        addDocuments: async () => undefined,
        deleteByIds: async () => undefined,
        deleteTable: async () => undefined,
    }),
}))

import { closeDb, getDb } from '../../db/database.js'
import { MemoryKnowledgeStore } from './memory-knowledge.js'
import { planReusableKnowledgeChunks } from './memory-deep-research.js'
import { createMemoryKnowledgeBackup, restoreMemoryKnowledgeBackup } from './memory-knowledge-backup.js'
import type { PreparedMemoryChunk } from './parser.js'
import { getEventBus } from '../telemetry/event-bus.js'

let dataDir: string
let store: MemoryKnowledgeStore

function addDocument(documentId: string, fileName: string, contentHash: string, categoryId = 'test-space'): void {
    getDb().prepare(`
        INSERT INTO memory_file_index
            (document_id, document_ref, category_id, file_name, content_hash, chunk_count,
             last_indexed_at, deep_researched_at, created_at)
        VALUES (?, ?, ?, ?, ?, 2, ?, 0, ?)
    `).run(documentId, `doc-${documentId}`, categoryId, fileName, contentHash, Date.now(), Date.now())
}

function chunk(text: string, chunkIndex: number): PreparedMemoryChunk {
    return {
        text,
        searchText: text,
        chunkIndex,
        documentTitle: 'People',
        sectionPath: 'People',
        contentHash: `chunk-${chunkIndex}-${text.length}`,
    }
}

beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cynosure-knowledge-test-'))
    process.env.CYNOSURE_DATA_DIR = dataDir
    const db = getDb()
    db.prepare(`
        INSERT INTO memory_folders (id, name, description, directory_path, sort_order, is_uncategorized, created_at)
        VALUES ('test-space', 'Test', '', ?, 1, 0, ?)
    `).run(dataDir, Date.now())
    store = new MemoryKnowledgeStore()
})

afterEach(() => {
    closeDb()
    delete process.env.CYNOSURE_DATA_DIR
    rmSync(dataDir, { recursive: true, force: true })
})

describe('memory knowledge v3', () => {
    test('reuses unchanged chunk knowledge across a partial document edit', () => {
        addDocument('doc-incremental', 'incremental.md', 'revision-1')
        const originalChunks = [
            { ...chunk('Ada uses TypeScript.', 0), contentHash: 'stable-ada' },
            { ...chunk('Bob uses Python.', 1), contentHash: 'stable-bob' },
        ]
        store.publishDocument({
            documentId: 'doc-incremental', contentHash: 'revision-1', categoryId: 'test-space',
            fileName: 'incremental.md', sourceId: 'memory:test-space:incremental.md', chunks: originalChunks,
            relations: [
                { from: { name: 'Ada', type: 'person' }, relation: 'uses', to: { name: 'TypeScript', type: 'technology' }, sourceChunkIndex: 0, note: 'Ada uses TypeScript.' },
                { from: { name: 'Bob', type: 'person' }, relation: 'uses', to: { name: 'Python', type: 'technology' }, sourceChunkIndex: 1, note: 'Bob uses Python.' },
            ],
            chunkTags: [
                { sourceChunkIndex: 0, tags: ['ada', 'typescript'] },
                { sourceChunkIndex: 1, tags: ['bob', 'python'] },
            ],
        })

        const revisedChunks = [
            { ...chunk('New project context.', 0), contentHash: 'new-context' },
            { ...chunk('Ada uses TypeScript.', 1), contentHash: 'stable-ada' },
        ]
        const plan = planReusableKnowledgeChunks('doc-incremental', revisedChunks)
        expect(plan.chunksToExtract.map((item) => item.chunkIndex)).toEqual([0])
        expect(plan.reusableChunks).toEqual([{ sourceChunkIndex: 1, priorTextUnitId: expect.any(String) }])
        expect(plan.chunkTags).toEqual([{ sourceChunkIndex: 1, tags: ['ada', 'typescript'] }])

        getDb().prepare(`UPDATE memory_file_index SET content_hash = 'revision-2' WHERE document_id = 'doc-incremental'`).run()
        store.publishDocument({
            documentId: 'doc-incremental', contentHash: 'revision-2', categoryId: 'test-space',
            fileName: 'incremental.md', sourceId: 'memory:test-space:incremental.md', chunks: revisedChunks,
            relations: [{
                from: { name: 'Cynosure', type: 'project' }, relation: 'has_goal',
                to: { name: 'New project context', type: 'concept' }, sourceChunkIndex: 0,
                note: 'Cynosure has new project context.',
            }],
            chunkTags: [...plan.chunkTags, { sourceChunkIndex: 0, tags: ['project context'] }],
            reusableChunks: plan.reusableChunks,
        })

        const edges = store.browseGraph({ categoryIds: ['test-space'] }).edges
        expect(edges.some((edge) => edge.fromName === 'Ada' && edge.toName === 'TypeScript' && edge.sourceChunk?.chunkIndex === 1)).toBe(true)
        expect(edges.some((edge) => edge.fromName === 'Cynosure' && edge.toName === 'New project context')).toBe(true)
        expect(edges.some((edge) => edge.fromName === 'Bob' || edge.toName === 'Python')).toBe(false)
        expect(getDb().prepare(`
            SELECT chunk_index, tags_json FROM memory_knowledge_text_units
            WHERE run_id = (SELECT id FROM memory_knowledge_index_runs WHERE document_id = 'doc-incremental' AND status = 'active')
            ORDER BY chunk_index
        `).all()).toEqual([
            { chunk_index: 0, tags_json: '["project context"]' },
            { chunk_index: 1, tags_json: '["ada","typescript"]' },
        ])
    })

    test('backs up and restores manual knowledge corrections', async () => {
        addDocument('doc-backup', 'backup.md', 'revision-1')
        store.publishDocument({
            documentId: 'doc-backup', contentHash: 'revision-1', categoryId: 'test-space',
            fileName: 'backup.md', sourceId: 'memory:test-space:backup.md', chunks: [chunk('Ada leads Project Atlas.', 0)],
            relations: [{
                from: { name: 'Ada', type: 'person' }, relation: 'manages',
                to: { name: 'Project Atlas', type: 'project' }, sourceChunkIndex: 0,
                note: 'Ada leads Project Atlas.',
            }],
        })
        const edge = store.browseGraph({ categoryIds: ['test-space'] }).edges[0]
        store.updateEdge(edge.id, { note: 'Manually verified leadership relationship.' })
        const backup = createMemoryKnowledgeBackup()

        await store.reset()
        expect(store.browseGraph({ categoryIds: ['test-space'] }).edges).toHaveLength(0)
        const restored = await restoreMemoryKnowledgeBackup(backup)

        expect(restored.restored).toBeGreaterThan(0)
        expect(store.getEdge(edge.id)?.note).toBe('Manually verified leadership relationship.')
        expect((getDb().prepare(`SELECT COUNT(*) AS count FROM memory_knowledge_assertion_corrections`).get() as { count: number }).count).toBe(1)
    })

    test('bulk graph retractions are all-or-nothing', () => {
        addDocument('doc-bulk', 'bulk.md', 'revision-1')
        store.publishDocument({
            documentId: 'doc-bulk', contentHash: 'revision-1', categoryId: 'test-space',
            fileName: 'bulk.md', sourceId: 'memory:test-space:bulk.md', chunks: [chunk('Ada manages Atlas and uses TypeScript.', 0)],
            relations: [
                { from: { name: 'Ada', type: 'person' }, relation: 'manages', to: { name: 'Atlas', type: 'project' }, sourceChunkIndex: 0, note: 'Ada manages Atlas.' },
                { from: { name: 'Ada', type: 'person' }, relation: 'uses', to: { name: 'TypeScript', type: 'technology' }, sourceChunkIndex: 0, note: 'Ada uses TypeScript.' },
            ],
        })
        const graph = store.browseGraph({ categoryIds: ['test-space'] })
        const edgeIds = graph.edges.map((edge) => edge.id)
        expect(store.deleteEdgesByIds([edgeIds[0], 'missing-edge'])).toBe(0)
        expect(store.browseGraph({ categoryIds: ['test-space'] }).edges).toHaveLength(2)
        expect(store.deleteEdgesByIds(edgeIds)).toBe(2)
        expect(store.browseGraph({ categoryIds: ['test-space'] }).edges).toHaveLength(0)

        const nodeIds = graph.nodes.map((node) => node.id)
        expect(store.retractEntitiesByIds([nodeIds[0], 'missing-node'])).toBe(0)
        expect(store.getNode(nodeIds[0])).not.toBeNull()
        expect(store.retractEntitiesByIds(nodeIds)).toBe(nodeIds.length)
        expect(nodeIds.every((id) => store.getNode(id) === null)).toBe(true)
    })

    test('keeps multiple source chunks and contextual notes for one assertion', async () => {
        addDocument('doc-1', 'people.md', 'revision-1')
        const chunks = [
            chunk('Caroline works at Acme in Berlin.', 0),
            chunk('The team directory confirms that Caroline works at Acme.', 1),
        ]
        const published = store.publishDocument({
            documentId: 'doc-1', contentHash: 'revision-1', categoryId: 'test-space',
            fileName: 'people.md', sourceId: 'memory:test-space:people.md', chunks,
            relations: chunks.map((item) => ({
                from: { name: 'Caroline', type: 'person' }, relation: 'works_for',
                to: { name: 'Acme', type: 'organization' }, sourceChunkIndex: item.chunkIndex,
                note: item.chunkIndex === 0 ? 'Caroline works for Acme in Berlin.' : 'A team directory confirms Caroline’s employment at Acme.',
            })),
            chunkTags: [
                { sourceChunkIndex: 0, tags: ['caroline', 'acme', 'berlin'] },
                { sourceChunkIndex: 1, tags: ['team directory', 'employment'] },
            ],
        })

        expect(published).toMatchObject({ status: 'active', assertions: 1, evidence: 2, rejectedClaims: 0 })
        expect((getDb().prepare('SELECT COUNT(*) AS count FROM memory_knowledge_assertion_evidence').get() as { count: number }).count).toBe(2)
        expect(getDb().prepare('SELECT DISTINCT quote, extractor_confidence FROM memory_knowledge_assertion_evidence').all()).toEqual([
            { quote: '', extractor_confidence: 1 },
        ])
        expect((getDb().prepare("SELECT COUNT(*) AS count FROM memory_knowledge_entities WHERE canonical_name = 'Caroline'").get() as { count: number }).count).toBe(1)
        expect((getDb().prepare('SELECT chunk_index, tags_json FROM memory_knowledge_text_units ORDER BY chunk_index').all() as Array<{ chunk_index: number; tags_json: string }>).map((row) => ({
            chunkIndex: row.chunk_index,
            tags: JSON.parse(row.tags_json),
        }))).toEqual([
            { chunkIndex: 0, tags: ['caroline', 'acme', 'berlin'] },
            { chunkIndex: 1, tags: ['team directory', 'employment'] },
        ])

        const result = await store.search('Where does Caroline work?', ['test-space'])
        expect(result.graph?.edges[0]).toMatchObject({ fromName: 'Caroline', relation: 'works_at', toName: 'Acme' })
        expect(result.sourceChunks[0].text).toContain('Caroline works at Acme')
        expect(result.sourceChunks.map((item) => item.chunkIndex).sort()).toEqual([0, 1])
        expect(result.sourceChunks.every((item) => item.documentId === 'doc-1')).toBe(true)
        const graph = store.browseGraph({ categoryIds: ['test-space'] })
        expect(graph.edges[0]).toMatchObject({
            note: expect.stringContaining('Caroline'),
            sourceChunk: { documentId: 'doc-1', fileName: 'people.md', chunkIndex: expect.any(Number), text: '' },
        })
        expect(graph.edges[0]).not.toHaveProperty('confidence')
        expect(graph.edges[0]).not.toHaveProperty('evidence')
        const graphEdgeChunk = graph.edges[0].sourceChunk
        expect(graphEdgeChunk && store.getSourceChunk(graphEdgeChunk.textUnitId)?.text).toContain('Caroline works at Acme')
        expect(graph.nodes.find((node) => node.name === 'Caroline')?.origins).toEqual([expect.objectContaining({
            sourceKind: 'memory', sourceId: 'memory:test-space:people.md', label: 'people.md', count: 2,
            chunks: expect.arrayContaining([
                expect.objectContaining({ chunkIndex: 0, text: '', notes: expect.arrayContaining(['Caroline works for Acme in Berlin.']) }),
                expect.objectContaining({ chunkIndex: 1, notes: expect.arrayContaining(['A team directory confirms Caroline’s employment at Acme.']) }),
            ]),
        })])
        expect((await store.search('team directory', ['test-space'])).graph?.edges[0].note).toContain('team directory')
    })

    test('rejects a relationship whose source chunk does not exist', () => {
        addDocument('doc-2', 'unsupported.md', 'revision-1')
        const published = store.publishDocument({
            documentId: 'doc-2', contentHash: 'revision-1', categoryId: 'test-space',
            fileName: 'unsupported.md', sourceId: 'memory:test-space:unsupported.md',
            chunks: [chunk('Caroline visited Berlin.', 0)],
            relations: [{
                from: { name: 'Caroline', type: 'person' }, relation: 'lives_in',
                to: { name: 'Berlin', type: 'place' }, sourceChunkIndex: 99,
                note: 'Caroline lives in Berlin.',
            }],
        })

        expect(published).toMatchObject({ assertions: 0, evidence: 0, rejectedClaims: 1 })
    })

    test('keeps ambiguous single-name people separate and returns every exact match', async () => {
        addDocument('doc-a', 'a.md', 'revision-a')
        addDocument('doc-b', 'b.md', 'revision-b')
        store.publishDocument({
            documentId: 'doc-a', contentHash: 'revision-a', categoryId: 'test-space', fileName: 'a.md',
            sourceId: 'memory:test-space:a.md', chunks: [chunk('Alex uses Python.', 0)],
            relations: [{ from: { name: 'Alex', type: 'person' }, relation: 'uses', to: { name: 'Python', type: 'technology' }, sourceChunkIndex: 0 }],
        })
        store.publishDocument({
            documentId: 'doc-b', contentHash: 'revision-b', categoryId: 'test-space', fileName: 'b.md',
            sourceId: 'memory:test-space:b.md', chunks: [chunk('Alex uses Rust.', 0)],
            relations: [{ from: { name: 'Alex', type: 'person' }, relation: 'uses', to: { name: 'Rust', type: 'technology' }, sourceChunkIndex: 0 }],
        })

        expect((getDb().prepare("SELECT COUNT(*) AS count FROM memory_knowledge_entities WHERE normalized_name = 'alex'").get() as { count: number }).count).toBe(2)
        const decisions = getDb().prepare("SELECT decision FROM memory_knowledge_entity_resolution_decisions WHERE normalized_surface = 'alex' ORDER BY created_at").all() as Array<{ decision: string }>
        expect(decisions.map((item) => item.decision)).toEqual(['created', 'ambiguous'])

        const result = await store.search('Alex', ['test-space'])
        expect(result.graph?.seedNodes).toHaveLength(2)
        expect(result.graph?.seedNodes.every((node) => node.name === 'Alex')).toBe(true)
        expect(result.graph?.edges.map((edge) => edge.toName).sort()).toEqual(['Python', 'Rust'])
    })

    test('prioritizes ambiguous exact names over generic entity tokens for automatic context', async () => {
        addDocument('doc-auto-alex-a', 'auto-alex-a.md', 'revision-a')
        addDocument('doc-auto-alex-b', 'auto-alex-b.md', 'revision-b')
        addDocument('doc-auto-caroline', 'auto-caroline.md', 'revision-c')
        store.publishDocument({
            documentId: 'doc-auto-alex-a', contentHash: 'revision-a', categoryId: 'test-space', fileName: 'auto-alex-a.md',
            sourceId: 'memory:test-space:auto-alex-a.md', chunks: [chunk('Alex uses Python.', 0)],
            relations: [{ from: { name: 'Alex', type: 'person' }, relation: 'uses', to: { name: 'Python', type: 'technology' }, sourceChunkIndex: 0 }],
        })
        store.publishDocument({
            documentId: 'doc-auto-alex-b', contentHash: 'revision-b', categoryId: 'test-space', fileName: 'auto-alex-b.md',
            sourceId: 'memory:test-space:auto-alex-b.md', chunks: [chunk('Alex uses Rust.', 0)],
            relations: [{ from: { name: 'Alex', type: 'person' }, relation: 'uses', to: { name: 'Rust', type: 'technology' }, sourceChunkIndex: 0 }],
        })
        store.publishDocument({
            documentId: 'doc-auto-caroline', contentHash: 'revision-c', categoryId: 'test-space', fileName: 'auto-caroline.md',
            sourceId: 'memory:test-space:auto-caroline.md', chunks: [chunk('Caroline wants a reliable relationship.', 0)],
            relations: [{ from: { name: 'Caroline', type: 'person' }, relation: 'has_goal', to: { name: 'Reliable relationship', type: 'concept' }, sourceChunkIndex: 0 }],
        })

        const result = await store.search(
            'What do you know about Alex? Use the knowledge afterward.',
            ['test-space'],
            8,
            { allowAmbiguousExactMatches: true },
        )

        expect(result.graph?.seedNodes).toHaveLength(2)
        expect(result.graph?.seedNodes.every((node) => node.name === 'Alex')).toBe(true)
        expect(result.graph?.edges.map((edge) => edge.toName).sort()).toEqual(['Python', 'Rust'])
    })

    test('walks from multiple explicitly selected entities', () => {
        addDocument('doc-multi-select', 'multi-select.md', 'revision-1')
        const chunks = [
            chunk('Andi North uses TypeScript.', 0),
            chunk('Andi South uses Rust.', 1),
        ]
        store.publishDocument({
            documentId: 'doc-multi-select', contentHash: 'revision-1', categoryId: 'test-space',
            fileName: 'multi-select.md', sourceId: 'memory:test-space:multi-select.md', chunks,
            relations: [
                { from: { name: 'Andi North', type: 'person' }, relation: 'uses', to: { name: 'TypeScript', type: 'technology' }, sourceChunkIndex: 0 },
                { from: { name: 'Andi South', type: 'person' }, relation: 'uses', to: { name: 'Rust', type: 'technology' }, sourceChunkIndex: 1 },
            ],
        })

        const fullGraph = store.browseGraph({ categoryIds: ['test-space'] })
        const selectedIds = fullGraph.nodes
            .filter((node) => node.name === 'Andi North' || node.name === 'Andi South')
            .map((node) => node.id)
        const walk = store.browseGraph({ categoryIds: ['test-space'], nodeIds: selectedIds, depth: 1 })

        expect(walk.seedNodes.map((node) => node.name).sort()).toEqual(['Andi North', 'Andi South'])
        expect(walk.edges.map((edge) => edge.fromName).sort()).toEqual(['Andi North', 'Andi South'])
    })

    test('merges duplicate entities, preserves aliases, and consolidates relationships', async () => {
        addDocument('doc-entity-merge', 'entity-merge.md', 'revision-1')
        const source = chunk('Chantal, Chantal Partner, and Chantal Example all use Atlas and refer to the same person.', 0)
        store.publishDocument({
            documentId: 'doc-entity-merge', contentHash: 'revision-1', categoryId: 'test-space',
            fileName: 'entity-merge.md', sourceId: 'memory:test-space:entity-merge.md', chunks: [source],
            relations: [
                { from: { name: 'Chantal', type: 'person' }, relation: 'uses', to: { name: 'Atlas', type: 'technology' }, sourceChunkIndex: 0 },
                { from: { name: 'Chantal Partner', type: 'person' }, relation: 'uses', to: { name: 'Atlas', type: 'technology' }, sourceChunkIndex: 0 },
                { from: { name: 'Chantal Example', type: 'person' }, relation: 'uses', to: { name: 'Atlas', type: 'technology' }, sourceChunkIndex: 0 },
                { from: { name: 'Chantal', type: 'person' }, relation: 'partner_of', to: { name: 'Chantal Partner', type: 'person' }, sourceChunkIndex: 0 },
            ],
        })
        const chantal = store.suggestNodes('Chantal', 10, ['test-space'])
            .filter((node) => ['Chantal', 'Chantal Partner', 'Chantal Example'].includes(node.name))
        expect(chantal).toHaveLength(3)

        const result = await store.mergeEntities({
            entityIds: chantal.filter((node) => node.name !== 'Chantal Example').map((node) => node.id),
            canonicalName: 'Chantal Example',
            categoryIds: ['test-space'],
        })

        expect(result.entity).toMatchObject({ name: 'Chantal Example', type: 'person' })
        expect(result.entity.aliases).toEqual(expect.arrayContaining(['Chantal', 'Chantal Partner']))
        expect(result.mergedEntityIds).toHaveLength(2)
        expect(result.consolidatedAssertions).toBe(2)
        expect(result.retiredSelfRelationships).toBe(1)
        const graph = store.browseGraph({ categoryIds: ['test-space'] })
        expect(graph.nodes.filter((node) => node.name === 'Chantal Example')).toHaveLength(1)
        expect(graph.edges.filter((edge) => edge.fromName === 'Chantal Example' && edge.relation === 'uses')).toHaveLength(1)
        expect(graph.edges.some((edge) => edge.fromNodeId === edge.toNodeId)).toBe(false)
        expect((getDb().prepare("SELECT COUNT(*) AS count FROM memory_knowledge_entities WHERE status = 'merged' AND merged_into_id = ?")
            .get(result.entity.id) as { count: number }).count).toBe(2)
    })

    test('merges entities across selected memory folders and keeps future indexing resolved', async () => {
        getDb().prepare(`
            INSERT INTO memory_folders (id, name, description, directory_path, sort_order, is_uncategorized, created_at)
            VALUES ('second-space', 'Second', '', ?, 2, 0, ?)
        `).run(dataDir, Date.now())
        addDocument('doc-primary-person', 'primary.md', 'revision-1')
        addDocument('doc-alternate-person', 'alternate.md', 'revision-1', 'second-space')
        store.publishDocument({
            documentId: 'doc-primary-person', contentHash: 'revision-1', categoryId: 'test-space',
            fileName: 'primary.md', sourceId: 'memory:test-space:primary.md', chunks: [chunk('Herbert Hagen uses Atlas.', 0)],
            relations: [{ from: { name: 'Herbert Hagen', type: 'person' }, relation: 'uses', to: { name: 'Atlas', type: 'technology' }, sourceChunkIndex: 0 }],
        })
        store.publishDocument({
            documentId: 'doc-alternate-person', contentHash: 'revision-1', categoryId: 'second-space',
            fileName: 'alternate.md', sourceId: 'memory:second-space:alternate.md', chunks: [chunk('Herbert H. created Beacon.', 0)],
            relations: [{ from: { name: 'Herbert H.', type: 'person', aliases: ['H. Hagen'] }, relation: 'created', to: { name: 'Beacon', type: 'project' }, sourceChunkIndex: 0 }],
        })

        const primary = store.suggestNodes('Herbert Hagen', 5, ['test-space'])[0]
        const alternate = store.suggestNodes('Herbert H.', 5, ['second-space'])[0]
        const result = await store.mergeEntities({
            // A canonical-name owner in any selected space is retained even
            // when only the duplicate ID is supplied.
            entityIds: [alternate.id],
            canonicalName: 'Herbert Hagen',
            categoryIds: ['test-space', 'second-space'],
        })

        expect(result.mergedEntityIds).toEqual([alternate.id])
        expect(result.entity.id).toBe(primary.id)
        expect(store.browseGraph({ categoryIds: ['test-space'] }).nodes.some((node) => node.id === result.entity.id)).toBe(true)
        expect(store.browseGraph({ categoryIds: ['second-space'] }).nodes.some((node) => node.id === result.entity.id)).toBe(true)

        getDb().prepare("UPDATE memory_file_index SET content_hash = 'revision-2' WHERE document_id = 'doc-alternate-person'").run()
        store.publishDocument({
            documentId: 'doc-alternate-person', contentHash: 'revision-2', categoryId: 'second-space',
            fileName: 'alternate.md', sourceId: 'memory:second-space:alternate.md', chunks: [chunk('H. Hagen created Beacon.', 0)],
            relations: [{ from: { name: 'H. Hagen', type: 'person' }, relation: 'created', to: { name: 'Beacon', type: 'project' }, sourceChunkIndex: 0 }],
        })

        const resolved = store.suggestNodes('Herbert', 10, ['test-space', 'second-space'])
            .filter((node) => node.type === 'person')
        expect(resolved).toHaveLength(1)
        expect(resolved[0].id).toBe(result.entity.id)
    })

    test('atomically retires claims removed by a newer document revision', async () => {
        addDocument('doc-versioned', 'versioned.md', 'revision-old')
        store.publishDocument({
            documentId: 'doc-versioned', contentHash: 'revision-old', categoryId: 'test-space', fileName: 'versioned.md',
            sourceId: 'memory:test-space:versioned.md', chunks: [chunk('Mira works at Northwind.', 0)],
            relations: [{ from: { name: 'Mira', type: 'person' }, relation: 'works_at', to: { name: 'Northwind', type: 'organization' }, sourceChunkIndex: 0 }],
        })
        getDb().prepare("UPDATE memory_file_index SET content_hash = 'revision-new' WHERE document_id = 'doc-versioned'").run()
        store.publishDocument({
            documentId: 'doc-versioned', contentHash: 'revision-new', categoryId: 'test-space', fileName: 'versioned.md',
            sourceId: 'memory:test-space:versioned.md', chunks: [chunk('Mira is taking a sabbatical.', 0)], relations: [],
        })

        expect((getDb().prepare("SELECT status FROM memory_knowledge_assertions").get() as { status: string }).status).toBe('retired')
        expect((await store.search('Where does Mira work?', ['test-space'])).graph).toBeUndefined()
        const runs = getDb().prepare('SELECT status FROM memory_knowledge_index_runs ORDER BY started_at').all() as Array<{ status: string }>
        expect(runs.map((run) => run.status).sort()).toEqual(['active', 'retired'])
    })

    test('audits manual relationship corrections and applies them to retrieval', async () => {
        addDocument('doc-correction', 'correction.md', 'revision-1')
        store.publishDocument({
            documentId: 'doc-correction', contentHash: 'revision-1', categoryId: 'test-space', fileName: 'correction.md',
            sourceId: 'memory:test-space:correction.md', chunks: [chunk('Nora works at Contoso.', 0)],
            relations: [{ from: { name: 'Nora', type: 'person' }, relation: 'works_at', to: { name: 'Contoso', type: 'organization' }, sourceChunkIndex: 0 }],
        })

        const edge = store.browseGraph({ categoryIds: ['test-space'] }).edges[0]
        expect(store.updateEdge(edge.id, { relation: 'created', note: 'Manually verified correction.', importance: 3 })).toMatchObject({ relation: 'created' })

        const result = await store.search('What did Nora create?', ['test-space'])
        expect(result.graph?.edges[0]).toMatchObject({
            relation: 'created', note: 'Manually verified correction.',
            sourceKind: 'manual', sourceChunkIndex: undefined,
        })
        expect(result.sourceChunks).toEqual([])
        expect(store.filterManuallySupersededChunks([{
            id: 'chunk', text: 'Nora works at Contoso.', source: 'memory', score: 1,
            documentId: 'doc-correction', revision: 'revision-1', chunkIndex: 0,
        }])).toEqual([])
        expect((getDb().prepare('SELECT COUNT(*) AS count FROM memory_knowledge_assertion_corrections').get() as { count: number }).count).toBe(1)
    })

    test('marks same-source functional changes as superseded instead of silently overwriting them', async () => {
        addDocument('doc-employment', 'employment.md', 'revision-old')
        store.publishDocument({
            documentId: 'doc-employment', contentHash: 'revision-old', categoryId: 'test-space', fileName: 'employment.md',
            sourceId: 'memory:test-space:employment.md', chunks: [chunk('Mira works at Northwind.', 0)],
            relations: [{ from: { name: 'Mira', type: 'person' }, relation: 'works_at', to: { name: 'Northwind', type: 'organization' }, sourceChunkIndex: 0 }],
        })
        getDb().prepare("UPDATE memory_file_index SET content_hash = 'revision-new' WHERE document_id = 'doc-employment'").run()
        store.publishDocument({
            documentId: 'doc-employment', contentHash: 'revision-new', categoryId: 'test-space', fileName: 'employment.md',
            sourceId: 'memory:test-space:employment.md', chunks: [chunk('Mira now works at Contoso.', 0)],
            relations: [{ from: { name: 'Mira', type: 'person' }, relation: 'works_at', to: { name: 'Contoso', type: 'organization' }, sourceChunkIndex: 0 }],
        })

        const assertions = getDb().prepare(`
            SELECT a.status, oe.canonical_name AS object_name, a.superseded_by_id
            FROM memory_knowledge_assertions a
            JOIN memory_knowledge_entities oe ON oe.id = a.object_entity_id
            ORDER BY oe.canonical_name
        `).all() as Array<Record<string, unknown>>
        expect(assertions).toEqual([
            expect.objectContaining({ object_name: 'Contoso', status: 'active' }),
            expect.objectContaining({ object_name: 'Northwind', status: 'superseded', superseded_by_id: expect.any(String) }),
        ])
        const current = await store.search('Where does Mira work?', ['test-space'])
        expect(current.graph?.edges.map((edge) => edge.toName)).toEqual(['Contoso'])
    })

    test('propagates unambiguous entity corrections and retractions into the knowledge authority', async () => {
        addDocument('doc-entity', 'entity.md', 'revision-1')
        store.publishDocument({
            documentId: 'doc-entity', contentHash: 'revision-1', categoryId: 'test-space', fileName: 'entity.md',
            sourceId: 'memory:test-space:entity.md', chunks: [chunk('Nora uses TypeScript.', 0)],
            relations: [{ from: { name: 'Nora', type: 'person' }, relation: 'uses', to: { name: 'TypeScript', type: 'technology' }, sourceChunkIndex: 0 }],
        })

        const entity = store.suggestNodes('Nora', 1, ['test-space'])[0]
        expect(store.updateEntity(entity.id, { name: 'Nora Smith', aliases: ['Nora'] })).toMatchObject({ name: 'Nora Smith' })
        expect((await store.search('What does Nora Smith use?', ['test-space'])).graph?.edges[0].fromName).toBe('Nora Smith')
        expect(store.retractEntityById(entity.id)).toBe(true)
        expect((await store.search('What does Nora Smith use?', ['test-space'])).graph).toBeUndefined()
    })

    test('indexes isolated named entities and returns their grounded source chunk', async () => {
        addDocument('doc-mention', 'mention.md', 'revision-1')
        store.publishDocument({
            documentId: 'doc-mention', contentHash: 'revision-1', categoryId: 'test-space', fileName: 'mention.md',
            sourceId: 'memory:test-space:mention.md', chunks: [chunk('The keynote speaker was Dr. Selene Voss.', 0)],
            relations: [],
            mentions: [{ entity: { name: 'Dr. Selene Voss', type: 'person', identityHint: 'keynote speaker' }, sourceChunkIndex: 0, note: 'Dr. Selene Voss is identified as the keynote speaker.' }],
        })

        const result = await store.search('Who is Selene Voss?', ['test-space'])
        expect(result.graph?.nodes[0]).toMatchObject({ name: 'Dr. Selene Voss', type: 'person' })
        expect(result.graph?.edges).toEqual([])
        expect(result.sourceChunks[0]).toMatchObject({ sourceFile: 'mention.md', scoreType: 'entity-resolution' })
        expect(result.sourceChunks[0].text).toContain('keynote speaker')
        const originChunk = store.browseGraph({ categoryIds: ['test-space'] }).nodes[0].origins?.[0].chunks[0]
        expect(originChunk).toMatchObject({
            chunkIndex: 0,
            text: '',
            notes: ['Dr. Selene Voss is identified as the keynote speaker.'],
        })
        expect(originChunk && store.getSourceChunk(originChunk.textUnitId)?.text).toBe('The keynote speaker was Dr. Selene Voss.')
    })

    test('previews document relationships and standalone entities without duplicating participants', () => {
        addDocument('doc-preview', 'preview.md', 'revision-1')
        store.publishDocument({
            documentId: 'doc-preview', contentHash: 'revision-1', categoryId: 'test-space', fileName: 'preview.md',
            sourceId: 'memory:test-space:preview.md', chunks: [chunk('Nora uses TypeScript. Selene spoke.', 0)],
            relations: [{ from: { name: 'Nora', type: 'person' }, relation: 'uses', to: { name: 'TypeScript', type: 'technology' }, sourceChunkIndex: 0 }],
            mentions: [{ entity: { name: 'Selene', type: 'person' }, sourceChunkIndex: 0 }],
        })

        expect(store.documentDeepResearchPreview('test-space', 'preview.md')).toEqual({
            items: [
                { kind: 'relationship', label: 'Nora uses TypeScript' },
                { kind: 'entity', label: 'Selene (person)' },
            ],
            total: 2,
        })
        expect(store.documentDeepResearchPreview('test-space', 'missing.md')).toEqual({ items: [], total: 0 })
    })

    test('caps document extraction previews at fifteen entries', () => {
        const chunks = Array.from({ length: 16 }, (_, index) => chunk(`Person ${index} uses Tool ${index}.`, index))
        addDocument('doc-preview-limit', 'preview-limit.md', 'revision-1')
        store.publishDocument({
            documentId: 'doc-preview-limit', contentHash: 'revision-1', categoryId: 'test-space', fileName: 'preview-limit.md',
            sourceId: 'memory:test-space:preview-limit.md', chunks,
            relations: chunks.map((item, index) => ({
                from: { name: `Person ${index}`, type: 'person' }, relation: 'uses',
                to: { name: `Tool ${index}`, type: 'technology' }, sourceChunkIndex: index,
            })),
        })

        const preview = store.documentDeepResearchPreview('test-space', 'preview-limit.md', 99)
        expect(preview.items).toHaveLength(15)
        expect(preview.total).toBe(16)
    })

    test('anchors role queries to an exact unique person without leaking neighboring profiles when reranking is unavailable', async () => {
        addDocument('doc-family', 'family.md', 'revision-1')
        const familyChunks = [
            chunk('Carmen Hagen is the mother of Andi.', 0),
            chunk('Andi wants to build a workshop.', 1),
        ]
        store.publishDocument({
            documentId: 'doc-family', contentHash: 'revision-1', categoryId: 'test-space', fileName: 'family.md',
            sourceId: 'memory:test-space:family.md', chunks: familyChunks,
            relations: [
                { from: { name: 'Carmen Hagen', type: 'person' }, relation: 'parent_of', to: { name: 'Andi', type: 'person' }, sourceChunkIndex: 0 },
                { from: { name: 'Andi', type: 'person' }, relation: 'has_goal', objectValue: 'build a workshop', sourceChunkIndex: 1 },
            ],
        })

        const result = await store.search('carmen mama', ['test-space'], 12, { depth: 1 })

        expect(result.graph?.seedNodes.map((node) => node.name)).toEqual(['Carmen Hagen'])
        expect(result.graph?.edges.map((edge) => `${edge.fromName}:${edge.relation}:${edge.toName}`)).toEqual([
            'Carmen Hagen:parent_of:Andi',
        ])
        expect(result.graph?.edges[0]).toMatchObject({ retrievalRelevance: expect.any(Number) })
    })

    test('honors focused graph depth and does not invent a seed for an unrelated query', async () => {
        addDocument('doc-depth', 'depth.md', 'revision-1')
        const depthChunks = [
            chunk('Alpha Person knows Beta Person.', 0),
            chunk('Beta Person knows Gamma Person.', 1),
            chunk('Gamma Person knows Delta Person.', 2),
        ]
        store.publishDocument({
            documentId: 'doc-depth', contentHash: 'revision-1', categoryId: 'test-space', fileName: 'depth.md',
            sourceId: 'memory:test-space:depth.md', chunks: depthChunks,
            relations: depthChunks.map((item, index) => ({
                from: { name: ['Alpha Person', 'Beta Person', 'Gamma Person'][index], type: 'person' },
                relation: 'knows',
                to: { name: ['Beta Person', 'Gamma Person', 'Delta Person'][index], type: 'person' },
                sourceChunkIndex: index,
            })),
        })

        const oneHop = await store.search('Alpha Person', ['test-space'], 12, { depth: 1 })
        const twoHops = await store.search('Alpha Person', ['test-space'], 12, { depth: 2 })
        const absent = await store.search('Zzyzx Unrelated', ['test-space'], 12, { depth: 1 })

        expect(oneHop.graph?.edges.map((edge) => edge.fromName)).toEqual(['Alpha Person'])
        expect(twoHops.graph?.edges).toHaveLength(2)
        expect(twoHops.graph?.edges.some((edge) => edge.fromName === 'Beta Person' && edge.toName === 'Gamma Person')).toBe(true)
        expect(absent.graph).toBeUndefined()
    })

    test('does not leak another profile through a shared one-hop entity', () => {
        addDocument('doc-shared-location', 'shared-location.md', 'revision-1')
        const locationChunks = [
            chunk('Patrick Klabacher uses Notion.', 0),
            chunk('Patrick Klabacher is located in Salzburg.', 1),
            chunk('Andreas Hagen is located in Salzburg.', 2),
        ]
        store.publishDocument({
            documentId: 'doc-shared-location', contentHash: 'revision-1', categoryId: 'test-space',
            fileName: 'shared-location.md', sourceId: 'memory:test-space:shared-location.md', chunks: locationChunks,
            relations: [
                { from: { name: 'Patrick Klabacher', type: 'person' }, relation: 'uses', to: { name: 'Notion', type: 'technology' }, sourceChunkIndex: 0 },
                { from: { name: 'Patrick Klabacher', type: 'person' }, relation: 'located_in', to: { name: 'Salzburg', type: 'place' }, sourceChunkIndex: 1 },
                { from: { name: 'Andreas Hagen', type: 'person' }, relation: 'located_in', to: { name: 'Salzburg', type: 'place' }, sourceChunkIndex: 2 },
            ],
        })

        const andreas = store.suggestNodes('Andreas Hagen', 1, ['test-space'])[0]
        const oneHop = store.browseGraph({ categoryIds: ['test-space'], nodeIds: [andreas.id], depth: 1 })

        expect(oneHop.edges).toHaveLength(1)
        expect(oneHop.edges[0]).toMatchObject({ fromName: 'Andreas Hagen', relation: 'located_in', toName: 'Salzburg' })
        expect(oneHop.nodes.some((node) => node.name === 'Patrick Klabacher')).toBe(false)
    })

    test('stores and retracts explicit relationship assertions in the same knowledge plane', () => {
        const edge = store.assertRelationship({
            categoryId: 'test-space',
            from: { name: 'Cynosure', type: 'project' },
            relation: 'uses',
            to: { name: 'SQLite', type: 'technology' },
            importance: 3,
            note: 'Cynosure uses SQLite.',
        })

        expect(edge).toMatchObject({ fromName: 'Cynosure', relation: 'uses', toName: 'SQLite', sourceKind: 'manual' })
        expect(store.browseGraph({ categoryIds: ['test-space'] }).edges).toHaveLength(1)
        expect(store.deleteEdge(edge.id, ['test-space']).edgeDeleted).toBe(true)
        expect(store.browseGraph({ categoryIds: ['test-space'] }).edges).toHaveLength(0)
    })

    test('scopes graph rows and graph statistics to selected memory folders', () => {
        getDb().prepare(`
            INSERT INTO memory_folders (id, name, description, directory_path, sort_order, is_uncategorized, created_at)
            VALUES ('other-space', 'Other', '', ?, 2, 0, ?)
        `).run(join(dataDir, 'other'), Date.now())
        addDocument('doc-scoped-a', 'a.md', 'revision-1')
        addDocument('doc-scoped-b', 'b.md', 'revision-1', 'other-space')
        store.publishDocument({
            documentId: 'doc-scoped-a', contentHash: 'revision-1', categoryId: 'test-space', fileName: 'a.md',
            sourceId: 'memory:test-space:a.md', chunks: [chunk('Alice knows Bob.', 0)],
            relations: [{ from: { name: 'Alice', type: 'person' }, relation: 'knows', to: { name: 'Bob', type: 'person' }, sourceChunkIndex: 0 }],
        })
        store.publishDocument({
            documentId: 'doc-scoped-b', contentHash: 'revision-1', categoryId: 'other-space', fileName: 'b.md',
            sourceId: 'memory:other-space:b.md', chunks: [chunk('Carol knows Dave.', 0)],
            relations: [{ from: { name: 'Carol', type: 'person' }, relation: 'knows', to: { name: 'Dave', type: 'person' }, sourceChunkIndex: 0 }],
        })

        expect(store.graphStats()).toMatchObject({ nodeCount: 4, edgeCount: 2 })
        expect(store.graphStats(['test-space'])).toMatchObject({ nodeCount: 2, edgeCount: 1 })
        expect(store.browseGraph({ categoryIds: ['test-space'] }).nodes.map((node) => node.name).sort()).toEqual(['Alice', 'Bob'])
    })

    test('resets the complete knowledge projection while preserving source memory', async () => {
        const resetEvents: unknown[] = []
        const unsubscribe = getEventBus().on('memory:knowledge-reset', (event) => resetEvents.push(event))
        addDocument('doc-reset', 'reset.md', 'revision-1')
        store.publishDocument({
            documentId: 'doc-reset', contentHash: 'revision-1', categoryId: 'test-space', fileName: 'reset.md',
            sourceId: 'memory:test-space:reset.md', chunks: [chunk('Nora uses TypeScript.', 0)],
            relations: [{ from: { name: 'Nora', type: 'person' }, relation: 'uses', to: { name: 'TypeScript', type: 'technology' }, sourceChunkIndex: 0 }],
        })

        await expect(store.reset()).resolves.toEqual({ nodesDeleted: 2, edgesDeleted: 1 })
        expect(store.graphStats()).toEqual({ nodeCount: 0, edgeCount: 0, recentEdgeCount: 0 })
        expect((getDb().prepare(`SELECT deep_researched_at FROM memory_file_index WHERE document_id = 'doc-reset'`).get() as { deep_researched_at: number }).deep_researched_at).toBe(0)
        expect((getDb().prepare(`SELECT COUNT(*) AS count FROM memory_file_index WHERE document_id = 'doc-reset'`).get() as { count: number }).count).toBe(1)
        expect(resetEvents).toEqual([{ resetAt: expect.any(Number) }])
        unsubscribe()
    })
})
