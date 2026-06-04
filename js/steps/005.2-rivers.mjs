import {createDrawCellFn, orderedCellPoints} from "../data/cell.mjs";
import {cloneDeepKeepFunctions} from "../data/clone.mjs";
import {createDrawEdgeFn} from "../data/edge.mjs";
import * as H from "../data/helper.mjs";
import {Settings} from "../data/settings.mjs";

const DEFAULT_RIVER_SETTINGS = new Settings().rivers;
const RIVER_COLOR = "var(--sea-edge)";
const RIVER_ROLE_PRIMARY = "PRIMARY";
const RIVER_ROLE_FIRST_TRIBUTARY = "FIRST_TRIBUTARY";
const RIVER_ROLE_SECOND_TRIBUTARY = "SECOND_TRIBUTARY";

export const MIN_EDGE_SIZE = DEFAULT_RIVER_SETTINGS.minEdgeSize;

export const OPEN_SEA = "OPEN_SEA";
export const INNER_SEA = "INNER_SEA";
export const MIN_EXIT_OPEN_SEA_DISTANCE = DEFAULT_RIVER_SETTINGS.minExitOpenSeaDistance;
export const MIN_LOCKED_SEA_DISTANCE = DEFAULT_RIVER_SETTINGS.minLockedSeaDistance;

export function computeRivers(settings, map) {
  const startedAt = now();
  const riverSettings = resolveRiverSettings(settings);
  const deadline = startedAt + riverSettings.maxComputeMs;
  console.info("Rivers A*: starting");

  clearRiverState(map);

  const seaComponents = classifySeaComponents(map);
  if (seaComponents.length === 0) {
    console.info("Rivers A*: no sea components found");
    return map;
  }
  console.info(`Rivers A*: found ${seaComponents.length} sea components`);

  const landComponents = connectedComponents(map.cells.filter(cell => cell.type === "LAND"), landNeighbors);
  console.info(`Rivers A*: found ${landComponents.length} land components`);
  const selectedLandmass = largestComponent(landComponents);
  if (selectedLandmass.length === 0) {
    console.info("Rivers A*: no landmass found");
    return map;
  }

  const selectedLandSet = new Set(selectedLandmass);
  const openSeaComponents = seaComponents.filter(component => component.kind === OPEN_SEA);
  if (openSeaComponents.length === 0) {
    console.info("Rivers A*: no open sea found");
    return map;
  }

  console.info(`Rivers A*: found ${openSeaComponents.length} open sea components`);
  console.info(`Rivers A*: found ${seaComponents.length - openSeaComponents.length} inner sea components`);
  computeDistanceFromSea(selectedLandmass, selectedLandSet, seaComponents);
  console.info(`Rivers A*: selected ${selectedLandmass.length} cells (${formatPercent(selectedLandmass.length / map.cells.length)}) as landmass`);

  const exitCells = selectedLandmass
    .filter(cell => cell.seaD >= riverSettings.minExitOpenSeaDistance)
    .filter(cell => cell.edges.some(edge => edge.flags?.has("Boundary")));
  if (exitCells.length === 0) {
    console.info("Rivers A*: no eligible exit cells found");
    return map;
  }
  console.info(`Rivers A*: selected ${exitCells.length} cells (${formatPercent(exitCells.length / selectedLandmass.length)}) as river exit cells`);

  const mouthCandidates = findMouthCandidates(map, seaComponents)
    .filter(mouth => selectedLandSet.has(mouth.cell));
  const openMouths = mouthCandidates
    .filter(mouth => mouth.seaComponent?.kind === OPEN_SEA);
  console.info(`Rivers A*: found ${mouthCandidates.length} mouth candidates`);
  if (openMouths.length === 0) {
    console.info("Rivers A*: no open-sea mouth candidates found");
    return map;
  }
  console.info(`Rivers A*: found ${openMouths.length} open mouths`);

  const search = findBestAStarRiver({
    openMouths,
    exitCells,
    selectedLandSet,
    mapSize: map.size,
    deadline,
    riverSettings,
  });
  console.info(
    `Rivers A*: search ${search.timedOut ? "timed out" : "finished"} after ${Math.round(now() - startedAt)}ms, ` +
    `${search.attemptedPaths} paths attempted, ${search.validRivers.length} valid candidates found`
  );

  if (!search.selected) {
    console.info("Rivers A*: no valid river selected");
    return map;
  }

  const meanderedRiver = meanderRiverCandidate({
    candidate: search.selected,
    selectedLandSet,
    riverSettings,
  });
  const selectedRiver = normalizeRiver(meanderedRiver, {type: "MAIN", id: "river-0", order: 0, role: RIVER_ROLE_PRIMARY});
  map.rivers = [selectedRiver];
  console.info(`Rivers A*: selected ${formatRiver(selectedRiver)}`);
  drawRivers(map.rivers, map, RIVER_COLOR);
  console.info(`Rivers A*: done in ${Math.round(now() - startedAt)}ms`);

  return map;
}

