import {orderedCellPoints} from "../data/cell.mjs";

export function buildHoverIndex(map) {
  const cells = new globalThis.Map();
  const edges = new globalThis.Map();
  const nodes = new globalThis.Map();

  for (const cell of map?.cells ?? []) {
    if (!cell?.id) continue;
    const points = safeOrderedCellPoints(cell);
    const neighbors = uniqueCellsFromEdges(cell);
    const edgeTypeCounts = countEdgeTypes(cell.edges ?? []);

    cells.set(cell.id, {
      kind: "cell",
      entity: cell,
      points,
      area: polygonArea(points),
      neighbors,
      edgeTypeCounts,
      tags: sortedStrings(cell.flags),
    });
  }

  for (const edge of map?.edges ?? []) {
    if (!edge?.id) continue;
    const connectedEdges = new Set();
    for (const node of [edge.start, edge.end]) {
      for (const incident of node?.edges ?? []) {
        if (incident && incident !== edge) connectedEdges.add(incident);
      }
    }

    edges.set(edge.id, {
      kind: "edge",
      entity: edge,
      length: edgeLength(edge),
      connectedEdges,
      connectedNodes: uniqueById([edge.start, edge.end]),
      connectedCells: uniqueById([edge.leftCell, edge.rightCell]),
      tags: sortedStrings(edge.flags),
    });
  }

  for (const node of map?.nodes ?? []) {
    if (!node?.id) continue;
    const connectedEdges = uniqueById([...(node.edges ?? [])]);
    const neighboringNodes = uniqueById(connectedEdges.map((edge) => oppositeNode(edge, node)));
    const connectedCells = uniqueById(
      connectedEdges.flatMap((edge) => [edge.leftCell, edge.rightCell])
    );

    nodes.set(node.id, {
      kind: "node",
      entity: node,
      connectedEdges,
      neighboringNodes,
      connectedCells,
      tags: sortedStrings(node.flags),
    });
  }

  return {
    map,
    cells,
    edges,
    nodes,
    get(kind, id) {
      if (kind === "cell") return cells.get(id) ?? null;
      if (kind === "edge") return edges.get(id) ?? null;
      if (kind === "node") return nodes.get(id) ?? null;
      return null;
    },
  };
}

export function describeHoveredEntity(index, hovered) {
  if (!hovered?.kind || !hovered?.id) return null;

  if (hovered.kind === "cell") {
    const cell = index.get("cell", hovered.id);
    if (!cell) return null;
    return {
      kind: "cell",
      entity: cell.entity,
      details: {
        id: cell.entity.id,
        type: cell.entity.type,
        area: cell.area,
        edgeCount: (cell.entity.edges ?? []).length,
        edgeTypeCounts: sortedEntries(cell.edgeTypeCounts),
        neighborIds: sortedEntityIds(cell.neighbors),
        tags: cell.tags,
      },
      highlight: {
        cells: new Set([cell.entity.id, ...sortedEntityIds(cell.neighbors)]),
        edges: new Set(),
        nodes: new Set(),
      },
    };
  }

  if (hovered.kind === "edge") {
    const edge = index.get("edge", hovered.id);
    if (!edge) return null;
    return {
      kind: "edge",
      entity: edge.entity,
      details: {
        id: edge.entity.id,
        type: edge.entity.type,
        length: edge.length,
        connectedEdgeIds: sortedEntityIds(edge.connectedEdges),
        connectedNodeIds: sortedEntityIds(edge.connectedNodes),
        connectedCellIds: sortedEntityIds(edge.connectedCells),
        tags: edge.tags,
      },
      highlight: {
        cells: new Set(),
        edges: new Set([edge.entity.id, ...sortedEntityIds(edge.connectedEdges)]),
        nodes: new Set(),
      },
    };
  }

  if (hovered.kind === "node") {
    const node = index.get("node", hovered.id);
    if (!node) return null;
    return {
      kind: "node",
      entity: node.entity,
      details: {
        id: node.entity.id,
        type: node.entity.type,
        connectedEdgeIds: sortedEntityIds(node.connectedEdges),
        connectedCellIds: sortedEntityIds(node.connectedCells),
        neighboringNodeIds: sortedEntityIds(node.neighboringNodes),
        tags: node.tags,
      },
      highlight: {
        cells: new Set(),
        edges: new Set(),
        nodes: new Set([node.entity.id, ...sortedEntityIds(node.neighboringNodes)]),
      },
    };
  }

  return null;
}

function safeOrderedCellPoints(cell) {
  try {
    return orderedCellPoints(cell);
  } catch {
    return [];
  }
}

function uniqueCellsFromEdges(cell) {
  const neighbors = new Set();
  for (const edge of cell?.edges ?? []) {
    const neighbor = edge?.leftCell === cell
      ? edge.rightCell
      : edge?.rightCell === cell
        ? edge.leftCell
        : null;
    if (neighbor) neighbors.add(neighbor);
  }
  return neighbors;
}

function countEdgeTypes(edges) {
  const counts = {};
  for (const edge of edges ?? []) {
    const key = String(edge?.type ?? "unknown");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function oppositeNode(edge, node) {
  if (edge?.start === node) return edge.end ?? null;
  if (edge?.end === node) return edge.start ?? null;
  return null;
}

function uniqueById(values) {
  const seen = new Set();
  const unique = [];
  for (const value of values ?? []) {
    if (!value?.id || seen.has(value.id)) continue;
    seen.add(value.id);
    unique.push(value);
  }
  return unique;
}

function polygonArea(points) {
  if ((points?.length ?? 0) < 3) return 0;

  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(twiceArea) / 2;
}

function edgeLength(edge) {
  const start = edge?.start;
  const end = edge?.end;
  if (!start || !end) return 0;
  return Math.hypot(end.x - start.x, end.y - start.y);
}

function sortedStrings(values) {
  return [...(values ?? [])]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value))
    .sort((left, right) => left.localeCompare(right));
}

function sortedEntityIds(values) {
  return uniqueById(Array.isArray(values) ? values : [...(values ?? [])])
    .map((value) => value.id)
    .sort((left, right) => left.localeCompare(right));
}

function sortedEntries(record) {
  return Object.entries(record ?? {})
    .sort(([left], [right]) => left.localeCompare(right));
}
