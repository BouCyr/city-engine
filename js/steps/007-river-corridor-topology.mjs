import polygonClipping from "polygon-clipping";
import {Area, AreaGroup} from "../data/area.mjs";
import {Cell, orderedCellPoints} from "../data/cell.mjs";
import {Edge} from "../data/edge.mjs";
import * as H from "../data/helper.mjs";
import {Node} from "../data/nodes.mjs";
import {cloneDeepKeepFunctions} from "../data/clone.mjs";
import {
  AREA_KIND_INNER_SEA,
  AREA_KIND_OPEN_SEA,
  EDGE_TYPE_BANK,
  EDGE_TYPE_COAST,
  EDGE_TYPE_LAND,
  EDGE_TYPE_MOUTH,
  EDGE_TYPE_RIVER,
  EDGE_TYPE_SEA,
  MAP_FLAG_BOUNDARY,
  NODE_TYPE_COAST,
  NODE_TYPE_LAND,
  NODE_TYPE_RIVER,
  NODE_TYPE_SEA,
  RIVER_ROLE_PRIMARY,
  RIVER_TYPE_MAIN,
  OVERLAY_TYPE_RIVERS,
  TERRAIN_COAST,
  TERRAIN_LAND,
  TERRAIN_RIVER,
  TERRAIN_SEA,
} from "../constants.mjs";

const DEFAULT_PRIMARY_WIDTH = 40;
const DEFAULT_TRIBUTARY_WIDTH = 24;
const END_EXTENSION = 50;
const EPSILON = 1e-7;
const RIVER_CORRIDOR_STROKE = "var(--sea-edge)";

export function computeRiverCorridorTopology(settings, map) {
  const metrics = createMetrics(settings);
  metrics.inputCells = map.cells.length;
  metrics.inputEdges = map.edges.length;
  metrics.inputNodes = map.nodes.length;
  checkDeadline(settings, "initialize");

  const rivers = (map.rivers ?? []).filter((river) => river?.riverCells?.length);
  if (rivers.length === 0) {
    rebuildTerrainAreas(map);
    return map;
  }

  const corridors = rivers
    .map((river, index) => buildRiverCorridor(settings, river, index))
    .filter((corridor) => corridor.geometry.length > 0);
  metrics.riversProcessed = corridors.length;
  metrics.centerlinePoints = corridors.reduce((sum, corridor) => sum + corridor.centerline.length, 0);
  metrics.corridorPoints = corridors.reduce((sum, corridor) => sum + corridor.ring.length, 0);
  if (corridors.length === 0) {
    rebuildTerrainAreas(map);
    return map;
  }

  const corridorGeometry = cleanGeometry(polygonClipping.union(...corridors.map((corridor) => corridor.geometry)));
  const corridorBbox = bboxForGeometry(corridorGeometry);
  checkDeadline(settings, "buildCorridor");

  const fragments = [];
  const riverParts = [];
  const cellReplacement = new globalThis.Map();

  for (const cell of map.cells) {
    metrics.cellsVisited += 1;
    checkDeadline(settings, "clipCells");
    const ring = cleanupRing(orderedCellPoints(cell).map(toPair));
    if (ring.length < 3) continue;
    const cellGeometry = polygonFromRing(ring);

    if (cell.type !== TERRAIN_LAND) {
      fragments.push(...fragmentsFromGeometry(cellGeometry, cell, cell.id, cell.type));
      cellReplacement.set(cell, [cell.id]);
      if (cell.type === TERRAIN_SEA) metrics.nonLandCellsSkipped += 1;
      continue;
    }

    metrics.landCells += 1;
    if (!bboxIntersects(bboxForRing(ring), corridorBbox)) {
      fragments.push(...fragmentsFromGeometry(cellGeometry, cell, cell.id, cell.type));
      cellReplacement.set(cell, [cell.id]);
      metrics.cellsOutsideCorridorBbox += 1;
      continue;
    }

    const riverGeometry = cleanGeometry(polygonClipping.intersection(cellGeometry, corridorGeometry));
    const remainderGeometry = cleanGeometry(polygonClipping.difference(cellGeometry, corridorGeometry));

    if (geometryPolygonCount(riverGeometry) > 0) {
      metrics.carvedLandCells += 1;
      riverParts.push(riverGeometry);
    }

    const landFragments = fragmentsFromGeometry(remainderGeometry, cell, cell.id, TERRAIN_LAND);
    fragments.push(...landFragments);
    cellReplacement.set(cell, landFragments.map((fragment) => fragment.id));
  }

  const riverGeometry = riverParts.length > 0
    ? cleanGeometry(polygonClipping.union(...riverParts))
    : [];
  const riverFragments = fragmentsFromGeometry(riverGeometry, null, `river-corridor-cell`, TERRAIN_RIVER)
    .map((fragment) => ({
      ...fragment,
    }));
  metrics.riverCellsCreated = riverFragments.length;
  fragments.push(...riverFragments);

  const densifiedFragments = densifyFragments(settings, fragments, metrics);
  rebuildGraphFromFragments(settings, map, densifiedFragments, metrics);
  applyRiverReferences(map, corridors, cellReplacement);
  classifyEdgesAndNodes(map);
  rebuildTerrainAreas(map);

  map.drawOverlay = null;
  return map;
}