export function createReplay(settings, inputMap) {
  const riverSettings = resolveRiverSettings(settings);
  const map = cloneDeepKeepFunctions(inputMap);
  clearRiverState(map);

  const seaComponents = classifySeaComponents(map);
  const landComponents = connectedComponents(map.cells.filter(cell => cell.type === "LAND"), landNeighbors);
  const selectedLandmass = largestComponent(landComponents);
  const selectedLandSet = new Set(selectedLandmass);
  const openSeaComponents = seaComponents.filter(component => component.kind === OPEN_SEA);

  if (seaComponents.length === 0 || selectedLandmass.length === 0 || openSeaComponents.length === 0) {
    return {frames: [{label: "Before rivers", text: "Rivers cannot be replayed without sea and land cells.", map}]};
  }

  computeDistanceFromSea(selectedLandmass, selectedLandSet, seaComponents);

  const exitCells = selectedLandmass
    .filter(cell => cell.seaD >= riverSettings.minExitOpenSeaDistance)
    .filter(cell => cell.edges.some(edge => edge.flags?.has("Boundary")));
  const mouthCandidates = findMouthCandidates(map, seaComponents)
    .filter(mouth => selectedLandSet.has(mouth.cell));
  const openMouths = mouthCandidates
    .filter(mouth => mouth.seaComponent?.kind === OPEN_SEA);
  const attempts = collectReplayRiverAttempts({
    openMouths,
    exitCells,
    selectedLandSet,
    mapSize: map.size,
    riverSettings,
  });
  const overlay = emptyRiverReplayOverlaySpec();
  const frames = [];

  appendRiverReplayOverlay(overlay, {lowSeaDCells: selectedLandmass.filter(cell => (cell.seaD ?? 0) < riverSettings.minLockedSeaDistance), color: RIVER_COLOR});
  frames.push(replayFrame(map, "SeaD threshold", "Cells below the sea-distance threshold used for initial direction and sea avoidance are highlighted.", overlay));

  appendRiverReplayOverlay(overlay, {mouths: openMouths, color: RIVER_COLOR});
  frames.push(replayFrame(map, "Mouth computation", "Eligible land mouths adjacent to open sea are highlighted.", overlay));

  appendRiverReplayOverlay(overlay, {exits: exitCells, color: RIVER_COLOR});
  frames.push(replayFrame(map, "Exit computation", "Boundary exit cells far enough from any sea are highlighted.", overlay));

  appendRiverReplayOverlay(overlay, {forbiddenEdges: forbiddenRiverEdges(map, riverSettings), color: RIVER_COLOR});
  frames.push(replayFrame(map, "Forbidden edges", "Land edges too short for rivers to cross are highlighted.", overlay));

  appendRiverReplayOverlay(overlay, {river: attempts.failed, color: RIVER_COLOR});
  frames.push(replayFrame(map, "Failed river attempt", "One attempted route does not reach its target exit.", overlay));

  appendRiverReplayOverlay(overlay, {river: attempts.unselected, color: RIVER_COLOR});
  frames.push(replayFrame(map, "Valid unselected river", "One valid route reaches its exit but is not selected.", overlay));

  appendRiverReplayOverlay(overlay, {river: attempts.selected, color: RIVER_COLOR});
  frames.push(replayFrame(map, "Selected river", "Among the five longest straight mouth-to-exit candidates, the selected route has the highest exit seaD.", overlay));

  appendRiverReplayOverlay(overlay, {river: attempts.meandered, color: RIVER_COLOR});
  frames.push(replayFrame(map, "Meander refinement", "The selected main river is locally rerouted around interior cells when a short deterministic detour can replace a straight segment.", overlay));

  return {frames};
}

export function findBestAStarRiver({openMouths, exitCells, selectedLandSet, mapSize, deadline = Infinity, riverSettings = DEFAULT_RIVER_SETTINGS}) {
  const sortedMouths = [...openMouths].sort((a, b) => compareMouthsByCenterDesc(a, b, mapSize));
  const validRivers = [];
  let attemptedPaths = 0;
  let timedOut = false;

  for (const mouth of sortedMouths) {
    console.info(`Rivers A*: searching for best river from ${mouth.cell.id} to ${exitCells.length} exit cells`);
    const sortedExits = [...exitCells].sort((a, b) => compareExitsFromMouthDesc(a, b, mouth));
    for (const exit of sortedExits) {
      if (now() > deadline) {
        timedOut = true;
        return {
          selected: selectSelectedRiver(validRivers),
          validRivers,
          attemptedPaths,
          timedOut,
        };
      }

      attemptedPaths += 1;
      const candidate = findAStarPath({mouth, exit, selectedLandSet, riverSettings});
      if (candidate) validRivers.push(candidate);
    }
  }

  console.info(`Rivers A*: found ${validRivers.length} valid river candidates`);

  return {
    selected: selectSelectedRiver(validRivers),
    validRivers,
    attemptedPaths,
    timedOut,
  };
}

