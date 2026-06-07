import {Area, AreaGroup} from "../data/area.mjs";
import {Cell, orderedCellPoints} from "../data/cell.mjs";
import {Edge} from "../data/edge.mjs";
import * as H from "../data/helper.mjs";
import {Node} from "../data/nodes.mjs";
import {INNER_SEA, OPEN_SEA} from "./005.2-rivers.mjs";
import {TERRAIN_LAND, TERRAIN_SEA} from "./004-sea-land.mjs";

const RIVER_EDGE_TYPE = "river";
const RIVER_FLAG = "RIVER";
const RIVER_COLOR = "var(--sea-edge)";
const LAND_AREA_COLORS = [
  "#F44336",
  "#673AB7",
  "#2196F3",
  "#00BCD4",
  "#009688",
  "#CDDC39",
  "#FFC107",
  "#795548",
];

export function computeRiverTopology(settings, map) {
  const rivers = map.rivers ?? [];
  if (rivers.length === 0) {
    rebuildTerrainAreas(map);
    return map;
  }

  const splitSpecs = collectSplitSpecs(map, rivers);
  const replacements = new globalThis.Map();

  const orderedSplitSpecs = [...splitSpecs.entries()]
    .sort((a, b) => String(a[0].id).localeCompare(String(b[0].id)));

  for (const [cell, spec] of orderedSplitSpecs) {
    if (cell.type !== TERRAIN_LAND) {
      console.warn(`River topology: skipping non-land river cell ${cell.id}`);
      continue;
    }

    const boundaryNodes = [...spec.boundaryPoints.values()]
      .map((entry) => ensureBoundaryNode(map, cell, entry.point))
      .filter(Boolean);
    const uniqueBoundaryNodes = uniqueNodes(boundaryNodes);
    if (uniqueBoundaryNodes.length < 2) continue;

    const newCells = uniqueBoundaryNodes.length === 2
      ? splitCellInTwo(map, cell, uniqueBoundaryNodes, spec)
      : splitCellAroundJunction(map, cell, uniqueBoundaryNodes, spec);
    if (newCells.length === 0) continue;

    replacements.set(cell, newCells);
    map.cells = map.cells.filter((item) => item !== cell);
    map.cells.push(...newCells);
  }

  updateRiverReferences(map, replacements);
  map.drawOverlay = null;
  rebuildTerrainAreas(map);
  return map;
}

function collectSplitSpecs(map, rivers) {
  const specs = new globalThis.Map();
  const mainRiver = rivers[0];
  const mergeCells = new Set(
    rivers
      .slice(1)
      .map((river) => river.mouth?.riverCell)
      .filter(Boolean)
  );

  for (const river of rivers) {
    const cells = river.riverCells ?? [];
    for (let index = 0; index < cells.length; index += 1) {
      const cell = cells[index];
      if (!map.cells.includes(cell)) continue;

      const spec = ensureSplitSpec(specs, cell);
      const entry = riverEntryPoint(river, index);
      const exit = riverExitPoint(river, index);
      if (entry) addBoundaryPoint(spec, entry, river);
      if (exit) addBoundaryPoint(spec, exit, river);
      spec.rivers.add(river);
    }
  }

  for (const tributary of rivers.slice(1)) {
    const mergeCell = tributary.mouth?.riverCell;
    const firstTributaryCell = tributary.mouth?.cell ?? tributary.riverCells?.[0];
    if (!mergeCell || !firstTributaryCell || !map.cells.includes(mergeCell)) continue;

    const mergeSpec = ensureSplitSpec(specs, mergeCell);
    const tributaryEntry = midpointBetweenCells(mergeCell, firstTributaryCell);
    if (tributaryEntry) {
      const closestPrimaryPoint = findClosestPrimaryPointForTributary(mainRiver, mergeCell, tributaryEntry);
      if (closestPrimaryPoint && !mergeSpec.closestPrimaryPointKey) {
        mergeSpec.closestPrimaryPointKey = pointKey(closestPrimaryPoint);
      }

      addBoundaryPoint(mergeSpec, tributaryEntry, tributary);
    }

    const mainIndex = (mainRiver?.riverCells ?? []).indexOf(mergeCell);
    if (mainIndex >= 0) {
      const mainEntry = riverEntryPoint(mainRiver, mainIndex);
      const mainExit = riverExitPoint(mainRiver, mainIndex);
      if (mainEntry) addBoundaryPoint(mergeSpec, mainEntry, mainRiver);
      if (mainExit) addBoundaryPoint(mergeSpec, mainExit, mainRiver);
    }

    mergeSpec.forceJunction = true;
    mergeSpec.rivers.add(tributary);
  }

  for (const mergeCell of mergeCells) {
    const spec = specs.get(mergeCell);
    if (spec) spec.forceJunction = true;
  }

  return specs;
}

