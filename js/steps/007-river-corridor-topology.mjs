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
  EDGE_TYPE_CROSSING,
  EDGE_TYPE_LAND,
  EDGE_TYPE_MOUTH,
  EDGE_TYPE_RIVER,
  EDGE_TYPE_SEA,
  MAP_FLAG_BOUNDARY,
  NODE_TYPE_COAST,
  NODE_TYPE_CROSSING_END,
  NODE_TYPE_LAND,
  NODE_FLAG_CROSSING,
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

  const corridors = [];
  const corridorByRiverId = new globalThis.Map();
  for (const [index, river] of rivers.entries()) {
    const corridor = buildRiverCorridor(settings, river, index, corridorByRiverId);
    if (corridor.geometry.length === 0) continue;
    corridors.push(corridor);
    if (river?.id) corridorByRiverId.set(river.id, corridor);
  }
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
      const riverFragments = fragmentsFromGeometry(riverGeometry, cell, `${cell.id}-river`, TERRAIN_RIVER)
        .map((fragment) => ({
          ...fragment,
          pointMetadata: buildCrossingPointMetadata(fragment.ring, cell.edges),
        }));
      metrics.riverCellsCreated += riverFragments.length;
      fragments.push(...riverFragments);
    }

    const landFragments = fragmentsFromGeometry(remainderGeometry, cell, cell.id, TERRAIN_LAND);
    fragments.push(...landFragments);
    cellReplacement.set(cell, landFragments.map((fragment) => fragment.id));
  }

  const densifiedFragments = densifyFragments(settings, fragments, metrics);
  rebuildGraphFromFragments(settings, map, densifiedFragments, metrics);
  applyRiverReferences(map, corridors, cellReplacement);
  restoreRiverCrossings(map);
  normalizeGraphAfterCrossings(map);
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

  const sourceCorridors = [];
  const sourceCorridorByRiverId = new globalThis.Map();
  for (const [index, river] of sourceRivers.entries()) {
    const corridor = buildRiverCorridor(settings, river, index, sourceCorridorByRiverId);
    if (corridor.geometry.length === 0) continue;
    sourceCorridors.push(corridor);
    if (river?.id) sourceCorridorByRiverId.set(river.id, corridor);
  }

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

function buildRiverCorridor(settings, river, index, corridorByRiverId = new globalThis.Map()) {
  const centerline = buildRiverCenterline(river, corridorByRiverId);
  if (centerline.length < 2) {
    return {river, centerline: [], smoothed: [], ring: [], geometry: []};
  }
  const smoothed = smoothPolyline(centerline, 2);
  const primary = isPrimaryRiver(river);
  const mergesMain = Boolean(river?.mouth?.riverCell);
  const ring = buildCorridor(smoothed, primary ? primaryHalfWidth(settings) : tributaryHalfWidth(settings), {
    extendStart: primary || !mergesMain,
    extendEnd: true,
  });
  const baseGeometry = isUsableRing(ring) ? polygonFromRing(ring) : [];
  const supportGeometry = mergesMain ? riverCorridorSupportGeometry(river) : [];
  const geometry = baseGeometry.length > 0 && supportGeometry.length > 0
    ? cleanGeometry(polygonClipping.intersection(baseGeometry, supportGeometry))
    : baseGeometry;
  const finalRing = geometryOuterRing(geometry) ?? ring;
  river.finalCenterline = smoothed.map(({x, y}) => ({x, y}));
  river.finalCorridor = finalRing.map(([x, y]) => ({x, y}));
  return {river, centerline, smoothed, ring, geometry};
}