function collectReplayRiverAttempts({openMouths, exitCells, selectedLandSet, mapSize, riverSettings = DEFAULT_RIVER_SETTINGS}) {
  const validRivers = [];
  let failed = null;

  const sortedMouths = [...openMouths].sort((a, b) => compareMouthsByCenterDesc(a, b, mapSize));
  for (const mouth of sortedMouths) {
    const sortedExits = [...exitCells].sort((a, b) => compareExitsFromMouthDesc(a, b, mouth));
    for (const exit of sortedExits) {
      const result = findAStarPathDetailed({mouth, exit, selectedLandSet, riverSettings});
      if (result.candidate) {
        validRivers.push(result.candidate);
      } else if (!failed && result.partial?.riverCells?.length > 1) {
        failed = result.partial;
      }
    }
  }

  const selected = selectSelectedRiver(validRivers);
  const meandered = selected ? meanderRiverCandidate({
    candidate: selected,
    selectedLandSet,
    riverSettings,
  }) : null;
  if (!failed && selected?.riverCells?.length > 2) {
    failed = {
      ...selected,
      riverCells: selected.riverCells.slice(0, -1),
    };
  }
  const unselected = validRivers.find(candidate => candidate !== selected) ?? null;

  return {failed, unselected, selected, meandered};
}

function replayFrame(map, label, text, overlay) {
  const frameMap = cloneDeepKeepFunctions(map);
  const frameOverlay = cloneRiverReplayOverlaySpec(overlay);
  frameMap.drawOverlay = createRiverReplayOverlayDraw(frameOverlay);
  return {label, text, map: frameMap, overlay: frameOverlay};
}

function emptyRiverReplayOverlaySpec() {
  return {
    type: "rivers",
    polygons: [],
    arrows: [],
    lines: [],
    paths: [],
  };
}

function cloneRiverReplayOverlaySpec(overlay) {
  return {
    type: "rivers",
    polygons: (overlay.polygons ?? []).map(polygon => ({...polygon, points: (polygon.points ?? []).map(point => ({...point}))})),
    arrows: (overlay.arrows ?? []).map(arrow => ({...arrow})),
    lines: (overlay.lines ?? []).map(line => ({...line})),
    paths: (overlay.paths ?? []).map(path => ({...path})),
  };
}

function appendRiverReplayOverlay(overlay, {lowSeaDCells = [], mouths = [], exits = [], forbiddenEdges = [], river = null, color = RIVER_COLOR}) {
  overlay.polygons.push(...lowSeaDCells.map(cell => ({
    points: orderedCellPoints(cell).map(point => ({x: point.x, y: point.y})),
    fill: "rgba(239, 68, 68, 0.22)",
    stroke: "none",
  })));

  overlay.arrows.push(...mouths.map(mouth => {
    const start = H.cellCentroid(mouth.seaCell);
    const end = H.cellCentroid(mouth.cell);
    return {
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      stroke: "black",
      strokeWidth: 7,
    };
  }));

  overlay.arrows.push(...exits.map(exit => {
    const start = H.cellCentroid(exit);
    const edge = exit.edges.find(candidate => candidate.flags?.has("Boundary"));
    const end = edge ? H.midpoint(edge.start, edge.end) : start;
    return {
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      stroke: "black",
      strokeWidth: 7,
    };
  }));

  overlay.lines.push(...forbiddenEdges.map(edge => ({
      x1: edge.start.x,
      y1: edge.start.y,
      x2: edge.end.x,
      y2: edge.end.y,
      stroke: "red",
      strokeWidth: 7,
    })));

  if (river) {
    overlay.paths.forEach(path => {
      path.opacity = 0.25;
    });
    overlay.paths.push({
      d: buildStraightRiverPath(river),
      stroke: color,
      strokeWidth: 7,
      opacity: 1,
    });
  }
}

function createRiverReplayOverlayDraw(overlay) {
  return function drawRiverReplayOverlay(svg) {
    const layer = svg.getElementById("overlay") ?? svg.getElementById("cells");
    if (!layer) return;
    drawRiverReplayOverlaySpec(layer, overlay);
  };
}

function drawRiverReplayOverlaySpec(layer, overlay) {
  for (const polygon of overlay.polygons ?? []) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    element.setAttribute("points", polygon.points.map(point => `${point.x},${point.y}`).join(" "));
    element.setAttribute("fill", polygon.fill);
    element.setAttribute("stroke", polygon.stroke);
    layer.appendChild(element);
  }

  for (const arrow of overlay.arrows ?? []) {
    appendReplayArrow(layer, arrow);
  }

  for (const line of overlay.lines ?? []) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", "line");
    element.setAttribute("x1", line.x1);
    element.setAttribute("y1", line.y1);
    element.setAttribute("x2", line.x2);
    element.setAttribute("y2", line.y2);
    element.setAttribute("stroke", line.stroke);
    element.setAttribute("stroke-width", line.strokeWidth);
    layer.appendChild(element);
  }

  for (const path of overlay.paths ?? []) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", "path");
    element.setAttribute("fill", "none");
    element.setAttribute("stroke", path.stroke);
    element.setAttribute("stroke-width", path.strokeWidth);
    element.setAttribute("stroke-opacity", path.opacity);
    element.setAttribute("d", path.d);
    layer.appendChild(element);
  }
}

