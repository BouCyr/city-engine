import * as H from "../data/helper.mjs";
import {Settings} from "../data/settings.mjs";
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
  normalizeRiver,
  riverKey,
  touchesBoundary,
  typedNeighbors,
} from "./005.2-rivers.mjs";

const DEFAULT_TRIBUTARY_SETTINGS = new Settings().tributaries;

export function computeTributaries(settings, map) {
  const startedAt = now();
  const tributarySettings = resolveTributarySettings(settings);
  console.info("Tributaries: starting");

  const mainRiver = map.rivers?.[0];
  if (!mainRiver?.riverCells?.length) {
    console.info("Tributaries: no main river found");
    return map;
  }

  const landmass = largestComponent(connectedComponents(map.cells.filter(cell => cell.type === "LAND"), landNeighbors));
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
      riverSettings: settings?.rivers,
    });
    const normalized = normalizeRiver(meanderedTributary, {
      type: "TRIBUTARY",
      id: `river-${rivers.length}`,
      order: rivers.length,
      sourceRiverId: mainRiver.id ?? "river-0",
    });
    rivers.push(normalized);
    previousTributaryMouth = normalized.mouth.cell;
    console.info(`Tributaries: selected ${normalized.id} with ${normalized.riverCells.length} cells`);
  }

  map.rivers = rivers;
  map.drawOverlay = null;
  drawRivers(map.rivers, map, tributarySettings.color);
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
    const touchesSea = typedNeighbors(cell, "SEA").length > 0;
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
    if (typedNeighbors(cell, "SEA").length === 0) continue;
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

function compareTributaryMouths(a, b) {
  return compareCells(a.cell, b.cell) || compareCells(a.riverCell, b.riverCell);
}

function compareExitsFromMouthDesc(a, b, mouth) {
  const mouthCentroid = H.cellCentroid(mouth.cell);
  const aDistance = H.distance(H.cellCentroid(a), mouthCentroid);
  const bDistance = H.distance(H.cellCentroid(b), mouthCentroid);
  return bDistance - aDistance || compareCells(a, b);
}

function componentKey(component) {
  return component.map(cell => cell.id).sort().join("|");
}

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}