function buildRiverCenterline(river, corridorByRiverId = new globalThis.Map()) {
  const cells = river.riverCells ?? [];
  const points = [];
  const mergeArmPoint = resolveMergeArmPoint(river, corridorByRiverId);
  if (mergeArmPoint) points.push(mergeArmPoint);
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

function resolveMergeArmPoint(river, corridorByRiverId = new globalThis.Map()) {
  if (!river?.mouth?.riverCell) return null;
  const mergeCell = river.mouth.riverCell;
  const sourceRiverId = river.sourceRiverId;
  const sourceCorridor = sourceRiverId ? corridorByRiverId.get(sourceRiverId) : null;
  const fallbackPoint = river.mouth?.riverExitPoint ?? H.cellCentroid(mergeCell);
  if (!sourceCorridor?.smoothed?.length) return fallbackPoint;

  const downstreamEdge = downstreamMergeEdge(sourceCorridor.river, mergeCell);
  if (downstreamEdge) {
    const edgeIntersection = polylineEdgeIntersection(
      sourceCorridor.smoothed,
      toPair(downstreamEdge.start),
      toPair(downstreamEdge.end),
    );
    if (edgeIntersection) return {x: edgeIntersection[0], y: edgeIntersection[1]};
  }

  const mergeCellRing = cleanupRing(orderedCellPoints(mergeCell).map(toPair));
  if (mergeCellRing.length < 3) return fallbackPoint;

  const sampledPoints = samplePolyline(sourceCorridor.smoothed, 24)
    .filter((point) => pointInRing(toPair(point), mergeCellRing));
  if (sampledPoints.length === 0) return fallbackPoint;
  return nearestPoint(sampledPoints, fallbackPoint);
}

function downstreamMergeEdge(sourceRiver, mergeCell) {
  const cells = sourceRiver?.riverCells ?? [];
  const index = cells.indexOf(mergeCell);
  if (index < 0) return null;
  const downstreamCell = cells[index - 1];
  return downstreamCell ? H.cellsEdge(mergeCell, downstreamCell) : null;
}

function riverCorridorSupportGeometry(river) {
  const supportCells = uniqueCells([
    ...(river?.riverCells ?? []),
    river?.mouth?.riverCell,
  ]);
  const polygons = supportCells
    .map(cellGeometry)
    .filter((geometry) => geometry.length > 0);
  return polygons.length > 0 ? cleanGeometry(polygonClipping.union(...polygons)) : [];
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
    const densified = densifyRing(fragment.ring, uniquePoints, fragment.pointMetadata);
    return {
      ...fragment,
      ring: removeDuplicatePairs(densified.ring),
      pointMetadata: densified.pointMetadata,
    };
  });
}

function densifyRing(ring, points, pointMetadata = new globalThis.Map()) {
  const result = [];
  const metadata = new globalThis.Map(pointMetadata ?? []);
  for (let index = 0; index < ring.length; index += 1) {
    const start = ring[index];
    const end = ring[(index + 1) % ring.length];
    result.push(start);
    const segmentPoints = points
      .filter((point) => !samePair(point, start) && !samePair(point, end) && pairOnSegment(point, start, end))
      .sort((a, b) => pairDistance(start, a) - pairDistance(start, b));
    const propagated = crossingMetadataForSegment(start, end, metadata);
    if (propagated) {
      for (const point of segmentPoints) {
        metadata.set(pairKey(point), cloneCrossingMetadata(propagated));
      }
    }
    result.push(...segmentPoints);
  }
  return {ring: result, pointMetadata: metadata};
}

function rebuildGraphFromFragments(settings, map, fragments, metrics) {
  const nodeByPoint = new globalThis.Map();
  const edgeByKey = new globalThis.Map();
  const pointMetadata = collectPointMetadata(fragments);
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
      const start = getOrCreateNode(map, nodeByPoint, fragment.ring[index], pointMetadata.get(pairKey(fragment.ring[index])));
      const end = getOrCreateNode(map, nodeByPoint, fragment.ring[(index + 1) % fragment.ring.length], pointMetadata.get(pairKey(fragment.ring[(index + 1) % fragment.ring.length])));
      if (start === end) continue;
      const edge = getOrCreateEdge(map, edgeByKey, start, end);
      assignEdgeCell(edge, cell);
      cell.edges.push(edge);
    }

    if (cell.edges.length >= 3) map.cells.push(cell);
  }
}

