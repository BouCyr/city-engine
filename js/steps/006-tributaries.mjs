import {cloneDeepKeepFunctions} from "../data/clone.mjs";
import * as H from "../data/helper.mjs";
import {Settings} from "../data/settings.mjs";
import {
  MAP_FLAG_BOUNDARY,
  RIVER_ROLE_FIRST_TRIBUTARY,
  RIVER_ROLE_PRIMARY,
  RIVER_ROLE_SECOND_TRIBUTARY,
  RIVER_TYPE_TRIBUTARY,
  OVERLAY_TYPE_RIVERS,
  TERRAIN_LAND,
  TERRAIN_SEA,
} from "../constants.mjs";
import {
  compareByPathCost,
  compareCells,
  connectedComponents,
  drawRivers,
  findAStarPath,
  landHopDistances,
  landNeighbors,
  largestComponent,
  meanderRiverCandidate,
  MIN_EDGE_SIZE,
  MIN_LOCKED_SEA_DISTANCE,
  buildStraightRiverPath,
  normalizeRiver,
  riverKey,
  touchesBoundary,
  typedNeighbors,
} from "./005.2-rivers.mjs";

const DEFAULT_TRIBUTARY_SETTINGS = new Settings().tributaries;
const RIVER_COLOR = "var(--sea-edge)";

export function createReplay(settings, inputMap) {
  const map = cloneDeepKeepFunctions(inputMap);
  const tributarySettings = resolveTributarySettings(settings);
  const frames = [];

  frames.push(replayFrame(map, "Before tributaries", "Tributaries are evaluated from the existing main river and its adjacent land banks.", emptyTributaryReplayOverlay()));

  const mainRiver = map.rivers?.[0];
  if (!mainRiver?.riverCells?.length) {
    frames.push(replayFrame(map, "No tributaries", "No primary river was found, so tributaries cannot be generated.", emptyTributaryReplayOverlay()));
    return {frames};
  }

  const landmass = largestComponent(connectedComponents(map.cells.filter(cell => cell.type === TERRAIN_LAND), landNeighbors));
  if (landmass.length === 0) {
    frames.push(replayFrame(map, "No tributaries", "No landmass was found after river extraction.", emptyTributaryReplayOverlay()));
    return {frames};
  }

  const mainRiverSet = new Set(mainRiver.riverCells);
  const banks = computeRiverBanks(landmass, mainRiverSet)
    .sort((a, b) => b.length - a.length || componentKey(a).localeCompare(componentKey(b)));
  if (banks.length === 0) {
    frames.push(replayFrame(map, "No tributaries", "The main river does not split land into banks for attachment.", emptyTributaryReplayOverlay()));
    return {frames};
  }

  frames.push(replayFrame(map, "Bank search", `${Math.min(2, banks.length)} largest bank components were inspected for tributaries.`, emptyTributaryReplayOverlay()));

  const seaDistances = computeSeaOnlyDistances(new Set(landmass));
  const rivers = [mainRiver];
  let previousTributaryMouth = null;

  for (const [index, bank] of banks.slice(0, 2).entries()) {
    const bankLabel = `Bank ${index + 1}`;
    const deadline = now() + tributarySettings.maxComputeMs;
    const tributary = findBestTributary({
      bank,
      mainRiver,
      mainRiverSet,
      seaDistances,
      previousTributaryMouth,
      deadline,
      tributarySettings,
    });

    if (!tributary) {
      frames.push(replayFrame(map, `${bankLabel}: no tributary`, `${bankLabel} had no valid boundary-to-boundary path in this run.`, emptyTributaryReplayOverlay()));
      continue;
    }

    frames.push(replayFrame(
      map,
      `${bankLabel}: best candidate`,
      `${bankLabel} candidate found. The raw route is shown before local meander refinement.`,
      riversReplayOverlay([tributary]),
    ));

    const meanderedTributary = meanderRiverCandidate({
      candidate: tributary,
      selectedLandSet: bankSetWithMouth(bank, tributary.mouth),
      riverSettings: {
        ...(settings?.rivers ?? {}),
        minLockedSeaDistance: tributarySettings.seaDThreshold,
      },
    });

    const normalized = normalizeRiver(meanderedTributary, {
      type: RIVER_TYPE_TRIBUTARY,
      id: `river-${rivers.length}`,
      order: rivers.length,
      sourceRiverId: mainRiver.id ?? "river-0",
      role: rivers.length === 1 ? RIVER_ROLE_FIRST_TRIBUTARY : RIVER_ROLE_SECOND_TRIBUTARY,
    });
    normalized.mouth = {
      ...normalized.mouth,
      riverExitPoint: mainRiverExitPoint(mainRiver, normalized.mouth?.riverCell),
    };

    rivers.push(normalized);
    map.rivers = [...rivers];
    previousTributaryMouth = normalized.mouth.cell;

    frames.push(replayFrame(
      map,
      `${bankLabel}: applied`,
      `${bankLabel} has been meander-refined and appended to the river list.`,
      riversReplayOverlay([normalized]),
    ));
  }

  map.rivers = rivers;
  frames.push(replayFrame(map, "Tributaries complete", `Added ${Math.max(0, rivers.length - 1)} tributary river(s).`, emptyTributaryReplayOverlay()));
  return {frames};
}

