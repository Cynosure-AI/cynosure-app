export type EntityType = 'person' | 'place' | 'organization' | 'project' | 'event' | 'date' | 'technology' | 'product' | 'artifact' | 'concept' | 'other'

/** 0 = temporary, 1 = minor, 2 = useful, 3 = core. */
export type ImportanceLevel = 0 | 1 | 2 | 3

export interface KnowledgeSourceChunk {
  textUnitId: string
  href: string
  documentId: string
  fileName: string
  chunkIndex: number
  documentTitle: string
  sectionPath: string
  text: string
  notes: string[]
}

export interface EntityOrigin {
  sourceKind: string
  sourceId: string
  label: string
  count: number
  lastSeenAt: number
  chunks: KnowledgeSourceChunk[]
}

export interface EntityNode {
  id: string
  name: string
  normalizedName: string
  type: EntityType
  aliases: string[]
  importance: ImportanceLevel
  mentionCount: number
  sourceCount: number
  origins?: EntityOrigin[]
  firstSeenAt: number
  lastSeenAt: number
}

export interface EntityEdge {
  id: string
  fromNodeId: string
  toNodeId: string
  fromName: string
  toName: string
  relation: string
  importance: ImportanceLevel
  /** Query-specific retrieval relevance. */
  retrievalRelevance?: number
  assertionStatus?: 'active' | 'superseded' | 'disputed' | 'retracted' | 'retired' | 'staging'
  note?: string
  sourceKind: string
  sourceId: string
  sourceDocumentId?: string
  sourceContentHash?: string
  sourceChunkIndex?: number
  sourceChunk?: KnowledgeSourceChunk
  sourceIds?: string[]
  mentionCount: number
  firstSeenAt: number
  lastSeenAt: number
}

export interface GraphWalkResult {
  seedNodes: EntityNode[]
  nodes: EntityNode[]
  edges: EntityEdge[]
}

export interface DeleteEdgeResult {
  edgeDeleted: boolean
  orphanedNodeIds: string[]
}

export interface EntityMergeResult {
  entity: EntityNode
  mergedEntityIds: string[]
  consolidatedAssertions: number
  retiredSelfRelationships: number
}