function appendReplayArrow(layer, arrow) {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", arrow.x1);
  line.setAttribute("y1", arrow.y1);
  line.setAttribute("x2", arrow.x2);
  line.setAttribute("y2", arrow.y2);
  line.setAttribute("stroke", arrow.stroke);
  line.setAttribute("stroke-width", arrow.strokeWidth);
  layer.appendChild(line);

  const head = replayArrowHead(arrow);
  if (!head) return;

  const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  polygon.setAttribute("points", head.map(point => `${point.x},${point.y}`).join(" "));
  polygon.setAttribute("fill", arrow.stroke);
  layer.appendChild(polygon);
}

function replayArrowHead({x1, y1, x2, y2}) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;

  const ux = dx / length;
  const uy = dy / length;
  const size = 16;
  const width = 9;
  const baseX = x2 - ux * size;
  const baseY = y2 - uy * size;
  const px = -uy * width;
  const py = ux * width;
  return [
    {x: x2, y: y2},
    {x: baseX + px, y: baseY + py},
    {x: baseX - px, y: baseY - py},
  ];
}

function forbiddenRiverEdges(map, riverSettings = DEFAULT_RIVER_SETTINGS) {
  return map.edges
    .filter(edge => edge.flags?.has("LAND"))
    .filter(edge => H.edgeLength(edge) <= riverSettings.minEdgeSize);
}

export function findAStarPath({
  mouth,
  exit,
  selectedLandSet,
  initialSeaDIncreaseSteps,
  lockedSeaDistance,
  blockedCells = new Set(),
  maxPathCells = Infinity,
  riverSettings = DEFAULT_RIVER_SETTINGS,
}) {
  return findAStarPathDetailed({
    mouth,
    exit,
    selectedLandSet,
    initialSeaDIncreaseSteps: initialSeaDIncreaseSteps ?? riverSettings.initialSeaDIncreaseSteps,
    lockedSeaDistance: lockedSeaDistance ?? riverSettings.minLockedSeaDistance,
    blockedCells,
    maxPathCells,
    riverSettings,
  }).candidate;
}

export function findAStarPathDetailed({
  mouth,
  exit,
  selectedLandSet,
  initialSeaDIncreaseSteps = DEFAULT_RIVER_SETTINGS.initialSeaDIncreaseSteps,
  lockedSeaDistance = DEFAULT_RIVER_SETTINGS.minLockedSeaDistance,
  blockedCells = new Set(),
  maxPathCells = Infinity,
  riverSettings = DEFAULT_RIVER_SETTINGS,
}) {
  const start = mouth.cell;
  if (!selectedLandSet.has(start) || !selectedLandSet.has(exit)) {
    return {candidate: null, partial: null};
  }

  const startState = {
    cell: start,
    steps: 0,
    lockedAwayFromSea: isLockedAwayFromSea(start, lockedSeaDistance),
    visitedCells: new Set([start]),
  };
  const startKey = pathStateKey(startState);
  const states = new Map([[startKey, startState]]);
  const open = new Set([startKey]);
  const cameFrom = new Map();
  const gScore = new Map([[startKey, 0]]);
  const fScore = new Map([[startKey, H.distance(H.cellCentroid(start), H.cellCentroid(exit))]]);
  const closed = new Set();
  let bestPartialKey = startKey;

  while (open.size > 0) {
    const currentKey = lowestScoreState(open, fScore, states);
    const currentState = states.get(currentKey);
    const current = currentState.cell;
    if (isBetterPartial(currentKey, bestPartialKey, states, gScore, exit)) {
      bestPartialKey = currentKey;
    }
    if (current === exit) {
      const riverCells = reconstructPath(cameFrom, states, currentKey);
      const candidate = {
        riverCells,
        pathCost: computeRiverPathCost(riverCells),
        mouthExitDistance: mouthExitDistance(mouth, exit),
        mouth,
        originalMouth: start,
        exit,
      };
      return {candidate, partial: candidate};
    }

    open.delete(currentKey);
    closed.add(currentKey);
    if (currentState.visitedCells.size >= maxPathCells) continue;

    for (const neighbor of passableLandNeighbors(current, selectedLandSet, riverSettings)) {
      const next = neighbor.cell;
      const mustIncreaseSeaD = currentState.steps < initialSeaDIncreaseSteps;
      if (mustIncreaseSeaD && !increasesSeaD(current, next)) continue;
      if (currentState.lockedAwayFromSea && !isLockedAwayFromSea(next, lockedSeaDistance)) continue;
      if (next !== exit && touchesBoundary(next)) continue;
      if (next !== exit && next !== start && blockedCells.has(next)) continue;
      if (currentState.visitedCells.has(next)) continue;

      const nextVisitedCells = new Set([...currentState.visitedCells, next]);
      if (nextVisitedCells.size > maxPathCells) continue;
      const nextState = {
        cell: next,
        steps: Math.min(currentState.steps + 1, initialSeaDIncreaseSteps),
        lockedAwayFromSea: currentState.lockedAwayFromSea || isLockedAwayFromSea(next, lockedSeaDistance),
        visitedCells: nextVisitedCells,
      };
      const nextKey = pathStateKey(nextState);
      states.set(nextKey, nextState);
      const nextGScore = gScore.get(currentKey) + movementCost(current, next, neighbor.edge);
      if (closed.has(nextKey) && nextGScore >= (gScore.get(nextKey) ?? Infinity)) continue;
      if (nextGScore >= (gScore.get(nextKey) ?? Infinity)) continue;

      cameFrom.set(nextKey, currentKey);
      gScore.set(nextKey, nextGScore);
      fScore.set(nextKey, nextGScore + H.distance(H.cellCentroid(next), H.cellCentroid(exit)));
      open.add(nextKey);
      closed.delete(nextKey);
    }
  }

  return {
    candidate: null,
    partial: buildPartialCandidate(cameFrom, states, bestPartialKey, gScore, mouth, exit),
  };
}

