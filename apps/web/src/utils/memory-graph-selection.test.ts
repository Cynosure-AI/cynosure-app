import { describe, expect, test } from "vitest";
import type { EntityGraphEdge, EntityGraphNode, EntityGraphResponse } from "../api/types";
import { selectConnectedGraph } from "./memory-graph-selection";

function node(id: string, importance: EntityGraphNode["importance"] = 1): EntityGraphNode {
  return {
    id, name: id, normalizedName: id, type: "concept", aliases: [], importance,
    mentionCount: 1, sourceCount: 1, origins: [], firstSeenAt: 1, lastSeenAt: 1,
  };
}

function edge(id: string, from: string, to: string): EntityGraphEdge {
  return {
    id, fromNodeId: from, toNodeId: to, fromName: from, toName: to,
    relation: "related_to", importance: 1, sourceKind: "memory", sourceId: "test",
    mentionCount: 1, firstSeenAt: 1, lastSeenAt: 1,
  };
}

function graph(nodes: EntityGraphNode[], edges: EntityGraphEdge[], seeds: EntityGraphNode[] = []): EntityGraphResponse {
  return {
    stats: { nodeCount: nodes.length, edgeCount: edges.length, recentEdgeCount: edges.length },
    seedNodes: seeds, nodes, edges,
  };
}

describe("connected knowledge graph selection", () => {
  test("uses the node budget for a fuller component before unrelated dyads and isolates", () => {
    const nodes = ["a", "b", "c", "d", "e", "x", "y", "solo"].map((id) => node(id));
    const edges = [edge("ab", "a", "b"), edge("bc", "b", "c"), edge("cd", "c", "d"), edge("de", "d", "e"), edge("xy", "x", "y")];

    const selected = selectConnectedGraph(graph(nodes, edges), 4);

    expect(selected.nodes.map((item) => item.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(selected.edges).toHaveLength(3);
    expect(selected.nodes.some((item) => item.id === "solo")).toBe(false);
  });

  test("keeps an explicitly selected standalone entity", () => {
    const connected = [node("a"), node("b"), node("c")];
    const solo = node("solo");
    const selected = selectConnectedGraph(
      graph([...connected, solo], [edge("ab", "a", "b"), edge("bc", "b", "c")], [solo]),
      2,
    );

    expect(selected.nodes.map((item) => item.id)).toContain("solo");
  });
});
