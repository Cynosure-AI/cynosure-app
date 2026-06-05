import type { EntityGraphNode } from "../../api/types";

export type FlowNodeData = {
  entity: EntityGraphNode;
  label: string;
  isSeed: boolean;
  connectedHandles: Set<string>;
};