export function computeTributaries(settings, map) {
  const startedAt = now();
  const tributarySettings = resolveTributarySettings(settings);
  console.info("Tributaries: starting");

  const mainRiver = map.rivers?.[0];
  if (!mainRiver?.riverCells?.length) {
    console.info("Tributaries: no main river found");
    return map;
  }

  const landmass = largestComponent(connectedComponents(map.cells.filter(cell => cell.type === TERRAIN_LAND), landNeighbors));
  if (landmass.length === 0) {
    console.info("Tributaries: no landmass found");
    return map;
  }

  const mainRiverSet = new Set(mainRiver.riverCells);
  const banks = computeRiverBanks(landmass, mainRiverSet)
    .sort((a, b) => b.length - a.length || componentKey(a).localeCompare(componentKey(b)));
  if (banks.length === 0) {
    console.info("Tributaries: main river does not split the landmass");
    return map;
  }

  const seaDistances = computeSeaOnlyDistances(new Set(landmass));
  const rivers = [mainRiver];
  let previousTributaryMouth = null;

  for (const bank of banks.slice(0, 2)) {
    const deadline = now() + tributarySettings.maxComputeMs;
    const tributary = findBestTributary({
      bank,
      mainRiver,
      mainRiverSet,
      seaDistances,
      previousTributaryMouth,
      deadline,
      tributarySettings,
    });

    if (!tributary) continue;

    const meanderedTributary = meanderRiverCandidate({
      candidate: tributary,
      selectedLandSet: bankSetWithMouth(bank, tributary.mouth),
      riverSettings: {
        ...(settings?.rivers ?? {}),
        minLockedSeaDistance: tributarySettings.seaDThreshold,
      },
    });
    meanderedTributary.mouth = {
      ...meanderedTributary.mouth,
      riverExitPoint: mainRiverExitPoint(mainRiver, meanderedTributary.mouth?.riverCell),
    };
    const normalized = normalizeRiver(meanderedTributary, {
      type: RIVER_TYPE_TRIBUTARY,
      id: `river-${rivers.length}`,
      order: rivers.length,
      sourceRiverId: mainRiver.id ?? "river-0",
      role: rivers.length === 1 ? RIVER_ROLE_FIRST_TRIBUTARY : RIVER_ROLE_SECOND_TRIBUTARY,
    });
    rivers.push(normalized);
    previousTributaryMouth = normalized.mouth.cell;
    console.info(`Tributaries: selected ${normalized.id} with ${normalized.riverCells.length} cells`);
  }

  map.rivers = rivers;
  map.drawOverlay = null;
  drawRivers(map.rivers, map);
  console.info(`Tributaries: done in ${Math.round(now() - startedAt)}ms with ${rivers.length - 1} tributaries`);

  return map;
}

export function findBestTributary({bank, mainRiver, mainRiverSet, seaDistances, previousTributaryMouth = null, deadline = Infinity, tributarySettings = DEFAULT_TRIBUTARY_SETTINGS}) {
  const bankSet = new Set(bank);
  computeDistanceFromSeaOrRiver(bank, bankSet, mainRiverSet);

  const exitCells = bank
    .filter(cell => (cell.seaD ?? 0) >= tributarySettings.seaDThreshold)
    .filter(touchesBoundary)
    .sort(compareCells);
  if (exitCells.length === 0) return null;

  const mouthDistances = previousTributaryMouth
    ? landHopDistances(new Set([...bank, previousTributaryMouth, ...mainRiverSet]), [previousTributaryMouth])
    : new Map();
  const mouths = findTributaryMouthCandidates({
    bank,
      mainRiverSet,
      seaDistances,
      mouthDistances,
      previousTributaryMouth,
      tributarySettings,
    });
  if (mouths.length === 0) return null;

  const validRivers = [];
  let timedOut = false;

  for (const mouth of mouths) {
    const exits = [...exitCells].sort((a, b) => compareExitsFromMouthDesc(a, b, mouth));
    for (const exit of exits) {
      if (now() > deadline) {
        timedOut = true;
        break;
      }

      const candidate = findAStarPath({
        mouth,
        exit,
        selectedLandSet: bankSet,
        initialSeaDIncreaseSteps: tributarySettings.seaDThreshold,
        lockedSeaDistance: tributarySettings.seaDThreshold,
      });
      if (!candidate) continue;
      validRivers.push({
        ...candidate,
        sourceExitDistance: sourceExitDistance(candidate, mainRiver),
        mouthThirdScore: mouthThirdScore(candidate, mainRiver),
      });
    }
    if (timedOut) break;
  }

  return selectTributary(validRivers, mainRiver);
}

