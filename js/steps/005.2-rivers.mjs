import {createDrawCellFn} from "../data/cell.mjs";
import {createDrawEdgeFn} from "../data/edge.mjs";
import * as H from "../data/helper.mjs";

export const MIN_EDGE_SIZE = 50;

const OPEN_SEA = "OPEN_SEA";
const INNER_SEA = "INNER_SEA";
const MAX_COMPUTE_MS = 1000;
const MIN_EXIT_OPEN_SEA_DISTANCE = 5;
const INITIAL_SEAD_INCREASE_STEPS = 4;
const MIN_LOCKED_SEA_DISTANCE = 4;
const RIVER_COLOR = "var(--sea-edge)";

export function computeRivers(settings, map) {
  const startedAt = now();
  const deadline = startedAt + MAX_COMPUTE_MS;
  console.info("Rivers A*: starting");

  clearRiverState(map);
  flagShortEdges(map);

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
    .filter(cell => cell.seaD >= MIN_EXIT_OPEN_SEA_DISTANCE)
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
  });
  console.info(
    `Rivers A*: search ${search.timedOut ? "timed out" : "finished"} after ${Math.round(now() - startedAt)}ms, ` +
    `${search.attemptedPaths} paths attempted, ${search.validRivers.length} valid candidates found`
  );

  if (!search.selected) {
    console.info("Rivers A*: no valid river selected");
    return map;
  }

  console.info(`Rivers A*: selected ${formatRiver(search.selected)}`);
  drawRiver(search.selected, map, RIVER_COLOR);
  console.info(`Rivers A*: done in ${Math.round(now() - startedAt)}ms`);

  return map;
}