function findClosestPrimaryPointForTributary(mainRiver, mergeCell, tributaryEntry) {
  if (!mainRiver || !tributaryEntry) return null;

  const mainIndex = (mainRiver.riverCells ?? []).indexOf(mergeCell);
  if (mainIndex < 0) return null;

  const candidates = [];
  const mainEntry = riverEntryPoint(mainRiver, mainIndex);
  const mainExit = riverExitPoint(mainRiver, mainIndex);
  if (mainEntry) candidates.push(mainEntry);
  if (mainExit) candidates.push(mainExit);

  const uniqueCandidates = uniquePoints(candidates.filter(Boolean));
  if (uniqueCandidates.length === 0) return null;

  return uniqueCandidates.reduce((closest, candidate) => {
    return H.distance(closest, tributaryEntry) <= H.distance(candidate, tributaryEntry) ? closest : candidate;
  });
}

function ensureSplitSpec(specs, cell) {
  if (!specs.has(cell)) {
    specs.set(cell, {
      boundaryPoints: new globalThis.Map(),
      rivers: new Set(),
      forceJunction: false,
    });
  }
  return specs.get(cell);
}

function addBoundaryPoint(spec, point, river) {
  const key = pointKey(point);
  if (!spec.boundaryPoints.has(key)) {
    spec.boundaryPoints.set(key, {
      point,
      rivers: new Set(),
    });
  }
  spec.boundaryPoints.get(key).rivers.add(river);
}

function riverEntryPoint(river, index) {
  const cells = river.riverCells ?? [];
  const current = cells[index];
  if (!current) return null;

  if (index > 0) return midpointBetweenCells(current, cells[index - 1]);

  if (river.mouth?.riverCell) return midpointBetweenCells(current, river.mouth.riverCell);
  if (river.mouth?.seaCell) return midpointBetweenCells(current, river.mouth.seaCell);
  const seaNeighbor = typedNeighbors(current, TERRAIN_SEA)[0]?.cell;
  return seaNeighbor ? midpointBetweenCells(current, seaNeighbor) : null;
}

function riverExitPoint(river, index) {
  const cells = river.riverCells ?? [];
  const current = cells[index];
  const next = cells[index + 1];
  if (!current) return null;
  if (next) return midpointBetweenCells(current, next);

  const exitEdge = current.edges.find((edge) => edge.flags?.has("Boundary"));
  return exitEdge ? H.midpoint(exitEdge.start, exitEdge.end) : null;
}

function midpointBetweenCells(cellA, cellB) {
  const edge = H.cellsEdge(cellA, cellB);
  return edge ? H.midpoint(edge.start, edge.end) : null;
}

function ensureBoundaryNode(map, cell, point) {
  const existing = map.nodes.find((node) => samePoint(node, point));
  if (existing) return existing;

  const edge = cell.edges.find((candidate) => pointOnEdge(point, candidate));
  if (!edge) return null;

  return splitEdgeAtPoint(map, edge, point);
}

function splitEdgeAtPoint(map, edge, point) {
  if (samePoint(edge.start, point)) return edge.start;
  if (samePoint(edge.end, point)) return edge.end;

  const adjacentCells = [edge.leftCell, edge.rightCell].filter(Boolean);
  const forwardByCell = new globalThis.Map(
    adjacentCells.map((cell) => [cell, cellTraversesEdgeForward(cell, edge)])
  );

  const node = Node(`river-node-${map.nodes.length}`, point.x, point.y, "river");
  map.nodes.push(node);

  edge.start.edges?.delete?.(edge);
  edge.end.edges?.delete?.(edge);

  const first = Edge(`${edge.id}-a`, edge.start, node, edge.type, edge.draw, [...(edge.flags ?? [])]);
  const second = Edge(`${edge.id}-b`, node, edge.end, edge.type, edge.draw, [...(edge.flags ?? [])]);
  first.leftCell = edge.leftCell;
  first.rightCell = edge.rightCell;
  second.leftCell = edge.leftCell;
  second.rightCell = edge.rightCell;

  const edgeIndex = map.edges.indexOf(edge);
  if (edgeIndex >= 0) map.edges.splice(edgeIndex, 1, first, second);
  else map.edges.push(first, second);

  for (const cell of adjacentCells) {
    const index = cell.edges.indexOf(edge);
    if (index < 0) continue;
    const replacement = forwardByCell.get(cell) ? [first, second] : [second, first];
    cell.edges.splice(index, 1, ...replacement);
  }

  return node;
}

