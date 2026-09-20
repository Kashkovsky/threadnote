export const MANAGER_GRAPH_DEFAULT_NODE_LIMIT = 240;
export const MANAGER_GRAPH_DEFAULT_EDGE_LIMIT = 640;
export const MANAGER_GRAPH_MAX_NODE_LIMIT = 500;
export const MANAGER_GRAPH_MAX_EDGE_LIMIT = 1_500;

export interface ManagerGraphVisualizationBudget {
  readonly edgeLimit?: number;
  readonly nodeLimit?: number;
}

export interface ManagerGraphVisualizationLimits {
  readonly edgeLimit: number;
  readonly nodeLimit: number;
}

export function managerGraphVisualizationLimits(
  requested: ManagerGraphVisualizationBudget = {},
): ManagerGraphVisualizationLimits {
  return {
    edgeLimit: boundedLimit(requested.edgeLimit, MANAGER_GRAPH_DEFAULT_EDGE_LIMIT, MANAGER_GRAPH_MAX_EDGE_LIMIT),
    nodeLimit: boundedLimit(requested.nodeLimit, MANAGER_GRAPH_DEFAULT_NODE_LIMIT, MANAGER_GRAPH_MAX_NODE_LIMIT),
  };
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? Math.max(1, Math.min(maximum, value)) : fallback;
}