export function createReplay(settings, inputMap) {
  const map = cloneDeepKeepFunctions(inputMap);
  const frames = [];

  const startLabel = "Before river corridor topology";
  const startText = "Rivers will be converted into carved river terrain using clipped corridor polygons.";
  frames.push(replayFrame(map, startLabel, startText, emptyRiverCorridorReplayOverlay()));

  const sourceRivers = (map.rivers ?? []).filter((river) => river?.riverCells?.length);
  if (sourceRivers.length === 0) {
    frames.push(replayFrame(
      map,
      "No river corridors",
      "No valid river cells were present, so no corridor was generated.",
      emptyRiverCorridorReplayOverlay(),
    ));
    return {frames};
  }

  const sourceCorridors = sourceRivers
    .map((river, index) => buildRiverCorridor(settings, river, index))
    .filter((corridor) => corridor.geometry.length > 0);

  frames.push(replayFrame(
    map,
    "River corridor templates",
    "Smoothed centerlines are expanded into width-aware corridor polygons.",
    riverCorridorTemplateOverlay(sourceCorridors),
  ));

  const result = computeRiverCorridorTopology(settings, map);
  frames.push(replayFrame(
    result,
    "River corridor topology",
    "Carved river polygons replace matching land cells and terrain graph boundaries are rebuilt.",
    finalCorridorOverlay(result.rivers ?? []),
  ));

  return {frames};
}

function isPrimaryRiver(river) {
  return river?.role === RIVER_ROLE_PRIMARY || river?.type === RIVER_TYPE_MAIN;
}

function primaryHalfWidth(settings) {
  const width = Number(settings?.riverCells?.primaryWidth);
  const safeWidth = Number.isFinite(width) && width >= 1 ? width : DEFAULT_PRIMARY_WIDTH;
  return safeWidth / 2;
}

function tributaryHalfWidth(settings) {
  const width = Number(settings?.riverCells?.tributaryWidth);
  const safeWidth = Number.isFinite(width) && width >= 1 ? width : DEFAULT_TRIBUTARY_WIDTH;
  return safeWidth / 2;
}

function buildRiverCorridor(settings, river, index) {
  const centerline = buildRiverCenterline(river);
  if (centerline.length < 2) {
    return {river, centerline: [], smoothed: [], ring: [], geometry: []};
  }
  const smoothed = smoothPolyline(centerline, 2);
  const primary = isPrimaryRiver(river);
  const mergesMain = Boolean(river?.mouth?.riverCell);
  const corridorCenterline = prependMergeArmPoint(smoothed, river);
  const ring = buildCorridor(corridorCenterline, primary ? primaryHalfWidth(settings) : tributaryHalfWidth(settings), {
    extendStart: primary || !mergesMain,
    extendEnd: true,
  });
  const geometry = isUsableRing(ring) ? polygonFromRing(ring) : [];
  river.finalCenterline = smoothed.map(({x, y}) => ({x, y}));
  river.finalCorridor = ring.map(([x, y]) => ({x, y}));
  return {river, centerline, smoothed, ring, geometry};
}