function splitCellInTwo(map, cell, boundaryNodes, spec) {
  const nodes = orderedUniqueCellNodes(cell);
  const firstIndex = nodes.indexOf(boundaryNodes[0]);
  const secondIndex = nodes.indexOf(boundaryNodes[1]);
  if (firstIndex < 0 || secondIndex < 0 || firstIndex === secondIndex) return [];

  const river = dominantRiver(spec);
  const riverEdge = createOrGetRiverEdge(map, boundaryNodes[0], boundaryNodes[1], riverDraw(river), [RIVER_FLAG]);
  applyRiverMetadata(riverEdge, river);

  const firstPath = nodesBetween(nodes, firstIndex, secondIndex);
  const secondPath = nodesBetween(nodes, secondIndex, firstIndex);
  return [
    createChildCell(map, cell, `${cell.id}-bank-0`, firstPath, [riverEdge]),
    createChildCell(map, cell, `${cell.id}-bank-1`, secondPath, [riverEdge]),
  ];
}

function splitCellAroundJunction(map, cell, boundaryNodes, spec) {
  const nodes = orderedUniqueCellNodes(cell);
  const indexedNodes = boundaryNodes
    .map((node) => ({node, index: nodes.indexOf(node)}))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index);
  if (indexedNodes.length < 3) return splitCellInTwo(map, cell, boundaryNodes.slice(0, 2), spec);

  const center = resolveJunctionCenter(map, cell, spec, indexedNodes);

  const spokeByNode = new globalThis.Map();
  for (const {node} of indexedNodes) {
    if (node === center) continue;
    const river = dominantRiverForNode(spec, node) ?? dominantRiver(spec);
    const spoke = createOrGetRiverEdge(map, node, center, riverDraw(river), [RIVER_FLAG]);
    applyRiverMetadata(spoke, river);
    spokeByNode.set(node, spoke);
  }

  const children = [];
  for (let index = 0; index < indexedNodes.length; index += 1) {
    const current = indexedNodes[index];
    const next = indexedNodes[(index + 1) % indexedNodes.length];
    const path = nodesBetween(nodes, current.index, next.index);
    const currentSpoke = current.node === center ? null : spokeByNode.get(current.node);
    const nextSpoke = next.node === center ? null : spokeByNode.get(next.node);
    children.push(createChildCell(
      map,
      cell,
      `${cell.id}-bank-${index}`,
      path,
      [nextSpoke, currentSpoke]
    ));
  }
  return children;
}

function resolveJunctionCenter(map, cell, spec, indexedNodes) {
  const preferredKey = spec.closestPrimaryPointKey;
  if (preferredKey) {
    const directMatch = indexedNodes.find((entry) => pointKey(entry.node) === preferredKey);
    if (directMatch) {
      directMatch.node.type = "river-junction";
      return directMatch.node;
    }
  }

  const center = Node(`river-junction-${map.nodes.length}`, H.cellCentroid(cell).x, H.cellCentroid(cell).y, "river-junction");
  map.nodes.push(center);
  return center;
}

function createChildCell(map, originalCell, id, boundaryPath, internalEdges) {
  const edges = [];
  for (let index = 0; index < boundaryPath.length - 1; index += 1) {
    edges.push(createOrGetBoundaryEdge(map, boundaryPath[index], boundaryPath[index + 1], originalCell.type, null, [TERRAIN_LAND]));
  }
  edges.push(...internalEdges.filter(Boolean));

  const child = Cell(id, edges, originalCell.fill, null, [...(originalCell.flags ?? [])]);
  child.type = TERRAIN_LAND;
  child.draw = originalCell.draw ?? null;
  child.parentCellId = originalCell.id;
  child.flags.add(TERRAIN_LAND);

  for (const edge of edges) {
    assignEdgeCell(edge, originalCell, child);
  }
  return child;
}

function createOrGetBoundaryEdge(map, start, end, type, drawFn = null, flags = []) {
  const existing = findEdgeByEndpoints(map, start, end, (edge) => edge.type !== RIVER_EDGE_TYPE);
  if (existing) return existing;

  const edge = Edge(`${type}-edge-${map.edges.length}`, start, end, type, drawFn, flags);
  map.edges.push(edge);
  return edge;
}

