import type { EntityGraphNode } from "../../api/types";

export type GraphEdgePathType = "bezier" | "step" | "straight";

export type FlowNodeData = {
  entity: EntityGraphNode;
  label: string;
  isSeed: boolean;
  connectedHandles: Set<string>;
  isFocusHighlighted?: boolean;
  isFocusDimmed?: boolean;
};

export type FlowEdgeData = {
  labels: string[];
  labelGroups: {
    fromNodeId: string;
    toNodeId: string;
    fromName: string;
    toName: string;
    labels: string[];
  }[];
  isBidirectional: boolean;
  edgeIds: string[];
  fromNodeId: string;
  toNodeId: string;
  isFocusHighlighted?: boolean;
  isFocusDimmed?: boolean;
};
