import type { EntityGraphNode } from "../../api/types";

export type FlowNodeData = {
  entity: EntityGraphNode;
  label: string;
  isSeed: boolean;
  connectedHandles: Set<string>;
  isHoverFocused?: boolean;
  isHoverDimmed?: boolean;
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
  isHoverFocused?: boolean;
  isHoverDimmed?: boolean;
};
