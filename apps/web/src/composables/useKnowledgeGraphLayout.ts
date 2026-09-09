import { nextTick, ref, watch, type Ref } from "vue";
import { MarkerType, useVueFlow, type Edge, type Node } from "@vue-flow/core";
import type { KnowledgeGraphEdge, KnowledgeGraphNode, KnowledgeGraphNodeType, KnowledgeGraph } from "../api/types";
import type { FlowEdgeData, FlowNodeData } from "../components/memory/knowledge-graph-types";

type FlowPoint = { x: number; y: number; width: number; height: number };
export const KNOWLEDGE_GRAPH_FLOW_ID = "knowledge-graph";

export function useKnowledgeGraphLayout(options: {
  graph: Ref<KnowledgeGraph | null>;
  nodeSpacing: Ref<number>;
  formatRelation: (relation: string) => string;
}) {
  const flowNodes = ref<Node<FlowNodeData>[]>([]);
  const flowEdges = ref<Edge<FlowEdgeData>[]>([]);
  const focusedNodeId = ref<string | null>(null);
  const { fitView } = useVueFlow(KNOWLEDGE_GRAPH_FLOW_ID);

  let elkPromise: Promise<InstanceType<typeof import("elkjs/lib/elk-api").default>> | null = null;
  let layoutRequest = 0;
  let fitAfterLayout = false;

  async function getElk() {
    if (!elkPromise) {
      elkPromise = import("elkjs/lib/elk-api").then(({ default: ELK }) => new ELK({
        workerUrl: "/elk-worker.min.js",
      }));
    }
    return elkPromise;
  }

  async function layout() {
    const requestId = ++layoutRequest;
    const graph = options.graph.value;
    if (!graph) {
      flowNodes.value = [];
      flowEdges.value = [];
      return;
    }

    const nodeLabels = new Map<string, KnowledgeGraphNode>();
    for (const node of graph.nodes) nodeLabels.set(node.id, node);
    for (const edge of graph.edges) {
      if (!nodeLabels.has(edge.fromNodeId)) nodeLabels.set(edge.fromNodeId, fallbackNode(edge.fromNodeId, edge.fromName));
      if (!nodeLabels.has(edge.toNodeId)) nodeLabels.set(edge.toNodeId, fallbackNode(edge.toNodeId, edge.toName));
    }

    const seedIds = new Set(graph.seedNodes.map((node) => node.id));
    const dimensions = new Map<string, { width: number; height: number }>(
      [...nodeLabels.entries()].map(([id, node]) => [id, nodeDimensions(node.name, node.importance)]),
    );
    const elk = await getElk();
    const result = await elk.layout({
      id: "entity-root",
      layoutOptions: {
        "elk.algorithm": "stress",
        "elk.stress.desiredEdgeLength": String(Math.round(280 * options.nodeSpacing.value)),
        "elk.spacing.nodeNode": String(Math.round(120 * options.nodeSpacing.value)),
        "elk.separateConnectedComponents": "true",
        "elk.disco.componentCompaction.strategy": "POLYOMINO",
        "elk.randomSeed": "7",
      },
      children: [...nodeLabels.keys()].map((id) => ({
        id,
        width: dimensions.get(id)?.width || 150,
        height: dimensions.get(id)?.height || 44,
      })),
      edges: graph.edges.map((edge) => ({ id: edge.id, sources: [edge.fromNodeId], targets: [edge.toNodeId] })),
    });

    const positions = new Map<string, { x: number; y: number }>((result.children || []).map((child) => [
      child.id,
      { x: Math.round(child.x || 0), y: Math.round(child.y || 0) },
    ]));
    const points = new Map<string, FlowPoint>();
    for (const [id, position] of positions.entries()) {
      points.set(id, { ...position, ...(dimensions.get(id) || { width: 150, height: 44 }) });
    }

    const edgeGroups = new Map<string, KnowledgeGraphEdge[]>();
    for (const edge of graph.edges) {
      const key = [edge.fromNodeId, edge.toNodeId].sort().join("<->");
      edgeGroups.set(key, [...(edgeGroups.get(key) || []), edge]);
    }
    const connectedHandles = new Map<string, Set<string>>();
    const nextEdges: Edge<FlowEdgeData>[] = [...edgeGroups.values()].map((group) => {
      const edge = group[0];
      const labelGroups = groupedEdgeLabels(group, options.formatRelation);
      const isBidirectional = labelGroups.length > 1;
      const isFocusHighlighted = edgeIsFocused(edge.fromNodeId, edge.toNodeId);
      const isFocusDimmed = Boolean(focusedNodeId.value) && !isFocusHighlighted;
      const handles = closestHandles(points.get(edge.fromNodeId), points.get(edge.toNodeId));
      connectedHandles.set(edge.fromNodeId, new Set([...(connectedHandles.get(edge.fromNodeId) || []), handles.sourceHandle]));
      connectedHandles.set(edge.toNodeId, new Set([...(connectedHandles.get(edge.toNodeId) || []), handles.targetHandle]));
      return {
        id: group.map((item) => item.id).join("__"),
        type: "stacked",
        source: edge.fromNodeId,
        target: edge.toNodeId,
        sourceHandle: handles.sourceHandle,
        targetHandle: handles.targetHandle,
        markerEnd: MarkerType.ArrowClosed,
        markerStart: isBidirectional ? MarkerType.ArrowClosed : undefined,
        class: edgeClass(isFocusHighlighted, isFocusDimmed),
        data: {
          relationships: labelGroups.flatMap((item) => item.relationships),
          labelGroups,
          isBidirectional,
          edgeIds: group.map((item) => item.id),
          fromNodeId: edge.fromNodeId,
          toNodeId: edge.toNodeId,
          isFocusHighlighted,
          isFocusDimmed,
        },
        style: { stroke: "var(--memory-flow-edge)", strokeWidth: 1.8 },
      };
    });

    const nextNodes: Node<FlowNodeData>[] = [...nodeLabels.entries()].map(([id, entity]) => {
      const isFocusRoot = focusedNodeId.value === id;
      const isFocusHighlighted = nodeIsFocused(id, graph.edges);
      const isFocusDimmed = Boolean(focusedNodeId.value) && !isFocusHighlighted;
      return {
        id,
        type: "entity",
        position: positions.get(id) || { x: 0, y: 0 },
        class: nodeClass(entity, seedIds.has(id), isFocusRoot, isFocusHighlighted, isFocusDimmed),
        data: {
          entity,
          label: entity.name,
          isSeed: seedIds.has(id),
          connectedHandles: connectedHandles.get(id) ?? new Set(),
          isFocusRoot,
          isFocusHighlighted,
          isFocusDimmed,
        },
      };
    });
    if (requestId !== layoutRequest) return;
    flowNodes.value = nextNodes;
    flowEdges.value = nextEdges;
  }

  function setFocusedNode(nodeId: string | null): void {
    if (focusedNodeId.value === nodeId) return;
    focusedNodeId.value = nodeId;
    applyFocus();
  }

  function applyFocus(): void {
    const graph = options.graph.value;
    if (!graph) return;
    const seedIds = new Set(graph.seedNodes.map((node) => node.id));
    const nextNodes: Node<FlowNodeData>[] = [];
    for (const node of flowNodes.value) {
      if (!node.data) {
        nextNodes.push(node as Node<FlowNodeData>);
        continue;
      }
      const isFocusRoot = focusedNodeId.value === node.id;
      const highlighted = nodeIsFocused(node.id, graph.edges);
      const dimmed = Boolean(focusedNodeId.value) && !highlighted;
      nextNodes.push({
        ...node,
        class: nodeClass(node.data.entity, seedIds.has(node.id), isFocusRoot, highlighted, dimmed),
        data: { ...node.data, isFocusRoot, isFocusHighlighted: highlighted, isFocusDimmed: dimmed },
      } as Node<FlowNodeData>);
    }
    flowNodes.value = nextNodes;

    const nextEdges: Edge<FlowEdgeData>[] = [];
    for (const edge of flowEdges.value) {
      const highlighted = edgeIsFocused(edge.data?.fromNodeId || edge.source, edge.data?.toNodeId || edge.target);
      const dimmed = Boolean(focusedNodeId.value) && !highlighted;
      nextEdges.push({
        ...edge,
        class: edgeClass(highlighted, dimmed),
        data: edge.data ? { ...edge.data, isFocusHighlighted: highlighted, isFocusDimmed: dimmed } : edge.data,
      } as Edge<FlowEdgeData>);
    }
    flowEdges.value = nextEdges;
  }

  function nodeIsFocused(nodeId: string, edges: KnowledgeGraphEdge[]): boolean {
    if (!focusedNodeId.value) return false;
    if (nodeId === focusedNodeId.value) return true;
    return edges.some((edge) =>
      (edge.fromNodeId === focusedNodeId.value && edge.toNodeId === nodeId)
      || (edge.toNodeId === focusedNodeId.value && edge.fromNodeId === nodeId),
    );
  }

  function edgeIsFocused(fromNodeId: string, toNodeId: string): boolean {
    return Boolean(focusedNodeId.value && (fromNodeId === focusedNodeId.value || toNodeId === focusedNodeId.value));
  }

  async function fit(): Promise<void> {
    await layout();
    if (!flowNodes.value.length) return;
    await nextTick();
    window.setTimeout(() => fitView({ padding: 0.18, duration: 320 }).catch(() => undefined), 40);
  }

  function requestFit(): void {
    fitAfterLayout = true;
  }

  watch(options.graph, async () => {
    await layout();
    if (!fitAfterLayout || !options.graph.value || !flowNodes.value.length) return;
    fitAfterLayout = false;
    await nextTick();
    window.setTimeout(() => fitView({ padding: 0.18, duration: 320 }).catch(() => undefined), 40);
  });

  return { flowNodes, flowEdges, focusedNodeId, layout, fit, requestFit, setFocusedNode };
}