function buildRiverCenterline(river) {
  const cells = river.riverCells ?? [];
  const points = [];
  const mouthPoint = riverMouthPoint(river);
  if (mouthPoint) points.push(mouthPoint);
  for (const cell of cells) points.push(H.cellCentroid(cell));
  const exitPoint = riverExitPoint(river);
  if (exitPoint) points.push(exitPoint);
  return removeDuplicatePointObjects(points);
}

function riverMouthPoint(river) {
  if (river.mouth?.cell && river.mouth?.seaCell) {
    const edge = H.cellsEdge(river.mouth.cell, river.mouth.seaCell);
    if (edge) return H.midpoint(edge.start, edge.end);
  }
  if (river.mouth?.cell && river.mouth?.riverCell) {
    const edge = H.cellsEdge(river.mouth.cell, river.mouth.riverCell);
    if (edge) return H.midpoint(edge.start, edge.end);
    return H.cellCentroid(river.mouth.riverCell);
  }
  return river.mouth?.cell ? H.cellCentroid(river.mouth.cell) : null;
}

function prependMergeArmPoint(centerline, river) {
  if (!river?.mouth?.riverCell || centerline.length < 2) return centerline;
  const mergeArmPoint = river.mouth?.riverExitPoint ?? H.cellCentroid(river.mouth.riverCell);
  if (!mergeArmPoint) return centerline;
  if (H.distance(mergeArmPoint, centerline[0]) <= EPSILON) return centerline;
  return [mergeArmPoint, ...centerline];
}

function riverExitPoint(river) {
  const exitEdge = river.exit?.edges?.find((edge) => edge.flags?.has(MAP_FLAG_BOUNDARY));
  return exitEdge ? H.midpoint(exitEdge.start, exitEdge.end) : river.exit ? H.cellCentroid(river.exit) : null;
}

function smoothPolyline(points, passes) {
  let current = removeDuplicatePointObjects(points);
  for (let pass = 0; pass < passes; pass += 1) {
    if (current.length < 3) break;
    const next = [current[0]];
    for (let index = 0; index < current.length - 1; index += 1) {
      const start = current[index];
      const end = current[index + 1];
      next.push({
        x: start.x * 0.75 + end.x * 0.25,
        y: start.y * 0.75 + end.y * 0.25,
      });
      next.push({
        x: start.x * 0.25 + end.x * 0.75,
        y: start.y * 0.25 + end.y * 0.75,
      });
    }
    next.push(current.at(-1));
    current = removeDuplicatePointObjects(next);
  }
  return current;
}

function buildCorridor(centerline, halfWidth, {extendStart = true, extendEnd = true} = {}) {
  const extended = extendCenterline(centerline, {extendStart, extendEnd});
  const left = [];
  const right = [];

  for (let index = 0; index < extended.length; index += 1) {
    const previous = extended[Math.max(0, index - 1)];
    const current = extended[index];
    const next = extended[Math.min(extended.length - 1, index + 1)];
    const tangent = normalize({x: next.x - previous.x, y: next.y - previous.y});
    const normal = {x: -tangent.y, y: tangent.x};
    left.push([current.x + normal.x * halfWidth, current.y + normal.y * halfWidth]);
    right.push([current.x - normal.x * halfWidth, current.y - normal.y * halfWidth]);
  }

  return cleanupRing([...left, ...right.reverse()]);
}

function extendCenterline(centerline, {extendStart = true, extendEnd = true} = {}) {
  const first = centerline[0];
  const second = centerline[1];
  const beforeDirection = normalize({x: first.x - second.x, y: first.y - second.y});
  const last = centerline.at(-1);
  const beforeLast = centerline.at(-2);
  const afterDirection = normalize({x: last.x - beforeLast.x, y: last.y - beforeLast.y});
  return [
    ...(extendStart ? [{x: first.x + beforeDirection.x * END_EXTENSION, y: first.y + beforeDirection.y * END_EXTENSION}] : []),
    ...centerline,
    ...(extendEnd ? [{x: last.x + afterDirection.x * END_EXTENSION, y: last.y + afterDirection.y * END_EXTENSION}] : []),
  ];
}

