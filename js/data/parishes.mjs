import {EDGE_TYPE_LAND} from "../constants.mjs";
import {
  buildWeightedNodeGraph,
  computeShortestPathTree,
  reconstructShortestPath,
} from "./pathfinding.mjs";

export const PARISHES_STEP_TITLE = "Parishes";
export const PARISH_LAND_WEIGHT_FACTOR = 12;

export function createParishInteractionState() {
  return {
    displayMap: null,
    graph: null,
    startNodeId: null,
    shortestPathTree: null,
    previewTargetNodeId: null,
  };
}

export function resetParishInteractionState(state) {
  state.displayMap = null;
  state.graph = null;
  state.startNodeId = null;
  state.shortestPathTree = null;
  state.previewTargetNodeId = null;
  return state;
}

export function updateParishGraphCache(state, displayMap) {
  if (state.displayMap === displayMap) return state;

  state.displayMap = displayMap ?? null;
  state.graph = displayMap ? buildParishPathGraph(displayMap) : null;
  state.startNodeId = null;
  state.shortestPathTree = null;
  state.previewTargetNodeId = null;
  return state;
}

export function setParishStartNode(state, startNodeId) {
  if (!state.graph?.getNode?.(startNodeId)) {
    clearParishSelection(state);
    return state;
  }
  if (state.startNodeId === startNodeId && state.shortestPathTree) {
    state.previewTargetNodeId = null;
    return state;
  }

  state.startNodeId = startNodeId;
  state.shortestPathTree = computeShortestPathTree(state.graph, startNodeId);
  state.previewTargetNodeId = null;
  return state;
}

export function setParishPreviewTarget(state, targetNodeId) {
  state.previewTargetNodeId = targetNodeId ?? null;
  return state;
}

export function clearParishSelection(state) {
  state.startNodeId = null;
  state.shortestPathTree = null;
  state.previewTargetNodeId = null;
  return state;
}

export function buildParishPathGraph(map) {
  return buildWeightedNodeGraph(map, {
    edgeFilter: (edge) => edge?.type === EDGE_TYPE_LAND,
    edgeWeight: ({length}) => PARISH_LAND_WEIGHT_FACTOR * length,
  });
}

export function isSelectableParishStartNode(node) {
  return [...(node?.edges ?? [])].some((edge) => edge?.type === EDGE_TYPE_LAND);
}

export function getParishPreviewPath(state) {
  if (!state.startNodeId || !state.shortestPathTree || !state.previewTargetNodeId) return null;
  if (state.previewTargetNodeId === state.startNodeId) return null;
  return reconstructShortestPath(state.shortestPathTree, state.previewTargetNodeId);
}

export function describeParishPreviewPath(state) {
  const path = getParishPreviewPath(state);
  if (!path) return null;

  return {
    path,
    details: {
      startNodeId: path.nodes.at(0)?.id ?? null,
      targetNodeId: path.nodes.at(-1)?.id ?? null,
      nodeCount: path.nodes.length,
      edgeCount: path.edges.length,
      totalLength: path.totalLength,
      totalCost: path.totalWeight,
      nodeIds: path.nodes.map((node) => node.id),
      edgeIds: path.edges.map((edge) => edge.id),
    },
  };
}
