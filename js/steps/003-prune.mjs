import {Node} from "../data/nodes.mjs";
import {MAP_FLAG_BOUNDARY} from "../constants.mjs";

const EPSILON = 1e-7;

export function prune(settings, map) {
  const threshold = settings.prune?.threshold ?? 0;
  const thresholdSq = threshold * threshold;
  let nextNodeIndex = map.nodes.length;

  while (true) {
    const edgeToRemove = findShortestUnderThreshold(map.edges, thresholdSq);
    if (!edgeToRemove) break;

    const start = edgeToRemove.start;
    const end = edgeToRemove.end;
    const merged = mergeNodes(start, end, map.size);
    const mergedNode = Node(`V${nextNodeIndex}`, merged.x, merged.y, start.type, null, merged.flags);
    nextNodeIndex += 1;

    const touchedCells = new Set([
      edgeToRemove.leftCell,
      edgeToRemove.rightCell,
    ]);

    const touchingEdges = new Set([...start.edges, ...end.edges]);
    detachFromNodeSets(edgeToRemove);

    map.edges = map.edges.filter((edge) => edge !== edgeToRemove);
    map.nodes = map.nodes.filter((node) => node !== start && node !== end);
    map.nodes.push(mergedNode);

    rewireEdges(touchingEdges, start, end, mergedNode);
    cleanupCells(map, touchedCells, edgeToRemove);
  }

  return map;
}

function findShortestUnderThreshold(edges, thresholdSq) {
  let candidate = null;
  let bestLengthSq = Infinity;

  for (const edge of edges) {
    const lengthSq = squaredDistance(edge.start, edge.end);
    if (lengthSq >= thresholdSq) continue;
    if (lengthSq < bestLengthSq) {
      candidate = edge;
      bestLengthSq = lengthSq;
    }
  }

  return candidate;
}

function rewireEdges(edges, oldA, oldB, replacement) {
  for (const edge of edges) {
    let changed = false;

    if (edge.start === oldA) {
      edge.start = replacement;
      oldA.edges.delete(edge);
      changed = true;
    } else if (edge.start === oldB) {
      edge.start = replacement;
      oldB.edges.delete(edge);
      changed = true;
    }

    if (edge.end === oldA) {
      edge.end = replacement;
      oldA.edges.delete(edge);
      changed = true;
    } else if (edge.end === oldB) {
      edge.end = replacement;
      oldB.edges.delete(edge);
      changed = true;
    }

    if (changed) {
      replacement.edges.add(edge);
    }
  }
}

function cleanupCells(map, touchedCells, removedEdge) {
  for (const cell of touchedCells) {
    if (!cell) continue;

    cell.edges = cell.edges.filter((edge) => edge !== removedEdge);
    if (cell.edges.length >= 3) continue;

    removeCell(map, cell);
  }
}

function removeCell(map, cell) {
  map.cells = map.cells.filter((item) => item !== cell);

  for (const edge of map.edges) {
    if (edge.leftCell === cell) edge.leftCell = null;
    if (edge.rightCell === cell) edge.rightCell = null;
  }
}

function detachFromNodeSets(edge) {
  edge.start?.edges?.delete(edge);
  edge.end?.edges?.delete(edge);
}

function mergeNodes(firstNode, secondNode, size) {
  const mergedCoords = mergeCoordinates(firstNode, secondNode, size);
  const flags = mergeFlags(firstNode, secondNode, mergedCoords.isBoundary);

  return {
    x: mergedCoords.x,
    y: mergedCoords.y,
    flags,
  };
}

function mergeFlags(firstNode, secondNode, isBoundary) {
  const merged = new Set();
  for (const node of [firstNode, secondNode]) {
    if (node?.flags instanceof Set) {
      for (const flag of node.flags) merged.add(flag);
    }
  }

  if (isBoundary) merged.add(MAP_FLAG_BOUNDARY);
  return [...merged];
}

function mergeCoordinates(firstNode, secondNode, size) {
  const midpoint = {
    x: (firstNode.x + secondNode.x) / 2,
    y: (firstNode.y + secondNode.y) / 2,
  };

  const firstSides = boundarySides(firstNode, size);
  const secondSides = boundarySides(secondNode, size);
  const commonSides = intersection(firstSides, secondSides);

  if (isOppositeBoundaryPair(firstSides, secondSides)) {
    throw new Error("Cannot merge nodes on opposite boundaries");
  }

  if (commonSides.length === 1) {
    return {
      ...pointOnBoundary(midpoint, commonSides[0], size),
      isBoundary: true,
    };
  }

  const mergedSides = unionSides(firstSides, secondSides);
  if (mergedSides.length === 0) {
    return {
      ...midpoint,
      isBoundary: false,
    };
  }

  if (mergedSides.length === 1) {
    return {
      ...pointOnBoundary(midpoint, mergedSides[0], size),
      isBoundary: true,
    };
  }

  if (mergedSides.length === 2) {
    return {
      ...pointOnCorner(mergedSides[0], mergedSides[1], size),
      isBoundary: true,
    };
  }

  const fallbackSide = firstSides.length === 1 ? firstSides[0] : (secondSides.length === 1 ? secondSides[0] : null);
  if (fallbackSide) {
    return {
      ...pointOnBoundary(midpoint, fallbackSide, size),
      isBoundary: true,
    };
  }

  return {
    ...midpoint,
    isBoundary: false,
  };
}

function isOppositeBoundaryPair(firstSides, secondSides) {
  return (firstSides.includes("north") && secondSides.includes("south"))
    || (firstSides.includes("south") && secondSides.includes("north"))
    || (firstSides.includes("east") && secondSides.includes("west"))
    || (firstSides.includes("west") && secondSides.includes("east"));
}

function pointOnBoundary(point, side, size) {
  if (side === "north") return {x: point.x, y: 0};
  if (side === "south") return {x: point.x, y: size};
  if (side === "west") return {x: 0, y: point.y};
  if (side === "east") return {x: size, y: point.y};
  return point;
}

function pointOnCorner(firstSide, secondSide, size) {
  return {
    x: firstSide === "west" || secondSide === "west" ? 0 : size,
    y: firstSide === "north" || secondSide === "north" ? 0 : size,
  };
}

function boundarySides(node, size) {
  const sides = [];

  if (near(node.x, 0)) sides.push("west");
  if (near(node.x, size)) sides.push("east");
  if (near(node.y, 0)) sides.push("north");
  if (near(node.y, size)) sides.push("south");

  return sides;
}

function unionSides(firstSides, secondSides) {
  const uniq = new Set(firstSides);
  for (const side of secondSides) uniq.add(side);
  return [...uniq];
}

function intersection(firstSides, secondSides) {
  const right = new Set(secondSides);
  return firstSides.filter((side) => right.has(side));
}

function near(value, target) {
  return Math.abs(value - target) <= EPSILON;
}

function squaredDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}