function createOrGetRiverEdge(map, start, end, drawFn = null, flags = []) {
  const existing = findEdgeByEndpoints(map, start, end, (edge) => edge.type === RIVER_EDGE_TYPE);
  if (existing) return existing;

  const edge = Edge(`${RIVER_EDGE_TYPE}-edge-${map.edges.length}`, start, end, RIVER_EDGE_TYPE, drawFn, flags);
  map.edges.push(edge);
  return edge;
}

function findEdgeByEndpoints(map, start, end, matches = () => true) {
  const existing = map.edges.find((edge) => (
    matches(edge) && (
    (edge.start === start && edge.end === end) ||
    (edge.start === end && edge.end === start)
    )
  ));
  return existing ?? null;
}

function assignEdgeCell(edge, oldCell, newCell) {
  if (edge.leftCell === oldCell) edge.leftCell = newCell;
  else if (edge.rightCell === oldCell) edge.rightCell = newCell;
  else if (!edge.leftCell) edge.leftCell = newCell;
  else if (!edge.rightCell && edge.leftCell !== newCell) edge.rightCell = newCell;
}

function updateRiverReferences(map, replacements) {
  for (const river of map.rivers ?? []) {
    const originalCells = river.riverCells ?? [];
    const replacementCells = [];
    for (const cell of originalCells) {
      replacementCells.push(...(replacements.get(cell) ?? (map.cells.includes(cell) ? [cell] : [])));
    }
    river.originalRiverCellIds = originalCells.map((cell) => cell.id);
    river.riverCells = uniqueCells(replacementCells);
    river.originalMouth = remapCellReference(map, replacements, river.originalMouth);
    river.exit = remapCellReference(map, replacements, river.exit);
    if (river.mouth) {
      river.mouth = {
        ...river.mouth,
        cell: remapCellReference(map, replacements, river.mouth.cell),
        seaCell: remapCellReference(map, replacements, river.mouth.seaCell),
        riverCell: remapCellReference(map, replacements, river.mouth.riverCell),
      };
    }
    river.topologyEdges = map.edges.filter((edge) => edge.type === RIVER_EDGE_TYPE && edge.riverId === river.id);
  }
}

function remapCellReference(map, replacements, cell) {
  if (!cell) return null;
  return replacements.get(cell)?.[0] ?? (map.cells.includes(cell) ? cell : null);
}

function rebuildTerrainAreas(map) {
  const seaAreas = connectedComponents(
    map.cells.filter((cell) => cell.type === TERRAIN_SEA),
    (cell) => typedNeighbors(cell, TERRAIN_SEA)
      .filter(({edge}) => edge.type !== RIVER_EDGE_TYPE)
  ).map((cells, index) => {
    const kind = cells.some(touchesBoundary) ? OPEN_SEA : INNER_SEA;
    const area = Area(`${kind === OPEN_SEA ? "open-sea" : "inner-sea"}-${index}`, TERRAIN_SEA, cells);
    area.kind = kind;
    return area;
  });

  const landAreas = connectedComponents(
    map.cells.filter((cell) => cell.type === TERRAIN_LAND),
    landAreaNeighbors
  ).map((cells, index) => Area(`land-${index}`, TERRAIN_LAND, cells));

  assignLandAreaColors(landAreas);
  map.areas = [AreaGroup("terrain", [...seaAreas, ...landAreas])];
}

function assignLandAreaColors(areas) {
  const adjacency = new globalThis.Map(areas.map((area) => [area, new Set()]));
  const areaByCell = new globalThis.Map();
  areas.forEach((area) => area.cells.forEach((cell) => areaByCell.set(cell, area)));

  for (const area of areas) {
    for (const cell of area.cells) {
      for (const {cell: neighbor} of typedNeighbors(cell, TERRAIN_LAND)) {
        const neighborArea = areaByCell.get(neighbor);
        if (!neighborArea || neighborArea === area) continue;
        adjacency.get(area).add(neighborArea);
      }
    }
  }

  const assigned = new Set();
  for (const area of [...areas].sort((a, b) => a.name.localeCompare(b.name))) {
    const neighboringColors = new Set([...adjacency.get(area)].map((neighbor) => neighbor.tint).filter(Boolean));
    area.tint = chooseAreaColor(neighboringColors, assigned, adjacency.get(area));
    area.tintOpacity = 0.2;
    assigned.add(area.tint);
  }
}