export function findBestAStarRiver({openMouths, exitCells, selectedLandSet, mapSize, deadline = Infinity}) {
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
      const candidate = findAStarPath({mouth, exit, selectedLandSet});
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

export function findAStarPath({mouth, exit, selectedLandSet}) {
  const start = mouth.cell;
  if (!selectedLandSet.has(start) || !selectedLandSet.has(exit)) return null;

  const startState = {
    cell: start,
    steps: 0,
    lockedAwayFromSea: isLockedAwayFromSea(start),
    visitedCells: new Set([start]),
  };
  const startKey = pathStateKey(startState);
  const states = new Map([[startKey, startState]]);
  const open = new Set([startKey]);
  const cameFrom = new Map();
  const gScore = new Map([[startKey, 0]]);
  const fScore = new Map([[startKey, H.distance(H.cellCentroid(start), H.cellCentroid(exit))]]);
  const closed = new Set();

  while (open.size > 0) {
    const currentKey = lowestScoreState(open, fScore, states);
    const currentState = states.get(currentKey);
    const current = currentState.cell;
    if (current === exit) {
      const riverCells = reconstructPath(cameFrom, states, currentKey);
      return {
        riverCells,
        pathCost: gScore.get(currentKey),
        mouthExitDistance: mouthExitDistance(mouth, exit),
        mouth,
        originalMouth: start,
        exit,
      };
    }

    open.delete(currentKey);
    closed.add(currentKey);

    for (const neighbor of passableLandNeighbors(current, selectedLandSet)) {
      const next = neighbor.cell;
      const mustIncreaseSeaD = currentState.steps < INITIAL_SEAD_INCREASE_STEPS;
      if (mustIncreaseSeaD && !increasesSeaD(current, next)) continue;
      if (currentState.lockedAwayFromSea && !isLockedAwayFromSea(next)) continue;
      if (next !== exit && touchesBoundary(next)) continue;
      if (currentState.visitedCells.has(next)) continue;

      const nextState = {
        cell: next,
        steps: Math.min(currentState.steps + 1, INITIAL_SEAD_INCREASE_STEPS),
        lockedAwayFromSea: currentState.lockedAwayFromSea || isLockedAwayFromSea(next),
        visitedCells: new Set([...currentState.visitedCells, next]),
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

  return null;
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
}

function flagShortEdges(map) {
  map.edges
    .filter(edge => edge.flags?.has("LAND"))
    .filter(edge => H.edgeLength(edge) <= MIN_EDGE_SIZE)
    .forEach(edge => {
      edge.draw = createDrawEdgeFn(edge, "none", "red", "7");
    });
}

function classifySeaComponents(map) {
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

function computeDistanceFromSea(selectedLandmass, selectedLandSet, seaComponents) {
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
      landCell.draw = createDrawCellFn("none", "0", "#8B2a");
      mouths.push({cell: landCell, seaCell, seaComponent});
    }
  }

  return mouths;
}

export function selectSelectedRiver(candidates) {
  return [...candidates].sort(compareByMouthExitDistance)[0] ?? null;
}

function compareByPathCost(a, b) {
  return b.pathCost - a.pathCost
    || b.riverCells.length - a.riverCells.length
    || riverKey(a).localeCompare(riverKey(b));
}

function compareByMouthExitDistance(a, b) {
  return b.mouthExitDistance - a.mouthExitDistance
    || compareByPathCost(a, b);
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

function pathStateKey(state) {
  return `${state.cell.id}:${state.steps}:${state.lockedAwayFromSea ? 1 : 0}`;
}

function increasesSeaD(current, next) {
  return (next.seaD ?? 0) > (current.seaD ?? 0);
}

function isLockedAwayFromSea(cell) {
  return (cell.seaD ?? 0) >= MIN_LOCKED_SEA_DISTANCE;
}

function movementCost(current, next, edge) {
  const middle = H.midpoint(edge.start, edge.end);
  return H.distance(H.cellCentroid(current), middle) + H.distance(middle, H.cellCentroid(next));
}

function mouthExitDistance(mouth, exit) {
  return H.distance(H.cellCentroid(mouth.cell), H.cellCentroid(exit));
}

function formatRiver(candidate) {
  if (!candidate) return "none";
  return `${candidate.riverCells.length} cells, ` +
    `${Math.round(candidate.pathCost * 10) / 10} path cost, ` +
    `${Math.round(candidate.mouthExitDistance * 10) / 10} mouth-exit distance`;
}

function drawRiver(candidate, map, color = "blue") {
  if (!candidate) return;
  const points = [];
  const firstMouth = candidate.originalMouth;
  const firstSea = typedNeighbors(firstMouth, "SEA")[0]?.cell;
  const firstMouthEdge = H.cellsEdge(firstSea, firstMouth);
  if (firstMouthEdge) points.push(H.midpoint(firstMouthEdge.start, firstMouthEdge.end));

  candidate.riverCells.forEach(cell => points.push(H.cellCentroid(cell)));
  const exit = candidate.riverCells.at(-1)?.edges.find(edge => edge.flags?.has("Boundary"));
  if (exit) points.push(H.midpoint(exit.start, exit.end));

  const d = points.length > 0
    ? `M ${points.map(point => `${point.x} ${point.y}`).join(" L ")}`
    : "";
  const prevOverlayDraw = map.drawOverlay;
  map.drawOverlay = (svg) => {
    if (prevOverlayDraw) prevOverlayDraw(svg);
    const layer = svg.getElementById("cells");
    if (!layer || !d) return;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", "7");
    path.setAttribute("d", d);
    layer.appendChild(path);
  };
}

function connectedComponents(cells, neighborFn) {
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

function landHopDistances(landSet, starts) {
  const distances = new Map();
  const frontier = starts.filter(cell => landSet.has(cell));
  frontier.forEach(cell => distances.set(cell, 1));

  while (frontier.length > 0) {
    const current = frontier.shift();
    const currentDistance = distances.get(current);
    for (const {cell: neighbor} of passableLandNeighbors(current, landSet)) {
      if (distances.has(neighbor)) continue;
      distances.set(neighbor, currentDistance + 1);
      frontier.push(neighbor);
    }
  }

  return distances;
}

function passableLandNeighbors(cell, landSet) {
  return landNeighbors(cell)
    .filter(neighbor => landSet.has(neighbor.cell))
    .filter(neighbor => H.edgeLength(neighbor.edge) > MIN_EDGE_SIZE);
}

function landNeighbors(cell) {
  return typedNeighbors(cell, "LAND");
}

function seaNeighbors(cell) {
  return typedNeighbors(cell, "SEA");
}

function typedNeighbors(cell, type) {
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

function touchesBoundary(cell) {
  return cell.edges.some(edge => edge.flags?.has("Boundary"));
}

function largestComponent(components) {
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

function compareCells(a, b) {
  return String(a.id).localeCompare(String(b.id));
}

function componentKey(component) {
  return component.map(cell => cell.id).sort().join("|");
}

function riverKey(candidate) {
  return candidate.riverCells.map(cell => cell.id).join("|");
}

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function formatPercent(ratio) {
  return `${Math.round(ratio * 1000) / 10}%`;
}
