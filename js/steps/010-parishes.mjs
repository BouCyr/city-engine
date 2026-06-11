import {areaBoundaryPath} from "../data/area.mjs";
import {cloneDeepKeepFunctions} from "../data/clone.mjs";
import {computeShortestPathTree} from "../data/pathfinding.mjs";
import * as H from "../data/helper.mjs";
import {
  EDGE_TYPE_COAST,
  EDGE_TYPE_LAND,
  OVERLAY_TYPE_PARISHES,
  MAP_FLAG_BOUNDARY,
  MAP_FLAG_PARISH_CENTER,
  MAP_TAG_PARISH,
  NODE_TYPE_COAST,
  NODE_TYPE_LAND,
  NODE_TYPE_PARISH_CENTER,
  NODE_TYPE_RIVER,
  NODE_TYPE_RIVER_JUNCTION,
  TERRAIN_LAND,
} from "../constants.mjs";

export const KMEANS_MAX_COMPUTE_MS = 200;
export const DEFAULT_PARISH_SIZE = 16;
const LAND_EDGE_WEIGHT_FACTOR = 12;
const COAST_EDGE_WEIGHT_FACTOR = LAND_EDGE_WEIGHT_FACTOR * 2;

export function process(settings, map) {
  const result = computeParishes(settings, map);
  applyParishResult(map, result);
  return map;
}

export function createReplay(settings, inputMap) {
  const map = inputMap;
  const result = computeParishes(settings, map, {collectHistory: true});
  const frames = [];

  frames.push(replayFrame(
    map,
    "Before parishes",
    "Land masses are split by coast, rivers, crossings, and the map boundary before parish centers are seeded.",
    parishOverlayFromAssignments(map),
  ));

  for (const pass of result.history) {
    applyParishAssignments(map, pass.assignments, result.landMasses);
    frames.push(replayFrame(
      map,
      `K-means pass ${pass.pass}`,
      `Parish cells are assigned to the nearest center inside their own land mass; rivers and crossings remain non-crossable.`,
      parishOverlayFromAssignments(map, pass.centroids),
    ));
  }

  applyParishResult(map, result);
  frames.push(replayFrame(
    map,
    "Parishes complete",
    `Generated ${result.parishCount} parishes across ${result.landMasses.length} isolated land masses after ${result.passCount} k-means passes.`,
    parishOverlayFromAssignments(map),
  ));

  return {frames};
}

export function computeParishes(settings, map, {collectHistory = false} = {}) {
  const rng = settings?.rng ?? settings?.createStepRng?.("Parishes");
  const parishSize = parishSizeFromSettings(settings);
  const landMasses = findLandMasses(map, parishSize);
  const plans = landMasses.map((landMass, landMassIndex) => createLandMassPlan(landMass, landMassIndex, rng));
  const history = [];
  let passCount = 0;
  const startedAt = now();
  const deadline = startedAt + KMEANS_MAX_COMPUTE_MS;
  let cappedByTime = false;

  clearParishData(map);

  if (plans.length === 0) {
    return {
      landMasses,
      assignments: new globalThis.Map(),
      centroids: [],
      history,
      parishCount: 0,
      parishSize,
      passCount: 0,
      computeMs: 0,
      cappedByTime: false,
    };
  }

  while (now() < deadline) {
    const pass = passCount + 1;
    let changed = false;

    for (const plan of plans) {
      changed = assignCellsToCentroids(plan) || changed;
    }
    for (const plan of plans) {
      recomputeCentroids(plan);
    }

    passCount = pass;
    if (collectHistory) {
      history.push({
        pass,
        assignments: assignmentsFromPlans(plans),
        centroids: centroidsFromPlans(plans),
      });
    }
    if (!changed) break;
  }
  cappedByTime = now() >= deadline;

  return {
    landMasses,
    assignments: assignmentsFromPlans(plans),
    centroids: centroidsFromPlans(plans),
    history,
    parishCount: plans.reduce((sum, plan) => sum + plan.k, 0),
    parishSize,
    passCount,
    computeMs: now() - startedAt,
    cappedByTime,
  };
}