function fragmentsFromGeometry(geometry, sourceCell, baseId, type) {
  const fragments = [];
  let index = 0;
  for (const polygon of geometry ?? []) {
    const outer = cleanupRing(polygon[0] ?? []);
    if (!isUsableRing(outer)) continue;
    fragments.push({
      id: index === 0 ? baseId : `${baseId}-${type.toLowerCase()}-${index}`,
      sourceCell,
      type,
      ring: outer,
      fill: sourceCell?.fill ?? null,
      draw: type === TERRAIN_RIVER ? drawRiverCell : sourceCell?.draw ?? null,
      flags: type === TERRAIN_RIVER ? [TERRAIN_RIVER] : [...(sourceCell?.flags ?? [])],
    });
    index += 1;
  }
  return fragments;
}

function densifyFragments(settings, fragments, metrics) {
  const allPoints = [];
  for (const fragment of fragments) {
    for (const point of fragment.ring) allPoints.push(point);
  }
  const uniquePoints = uniquePairs(allPoints);
  metrics.densifyPoints = uniquePoints.length;

  return fragments.map((fragment) => {
    checkDeadline(settings, "densifyFragments");
    return {
      ...fragment,
      ring: removeDuplicatePairs(densifyRing(fragment.ring, uniquePoints)),
    };
  });
}

function densifyRing(ring, points) {
  const result = [];
  for (let index = 0; index < ring.length; index += 1) {
    const start = ring[index];
    const end = ring[(index + 1) % ring.length];
    result.push(start);
    const segmentPoints = points
      .filter((point) => !samePair(point, start) && !samePair(point, end) && pairOnSegment(point, start, end))
      .sort((a, b) => pairDistance(start, a) - pairDistance(start, b));
    result.push(...segmentPoints);
  }
  return result;
}

function rebuildGraphFromFragments(settings, map, fragments, metrics) {
  const nodeByPoint = new globalThis.Map();
  const edgeByKey = new globalThis.Map();
  map.nodes = [];
  map.edges = [];
  map.cells = [];

  for (const fragment of fragments) {
    checkDeadline(settings, "rebuildGraph");
    const cell = Cell(fragment.id, [], fragment.fill, fragment.draw, fragment.flags);
    cell.type = fragment.type;
    cell.sourceCellId = fragment.sourceCell?.id ?? null;
    if (fragment.riverId) cell.riverId = fragment.riverId;

    for (let index = 0; index < fragment.ring.length; index += 1) {
      const start = getOrCreateNode(map, nodeByPoint, fragment.ring[index]);
      const end = getOrCreateNode(map, nodeByPoint, fragment.ring[(index + 1) % fragment.ring.length]);
      if (start === end) continue;
      const edge = getOrCreateEdge(map, edgeByKey, start, end);
      assignEdgeCell(edge, cell);
      cell.edges.push(edge);
    }

    if (cell.edges.length >= 3) map.cells.push(cell);
  }
}

function getOrCreateNode(map, nodeByPoint, pair) {
  const key = pairKey(pair);
  let node = nodeByPoint.get(key);
  if (node) return node;
  node = Node(`river-corridor-node-${nodeByPoint.size}`, pair[0], pair[1], NODE_TYPE_LAND);
  node.draw = null;
  nodeByPoint.set(key, node);
  map.nodes.push(node);
  return node;
}

function getOrCreateEdge(map, edgeByKey, start, end) {
  const key = edgeKey(start, end);
  let edge = edgeByKey.get(key);
  if (edge) return edge;
  edge = Edge(`river-corridor-edge-${edgeByKey.size}`, start, end, EDGE_TYPE_LAND, drawTerrainEdge, []);
  edgeByKey.set(key, edge);
  map.edges.push(edge);
  return edge;
}

function assignEdgeCell(edge, cell) {
  if (edge.leftCell === cell || edge.rightCell === cell) return;
  if (!edge.leftCell) edge.leftCell = cell;
  else if (!edge.rightCell) edge.rightCell = cell;
}

