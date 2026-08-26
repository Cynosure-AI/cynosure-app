import type { KnowledgeGraphEdge, KnowledgeGraphNode, KnowledgeGraph } from "../api/types";

type GraphComponent = {
  nodeIds: Set<string>;
  edges: KnowledgeGraphEdge[];
  seedCount: number;
  score: number;
};

function nodeScore(node: KnowledgeGraphNode): number {
  return (node.importance * 1_000_000)
    + (Math.min(node.mentionCount, 1_000) * 1_000)
    + (Math.min(node.sourceCount, 100) * 100)
    + Math.floor(node.lastSeenAt / 1_000_000_000);
}

/**
 * Spend a visual node budget on coherent neighborhoods instead of selecting
 * individually popular nodes and leaving behind fragmented two-node islands.
 */
export function selectConnectedGraph(graph: KnowledgeGraph, limit: number): KnowledgeGraph {
  if (graph.nodes.length <= limit) return graph;

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const seedIds = new Set(graph.seedNodes.map((node) => node.id));
  const adjacency = new Map<string, Set<string>>();
  const edgesByNode = new Map<string, KnowledgeGraphEdge[]>();
  for (const node of graph.nodes) {
    adjacency.set(node.id, new Set());
    edgesByNode.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (!nodeById.has(edge.fromNodeId) || !nodeById.has(edge.toNodeId)) continue;
    adjacency.get(edge.fromNodeId)!.add(edge.toNodeId);
    adjacency.get(edge.toNodeId)!.add(edge.fromNodeId);
    edgesByNode.get(edge.fromNodeId)!.push(edge);
    edgesByNode.get(edge.toNodeId)!.push(edge);
  }

  const components: GraphComponent[] = [];
  const visited = new Set<string>();
  for (const node of graph.nodes) {
    if (visited.has(node.id)) continue;
    const nodeIds = new Set<string>();
    const stack = [node.id];
    visited.add(node.id);
    while (stack.length) {
      const current = stack.pop()!;
      nodeIds.add(current);
      for (const neighbor of adjacency.get(current) || []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }
    const componentEdges = graph.edges.filter((edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId));
    const seedCount = [...nodeIds].filter((id) => seedIds.has(id)).length;
    const score = [...nodeIds].reduce((total, id) => total + nodeScore(nodeById.get(id)!), 0)
      + componentEdges.reduce((total, edge) => total + (edge.importance * 100_000) + edge.mentionCount, 0);
    components.push({ nodeIds, edges: componentEdges, seedCount, score });
  }

  components.sort((a, b) => {
    if (a.seedCount !== b.seedCount) return b.seedCount - a.seedCount;
    const aConnected = a.edges.length > 0 ? 1 : 0;
    const bConnected = b.edges.length > 0 ? 1 : 0;
    if (aConnected !== bConnected) return bConnected - aConnected;
    const aRich = a.nodeIds.size >= 3 ? 1 : 0;
    const bRich = b.nodeIds.size >= 3 ? 1 : 0;
    if (aRich !== bRich) return bRich - aRich;
    if (a.nodeIds.size !== b.nodeIds.size) return b.nodeIds.size - a.nodeIds.size;
    return b.score - a.score;
  });

  const selectedIds = new Set<string>();
  for (const component of components) {
    const remaining = limit - selectedIds.size;
    if (remaining <= 0) break;
    // Standalone mentions remain searchable and inspectable elsewhere, but do
    // not consume overview space unless they are an explicit walk/search seed.
    if (component.edges.length === 0 && component.seedCount === 0) continue;
    if (component.nodeIds.size <= remaining) {
      for (const id of component.nodeIds) selectedIds.add(id);
      continue;
    }

    const chosen = new Set<string>();
    const candidates = [...component.nodeIds].sort((a, b) => {
      const seedDelta = Number(seedIds.has(b)) - Number(seedIds.has(a));
      return seedDelta || nodeScore(nodeById.get(b)!) - nodeScore(nodeById.get(a)!);
    });
    if (candidates[0]) chosen.add(candidates[0]);
    while (chosen.size < remaining) {
      const frontier = new Set<string>();
      for (const id of chosen) {
        for (const neighbor of adjacency.get(id) || []) {
          if (component.nodeIds.has(neighbor) && !chosen.has(neighbor)) frontier.add(neighbor);
        }
      }
      const next = [...frontier].sort((a, b) => {
        const seedDelta = Number(seedIds.has(b)) - Number(seedIds.has(a));
        if (seedDelta) return seedDelta;
        const edgeWeight = (id: string) => (edgesByNode.get(id) || [])
          .filter((edge) => chosen.has(edge.fromNodeId) || chosen.has(edge.toNodeId))
          .reduce((total, edge) => total + edge.importance + 1, 0);
        return edgeWeight(b) - edgeWeight(a) || nodeScore(nodeById.get(b)!) - nodeScore(nodeById.get(a)!);
      })[0];
      if (!next) break;
      chosen.add(next);
    }
    for (const id of chosen) selectedIds.add(id);
  }

  return {
    ...graph,
    seedNodes: graph.seedNodes.filter((node) => selectedIds.has(node.id)),
    nodes: graph.nodes.filter((node) => selectedIds.has(node.id)),
    edges: graph.edges.filter((edge) => selectedIds.has(edge.fromNodeId) && selectedIds.has(edge.toNodeId)),
  };
}
