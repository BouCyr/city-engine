import {Area, AreaGroup} from "../data/area.mjs";
import {createDrawCellFn} from "../data/cell.mjs";
import {createDrawEdgeFn} from "../data/edge.mjs";
import * as H from "../data/helper.mjs";

export const MIN_EDGE_SIZE = 50;
const OPEN_SEA = "OPEN_SEA";
const INNER_SEA = "INNER_SEA";
const MAX_CANDIDATE_STATES = 5000;
const MAX_COMPUTE_MS = 1000;
const MIN_EXIT_OPEN_SEA_DISTANCE = 5;
const INITIAL_MOUTH_DISTANCE_LIMIT = 4;
const INNER_SEA_ATTRACTION_DISTANCE = 4;
const MIN_BANK_A_RATIO = 0.30;

export function computeRivers(settings, map) {
  const startedAt = now();
  const deadline = startedAt + MAX_COMPUTE_MS;
  console.info("Rivers: starting");

  clearRiverState(map);
  flagShortEdges(map);

  const seaComponents = classifySeaComponents(map);
  if (seaComponents.length === 0) {
    console.info("Rivers: no sea components found");
    return map;
  }
  console.info(`Rivers: found ${seaComponents.length} sea components`);

  const landComponents = connectedComponents(map.cells.filter(cell => cell.type === "LAND"), landNeighbors);
  console.info(`Rivers: found ${landComponents.length} land components`);
  const selectedLandmass = largestComponent(landComponents);
  if (selectedLandmass.length === 0) {
    console.info("Rivers: no landmass found");
    return map;
  }

  const selectedLandSet = new Set(selectedLandmass);
  const openSeaComponents = seaComponents.filter(component => component.kind === OPEN_SEA);

  if(openSeaComponents.length === 0) {
    console.info("Rivers: no open sea found");
    return map;
  }

  console.info(`Rivers: found ${openSeaComponents.length} open sea components`);
  const innerSeaComponents = seaComponents.filter(component => component.kind === INNER_SEA);
  console.info(`Rivers: found ${innerSeaComponents.length} inner sea components`);
  computeDistanceFromOpenSea(selectedLandmass, selectedLandSet, openSeaComponents);

  console.info(`Rivers: selected ${selectedLandmass.length} cells (${formatPercent(selectedLandmass.length / map.cells.length)}) as landmass`);

  const exitCells = selectedLandmass
    .filter(cell => cell.seaD >= MIN_EXIT_OPEN_SEA_DISTANCE)
    .filter(cell => cell.edges.some(edge => edge.flags?.has("Boundary")));
  if (exitCells.length === 0) {
    console.info("Rivers: no eligible exit cells found");
    return map;
  }

  console.info(`Rivers: selected ${exitCells.length} cells (${formatPercent(exitCells.length / selectedLandmass.length)}) as river exit cells`);

  const mouthCandidates = findMouthCandidates(map, seaComponents)
    .filter(mouth => selectedLandSet.has(mouth.cell));
  const openMouths = mouthCandidates
    .filter(mouth => mouth.seaComponent?.kind === OPEN_SEA)
    .sort((a, b) => compareMouthsByCenter(a, b, map.size));
  console.info(`Rivers: found ${mouthCandidates.length} mouth candidates`);
  if (openMouths.length === 0) {
    console.info("Rivers: no open-sea mouth candidates found");
    return map;
  }

  console.info(`Rivers: found ${openMouths.length} open mouths`);

  const innerSeaRoutes = innerSeaComponents.map(component => ({
    component,
    mouths: mouthCandidates.filter(mouth => mouth.seaComponent === component).sort(compareMouths),
    distances: landHopDistances(
      selectedLandSet,
      mouthCandidates
        .filter(mouth => mouth.seaComponent === component)
        .map(mouth => mouth.cell)
    ),
  }));

  const search = findCompletedRivers({
    openMouths,
    innerSeaRoutes,
    selectedLandSet,
    exitCells: new Set(exitCells),
    deadline,
  });
  console.info(
    `Rivers: search ${search.timedOut ? "timed out" : "finished"} after ${Math.round(now() - startedAt)}ms, ` +
    `${search.expandedStates} states expanded, ${search.completed.length} completed candidates found`
  );

  const selected = selectRiver(search.completed, selectedLandmass);
  if (!selected) {
    console.info("Rivers: no valid river selected");
    return map;
  }



  console.info(`Rivers: selected ${selected.riverCells.length}-cell river with BANK-A ${formatPercent(selected.bankA.length / selectedLandmass.length)}${selected.matchesBankRatio ? "" : " (nearest ratio fallback)"}`);

  drawRiver(selected, map);
  writeBankAreas(map, selected.bankA, selected.bankB);
  console.info(`Rivers: done in ${Math.round(now() - startedAt)}ms`);

  return map;
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
      edge.draw = createDrawEdgeFn(edge, "none", "red", "7")
    })
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