function clearRiverState(map) {
  for (const cell of map.cells) {
    delete cell.seaD;
    delete cell.toSea;
    delete cell.cellToSea;
    delete cell.seaKind;
    delete cell.seaComponent;
    cell.flags?.delete?.(OPEN_SEA);
    cell.flags?.delete?.(INNER_SEA);
  }
  map.areas = (map.areas ?? []).filter(group => group.name !== "river-banks");
  map.rivers = [];
}

function flagShortEdges(map) {
  map.edges
    .filter(edge => edge.flags?.has("LAND"))
    .filter(edge => H.edgeLength(edge) <= MIN_EDGE_SIZE)
    .forEach(edge => {
      edge.draw = createDrawEdgeFn(edge, "none", "red", "7");
    });
}

export function classifySeaComponents(map) {
  const seaComponents = connectedComponents(map.cells.filter(cell => cell.type === "SEA"), seaNeighbors);
  seaComponents.forEach((cells, index) => {
    const component = {
      id: `sea-${index}`,
      cells,
      kind: cells.some(touchesBoundary) ? OPEN_SEA : INNER_SEA,
    };
    cells.forEach(cell => {
      cell.seaKind = component.kind;
      ensureFlags(cell).add(component.kind);
    });
    seaComponents[index] = component;
  });
  return seaComponents;
}

export function computeDistanceFromSea(selectedLandmass, selectedLandSet, seaComponents) {
  const starts = [];
  for (const component of seaComponents) {
    for (const seaCell of component.cells) {
      for (const {cell: landCell} of typedNeighbors(seaCell, "LAND")) {
        if (!selectedLandSet.has(landCell) || landCell.seaD !== undefined) continue;
        landCell.seaD = 1;
        landCell.cellToSea = 1;
        landCell.toSea = seaCell;
        starts.push(landCell);
      }
    }
  }

  const distances = landHopDistances(selectedLandSet, starts);
  for (const cell of selectedLandmass) {
    const distance = distances.get(cell);
    if (distance === undefined) continue;
    cell.seaD = distance;
    cell.cellToSea = distance;
  }
}