function applyRiverReferences(map, corridors, cellReplacement) {
  const riverCells = map.cells.filter((cell) => cell.type === TERRAIN_RIVER);

  for (const corridor of corridors) {
    const river = corridor.river;
    const matchedRiverCells = riverCells.filter((cell) => cellIntersectsGeometry(cell, corridor.geometry));
    river.riverCells = matchedRiverCells.length > 0 ? matchedRiverCells : riverCells;
    river.topologyEdges = [];
    river.originalMouth = remapCell(map, cellReplacement, river.originalMouth);
    river.exit = remapCell(map, cellReplacement, river.exit);
    if (river.mouth) {
      river.mouth = {
        ...river.mouth,
        cell: remapCell(map, cellReplacement, river.mouth.cell),
        seaCell: remapCell(map, cellReplacement, river.mouth.seaCell),
        riverCell: matchedRiverCells[0] ?? riverCells[0] ?? null,
      };
    }
    for (const cell of matchedRiverCells) cell.riverId = river.id ?? null;
  }
}

function remapCell(map, replacements, cell) {
  if (!cell) return null;
  const ids = replacements.get(cell) ?? [cell.id];
  return ids.map((id) => map.cells.find((candidate) => candidate.id === id)).find(Boolean) ?? null;
}

function classifyEdgesAndNodes(map) {
  for (const edge of map.edges) {
    const left = edge.leftCell?.type ?? null;
    const right = edge.rightCell?.type ?? null;
    const types = new Set([left, right].filter(Boolean));

    if (types.has(TERRAIN_RIVER) && types.has(TERRAIN_SEA)) edge.type = EDGE_TYPE_MOUTH;
    else if (types.has(TERRAIN_RIVER) && types.has(TERRAIN_LAND)) edge.type = EDGE_TYPE_BANK;
    else if (left === TERRAIN_RIVER && right === TERRAIN_RIVER) edge.type = EDGE_TYPE_RIVER;
    else if (left === TERRAIN_SEA && right === TERRAIN_SEA) edge.type = EDGE_TYPE_SEA;
    else if (left === TERRAIN_LAND && right === TERRAIN_LAND) edge.type = EDGE_TYPE_LAND;
    else if (types.has(TERRAIN_SEA) && types.has(TERRAIN_LAND)) edge.type = EDGE_TYPE_COAST;
    else if (types.has(TERRAIN_SEA)) edge.type = EDGE_TYPE_SEA;
    else if (types.has(TERRAIN_RIVER)) edge.type = EDGE_TYPE_BANK;
    else edge.type = EDGE_TYPE_LAND;

    edge.flags = flagsForEdge(edge.type);
    edge.draw = drawTerrainEdge;
  }

  for (const node of map.nodes) {
    const edges = [...(node.edges ?? [])].filter((edge) => map.edges.includes(edge));
    if (edges.some((edge) => edge.type === EDGE_TYPE_BANK || edge.type === EDGE_TYPE_MOUTH || edge.type === EDGE_TYPE_RIVER)) {
      node.type = NODE_TYPE_RIVER;
    } else if (edges.some((edge) => edge.type === EDGE_TYPE_COAST)) {
      node.type = NODE_TYPE_COAST;
    } else if (edges.some((edge) => edge.type === EDGE_TYPE_SEA)) {
      node.type = NODE_TYPE_SEA;
    } else {
      node.type = NODE_TYPE_LAND;
    }
    node.draw = null;
  }
}

function rebuildTerrainAreas(map) {
  const seaAreas = connectedComponents(
    map.cells.filter((cell) => cell.type === TERRAIN_SEA),
    (cell) => typedNeighbors(cell, TERRAIN_SEA).filter(({edge}) => edge.type !== EDGE_TYPE_MOUTH)
  ).map((cells, index) => {
    const kind = cells.some(touchesBoundary) ? AREA_KIND_OPEN_SEA : AREA_KIND_INNER_SEA;
    const area = Area(`${kind === AREA_KIND_OPEN_SEA ? "open-sea" : "inner-sea"}-${index}`, TERRAIN_SEA, cells);
    area.kind = kind;
    return area;
  });

  const landAreas = connectedComponents(
    map.cells.filter((cell) => cell.type === TERRAIN_LAND),
    (cell) => typedNeighbors(cell, TERRAIN_LAND)
  ).map((cells, index) => Area(`land-${index}`, TERRAIN_LAND, cells));

  const riverAreas = connectedComponents(
    map.cells.filter((cell) => cell.type === TERRAIN_RIVER),
    (cell) => typedNeighbors(cell, TERRAIN_RIVER)
  ).map((cells, index) => Area(`river-${index}`, TERRAIN_RIVER, cells));

  map.areas = [AreaGroup("terrain", [...seaAreas, ...landAreas, ...riverAreas])];
}