function computeDistanceFromOpenSea(selectedLandmass, selectedLandSet, openSeaComponents) {
  const starts = [];
  for (const component of openSeaComponents) {
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

function findMouthCandidates(map, seaComponents) {
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
    for (const {cell: landCell} of typedNeighbors(seaCell, "LAND")) {
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

function findCompletedRivers({openMouths, innerSeaRoutes, selectedLandSet, exitCells, deadline}) {
  const completed = [];
  let expandedStates = 0;
  let timedOut = false;
  const states = openMouths.map((mouth, mouthOrder) => ({
    mouth,
    mouthOrder,
    originalMouth: mouth.cell,
    current: mouth.cell,
    riverCells: [mouth.cell],
    bridgeSegments: [],
    bridgedSeaComponents: new Set(),
    visited: new Set([mouth.cell]),
  }));

  while (states.length > 0) {
    if (now() > deadline) {
      timedOut = true;
      break;
    }

    states.sort(compareStates);
    const state = states.shift();
    expandedStates += 1;
    if (exitCells.has(state.current)) {
      completed.push(finalizeCandidate(state));
      continue;
    }

    const nextStates = expandRiverState(state, innerSeaRoutes, selectedLandSet, exitCells);
    states.push(...nextStates);
    if (states.length > MAX_CANDIDATE_STATES) {
      states.sort(compareStates);
      states.length = MAX_CANDIDATE_STATES;
    }
  }

  return {completed, expandedStates, timedOut};
}

function expandRiverState(state, innerSeaRoutes, selectedLandSet) {
  const innerRoute = nearestAttractingInnerSea(state, innerSeaRoutes);
  const innerMouths = innerRoute?.mouths.filter(mouth => mouth.cell === state.current) ?? [];
  if (innerMouths.length > 0) {
    return restartFromInnerSea(state, innerMouths[0], innerRoute, selectedLandSet);
  }

  return passableLandNeighbors(state.current, selectedLandSet)
    .filter(({cell}) => !state.visited.has(cell))
    .filter(({cell}) => respectsInitialMouthRule(state, cell))
    .filter(({cell}) => {
      if (!innerRoute) return true;
      return innerRoute.distances.get(cell) < innerRoute.distances.get(state.current);
    })
    .sort((a, b) => compareCells(a.cell, b.cell))
    .map(({cell}) => extendState(state, cell));
}

function nearestAttractingInnerSea(state, innerSeaRoutes) {
  return innerSeaRoutes
    .filter(route => !state.bridgedSeaComponents.has(route.component))
    .map(route => ({route, distance: route.distances.get(state.current)}))
    .filter(entry => entry.route.mouths.length > 1)
    .filter(entry => entry.distance !== undefined && entry.distance <= INNER_SEA_ATTRACTION_DISTANCE)
    .sort((a, b) => a.distance - b.distance || a.route.component.id.localeCompare(b.route.component.id))[0]?.route ?? null;
}

function restartFromInnerSea(state, reachedMouth, innerRoute, selectedLandSet) {
  return innerRoute.mouths
    .filter(mouth => mouth.cell !== reachedMouth.cell)
    .filter(mouth => selectedLandSet.has(mouth.cell))
    .filter(mouth => !state.visited.has(mouth.cell))
    .map(mouth => {
      const next = extendState(state, mouth.cell);
      next.mouth = mouth;
      next.bridgeSegments.push({from: reachedMouth, to: mouth, seaComponent: innerRoute.component});
      next.bridgedSeaComponents.add(innerRoute.component);
      return next;
    });
}

function respectsInitialMouthRule(state, nextCell) {
  const distanceFromMouth = state.riverCells.length - 1;
  if (distanceFromMouth >= INITIAL_MOUTH_DISTANCE_LIMIT) return true;
  return (nextCell.seaD ?? 0) > (state.current.seaD ?? 0);
}

function extendState(state, nextCell) {
  return {
    ...state,
    current: nextCell,
    riverCells: [...state.riverCells, nextCell],
    bridgeSegments: [...state.bridgeSegments],
    bridgedSeaComponents: new Set(state.bridgedSeaComponents),
    visited: new Set([...state.visited, nextCell]),
  };
}

function finalizeCandidate(state) {
  return {
    riverCells: state.riverCells,
    bridgeSegments: state.bridgeSegments,
    mouth: state.mouth,
    originalMouth: state.originalMouth,
  };
}

export function selectRiver(candidates, landmass) {
  const scored = candidates
    .map(candidate => {
      const banks = computeBanks(landmass, candidate.riverCells);
      if (!banks) return null;
      const bankRatio = banks.bankA.length / landmass.length;
      return {
        ...candidate,
        ...banks,
        bankRatio,
        matchesBankRatio: bankRatio > MIN_BANK_A_RATIO,
      };
    })
    .filter(Boolean);

  const matching = scored
    .filter(candidate => candidate.matchesBankRatio)
    .sort(compareCandidates)[0];
  if (matching) return matching;

  return scored
    .sort(compareCandidateRatioFallbacks)[0] ?? null;
}

function computeBanks(landmass, riverCells) {
  const riverSet = new Set(riverCells);
  const remaining = landmass.filter(cell => !riverSet.has(cell));
  const components = connectedComponents(remaining, cell => landNeighbors(cell).filter(neighbor => !riverSet.has(neighbor.cell)));
  if (components.length < 2) return null;

  components.sort((a, b) => a.length - b.length || componentKey(a).localeCompare(componentKey(b)));
  const bankA = components[0];
  const bankB = components.slice(1).flat();
  return {bankA, bankB};
}

function writeBankAreas(map, bankA, bankB) {
  map.areas = (map.areas ?? []).filter(group => group.name !== "river-banks");
  map.areas.push(AreaGroup("river-banks", [
    Area("BANK-A", "LAND", bankA),
    Area("BANK-B", "LAND", bankB),
  ]));
}

function drawRiver(candidate, map, color = "blue") {
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
  if(edge.leftCell && edge.rightCell)
    return edge.leftCell.id === cell.id ? edge.rightCell : edge.leftCell;
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

function compareCandidates(a, b) {
  return a.riverCells.length - b.riverCells.length || riverKey(a).localeCompare(riverKey(b));
}

function compareCandidateRatioFallbacks(a, b) {
  return Math.abs(MIN_BANK_A_RATIO - a.bankRatio) - Math.abs(MIN_BANK_A_RATIO - b.bankRatio)
    || compareCandidates(a, b);
}

function compareStates(a, b) {
  return a.riverCells.length - b.riverCells.length
    || a.mouthOrder - b.mouthOrder
    || riverKey(a).localeCompare(riverKey(b));
}

function compareMouths(a, b) {
  return compareCells(a.cell, b.cell) || a.seaCell.id.localeCompare(b.seaCell.id);
}

function compareMouthsByCenter(a, b, size) {
  const center = {x: size / 2, y: size / 2};
  const aDistance = H.distance(H.cellCentroid(a.cell), center);
  const bDistance = H.distance(H.cellCentroid(b.cell), center);
  return aDistance - bDistance || compareMouths(a, b);
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