export function findMouthCandidates(map, seaComponents) {
  const seaComponentByCell = new Map();
  seaComponents.forEach(component => {
    component.cells.forEach(cell => seaComponentByCell.set(cell, component));
  });

  const seaMouthCandidates = map.cells
    .filter(cell => cell.type === "SEA")
    .filter(cell => typedNeighbors(cell, "LAND").length > 2);

  const mouths = [];
  const seen = new Set();
  for (const seaCell of seaMouthCandidates) {
    const seaComponent = seaComponentByCell.get(seaCell);
    for (const {cell: landCell, edge} of typedNeighbors(seaCell, "LAND")) {
      if (H.edgeLength(edge) < MIN_EDGE_SIZE) continue;
      const seaNeighbors = typedNeighbors(landCell, "SEA").map(neighbor => neighbor.cell);
      if (seaNeighbors.length !== 1 || seaNeighbors[0] !== seaCell) continue;
      const key = `${landCell.id}:${seaCell.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mouths.push({cell: landCell, seaCell, seaComponent});
    }
  }

  return mouths;
}

export function selectSelectedRiver(candidates) {
  return [...candidates]
    .sort(compareByMouthExitDistance)
    .slice(0, 5)
    .sort(compareByExitSeaD)[0] ?? null;
}

export function compareByPathCost(a, b) {
  return b.pathCost - a.pathCost
    || b.riverCells.length - a.riverCells.length
    || riverKey(a).localeCompare(riverKey(b));
}

export function meanderRiverCandidate({candidate, selectedLandSet, riverSettings = DEFAULT_RIVER_SETTINGS}) {
  if (!candidate?.riverCells?.length || !selectedLandSet?.size) return candidate;

  const meandered = {
    ...candidate,
    riverCells: [...candidate.riverCells],
  };
  let centerIndex = riverSettings.minExitOpenSeaDistance + riverSettings.meanderForbiddenRadii[0];

  while (centerIndex <= maxEligibleMeanderCenter(meandered.riverCells.length, riverSettings)) {
    const replacement = findMeanderReplacement({
      riverCells: meandered.riverCells,
      centerIndex,
      selectedLandSet,
      riverSettings,
    });
    if (!replacement) {
      centerIndex += 1;
      continue;
    }

    meandered.riverCells = [
      ...meandered.riverCells.slice(0, replacement.startIndex),
      ...replacement.path,
      ...meandered.riverCells.slice(replacement.endIndex + 1),
    ];
    centerIndex = replacement.startIndex + replacement.path.length;
  }

  meandered.pathCost = computeRiverPathCost(meandered.riverCells);
  return meandered;
}

export function compareByMouthExitDistance(a, b) {
  return b.mouthExitDistance - a.mouthExitDistance
    || compareByPathCost(a, b);
}

function compareByExitSeaD(a, b) {
  return (b.exit?.seaD ?? 0) - (a.exit?.seaD ?? 0)
    || compareByMouthExitDistance(a, b);
}

function lowestScoreState(keys, scores, states) {
  return [...keys].sort((a, b) =>
    (scores.get(a) ?? Infinity) - (scores.get(b) ?? Infinity)
    || compareCells(states.get(a).cell, states.get(b).cell)
    || states.get(a).steps - states.get(b).steps
  )[0];
}

function reconstructPath(cameFrom, states, currentKey) {
  const path = [states.get(currentKey).cell];
  while (cameFrom.has(currentKey)) {
    currentKey = cameFrom.get(currentKey);
    path.unshift(states.get(currentKey).cell);
  }
  return path;
}

function buildPartialCandidate(cameFrom, states, currentKey, gScore, mouth, exit) {
  if (!currentKey) return null;
  const riverCells = reconstructPath(cameFrom, states, currentKey);
  return {
    riverCells,
    pathCost: gScore.get(currentKey) ?? computeRiverPathCost(riverCells),
    mouthExitDistance: mouthExitDistance(mouth, exit),
    mouth,
    originalMouth: mouth.cell,
    exit,
  };
}

function findMeanderReplacement({riverCells, centerIndex, selectedLandSet, riverSettings = DEFAULT_RIVER_SETTINGS}) {
  const centerCell = riverCells[centerIndex];

  for (const radius of riverSettings.meanderForbiddenRadii) {
    const startIndex = centerIndex - radius;
    const endIndex = centerIndex + radius;
    if (startIndex < 0 || endIndex >= riverCells.length) continue;

    const start = riverCells[startIndex];
    const exit = riverCells[endIndex];
    const segmentCells = new Set(riverCells.slice(startIndex, endIndex + 1));
    const blockedCells = new Set(riverCells.filter(cell => !segmentCells.has(cell)));
    const belowSeaThresholdCells = new Set(
      [...selectedLandSet].filter(cell =>
        cell !== start
        && cell !== exit
        && cell.seaD !== undefined
        && cell.seaD < riverSettings.minLockedSeaDistance
      )
    );
    const maxPathCells = Math.max(
      endIndex - startIndex + 1,
      Math.ceil(radius * riverSettings.meanderMaxPathFactor)
    );
    const forbiddenCells = meanderForbiddenCells({
      centerCell,
      radius,
      selectedLandSet,
      allowedCells: new Set([start, exit]),
    });
    const candidate = findAStarPath({
      mouth: {cell: start, seaCell: null},
      exit,
      selectedLandSet,
      initialSeaDIncreaseSteps: 0,
      lockedSeaDistance: riverSettings.minLockedSeaDistance,
      blockedCells: new Set([...blockedCells, ...belowSeaThresholdCells, ...forbiddenCells]),
      maxPathCells,
      riverSettings,
    });
    if (!candidate) continue;
    if (candidate.riverCells.length > maxPathCells) continue;
    if (candidate.riverCells.length === endIndex - startIndex + 1 && sameCellSequence(candidate.riverCells, riverCells.slice(startIndex, endIndex + 1))) continue;
    return {
      startIndex,
      endIndex,
      path: candidate.riverCells,
    };
  }

  return null;
}

function meanderForbiddenCells({centerCell, radius, selectedLandSet, allowedCells = new Set()}) {
  if (radius <= 0) return new Set();

  const forbidden = new Set();
  const frontier = [{cell: centerCell, distance: 0}];
  const visited = new Set([centerCell]);

  while (frontier.length > 0) {
    const {cell, distance} = frontier.shift();
    if (distance < radius && !allowedCells.has(cell)) {
      forbidden.add(cell);
    }
    if (distance >= radius - 1) continue;

    for (const {cell: neighbor} of landNeighbors(cell)) {
      if (!selectedLandSet.has(neighbor) || visited.has(neighbor)) continue;
      visited.add(neighbor);
      frontier.push({cell: neighbor, distance: distance + 1});
    }
  }

  return forbidden;
}

function maxEligibleMeanderCenter(riverLength, riverSettings = DEFAULT_RIVER_SETTINGS) {
  const maxRadius = Math.max(0, ...(riverSettings.meanderForbiddenRadii ?? []));
  return riverLength - riverSettings.minExitOpenSeaDistance - maxRadius - 1;
}

function sameCellSequence(a, b) {
  return a.length === b.length && a.every((cell, index) => cell === b[index]);
}

function isBetterPartial(candidateKey, currentKey, states, gScore, exit) {
  if (!currentKey) return true;
  const candidateState = states.get(candidateKey);
  const currentState = states.get(currentKey);
  const candidateDistance = H.distance(H.cellCentroid(candidateState.cell), H.cellCentroid(exit));
  const currentDistance = H.distance(H.cellCentroid(currentState.cell), H.cellCentroid(exit));
  return candidateDistance < currentDistance
    || candidateDistance === currentDistance && (gScore.get(candidateKey) ?? 0) > (gScore.get(currentKey) ?? 0);
}

function pathStateKey(state) {
  return `${state.cell.id}:${state.steps}:${state.lockedAwayFromSea ? 1 : 0}`;
}

function increasesSeaD(current, next) {
  return (next.seaD ?? 0) > (current.seaD ?? 0);
}

function isLockedAwayFromSea(cell, lockedSeaDistance = DEFAULT_RIVER_SETTINGS.minLockedSeaDistance) {
  return (cell.seaD ?? 0) >= lockedSeaDistance;
}

function movementCost(current, next, edge) {
  const middle = H.midpoint(edge.start, edge.end);
  return H.distance(H.cellCentroid(current), middle) + H.distance(middle, H.cellCentroid(next));
}

function computeRiverPathCost(riverCells) {
  let total = 0;
  for (let index = 0; index < riverCells.length - 1; index += 1) {
    const current = riverCells[index];
    const next = riverCells[index + 1];
    const edge = H.cellsEdge(current, next);
    if (!edge) continue;
    total += movementCost(current, next, edge);
  }
  return total;
}

export function mouthExitDistance(mouth, exit) {
  return H.distance(H.cellCentroid(mouth.cell), H.cellCentroid(exit));
}

function formatRiver(candidate) {
  if (!candidate) return "none";
  return `${candidate.riverCells.length} cells, ` +
    `${Math.round(candidate.pathCost * 10) / 10} path cost, ` +
    `${Math.round(candidate.mouthExitDistance * 10) / 10} mouth-exit distance`;
}

export function drawRiver(candidate, map, color = RIVER_COLOR) {
  if (!candidate) return;
  drawRivers([candidate], map, color);
}

export function drawRivers(candidates, map, color = RIVER_COLOR) {
  const paths = (candidates ?? []).map(buildStraightRiverPath).filter(Boolean);
  if (paths.length === 0) return;
  const prevOverlayDraw = map.drawOverlay;
  map.drawOverlay = (svg) => {
    if (prevOverlayDraw) prevOverlayDraw(svg);
    const layer = svg.getElementById("cells");
    if (!layer) return;
    (candidates ?? []).forEach((candidate, index) => appendRiverPath(layer, paths[index], color, "1", riverStrokeWidth(candidate)));
  };
}

export function buildStraightRiverPath(candidate) {
  const cells = candidate.riverCells;
  if (cells.length === 0) return "";

  const segments = [];
  const entryStart = riverEntryStartPoint(candidate) ?? riverEntryPoint(candidate) ?? H.cellCentroid(cells[0]);
  const entry = riverEntryPoint(candidate) ?? H.cellCentroid(cells[0]);
  segments.push(`M ${entryStart.x} ${entryStart.y}`);

  if (entryStart.x !== entry.x || entryStart.y !== entry.y) {
    segments.push(`L ${entry.x} ${entry.y}`);
  }

  for (let index = 0; index < cells.length; index += 1) {
    const nextPoint = cellRiverExitPoint(candidate, index);
    if (!nextPoint) continue;
    segments.push(`L ${nextPoint.x} ${nextPoint.y}`);
  }

  return segments.join(" ");
}

function riverEntryStartPoint(candidate) {
  if (candidate.mouth?.riverCell) {
    return H.cellCentroid(candidate.mouth.riverCell);
  }
  return null;
}

function cellRiverExitPoint(candidate, index) {
  const cells = candidate.riverCells;
  const current = cells[index];
  const next = cells[index + 1];
  if (next) {
    const edge = H.cellsEdge(current, next);
    return edge ? H.midpoint(edge.start, edge.end) : H.cellCentroid(next);
  }
  return riverExitPoint(candidate);
}

function riverEntryPoint(candidate) {
  const firstMouth = candidate.originalMouth;
  if (candidate.mouth?.riverCell) {
    const firstRiverEdge = H.cellsEdge(candidate.mouth.riverCell, firstMouth);
    return firstRiverEdge ? H.midpoint(firstRiverEdge.start, firstRiverEdge.end) : null;
  }

  const firstSea = typedNeighbors(firstMouth, "SEA")[0]?.cell;
  const firstMouthEdge = H.cellsEdge(firstSea, firstMouth);
  return firstMouthEdge ? H.midpoint(firstMouthEdge.start, firstMouthEdge.end) : null;
}

function riverExitPoint(candidate) {
  const exitEdge = candidate.riverCells.at(-1)?.edges.find(edge => edge.flags?.has("Boundary"));
  return exitEdge ? H.midpoint(exitEdge.start, exitEdge.end) : null;
}

function appendRiverPath(layer, d, color, opacity, strokeWidth = 8) {
  if (!d) return;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", color);
  path.setAttribute("stroke-width", String(strokeWidth));
  path.setAttribute("stroke-opacity", opacity);
  path.setAttribute("d", d);
  layer.appendChild(path);
}

export function connectedComponents(cells, neighborFn) {
  const remaining = new Set(cells);
  const components = [];
  while (remaining.size > 0) {
    const first = [...remaining][0];
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

export function landHopDistances(landSet, starts) {
  const distances = new Map();
  const frontier = starts.filter(cell => landSet.has(cell));
  frontier.forEach(cell => distances.set(cell, 1));

  while (frontier.length > 0) {
    const current = frontier.shift();
    const currentDistance = distances.get(current);
    for (const {cell: neighbor} of landNeighbors(current)) {
      if (!landSet.has(neighbor)) continue;
      if (distances.has(neighbor)) continue;
      distances.set(neighbor, currentDistance + 1);
      frontier.push(neighbor);
    }
  }

  return distances;
}

function passableLandNeighbors(cell, landSet, riverSettings = DEFAULT_RIVER_SETTINGS) {
  return landNeighbors(cell)
    .filter(neighbor => landSet.has(neighbor.cell))
    .filter(neighbor => H.edgeLength(neighbor.edge) > riverSettings.minEdgeSize);
}

function resolveRiverSettings(settings) {
  return {
    ...DEFAULT_RIVER_SETTINGS,
    ...(settings?.rivers ?? {}),
    meanderForbiddenRadii: normalizeMeanderRadii(settings?.rivers?.meanderForbiddenRadii ?? DEFAULT_RIVER_SETTINGS.meanderForbiddenRadii),
  };
}

function normalizeMeanderRadii(value) {
  const radii = (Array.isArray(value) ? value : DEFAULT_RIVER_SETTINGS.meanderForbiddenRadii)
    .map(item => Number(item))
    .filter(item => Number.isFinite(item) && item >= 0);
  return radii.length > 0 ? radii : [...DEFAULT_RIVER_SETTINGS.meanderForbiddenRadii];
}

export function landNeighbors(cell) {
  return typedNeighbors(cell, "LAND");
}

function seaNeighbors(cell) {
  return typedNeighbors(cell, "SEA");
}

export function typedNeighbors(cell, type) {
  return cell.edges
    .map(edge => ({cell: otherSide(edge, cell), edge}))
    .filter(neighbor => neighbor.cell?.type === type);
}

function otherSide(edge, cell) {
  if (edge.leftCell && edge.rightCell) {
    return edge.leftCell.id === cell.id ? edge.rightCell : edge.leftCell;
  }
  return null;
}

export function touchesBoundary(cell) {
  return cell.edges.some(edge => edge.flags?.has("Boundary"));
}

export function largestComponent(components) {
  return [...components].sort((a, b) => b.length - a.length || componentKey(a).localeCompare(componentKey(b)))[0] ?? [];
}

function ensureFlags(entity) {
  if (!(entity.flags instanceof Set)) {
    entity.flags = new Set(Array.isArray(entity.flags) ? entity.flags : []);
  }
  return entity.flags;
}

function compareMouthsByCenterDesc(a, b, size) {
  const center = {x: size / 2, y: size / 2};
  const aDistance = H.distance(H.cellCentroid(a.cell), center);
  const bDistance = H.distance(H.cellCentroid(b.cell), center);
  return bDistance - aDistance || compareMouths(a, b);
}

function compareExitsFromMouthDesc(a, b, mouth) {
  const mouthCentroid = H.cellCentroid(mouth.cell);
  const aDistance = H.distance(H.cellCentroid(a), mouthCentroid);
  const bDistance = H.distance(H.cellCentroid(b), mouthCentroid);
  return bDistance - aDistance || compareCells(a, b);
}

function compareMouths(a, b) {
  return compareCells(a.cell, b.cell) || a.seaCell.id.localeCompare(b.seaCell.id);
}

export function compareCells(a, b) {
  return String(a.id).localeCompare(String(b.id));
}

function componentKey(component) {
  return component.map(cell => cell.id).sort().join("|");
}

export function riverKey(candidate) {
  return candidate.riverCells.map(cell => cell.id).join("|");
}

export function normalizeRiver(candidate, {type = "MAIN", id = "river-0", order = 0, sourceRiverId = null, role = null} = {}) {
  return {
    ...candidate,
    id,
    type,
    order,
    sourceRiverId,
    role: role ?? inferRiverRole(type, order),
    mouth: normalizeRiverMouth(candidate.mouth),
  };
}

function inferRiverRole(type, order) {
  if (type === "MAIN") return RIVER_ROLE_PRIMARY;
  if (order === 1) return RIVER_ROLE_FIRST_TRIBUTARY;
  if (order === 2) return RIVER_ROLE_SECOND_TRIBUTARY;
  return RIVER_ROLE_SECOND_TRIBUTARY;
}

function riverStrokeWidth(candidate) {
  switch (candidate?.role) {
    case RIVER_ROLE_PRIMARY:
      return 12;
    case RIVER_ROLE_FIRST_TRIBUTARY:
    case RIVER_ROLE_SECOND_TRIBUTARY:
      return 8;
    default:
      return candidate?.type === "MAIN" ? 12 : 8;
  }
}

function normalizeRiverMouth(mouth) {
  if (!mouth) return null;
  return {
    cell: mouth.cell ?? null,
    seaCell: mouth.seaCell ?? null,
    riverCell: mouth.riverCell ?? null,
  };
}

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function formatPercent(ratio) {
  return `${Math.round(ratio * 1000) / 10}%`;
}