function typedNeighbors(cell, type) {
  return (cell.edges ?? [])
    .map((edge) => ({cell: otherCell(edge, cell), edge}))
    .filter(({cell: neighbor}) => neighbor?.type === type);
}

function connectedComponents(cells, neighborFn) {
  const remaining = new Set(cells);
  const components = [];
  while (remaining.size > 0) {
    const first = [...remaining].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
    const component = [];
    const queue = [first];
    remaining.delete(first);
    while (queue.length > 0) {
      const current = queue.shift();
      component.push(current);
      for (const {cell: neighbor} of neighborFn(current)) {
        if (!remaining.has(neighbor)) continue;
        remaining.delete(neighbor);
        queue.push(neighbor);
      }
    }
    components.push(component);
  }
  return components;
}

function drawRiverCell(svg) {
  const layer = svg.getElementById("cells");
  if (!layer) return;
  const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  polygon.setAttribute("points", orderedCellPoints(this).map((point) => `${point.x},${point.y}`).join(" "));
  polygon.setAttribute("class", "cell terrain-river");
  layer.appendChild(polygon);
}

function drawTerrainEdge(svg) {
  const layer = svg.getElementById("edges");
  if (!layer) return;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", `M ${this.start.x} ${this.start.y} L ${this.end.x} ${this.end.y}`);
  path.setAttribute("class", `edge terrain-${terrainClassForEdge(this.type)}`);
  layer.appendChild(path);
}

function terrainClassForEdge(type) {
  if (type === EDGE_TYPE_MOUTH) return "mouth";
  if (type === EDGE_TYPE_BANK) return "banks";
  if (type === EDGE_TYPE_SEA) return "sea";
  if (type === EDGE_TYPE_COAST) return "coast";
  if (type === EDGE_TYPE_RIVER) return "river";
  return "land";
}

function flagsForEdge(type) {
  if (type === EDGE_TYPE_SEA) return new Set([TERRAIN_SEA]);
  if (type === EDGE_TYPE_COAST) return new Set([TERRAIN_COAST]);
  if (type === EDGE_TYPE_LAND) return new Set([TERRAIN_LAND]);
  if (type === EDGE_TYPE_BANK || type === EDGE_TYPE_MOUTH || type === EDGE_TYPE_RIVER) return new Set([TERRAIN_RIVER]);
  return new Set();
}

function polygonFromRing(ring) {
  return [[closeRing(cleanupRing(ring))]];
}

function cleanGeometry(geometry) {
  return (geometry ?? [])
    .map((polygon) => polygon
      .map((ring) => closeRing(cleanupRing(ring)))
      .filter((ring) => ring.length >= 4))
    .filter((polygon) => polygon.length > 0 && isUsableRing(polygon[0]));
}

function cleanupRing(ring) {
  const result = [];
  for (const point of ring ?? []) {
    const pair = Array.isArray(point) ? point : toPair(point);
    if (result.length > 0 && samePair(result.at(-1), pair)) continue;
    result.push([roundCoord(pair[0]), roundCoord(pair[1])]);
  }
  if (result.length > 1 && samePair(result[0], result.at(-1))) result.pop();
  return removeCollinearPairs(result);
}

function closeRing(ring) {
  const cleaned = cleanupRing(ring);
  if (cleaned.length === 0) return cleaned;
  return [...cleaned, cleaned[0]];
}

function removeCollinearPairs(points) {
  if (points.length < 3) return points;
  return points.filter((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    return Math.abs(crossPairs(previous, point, next)) > 0.000001;
  });
}

function isUsableRing(ring) {
  const open = cleanupRing(ring);
  return open.length >= 3 && Math.abs(signedArea(open)) > 0.001;
}

function geometryPolygonCount(geometry) {
  return (geometry ?? []).filter((polygon) => isUsableRing(polygon[0] ?? [])).length;
}