function fallbackNode(id: string, name: string): KnowledgeGraphNode {
  return { id, name, normalizedName: name.toLowerCase(), type: "other", aliases: [], importance: 1,
    mentionCount: 0, sourceCount: 0, origins: [], firstSeenAt: 0, lastSeenAt: 0 };
}

function nodeDimensions(label: string, importance = 1): { width: number; height: number } {
  const scale = 1 + importance * 0.1;
  return { width: Math.max(150, Math.min(250, label.length * 8 + 54)) * scale, height: (label.length > 18 ? 56 : 44) * scale };
}

function groupedEdgeLabels(edges: KnowledgeGraphEdge[], format: (relation: string) => string): FlowEdgeData["labelGroups"] {
  const groups = new Map<string, FlowEdgeData["labelGroups"][number]>();
  for (const edge of edges) {
    const key = `${edge.fromNodeId}->${edge.toNodeId}`;
    if (!groups.has(key)) groups.set(key, { fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId,
      fromName: edge.fromName, toName: edge.toName, relationships: [] });
    groups.get(key)!.relationships.push({ id: edge.id, label: format(edge.relation) });
  }
  return [...groups.values()];
}

function closestHandles(source?: FlowPoint, target?: FlowPoint): { sourceHandle: string; targetHandle: string } {
  if (!source || !target) return { sourceHandle: "source-bottom", targetHandle: "target-top" };
  const dx = target.x + target.width / 2 - (source.x + source.width / 2);
  const dy = target.y + target.height / 2 - (source.y + source.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0
    ? { sourceHandle: "source-right", targetHandle: "target-left" }
    : { sourceHandle: "source-left", targetHandle: "target-right" };
  return dy >= 0
    ? { sourceHandle: "source-bottom", targetHandle: "target-top" }
    : { sourceHandle: "source-top", targetHandle: "target-bottom" };
}

function nodeClass(entity: KnowledgeGraphNode, seed: boolean, focusRoot: boolean, highlighted: boolean, dimmed: boolean): string {
  return ["entity-flow-node", entityTypeClass(entity.type), seed ? "entity-flow-node-seed" : "",
    focusRoot ? "entity-flow-node-focus-root" : "",
    highlighted ? "entity-flow-node-focus-highlighted" : "", dimmed ? "entity-flow-node-focus-dimmed" : ""].filter(Boolean).join(" ");
}

function edgeClass(highlighted: boolean, dimmed: boolean): string {
  return ["entity-flow-edge", highlighted ? "entity-flow-edge-focus-highlighted" : "",
    dimmed ? "entity-flow-edge-focus-dimmed" : ""].filter(Boolean).join(" ");
}

function entityTypeClass(type: KnowledgeGraphNodeType): string {
  return `entity-flow-node-type-${type.replace(/_/g, "-")}`;
}
