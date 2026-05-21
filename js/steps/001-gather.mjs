import {Cell} from "../data/cell.mjs";
import {Edge} from "../data/edge.mjs";
import {Map as CityMap} from "../data/map.mjs";
import {Node} from "../data/nodes.mjs";

const EPSILON = 1e-7;
const KEY_PRECISION = 1000000;
const BOUNDARY = "Boundary";

export function cells(settings, map) {
  const sites = map.nodes.filter(node => node.type === "POI");
  const result = new CityMap(settings);
  const nodeIndex = new Map();
  const edgeIndex = new Map();

  sites.forEach((site, siteIndex) => {
    const polygon = buildVoronoiPolygon(site, sites, settings.size);
    if (polygon.length < 3) return;

    const cellEdges = [];
    const cell = Cell(`Cell${siteIndex}`, cellEdges);

    for (let index = 0; index < polygon.length; index += 1) {
      const startPoint = polygon[index];
      const endPoint = polygon[(index + 1) % polygon.length];
      if (samePoint(startPoint, endPoint)) continue;

      const start = getOrCreateNode(result, nodeIndex, startPoint);
      const end = getOrCreateNode(result, nodeIndex, endPoint);
      const edge = getOrCreateEdge(result, edgeIndex, start, end);
      assignCellSide(edge, cell, site);
      cellEdges.push(edge);
    }

    result.cells.push(cell);
  });

  return result;
}

function buildVoronoiPolygon(site, sites, size) {
  let polygon = [
    {x: 0, y: 0},
    {x: size, y: 0},
    {x: size, y: size},
    {x: 0, y: size},
  ];

  for (const other of sites) {
    if (other === site) continue;
    polygon = clipToCloserHalfPlane(polygon, site, other);
    if (polygon.length === 0) break;
  }

  return polygon;
}

function clipToCloserHalfPlane(polygon, site, other) {
  const result = [];

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const currentInside = isCloserOrEqual(current, site, other);
    const nextInside = isCloserOrEqual(next, site, other);

    if (currentInside && nextInside) {
      result.push(next);
    } else if (currentInside && !nextInside) {
      result.push(bisectorIntersection(current, next, site, other));
    } else if (!currentInside && nextInside) {
      result.push(bisectorIntersection(current, next, site, other));
      result.push(next);
    }
  }

  return cleanupPolygon(result);
}

function isCloserOrEqual(point, site, other) {
  return distanceSquared(point, site) <= distanceSquared(point, other) + EPSILON;
}

function distanceSquared(point, site) {
  const dx = point.x - site.x;
  const dy = point.y - site.y;
  return dx * dx + dy * dy;
}

function bisectorIntersection(start, end, site, other) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const a = 2 * (other.x - site.x);
  const b = 2 * (other.y - site.y);
  const c = site.x * site.x + site.y * site.y - other.x * other.x - other.y * other.y;
  const denominator = a * dx + b * dy;

  if (Math.abs(denominator) < EPSILON) return {...start};

  const t = -(a * start.x + b * start.y + c) / denominator;
  return {
    x: start.x + t * dx,
    y: start.y + t * dy,
  };
}

function cleanupPolygon(polygon) {
  const result = [];

  for (const point of polygon) {
    if (result.length === 0 || !samePoint(result[result.length - 1], point)) {
      result.push(point);
    }
  }

  if (result.length > 1 && samePoint(result[0], result[result.length - 1])) {
    result.pop();
  }

  return result;
}

function getOrCreateNode(map, nodeIndex, point) {
  const key = pointKey(point);
  let node = nodeIndex.get(key);
  if (!node) {
    const flags = isBoundaryPoint(point, map.size) ? [BOUNDARY] : [];
    node = Node(`V${nodeIndex.size}`, clamp(point.x, map.size), clamp(point.y, map.size), "Voronoi", null, flags);
    nodeIndex.set(key, node);
    map.nodes.push(node);
  }
  return node;
}

function getOrCreateEdge(map, edgeIndex, start, end) {
  const key = edgeKey(start, end);
  let edge = edgeIndex.get(key);
  if (!edge) {
    const flags = isBoundaryEdge(start, end, map.size) ? [BOUNDARY] : [];
    edge = Edge(`E${edgeIndex.size}`, start, end, "Voronoi", null, flags);
    edgeIndex.set(key, edge);
    map.edges.push(edge);
  }
  return edge;
}

function assignCellSide(edge, cell, site) {
  const side = sideOfEdge(edge, site);
  if (side >= 0) {
    if (!edge.leftCell) edge.leftCell = cell;
    else if (edge.leftCell !== cell && !edge.rightCell) edge.rightCell = cell;
  } else {
    if (!edge.rightCell) edge.rightCell = cell;
    else if (edge.rightCell !== cell && !edge.leftCell) edge.leftCell = cell;
  }
}

function sideOfEdge(edge, point) {
  const dx = edge.end.x - edge.start.x;
  const dy = edge.end.y - edge.start.y;
  return dx * (point.y - edge.start.y) - dy * (point.x - edge.start.x);
}

function isBoundaryPoint(point, size) {
  return near(point.x, 0) || near(point.y, 0) || near(point.x, size) || near(point.y, size);
}

function isBoundaryEdge(start, end, size) {
  return (near(start.x, 0) && near(end.x, 0))
    || (near(start.y, 0) && near(end.y, 0))
    || (near(start.x, size) && near(end.x, size))
    || (near(start.y, size) && near(end.y, size));
}

function near(value, target) {
  return Math.abs(value - target) <= EPSILON;
}

function samePoint(a, b) {
  return near(a.x, b.x) && near(a.y, b.y);
}

function pointKey(point) {
  return `${Math.round(point.x * KEY_PRECISION)},${Math.round(point.y * KEY_PRECISION)}`;
}

function edgeKey(start, end) {
  const startKey = pointKey(start);
  const endKey = pointKey(end);
  return startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
}

function clamp(value, size) {
  if (near(value, 0)) return 0;
  if (near(value, size)) return size;
  return value;
}