function chooseAreaColor(neighboringColors, assigned, neighbors) {
  const unusedAvailable = LAND_AREA_COLORS.find((color) => !neighboringColors.has(color) && !assigned.has(color));
  if (unusedAvailable) return unusedAvailable;

  const available = LAND_AREA_COLORS.find((color) => !neighboringColors.has(color));
  if (available) return available;

  return [...LAND_AREA_COLORS].sort((a, b) => {
    const aConflicts = [...neighbors].filter((area) => area.tint === a).length;
    const bConflicts = [...neighbors].filter((area) => area.tint === b).length;
    return aConflicts - bConflicts || LAND_AREA_COLORS.indexOf(a) - LAND_AREA_COLORS.indexOf(b);
  })[0];
}

function landAreaNeighbors(cell) {
  return typedNeighbors(cell, TERRAIN_LAND)
    .filter(({edge}) => edge.type !== RIVER_EDGE_TYPE);
}

function typedNeighbors(cell, type) {
  return cell.edges
    .map((edge) => ({cell: otherCell(edge, cell), edge}))
    .filter(({cell: neighbor}) => neighbor?.type === type);
}

function otherCell(edge, cell) {
  if (edge.leftCell === cell) return edge.rightCell;
  if (edge.rightCell === cell) return edge.leftCell;
  return null;
}

function connectedComponents(cells, neighborFn) {
  const remaining = new Set(cells);
  const components = [];
  while (remaining.size > 0) {
    const first = [...remaining].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
    const component = [];
    const frontier = [first];
    remaining.delete(first);
    while (frontier.length > 0) {
      const current = frontier.shift();
      component.push(current);
      for (const {cell: neighbor} of neighborFn(current)) {
        if (!remaining.has(neighbor)) continue;
        remaining.delete(neighbor);
        frontier.push(neighbor);
      }
    }
    components.push(component);
  }
  return components;
}

function cellTraversesEdgeForward(cell, edge) {
  const points = orderedCellPoints(cell);
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (current === edge.start && next === edge.end) return true;
    if (current === edge.end && next === edge.start) return false;
  }
  return true;
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

function uniquePoints(points) {
  const seen = new Set();
  const result = [];
  for (const point of points) {
    const key = pointKey(point);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(point);
  }
  return result;
}

function uniqueCells(cells) {
  return cells.filter((cell, index) => cells.indexOf(cell) === index);
}

function dominantRiver(spec) {
  return [...spec.rivers].sort(compareRivers)[0] ?? null;
}

function dominantRiverForNode(spec, node) {
  const entry = spec.boundaryPoints.get(pointKey(node));
  return entry ? [...entry.rivers].sort(compareRivers)[0] : null;
}

function compareRivers(a, b) {
  return (a?.order ?? 0) - (b?.order ?? 0) || String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

function applyRiverMetadata(edge, river) {
  edge.type = RIVER_EDGE_TYPE;
  edge.flags = ensureSet(edge.flags);
  edge.flags.add(RIVER_FLAG);
  edge.riverId = river?.id ?? null;
  edge.riverRole = river?.role ?? river?.type ?? null;
}

function riverDraw(river) {
  const width = river?.role === "PRIMARY" || river?.type === "MAIN" ? 12 : 8;
  return function drawRiverEdge(svg) {
    const layer = svg.getElementById("edges");
    if (!layer) return;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${this.start.x} ${this.start.y} L ${this.end.x} ${this.end.y}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", RIVER_COLOR);
    path.setAttribute("stroke-width", String(width));
    path.setAttribute("stroke-linecap", "round");
    layer.appendChild(path);
  };
}

function ensureSet(value) {
  return value instanceof Set ? value : new Set(Array.isArray(value) ? value : []);
}

function touchesBoundary(cell) {
  return cell.edges.some((edge) => edge.flags?.has("Boundary"));
}

function pointOnEdge(point, edge) {
  const length = H.edgeLength(edge);
  if (length === 0) return false;
  const distanceToEnds = H.distance(edge.start, point) + H.distance(point, edge.end);
  return Math.abs(distanceToEnds - length) < 0.000001;
}

function samePoint(a, b) {
  return Math.abs(a.x - b.x) < 0.000001 && Math.abs(a.y - b.y) < 0.000001;
}

function pointKey(point) {
  return `${Math.round(point.x * 1000000)},${Math.round(point.y * 1000000)}`;
}