export function findLandMasses(map, parishSize = DEFAULT_PARISH_SIZE) {
  const landCells = (map?.cells ?? [])
    .filter((cell) => cell?.type === TERRAIN_LAND)
    .sort(compareById);
  const unvisited = new Set(landCells);
  const landMasses = [];

  for (const start of landCells) {
    if (!unvisited.has(start)) continue;

    const cells = [];
    const queue = [start];
    unvisited.delete(start);

    while (queue.length > 0) {
      const cell = queue.shift();
      cells.push(cell);

      for (const neighbor of landNeighbors(cell).sort(compareById)) {
        if (!unvisited.has(neighbor)) continue;
        unvisited.delete(neighbor);
        queue.push(neighbor);
      }
    }

    cells.sort(compareById);
    landMasses.push({
      id: `land-mass-${landMasses.length}`,
      cells,
      parishCount: Math.max(1, Math.ceil(cells.length / parishSize)),
    });
  }

  return landMasses.sort((left, right) => compareById(left.cells[0], right.cells[0]))
    .map((landMass, index) => ({
      ...landMass,
      id: `land-mass-${index}`,
    }));
}

function createLandMassPlan(landMass, landMassIndex, rng) {
  const cells = landMass.cells.map((cell) => ({
    cell,
    point: H.cellCentroid(cell),
  }));
  const k = landMass.parishCount;
  const graph = buildLandMassDistanceGraph(cells);

  return {
    landMass,
    landMassIndex,
    k,
    cells,
    graph,
    centroids: chooseInitialCentroids(cells, k, rng),
    assignments: new globalThis.Map(),
  };
}

function chooseInitialCentroids(cells, k, rng) {
  const pool = [...cells].sort((left, right) => compareById(left.cell, right.cell));
  const chosen = [];

  while (chosen.length < k && pool.length > 0) {
    const index = rng ? Math.floor(rng.next() * pool.length) : 0;
    const [item] = pool.splice(index, 1);
    chosen.push({...item.point});
  }

  while (chosen.length < k) {
    chosen.push({...chosen[chosen.length - 1]});
  }

  return chosen;
}

function assignCellsToCentroids(plan) {
  let changed = false;
  const trees = plan.centroids.map((centroid) => (
    computeShortestPathTree(plan.graph, closestGraphNode(plan.graph, centroid))
  ));

  for (const item of plan.cells) {
    const nextIndex = nearestCentroidTreeIndex(item, plan.centroids, trees);
    if (plan.assignments.get(item.cell) !== nextIndex) {
      changed = true;
      plan.assignments.set(item.cell, nextIndex);
    }
  }

  return changed;
}

export function buildLandMassDistanceGraph(items) {
  const nodesById = new globalThis.Map();
  const adjacency = new globalThis.Map();
  const sourceNodes = [];

  function addNode(node, source = false) {
    if (!node?.id || nodesById.has(node.id)) return nodesById.get(node?.id);
    nodesById.set(node.id, node);
    adjacency.set(node.id, []);
    if (source) sourceNodes.push(node);
    return node;
  }

  function addEdge(edge, start, end, weightFactor = LAND_EDGE_WEIGHT_FACTOR) {
    if (!start?.id || !end?.id) return;
    addNode(start, true);
    addNode(end, true);
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const weight = weightFactor * length;
    adjacency.get(start.id).push({edge, node: end, length, weight});
    adjacency.get(end.id).push({edge, node: start, length, weight});
  }

  for (const item of items) {
    const centroidNode = {
      id: `parish-cell-centroid-${item.cell.id}`,
      x: item.point.x,
      y: item.point.y,
      type: "parish-cell-centroid",
    };
    item.centroidNode = centroidNode;
    addNode(centroidNode);

    for (const edge of item.cell.edges ?? []) {
      if (isTraversableParishEdge(edge)) {
        addEdge(edge, edge.start, edge.end, edge.type === EDGE_TYPE_COAST ? COAST_EDGE_WEIGHT_FACTOR : LAND_EDGE_WEIGHT_FACTOR);
      }
    }

    const cellNodes = uniqueNodesFromCell(item.cell);
    for (const node of cellNodes) {
      addNode(node, true);
      addEdge(
        {
          id: `parish-temp-${item.cell.id}-${node.id}`,
          type: EDGE_TYPE_LAND,
          start: centroidNode,
          end: node,
        },
        centroidNode,
        node,
        LAND_EDGE_WEIGHT_FACTOR,
      );
    }
  }

  return {
    nodesById,
    adjacency,
    sourceNodes,
    getNode(nodeOrId) {
      if (!nodeOrId) return null;
      if (typeof nodeOrId === "string") return nodesById.get(nodeOrId) ?? null;
      return nodesById.get(nodeOrId.id) ?? null;
    },
    getNeighbors(nodeOrId) {
      const node = this.getNode(nodeOrId);
      if (!node) return [];
      return adjacency.get(node.id) ?? [];
    },
  };
}