export function computeRiverBanks(landmass, riverSet) {
  const remaining = landmass.filter(cell => !riverSet.has(cell));
  return connectedComponents(remaining, cell => (
    landNeighbors(cell)
      .filter(neighbor => !riverSet.has(neighbor.cell))
  ));
}

export function findTributaryMouthCandidates({bank, mainRiverSet, seaDistances, mouthDistances = new Map(), previousTributaryMouth = null, tributarySettings = DEFAULT_TRIBUTARY_SETTINGS}) {
  const mouths = [];
  const seen = new Set();

  for (const cell of bank) {
    if (touchesBoundary(cell)) continue;
    if ((seaDistances.get(cell) ?? 0) < tributarySettings.mouthSeaDistance) continue;
    if (previousTributaryMouth && (mouthDistances.get(cell) ?? Infinity) < tributarySettings.secondMouthMinDistance) continue;

    for (const {cell: riverCell, edge} of landNeighbors(cell)) {
      if (!mainRiverSet.has(riverCell)) continue;
      if (H.edgeLength(edge) <= MIN_EDGE_SIZE) continue;

      const key = `${cell.id}:${riverCell.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mouths.push({cell, riverCell});
    }
  }

  return mouths.sort(compareTributaryMouths);
}

function computeDistanceFromSeaOrRiver(bank, bankSet, mainRiverSet) {
  for (const cell of bank) {
    delete cell.seaD;
    delete cell.cellToSea;
    delete cell.toSea;
  }

  const starts = [];
  for (const cell of bank) {
    const touchesSea = typedNeighbors(cell, TERRAIN_SEA).length > 0;
    const touchesRiver = landNeighbors(cell).some(neighbor => mainRiverSet.has(neighbor.cell));
    if (!touchesSea && !touchesRiver) continue;

    cell.seaD = 1;
    cell.cellToSea = 1;
    starts.push(cell);
  }

  const distances = landHopDistances(bankSet, starts);
  for (const cell of bank) {
    const distance = distances.get(cell);
    if (distance === undefined) continue;
    cell.seaD = distance;
    cell.cellToSea = distance;
  }
}

function computeSeaOnlyDistances(landSet) {
  const starts = [];
  for (const cell of landSet) {
    if (typedNeighbors(cell, TERRAIN_SEA).length === 0) continue;
    starts.push(cell);
  }

  return landHopDistances(landSet, starts);
}

function bankSetWithMouth(bank, mouth) {
  return new Set([
    ...bank,
    ...(mouth?.cell ? [mouth.cell] : []),
  ]);
}

function resolveTributarySettings(settings) {
  return {
    ...DEFAULT_TRIBUTARY_SETTINGS,
    ...(settings?.tributaries ?? {}),
  };
}

export function selectTributary(candidates, mainRiver = null) {
  candidates.forEach(candidate => {
    candidate.mouthThirdScore = candidate.mouthThirdScore ?? mouthThirdScore(candidate, mainRiver);
  });
  const maxSourceExitDistance = Math.max(1, ...candidates.map(candidate => candidate.sourceExitDistance ?? 0));
  const maxExitSeaD = Math.max(1, ...candidates.map(candidate => candidate.exit?.seaD ?? 0));
  return [...candidates].sort((a, b) => compareTributaries(a, b, maxSourceExitDistance, maxExitSeaD))[0] ?? null;
}

function compareTributaries(a, b, maxSourceExitDistance, maxExitSeaD) {
  return tributaryScore(b, maxSourceExitDistance, maxExitSeaD) - tributaryScore(a, maxSourceExitDistance, maxExitSeaD)
    || b.sourceExitDistance - a.sourceExitDistance
    || (b.exit?.seaD ?? 0) - (a.exit?.seaD ?? 0)
    || compareByPathCost(a, b)
    || riverKey(a).localeCompare(riverKey(b));
}

function tributaryScore(candidate, maxSourceExitDistance, maxExitSeaD) {
  return ((candidate.sourceExitDistance ?? 0) / maxSourceExitDistance)
    + ((candidate.exit?.seaD ?? 0) / maxExitSeaD)
    + (candidate.mouthThirdScore ?? 0);
}

export function mouthThirdScore(candidate, mainRiver) {
  const riverCells = mainRiver?.riverCells ?? [];
  if (riverCells.length < 2 || !candidate?.mouth?.riverCell) return 0;

  const index = riverCells.indexOf(candidate.mouth.riverCell);
  if (index < 0) return 0;

  const progress = index / (riverCells.length - 1);
  const target = 1 / 3;
  const maxDistance = 2 / 3;
  return Math.max(0, 1 - Math.abs(progress - target) / maxDistance);
}

function sourceExitDistance(candidate, mainRiver) {
  if (!candidate?.exit || !mainRiver?.exit) return 0;
  return H.distance(H.cellCentroid(candidate.exit), H.cellCentroid(mainRiver.exit));
}

function emptyTributaryReplayOverlay() {
  return {
    type: OVERLAY_TYPE_RIVERS,
    paths: [],
  };
}

function cloneTributaryReplayOverlay(overlay = {}) {
  return {
    type: overlay.type ?? OVERLAY_TYPE_RIVERS,
    paths: (overlay.paths ?? []).map((path) => ({...path})),
  };
}

function riversReplayOverlay(rivers = []) {
  return {
    ...emptyTributaryReplayOverlay(),
    paths: (rivers ?? [])
      .map((river) => {
        const path = buildStraightRiverPath(river);
        if (!path) return null;
        return {
          d: path,
          stroke: RIVER_COLOR,
          strokeWidth: riverReplayStrokeWidth(river),
          opacity: 1,
        };
      })
      .filter(Boolean),
  };
}

function riverReplayStrokeWidth(river) {
  if (!river?.role) return 8;
  return river.role === RIVER_ROLE_PRIMARY ? 12 : 8;
}

function replayFrame(map, label, text, overlay) {
  const frameMap = cloneDeepKeepFunctions(map);
  const frameOverlay = overlay ? cloneTributaryReplayOverlay(overlay) : emptyTributaryReplayOverlay();
  frameMap.drawOverlay = createReplayOverlayDraw(frameOverlay);
  return {label, text, map: frameMap, overlay: frameOverlay};
}

function createReplayOverlayDraw(overlay) {
  return function drawReplay(svg) {
    const layer = svg.getElementById("overlay") ?? svg.getElementById("cells");
    if (!layer) return;

    for (const path of overlay?.paths ?? []) {
      const element = document.createElementNS("http://www.w3.org/2000/svg", "path");
      element.setAttribute("fill", "none");
      element.setAttribute("stroke", path.stroke ?? RIVER_COLOR);
      element.setAttribute("stroke-width", String(path.strokeWidth ?? 8));
      element.setAttribute("stroke-opacity", String(path.opacity ?? 1));
      element.setAttribute("d", path.d);
      layer.appendChild(element);
    }
  };
}

function compareTributaryMouths(a, b) {
  return compareCells(a.cell, b.cell) || compareCells(a.riverCell, b.riverCell);
}

function compareExitsFromMouthDesc(a, b, mouth) {
  const mouthCentroid = H.cellCentroid(mouth.cell);
  const aDistance = H.distance(H.cellCentroid(a), mouthCentroid);
  const bDistance = H.distance(H.cellCentroid(b), mouthCentroid);
  return bDistance - aDistance || compareCells(a, b);
}

function mainRiverExitPoint(mainRiver, mergeCell) {
  const cells = mainRiver?.riverCells ?? [];
  const index = cells.indexOf(mergeCell);
  if (index < 0) return null;

  const downstream = cells[index - 1];
  if (downstream) {
    const edge = H.cellsEdge(mergeCell, downstream);
    return edge ? H.midpoint(edge.start, edge.end) : H.cellCentroid(downstream);
  }

  const exitEdge = mergeCell.edges.find(edge => edge.flags?.has(MAP_FLAG_BOUNDARY));
  return exitEdge ? H.midpoint(exitEdge.start, exitEdge.end) : H.cellCentroid(mergeCell);
}

function componentKey(component) {
  return component.map(cell => cell.id).sort().join("|");
}

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}