function cellIntersectsGeometry(cell, geometry) {
  const ring = cleanupRing(orderedCellPoints(cell).map(toPair));
  if (ring.length < 3 || geometry.length === 0) return false;
  return geometryPolygonCount(cleanGeometry(polygonClipping.intersection(polygonFromRing(ring), geometry))) > 0;
}

function bboxForGeometry(geometry) {
  const points = [];
  for (const polygon of geometry ?? []) {
    for (const ring of polygon ?? []) points.push(...cleanupRing(ring));
  }
  return bboxForRing(points);
}

function uniquePairs(points) {
  const seen = new Set();
  const result = [];
  for (const point of points) {
    const key = pairKey(point);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(point);
  }
  return result;
}

function removeDuplicatePairs(points) {
  const result = [];
  for (const point of points) {
    if (result.length > 0 && samePair(result.at(-1), point)) continue;
    result.push(point);
  }
  if (result.length > 1 && samePair(result[0], result.at(-1))) result.pop();
  return result;
}

function pairOnSegment(point, start, end) {
  const length = pairDistance(start, end);
  if (length <= EPSILON) return samePair(point, start);
  return Math.abs(crossPairs(start, point, end)) <= 0.00001
    && pairDistance(start, point) + pairDistance(point, end) <= length + 0.00001;
}

function pairDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function bboxForRing(ring) {
  const bbox = {minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity};
  for (const [x, y] of ring) {
    bbox.minX = Math.min(bbox.minX, x);
    bbox.minY = Math.min(bbox.minY, y);
    bbox.maxX = Math.max(bbox.maxX, x);
    bbox.maxY = Math.max(bbox.maxY, y);
  }
  return bbox;
}

function bboxIntersects(a, b) {
  return a.minX <= b.maxX + EPSILON
    && a.maxX + EPSILON >= b.minX
    && a.minY <= b.maxY + EPSILON
    && a.maxY + EPSILON >= b.minY;
}

function signedArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

function crossPairs(a, b, c) {
  return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
}

function toPair(point) {
  return [point.x, point.y];
}

function pairKey(pair) {
  return `${Math.round(pair[0] * 1000000)},${Math.round(pair[1] * 1000000)}`;
}

function edgeKey(start, end) {
  return [start.id, end.id].sort().join("|");
}

function samePair(a, b) {
  return Math.abs(a[0] - b[0]) <= EPSILON && Math.abs(a[1] - b[1]) <= EPSILON;
}

function roundCoord(value) {
  return Math.round(value * 1000000) / 1000000;
}

function removeDuplicatePointObjects(points) {
  const result = [];
  for (const point of points) {
    if (result.length > 0 && H.distance(result.at(-1), point) <= EPSILON) continue;
    result.push(point);
  }
  return result;
}

function normalize(vector) {
  const length = Math.hypot(vector.x, vector.y);
  if (length <= EPSILON) return {x: 1, y: 0};
  return {x: vector.x / length, y: vector.y / length};
}

function otherCell(edge, cell) {
  if (edge.leftCell === cell) return edge.rightCell;
  if (edge.rightCell === cell) return edge.leftCell;
  return null;
}

function touchesBoundary(cell) {
  return (cell.edges ?? []).some((edge) => edge.flags?.has(MAP_FLAG_BOUNDARY));
}

function createMetrics(settings) {
  const metrics = {
    phase: "river-corridor-topology",
    inputCells: 0,
    inputEdges: 0,
    inputNodes: 0,
    riversProcessed: 0,
    centerlinePoints: 0,
    corridorPoints: 0,
    cellsVisited: 0,
    landCells: 0,
    nonLandCellsSkipped: 0,
    cellsOutsideCorridorBbox: 0,
    carvedLandCells: 0,
    riverCellsCreated: 0,
    densifyPoints: 0,
  };
  settings.performanceMetrics = metrics;
  return metrics;
}