function isTraversableParishEdge(edge) {
  if (edge?.flags?.has(MAP_FLAG_BOUNDARY)) return false;
  return edge?.type === EDGE_TYPE_LAND || edge?.type === EDGE_TYPE_COAST;
}

function uniqueNodesFromCell(cell) {
  const nodes = [];
  const seen = new Set();
  for (const edge of cell?.edges ?? []) {
    for (const node of [edge.start, edge.end]) {
      if (!node?.id || seen.has(node.id)) continue;
      seen.add(node.id);
      nodes.push(node);
    }
  }
  return nodes;
}

function closestGraphNode(graph, point) {
  let best = graph.sourceNodes[0] ?? null;
  let bestDistance = Infinity;
  for (const node of graph.sourceNodes) {
    const distance = distanceSquared(point, node);
    if (distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }
  return best;
}

function nearestCentroidTreeIndex(item, centroids, trees) {
  let bestIndex = 0;
  let bestDistance = Infinity;

  for (let index = 0; index < trees.length; index += 1) {
    const distance = trees[index].distances.get(item.centroidNode.id);
    const comparable = distance ?? Infinity;
    if (comparable < bestDistance) {
      bestIndex = index;
      bestDistance = comparable;
    }
  }

  if (bestDistance < Infinity) return bestIndex;
  return nearestCentroidIndex(item.point, centroids);
}

function recomputeCentroids(plan) {
  const buckets = Array.from({length: plan.k}, () => []);
  for (const item of plan.cells) {
    buckets[plan.assignments.get(item.cell) ?? 0].push(item.point);
  }

  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index];
    if (bucket.length === 0) {
      plan.centroids[index] = farthestCellPoint(plan, index);
      continue;
    }

    plan.centroids[index] = {
      x: bucket.reduce((sum, point) => sum + point.x, 0) / bucket.length,
      y: bucket.reduce((sum, point) => sum + point.y, 0) / bucket.length,
    };
  }
}

function farthestCellPoint(plan, emptyIndex) {
  let best = plan.cells[0]?.point ?? {x: 0, y: 0};
  let bestDistance = -Infinity;

  for (const item of plan.cells) {
    const distance = plan.centroids.reduce((minDistance, centroid, index) => {
      if (index === emptyIndex) return minDistance;
      return Math.min(minDistance, distanceSquared(item.point, centroid));
    }, Infinity);

    if (distance > bestDistance) {
      best = item.point;
      bestDistance = distance;
    }
  }

  return {...best};
}

function nearestCentroidIndex(point, centroids) {
  let bestIndex = 0;
  let bestDistance = Infinity;

  for (let index = 0; index < centroids.length; index += 1) {
    const distance = distanceSquared(point, centroids[index]);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }

  return bestIndex;
}

function assignmentsFromPlans(plans) {
  const assignments = new globalThis.Map();

  for (const plan of plans) {
    for (const item of plan.cells) {
      const parishIndex = plan.assignments.get(item.cell) ?? 0;
      assignments.set(item.cell, {
        landMassId: plan.landMass.id,
        landMassIndex: plan.landMassIndex,
        parishId: parishId(plan.landMassIndex, parishIndex),
        parishIndex,
      });
    }
  }

  return assignments;
}

function centroidsFromPlans(plans) {
  return plans.flatMap((plan) => plan.centroids.map((centroid, parishIndex) => ({
    ...centroid,
    landMassId: plan.landMass.id,
    landMassIndex: plan.landMassIndex,
    parishId: parishId(plan.landMassIndex, parishIndex),
    parishIndex,
  })));
}

function applyParishResult(map, result) {
  applyParishAssignments(map, result.assignments, result.landMasses);
  tagParishCellsAndCenters(map, result.centroids);
  map.parishSummary = {
    landMassCount: result.landMasses.length,
    parishCount: result.parishCount,
    parishSize: result.parishSize,
    passCount: result.passCount,
    maxComputeMs: KMEANS_MAX_COMPUTE_MS,
    computeMs: result.computeMs,
    cappedByTime: result.cappedByTime,
  };
  delete map.drawOverlay;
}

