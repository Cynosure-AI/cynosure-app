import type { EntityGraphNode } from "../../api/types";

export type FlowNodeData = {
  entity: EntityGraphNode;
  label: string;
  isSeed: boolean;
  connectedHandles: Set<string>;
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
};