function finalCorridorOverlay(rivers = []) {
  return {
    ...emptyRiverCorridorReplayOverlay(),
    polygons: (rivers ?? [])
      .filter((river) => (river.finalCorridor ?? []).length >= 3)
      .map((river) => ({
        points: river.finalCorridor.map((point) => ({x: point.x ?? point[0], y: point.y ?? point[1]})),
        fill: "rgba(14, 165, 233, 0.12)",
        stroke: RIVER_CORRIDOR_STROKE,
      })),
    paths: (rivers ?? [])
      .filter((river) => (river.finalCenterline ?? []).length >= 2)
      .map((river) => ({
        d: toPathFromPoints(river.finalCenterline),
        stroke: RIVER_CORRIDOR_STROKE,
        strokeWidth: isPrimaryRiver(river) ? 2 : 1.5,
        opacity: 0.9,
      })),
  };
}

function riverCorridorTemplateOverlay(corridors = []) {
  return {
    ...emptyRiverCorridorReplayOverlay(),
    polygons: corridors
      .filter((corridor) => Array.isArray(corridor.ring) && corridor.ring.length >= 3)
      .map((corridor) => ({
        points: corridor.ring.map(([x, y]) => ({x, y})),
        fill: "rgba(14, 165, 233, 0.12)",
        stroke: RIVER_CORRIDOR_STROKE,
      })),
    paths: corridors
      .filter((corridor) => Array.isArray(corridor.smoothed) && corridor.smoothed.length >= 2)
      .map((corridor) => ({
        d: toPathFromPoints(corridor.smoothed),
        stroke: RIVER_CORRIDOR_STROKE,
        strokeWidth: riverReplayStrokeWidth(corridor.river),
        opacity: 0.9,
      })),
  };
}

function riverReplayStrokeWidth(river) {
  return isPrimaryRiver(river) ? 2 : 1.5;
}

function emptyRiverCorridorReplayOverlay() {
  return {
    type: OVERLAY_TYPE_RIVERS,
    polygons: [],
    arrows: [],
    lines: [],
    paths: [],
    points: [],
  };
}

function replayFrame(map, label, text, overlay) {
  const frameMap = cloneDeepKeepFunctions(map);
  const frameOverlay = overlay ? cloneRiverCorridorReplayOverlay(overlay) : emptyRiverCorridorReplayOverlay();
  frameMap.drawOverlay = createReplayOverlayDraw(frameOverlay);
  return {label, text, map: frameMap, overlay: frameOverlay};
}

function cloneRiverCorridorReplayOverlay(overlay = {}) {
  return {
    type: overlay.type ?? OVERLAY_TYPE_RIVERS,
    polygons: (overlay.polygons ?? []).map((polygon) => ({...polygon, points: [...(polygon.points ?? [])]})),
    arrows: [...(overlay.arrows ?? [])],
    lines: [...(overlay.lines ?? [])],
    paths: [...(overlay.paths ?? [])],
    points: [...(overlay.points ?? [])],
  };
}

function createReplayOverlayDraw(overlay) {
  return function drawReplayOverlay(svg) {
    const layer = svg.getElementById("overlay") ?? svg.getElementById("cells");
    if (!layer) return;

    for (const polygon of overlay?.polygons ?? []) {
      const element = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      element.setAttribute("points", (polygon.points ?? []).map((point) => `${point.x},${point.y}`).join(" "));
      element.setAttribute("fill", polygon.fill ?? "none");
      element.setAttribute("stroke", polygon.stroke ?? "none");
      element.setAttribute("stroke-width", String(polygon.strokeWidth ?? 1));
      layer.appendChild(element);
    }

    for (const path of overlay?.paths ?? []) {
      const element = document.createElementNS("http://www.w3.org/2000/svg", "path");
      if (!path?.d) continue;
      element.setAttribute("fill", "none");
      element.setAttribute("stroke", path.stroke ?? RIVER_CORRIDOR_STROKE);
      element.setAttribute("stroke-width", String(path.strokeWidth ?? 1));
      element.setAttribute("stroke-opacity", String(path.opacity ?? 1));
      element.setAttribute("d", path.d);
      layer.appendChild(element);
    }
  };
}

function toPathFromPoints(points) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x ?? point[0]} ${point.y ?? point[1]}`)
    .join(" ");
}

function checkDeadline(settings, label = "river-corridor-topology") {
  settings?.checkDeadline?.(label);
}