function applyParishAssignments(map, assignments, landMasses) {
  clearParishData(map);

  for (const [cell, assignment] of assignments) {
    cell.landMassId = assignment.landMassId;
    cell.landMassIndex = assignment.landMassIndex;
    cell.parishId = assignment.parishId;
    cell.parishIndex = assignment.parishIndex;
  }

  for (const landMass of landMasses) {
    for (const cell of landMass.cells) {
      cell.landMassId = cell.landMassId ?? landMass.id;
    }
  }
}

function clearParishData(map) {
  for (const cell of map?.cells ?? []) {
    delete cell.landMassId;
    delete cell.landMassIndex;
    delete cell.parishId;
    delete cell.parishIndex;
    removeKeyedTag(cell, MAP_TAG_PARISH);
  }

  for (const node of map?.nodes ?? []) {
    node.flags?.delete?.(MAP_FLAG_PARISH_CENTER);
    if (node.type === NODE_TYPE_PARISH_CENTER && node.parishCenterBaseType) {
      node.type = node.parishCenterBaseType;
      delete node.parishCenterBaseType;
    }
  }
}

function tagParishCellsAndCenters(map, centroids) {
  for (const cell of map?.cells ?? []) {
    if (!cell?.parishId) continue;
    addKeyedTag(cell, MAP_TAG_PARISH, cell.parishId);
  }

  const cellsByParishId = cellsGroupedByParishId(map);
  for (const centroid of centroids ?? []) {
    const cells = cellsByParishId.get(centroid.parishId) ?? [];
    const centerNode = closestParishNode(cells, centroid);
    if (centerNode) {
      if (centerNode.type !== NODE_TYPE_PARISH_CENTER) {
        centerNode.parishCenterBaseType = centerNode.type;
      }
      centerNode.type = NODE_TYPE_PARISH_CENTER;
      ensureFlags(centerNode).add(MAP_FLAG_PARISH_CENTER);
    }
  }
}

function cellsGroupedByParishId(map) {
  const groups = new globalThis.Map();
  for (const cell of map?.cells ?? []) {
    if (!cell?.parishId) continue;
    if (!groups.has(cell.parishId)) groups.set(cell.parishId, []);
    groups.get(cell.parishId).push(cell);
  }
  return groups;
}

function closestParishNode(cells, point) {
  let bestNode = null;
  let bestDistance = Infinity;
  let bestRank = Infinity;

  for (const node of uniqueNodesFromCells(cells)) {
    const rank = parishCenterNodeRank(node);
    if (rank === Infinity) continue;
    const distance = distanceSquared(point, node);
    if (
      rank < bestRank
      || (rank === bestRank && distance < bestDistance)
      || (rank === bestRank && distance === bestDistance && compareById(node, bestNode) < 0)
    ) {
      bestNode = node;
      bestDistance = distance;
      bestRank = rank;
    }
  }

  return bestNode;
}

function parishCenterNodeRank(node) {
  const type = node?.parishCenterBaseType ?? node?.type;
  if (type === NODE_TYPE_LAND) return 0;
  if (type === NODE_TYPE_COAST || type === NODE_TYPE_RIVER || type === NODE_TYPE_RIVER_JUNCTION) return 1;
  return Infinity;
}

function uniqueNodesFromCells(cells) {
  const nodes = [];
  const seen = new Set();

  for (const cell of cells ?? []) {
    for (const node of uniqueNodesFromCell(cell)) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      nodes.push(node);
    }
  }

  return nodes.sort(compareById);
}

function addKeyedTag(entity, key, value) {
  const flags = ensureFlags(entity);
  removeKeyedTag(entity, key);
  flags.add({key, value});
}

function removeKeyedTag(entity, key) {
  const flags = ensureFlags(entity);
  for (const flag of [...flags]) {
    if (isKeyedTag(flag, key)) flags.delete(flag);
  }
}

function isKeyedTag(flag, key) {
  return flag && typeof flag === "object" && flag.key === key;
}

function ensureFlags(entity) {
  if (!(entity.flags instanceof Set)) {
    entity.flags = new Set(Array.isArray(entity.flags) ? entity.flags : []);
  }
  return entity.flags;
}