function getOrCreateNode(map, nodeByPoint, pair, metadata = null) {
  const key = pairKey(pair);
  let node = nodeByPoint.get(key);
  if (node) {
    applyCrossingMetadata(node, metadata);
    return node;
  }
  node = Node(`river-corridor-node-${nodeByPoint.size}`, pair[0], pair[1], NODE_TYPE_LAND);
  node.draw = null;
  applyCrossingMetadata(node, metadata);
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

function restoreRiverCrossings(map) {
  const replacements = new globalThis.Map();
  let changed = true;

  while (changed) {
    changed = false;
    const riverCells = [...map.cells]
      .filter((cell) => cell.type === TERRAIN_RIVER)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

    for (const cell of riverCells) {
      const crossingGroup = firstCrossingGroupForCell(cell);
      if (!crossingGroup) continue;
      const children = splitRiverCellByCrossing(map, cell, crossingGroup);
      if (children.length === 0) continue;
      replacements.set(cell, children);
      map.cells = map.cells.filter((candidate) => candidate !== cell);
      map.cells.push(...children);
      changed = true;
      break;
    }
  }

  if (replacements.size > 0) {
    updateRiverReferencesForCrossings(map, replacements);
  }
}

function firstCrossingGroupForCell(cell) {
  const nodes = orderedUniqueCellNodes(cell);
  const groups = new globalThis.Map();

  for (const node of nodes) {
    const sourceEdgeIds = [...ensureSet(node.crossingSourceEdgeIds)].sort((a, b) => String(a).localeCompare(String(b)));
    for (const sourceEdgeId of sourceEdgeIds) {
      if (!groups.has(sourceEdgeId)) groups.set(sourceEdgeId, []);
      groups.get(sourceEdgeId).push(node);
    }
  }

  for (const sourceEdgeId of [...groups.keys()].sort((a, b) => String(a).localeCompare(String(b)))) {
    const uniqueGroupNodes = uniqueNodes(groups.get(sourceEdgeId));
    if (uniqueGroupNodes.length !== 2) continue;
    const [start, end] = uniqueGroupNodes;
    if (start === end || crossingEdgeBetween(start, end)) continue;
    return {sourceEdgeId, nodes: uniqueGroupNodes};
  }

  return null;
}

function splitRiverCellByCrossing(map, cell, crossingGroup) {
  const nodes = orderedUniqueCellNodes(cell);
  const [startNode, endNode] = crossingGroup.nodes;
  const firstIndex = nodes.indexOf(startNode);
  const secondIndex = nodes.indexOf(endNode);
  if (firstIndex < 0 || secondIndex < 0 || firstIndex === secondIndex) return [];

  startNode.type = NODE_TYPE_CROSSING_END;
  startNode.flags.add(NODE_FLAG_CROSSING);
  endNode.type = NODE_TYPE_CROSSING_END;
  endNode.flags.add(NODE_FLAG_CROSSING);

  const firstPath = nodesBetween(nodes, firstIndex, secondIndex);
  const secondPath = nodesBetween(nodes, secondIndex, firstIndex);
  if (firstPath.length < 3 || secondPath.length < 3) return [];
  const crossingEdge = createOrGetCrossingEdge(map, startNode, endNode);

  return [
    createRiverChildCell(map, cell, `${cell.id}-crossing-0`, firstPath, crossingEdge),
    createRiverChildCell(map, cell, `${cell.id}-crossing-1`, secondPath, crossingEdge),
  ].filter(Boolean);
}

function createRiverChildCell(map, originalCell, id, boundaryPath, crossingEdge) {
  const edges = [];
  for (let index = 0; index < boundaryPath.length - 1; index += 1) {
    edges.push(
      findCellEdgeBetween(originalCell, boundaryPath[index], boundaryPath[index + 1])
      ?? createOrGetBoundaryEdge(map, boundaryPath[index], boundaryPath[index + 1])
    );
  }
  edges.push(crossingEdge);
  if (edges.length < 3) return null;

  const child = Cell(id, edges, originalCell.fill, originalCell.draw, [...(originalCell.flags ?? [])]);
  child.type = TERRAIN_RIVER;
  child.parentCellId = originalCell.id;
  child.riverId = originalCell.riverId ?? null;
  child.flags = new Set([...(originalCell.flags ?? []), TERRAIN_RIVER]);

  for (const edge of edges) {
    assignEdgeCellReplacement(edge, originalCell, child);
  }
  return child;
}

function createOrGetBoundaryEdge(map, start, end) {
  const existing = map.edges.find((edge) => edge.type !== EDGE_TYPE_CROSSING && sameEdgeEndpoints(edge, start, end));
  if (existing) return existing;
  const edge = Edge(
    `river-corridor-edge-${map.edges.length}`,
    start,
    end,
    EDGE_TYPE_LAND,
    drawTerrainEdge,
    []
  );
  map.edges.push(edge);
  return edge;
}

function findCellEdgeBetween(cell, start, end) {
  return (cell.edges ?? []).find((edge) => sameEdgeEndpoints(edge, start, end)) ?? null;
}

function createOrGetCrossingEdge(map, start, end) {
  const existing = map.edges.find((edge) => edge.type === EDGE_TYPE_CROSSING && sameEdgeEndpoints(edge, start, end));
  if (existing) return existing;
  const edge = Edge(`river-corridor-crossing-${map.edges.length}`, start, end, EDGE_TYPE_CROSSING, drawTerrainEdge, [TERRAIN_RIVER]);
  map.edges.push(edge);
  return edge;
}

function crossingEdgeBetween(start, end) {
  return [...(start.edges ?? [])].some((edge) => edge.type === EDGE_TYPE_CROSSING && sameEdgeEndpoints(edge, start, end));
}

function assignEdgeCellReplacement(edge, oldCell, newCell) {
  if (edge.leftCell === oldCell) edge.leftCell = newCell;
  else if (edge.rightCell === oldCell) edge.rightCell = newCell;
  else if (!edge.leftCell) edge.leftCell = newCell;
  else if (!edge.rightCell && edge.leftCell !== newCell) edge.rightCell = newCell;
}

function updateRiverReferencesForCrossings(map, replacements) {
  for (const river of map.rivers ?? []) {
    river.riverCells = uniqueCellRefs(
      (river.riverCells ?? []).flatMap((cell) => expandReplacementCells(cell, replacements, map))
    );
    river.originalMouth = remapReplacementCell(river.originalMouth, replacements, map);
    river.exit = remapReplacementCell(river.exit, replacements, map);
    if (river.mouth?.cell) river.mouth.cell = remapReplacementCell(river.mouth.cell, replacements, map);
    if (river.mouth?.riverCell) river.mouth.riverCell = remapReplacementCell(river.mouth.riverCell, replacements, map);
  }
}

function normalizeGraphAfterCrossings(map) {
  const validCells = new Set(map.cells);

  for (const edge of map.edges) {
    if (edge.leftCell && !validCells.has(edge.leftCell)) edge.leftCell = null;
    if (edge.rightCell && !validCells.has(edge.rightCell)) edge.rightCell = null;
  }

  map.edges = map.edges.filter((edge) => edge.leftCell || edge.rightCell);

  for (const cell of map.cells) {
    cell.edges = (cell.edges ?? []).filter((edge) => map.edges.includes(edge) && (edge.leftCell === cell || edge.rightCell === cell));
  }

  for (const node of map.nodes) {
    node.edges = new Set([...(node.edges ?? [])].filter((edge) => map.edges.includes(edge)));
  }
}

function expandReplacementCells(cell, replacements, map) {
  if (!cell) return [];
  if (replacements.has(cell)) {
    return replacements.get(cell).flatMap((replacement) => expandReplacementCells(replacement, replacements, map));
  }
  return map.cells.includes(cell) ? [cell] : [];
}

function remapReplacementCell(cell, replacements, map) {
  return expandReplacementCells(cell, replacements, map)[0] ?? null;
}

function remapCell(map, replacements, cell) {
  if (!cell) return null;
  const ids = replacements.get(cell) ?? [cell.id];
  return ids.map((id) => map.cells.find((candidate) => candidate.id === id)).find(Boolean) ?? null;
}

function classifyEdgesAndNodes(map) {
  for (const edge of map.edges) {
    if (edge.type === EDGE_TYPE_CROSSING) {
      edge.flags = flagsForEdge(edge.type);
      edge.draw = drawTerrainEdge;
      continue;
    }
    const left = edge.leftCell?.type ?? null;
    const right = edge.rightCell?.type ?? null;
    const types = new Set([left, right].filter(Boolean));

    if (isCrossingEdge(edge)) edge.type = EDGE_TYPE_CROSSING;
    else if (types.has(TERRAIN_RIVER) && types.has(TERRAIN_SEA)) edge.type = EDGE_TYPE_MOUTH;
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
    if (isCrossingEndNode(node, edges)) {
      node.type = NODE_TYPE_CROSSING_END;
      node.flags = ensureSet(node.flags);
      node.flags.add(NODE_FLAG_CROSSING);
      node.draw = null;
      continue;
    }
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

function isCrossingEndNode(node, edges) {
  const hasCrossing = edges.some((edge) => edge.type === EDGE_TYPE_CROSSING);
  if (!hasCrossing) return false;
  if (node.type === NODE_TYPE_CROSSING_END) return true;
  if (node.flags?.has?.(NODE_FLAG_CROSSING)) return true;
  return edges.some((edge) => edge.type === EDGE_TYPE_LAND);
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
  if (type === EDGE_TYPE_CROSSING) return "crossing";
  if (type === EDGE_TYPE_SEA) return "sea";
  if (type === EDGE_TYPE_COAST) return "coast";
  if (type === EDGE_TYPE_RIVER) return "river";
  return "land";
}

function flagsForEdge(type) {
  if (type === EDGE_TYPE_SEA) return new Set([TERRAIN_SEA]);
  if (type === EDGE_TYPE_COAST) return new Set([TERRAIN_COAST]);
  if (type === EDGE_TYPE_LAND) return new Set([TERRAIN_LAND]);
  if (type === EDGE_TYPE_BANK || type === EDGE_TYPE_MOUTH || type === EDGE_TYPE_RIVER || type === EDGE_TYPE_CROSSING) return new Set([TERRAIN_RIVER]);
  return new Set();
}

function buildCrossingPointMetadata(ring, sourceEdges) {
  const metadata = new globalThis.Map();
  for (const point of ring) {
    const sourceEdgeId = sourceEdgeForInteriorPoint(point, sourceEdges);
    if (!sourceEdgeId) continue;
    metadata.set(pairKey(point), {sourceEdgeIds: [sourceEdgeId], crossing: true});
  }
  return metadata;
}

function sourceEdgeForInteriorPoint(point, sourceEdges) {
  const pair = Array.isArray(point) ? point : toPair(point);
  const candidates = (sourceEdges ?? [])
    .filter((edge) => edge.type === EDGE_TYPE_LAND || edge.flags?.has?.(TERRAIN_LAND))
    .filter((edge) => pairStrictlyInsideEdge(pair, edge));
  return candidates.length === 1 ? candidates[0].id : null;
}

function collectPointMetadata(fragments) {
  const pointMetadata = new globalThis.Map();
  for (const fragment of fragments) {
    for (const [key, metadata] of fragment.pointMetadata ?? []) {
      if (!pointMetadata.has(key)) {
        pointMetadata.set(key, {sourceEdgeIds: [], crossing: false});
      }
      const target = pointMetadata.get(key);
      target.crossing = target.crossing || Boolean(metadata?.crossing);
      for (const sourceEdgeId of metadata?.sourceEdgeIds ?? []) {
        if (!target.sourceEdgeIds.includes(sourceEdgeId)) target.sourceEdgeIds.push(sourceEdgeId);
      }
    }
  }
  return pointMetadata;
}

function applyCrossingMetadata(node, metadata) {
  if (!metadata?.crossing) return;
  node.flags = ensureSet(node.flags);
  node.flags.add(NODE_FLAG_CROSSING);
  node.crossingSourceEdgeIds = ensureSet(node.crossingSourceEdgeIds);
  for (const sourceEdgeId of metadata.sourceEdgeIds ?? []) node.crossingSourceEdgeIds.add(sourceEdgeId);
}

function crossingMetadataForSegment(start, end, metadata) {
  const startMeta = metadata.get(pairKey(start));
  const endMeta = metadata.get(pairKey(end));
  if (!startMeta?.crossing || !endMeta?.crossing) return null;
  const sharedIds = (startMeta.sourceEdgeIds ?? []).filter((id) => (endMeta.sourceEdgeIds ?? []).includes(id));
  return sharedIds.length > 0 ? {crossing: true, sourceEdgeIds: sharedIds} : null;
}

function cloneCrossingMetadata(metadata) {
  return {
    crossing: Boolean(metadata?.crossing),
    sourceEdgeIds: [...(metadata?.sourceEdgeIds ?? [])],
  };
}

function isCrossingEdge(edge) {
  if (edge.leftCell?.type !== TERRAIN_RIVER || edge.rightCell?.type !== TERRAIN_RIVER) return false;
  if (edge.leftCell?.sourceCellId && edge.rightCell?.sourceCellId && edge.leftCell.sourceCellId !== edge.rightCell.sourceCellId) {
    return true;
  }
  return sharedCrossingSourceEdgeIds(edge.start, edge.end).length > 0;
}

function sharedCrossingSourceEdgeIds(start, end) {
  const startIds = [...ensureSet(start?.crossingSourceEdgeIds)];
  const endIds = [...ensureSet(end?.crossingSourceEdgeIds)];
  return startIds.filter((id) => endIds.includes(id));
}

function orderedUniqueCellNodes(cell) {
  const points = orderedCellPoints(cell);
  return points.filter((point, index) => index === 0 || point !== points[index - 1]);
}

function nodesBetween(nodes, startIndex, endIndex) {
  const result = [nodes[startIndex]];
  let index = startIndex;
  while (index !== endIndex) {
    index = (index + 1) % nodes.length;
    result.push(nodes[index]);
  }
  return result;
}

function uniqueNodes(nodes) {
  return nodes.filter((node, index) => nodes.indexOf(node) === index);
}

function uniqueCellRefs(cells) {
  return cells.filter((cell, index) => cells.indexOf(cell) === index);
}

function sameEdgeEndpoints(edge, start, end) {
  return (edge.start === start && edge.end === end) || (edge.start === end && edge.end === start);
}

function pairStrictlyInsideEdge(point, edge) {
  const start = toPair(edge.start);
  const end = toPair(edge.end);
  return !samePair(point, start) && !samePair(point, end) && pairOnSegment(point, start, end);
}

function ensureSet(value) {
  return value instanceof Set ? value : new Set(Array.isArray(value) ? value : []);
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

function cellGeometry(cell) {
  const ring = cleanupRing(orderedCellPoints(cell).map(toPair));
  return ring.length >= 3 ? polygonFromRing(ring) : [];
}

function geometryOuterRing(geometry) {
  let bestRing = null;
  let bestArea = -Infinity;
  for (const polygon of geometry ?? []) {
    const ring = cleanupRing(polygon[0] ?? []);
    const area = Math.abs(signedArea(ring));
    if (ring.length < 3 || area <= bestArea) continue;
    bestRing = ring;
    bestArea = area;
  }
  return bestRing;
}

function samplePolyline(points, subdivisions = 16) {
  const result = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const steps = index === points.length - 2 ? subdivisions : subdivisions - 1;
    for (let step = 0; step <= steps; step += 1) {
      const ratio = subdivisions === 0 ? 0 : step / subdivisions;
      result.push({
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio,
      });
    }
  }
  return removeDuplicatePointObjects(result);
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[previous];
    const intersects = ((y1 > point[1]) !== (y2 > point[1]))
      && (point[0] < ((x2 - x1) * (point[1] - y1)) / ((y2 - y1) || EPSILON) + x1);
    if (intersects) inside = !inside;
  }
  return inside;
}

function polylineEdgeIntersection(points, edgeStart, edgeEnd) {
  for (let index = 0; index < points.length - 1; index += 1) {
    const intersection = segmentIntersection(toPair(points[index]), toPair(points[index + 1]), edgeStart, edgeEnd);
    if (intersection) return intersection;
  }
  return null;
}

function segmentIntersection(a1, a2, b1, b2) {
  const dax = a2[0] - a1[0];
  const day = a2[1] - a1[1];
  const dbx = b2[0] - b1[0];
  const dby = b2[1] - b1[1];
  const denominator = dax * dby - day * dbx;
  if (Math.abs(denominator) <= EPSILON) return null;

  const dx = b1[0] - a1[0];
  const dy = b1[1] - a1[1];
  const ua = (dx * dby - dy * dbx) / denominator;
  const ub = (dx * day - dy * dax) / denominator;
  if (ua < -EPSILON || ua > 1 + EPSILON || ub < -EPSILON || ub > 1 + EPSILON) return null;

  return [
    roundCoord(a1[0] + ua * dax),
    roundCoord(a1[1] + ua * day),
  ];
}

function nearestPoint(points, target) {
  let bestPoint = null;
  let bestDistance = Infinity;
  for (const point of points ?? []) {
    const distance = H.distance(point, target);
    if (distance >= bestDistance) continue;
    bestPoint = point;
    bestDistance = distance;
  }
  return bestPoint;
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

function uniqueCells(cells) {
  const seen = new Set();
  const result = [];
  for (const cell of cells ?? []) {
    if (!cell?.id || seen.has(cell.id)) continue;
    seen.add(cell.id);
    result.push(cell);
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
