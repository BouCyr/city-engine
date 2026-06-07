import {Cell} from "../data/cell.mjs";
import {cloneDeepKeepFunctions} from "../data/clone.mjs";
import {Edge} from "../data/edge.mjs";
import {Map as CityMap} from "../data/map.mjs";
import {Node} from "../data/nodes.mjs";
import {EDGE_TYPE_VORONOI, MAP_FLAG_BOUNDARY, NODE_TYPE_POI, NODE_TYPE_VORONOI, OVERLAY_TYPE_GATHER} from "../constants.mjs";

const EPSILON = 1e-7;
const KEY_PRECISION = 1000000;
const OVERLAY_COMPETITOR_LIMIT = 6;

export function cells(settings, map) {
  return buildGather(settings, map).map;
}

export function createReplay(settings, inputMap) {
  const frames = [{
    label: "Before gather",
    text: "Gather starts from the Scatter POIs before any Voronoi cells are built.",
    map: cloneDeepKeepFunctions(inputMap),
  }];

  buildGather(settings, inputMap, (result, cellInfo) => {
    const overlay = createGatherOverlaySpec({
      size: settings.size,
      site: cellInfo.site,
      sites: cellInfo.sites,
      polygon: cellInfo.polygon,
    });
    const frameMap = cloneDeepKeepFunctions(result);
    frameMap.drawOverlay = createGatherOverlayDraw(overlay);

    frames.push({
      label: `Cell ${cellInfo.cellNumber} / ${cellInfo.cellCount}`,
      text: `Cell ${cellInfo.cellNumber} is clipped to the half-planes where its POI stays closer than nearby competing POIs.`,
      map: frameMap,
      overlay,
    });
  });

  return {frames};
}

function buildGather(settings, map, afterCell) {
  const sites = map.nodes.filter(node => node.type === NODE_TYPE_POI);
  const siteCells = buildSiteCells(sites, settings.size);
  const result = new CityMap(settings);
  const nodeIndex = new Map();
  const edgeIndex = new Map();

  siteCells.forEach((siteCell, cellIndex) => {
    const {site, siteIndex, polygon} = siteCell;
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
    afterCell?.(result, {
      ...siteCell,
      cell,
      cellNumber: cellIndex + 1,
      cellCount: siteCells.length,
      sites,
    });
  });

  return {map: result, siteCells};
}

function buildSiteCells(sites, size) {
  return sites
    .map((site, siteIndex) => ({
      site,
      siteIndex,
      polygon: buildVoronoiPolygon(site, sites, size),
    }))
    .filter(siteCell => siteCell.polygon.length >= 3);
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
    const flags = isBoundaryPoint(point, map.size) ? [MAP_FLAG_BOUNDARY] : [];
    node = Node(`V${nodeIndex.size}`, clamp(point.x, map.size), clamp(point.y, map.size), NODE_TYPE_VORONOI, null, flags);
    nodeIndex.set(key, node);
    map.nodes.push(node);
  }
  return node;
}

function getOrCreateEdge(map, edgeIndex, start, end) {
  const key = edgeKey(start, end);
  let edge = edgeIndex.get(key);
  if (!edge) {
    const flags = isBoundaryEdge(start, end, map.size) ? [MAP_FLAG_BOUNDARY] : [];
    edge = Edge(`E${edgeIndex.size}`, start, end, EDGE_TYPE_VORONOI, null, flags);
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

function createGatherOverlaySpec({size, site, sites, polygon}) {
  return {
    type: OVERLAY_TYPE_GATHER,
    size,
    site: plainPoint(site),
    sites: sites.map(plainPoint),
    polygon: polygon.map(plainPoint),
  };
}

function plainPoint(point) {
  return {x: point.x, y: point.y};
}

function createGatherOverlayDraw({size, site, sites, polygon}) {
  const competitors = nearestCompetitors(site, sites, OVERLAY_COMPETITOR_LIMIT);

  return function drawGatherOverlay(svg) {
    const layer = svg.getElementById("overlay");
    if (!layer) return;

    appendPolygon(layer, polygon, "gather-overlay-polygon");

    for (const competitor of competitors) {
      appendLine(layer, site, competitor, "gather-overlay-link");
      const segment = bisectorSegment(site, competitor, size);
      if (segment) appendLine(layer, segment.start, segment.end, "gather-overlay-bisector");
      appendCircle(layer, competitor, 9, "gather-overlay-competitor");
    }

    appendCircle(layer, site, 14, "gather-overlay-active-site");
  };
}

function nearestCompetitors(site, sites, limit) {
  return sites
    .filter(other => !samePoint(other, site))
    .map(other => ({site: other, distance: distanceSquared(site, other)}))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map(item => item.site);
}

function bisectorSegment(site, other, size) {
  const a = 2 * (other.x - site.x);
  const b = 2 * (other.y - site.y);
  const c = site.x * site.x + site.y * site.y - other.x * other.x - other.y * other.y;
  const points = [];

  if (Math.abs(b) > EPSILON) {
    addUniquePoint(points, {x: 0, y: -c / b}, size);
    addUniquePoint(points, {x: size, y: -(a * size + c) / b}, size);
  }

  if (Math.abs(a) > EPSILON) {
    addUniquePoint(points, {x: -c / a, y: 0}, size);
    addUniquePoint(points, {x: -(b * size + c) / a, y: size}, size);
  }

  if (points.length < 2) return null;
  return {start: points[0], end: points[1]};
}

function addUniquePoint(points, point, size) {
  if (point.x < -EPSILON || point.x > size + EPSILON || point.y < -EPSILON || point.y > size + EPSILON) {
    return;
  }

  const clamped = {
    x: clamp(point.x, size),
    y: clamp(point.y, size),
  };

  if (!points.some(existing => samePoint(existing, clamped))) {
    points.push(clamped);
  }
}

function appendPolygon(layer, polygon, className) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  element.setAttribute("class", className);
  element.setAttribute("points", polygon.map(point => `${point.x},${point.y}`).join(" "));
  layer.appendChild(element);
}

function appendLine(layer, start, end, className) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", "line");
  element.setAttribute("class", className);
  element.setAttribute("x1", start.x);
  element.setAttribute("y1", start.y);
  element.setAttribute("x2", end.x);
  element.setAttribute("y2", end.y);
  layer.appendChild(element);
}

function appendCircle(layer, point, radius, className) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  element.setAttribute("class", className);
  element.setAttribute("cx", point.x);
  element.setAttribute("cy", point.y);
  element.setAttribute("r", radius);
  layer.appendChild(element);
}