function parishOverlayFromAssignments(map, centroids = []) {
  const parishCells = new globalThis.Map();
  for (const cell of map?.cells ?? []) {
    if (cell?.type !== TERRAIN_LAND || !cell.parishId) continue;
    if (!parishCells.has(cell.parishId)) {
      parishCells.set(cell.parishId, []);
    }
    parishCells.get(cell.parishId).push(cell);
  }

  return {
    type: OVERLAY_TYPE_PARISHES,
    areas: [...parishCells.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([parishId, cells]) => ({
        parishId,
        d: areaBoundaryPath(cells),
        color: colorForParish(parishId),
        cellIds: cells.map((cell) => cell.id).sort(),
      }))
      .filter((area) => area.d),
    centroids: centroids.map((centroid) => ({
      x: centroid.x,
      y: centroid.y,
      parishId: centroid.parishId,
      color: colorForParish(centroid.parishId),
    })),
  };
}

function createParishOverlayDraw(overlay) {
  return function drawParishOverlay(svg) {
    const layer = svg.getElementById("overlay");
    if (!layer) return;

    for (const area of overlay.areas ?? []) {
      appendParishBorder(svg, layer, area);
    }

    for (const centroid of overlay.centroids ?? []) {
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", centroid.x);
      circle.setAttribute("cy", centroid.y);
      circle.setAttribute("r", "9");
      circle.setAttribute("fill", centroid.color);
      circle.setAttribute("stroke", "#111");
      circle.setAttribute("stroke-width", "2");
      layer.appendChild(circle);
    }
  };
}

function appendParishBorder(svg, layer, area) {
  const clipId = `parish-clip-${cssSafeId(area.parishId)}`;
  const defs = ensureSvgDefs(svg);
  const clipPath = document.createElementNS("http://www.w3.org/2000/svg", "clipPath");
  const clipShape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");

  clipPath.setAttribute("id", clipId);
  clipShape.setAttribute("d", area.d);
  clipPath.appendChild(clipShape);
  defs.querySelector?.(`#${clipId}`)?.remove?.();
  defs.appendChild(clipPath);

  path.setAttribute("d", area.d);
  path.setAttribute("fill", area.color);
  path.setAttribute("fill-opacity", "0.1");
  path.setAttribute("stroke", area.color);
  path.setAttribute("stroke-opacity", "0.25");
  path.setAttribute("stroke-width", "42");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("clip-path", `url(#${clipId})`);
  layer.appendChild(path);
}

function ensureSvgDefs(svg) {
  let defs = svg.querySelector?.("defs");
  if (!defs) {
    defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    svg.insertBefore?.(defs, svg.firstChild ?? null);
  }
  return defs;
}

function cssSafeId(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "-");
}

function replayFrame(map, label, text, overlay) {
  const frameMap = cloneDeepKeepFunctions(map);
  frameMap.drawOverlay = createParishOverlayDraw(overlay);
  return {
    label,
    text,
    overlay,
    map: frameMap,
  };
}

function landNeighbors(cell) {
  const neighbors = [];

  for (const edge of cell?.edges ?? []) {
    if (edge?.type !== EDGE_TYPE_LAND) continue;
    const neighbor = edge.leftCell === cell
      ? edge.rightCell
      : edge.rightCell === cell
        ? edge.leftCell
        : null;
    if (neighbor?.type === TERRAIN_LAND) {
      neighbors.push(neighbor);
    }
  }

  return neighbors;
}

function parishId(landMassIndex, parishIndex) {
  return `parish-${landMassIndex}-${parishIndex}`;
}

function colorForParish(id) {
  const palette = [
    "#d81b60", "#1e88e5", "#ffc107", "#004d40", "#8e24aa", "#43a047",
    "#f4511e", "#3949ab", "#00acc1", "#c0ca33", "#6d4c41", "#e53935",
    "#5e35b1", "#00897b", "#fb8c00", "#7cb342", "#039be5", "#ad1457",
    "#546e7a", "#fdd835", "#2e7d32", "#c62828", "#283593", "#ef6c00",
  ];
  return palette[hashString(String(id)) % palette.length];
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function compareById(left, right) {
  return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

function parishSizeFromSettings(settings) {
  const value = Number(settings?.parishes?.parishSize);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_PARISH_SIZE;
}
