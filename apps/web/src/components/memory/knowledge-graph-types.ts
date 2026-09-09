import type { KnowledgeGraphNode } from "../../api/types";

export type GraphEdgePathType = "bezier" | "step" | "straight";

export type FlowNodeData = {
  entity: KnowledgeGraphNode;
  label: string;
  isSeed: boolean;
  connectedHandles: Set<string>;
  isFocusRoot?: boolean;
  isFocusHighlighted?: boolean;
  isFocusDimmed?: boolean;
};

export type FlowEdgeData = {
  relationships: { id: string; label: string }[];
  labelGroups: {
    fromNodeId: string;
    toNodeId: string;
    fromName: string;
    toName: string;
    relationships: { id: string; label: string }[];
  }[];
  isBidirectional: boolean;
  edgeIds: string[];
  fromNodeId: string;
  toNodeId: string;
  isFocusHighlighted?: boolean;
  isFocusDimmed?: boolean;
};
