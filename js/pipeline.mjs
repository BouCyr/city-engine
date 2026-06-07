import {steps} from "./steps.mjs";
import {Map} from "./data/map.mjs";
import {cloneDeepKeepFunctions} from "./data/clone.mjs";
import {Area, AreaGroup} from "./data/area.mjs";
import {AREA_NAME_LAND, AREA_NAME_SEA, TERRAIN_LAND, TERRAIN_SEA} from "./constants.mjs";

export function runPipeline(settings, initialMap = new Map(settings), registeredSteps = steps) {
  let map = initialMap;
  const stepResults = [{
    step: "void",
    map: cloneDeepKeepFunctions(map),
  }];

  for (const step of registeredSteps) {
    console.info(step.title, "Starting");
    const stepSettings = {
      ...settings,
      rng: settings.createStepRng(step.title),
    };
    const beforeMetrics = collectMapMetrics(map);
    const startedAt = now();
    const stepMap = step.process(stepSettings, cloneDeepKeepFunctions(map));
    const durationMs = now() - startedAt;
    normalizeCellEdgeReferences(stepMap);
    rebuildTerrainAreaGroup(stepMap);

    stepResults.push({
      step: step.title,
      map: cloneDeepKeepFunctions(stepMap),
      metrics: {
        before: beforeMetrics,
        after: collectMapMetrics(stepMap),
        durationMs,
      },
    });
    map = stepMap;
    console.info(step.title, "Done");
  }

  return {map, stepResults};
}

function normalizeCellEdgeReferences(map) {
  if (!Array.isArray(map?.cells)) return;

  for (const cell of map.cells) {
    if (!Array.isArray(cell?.edges)) {
      cell.edges = [];
      continue;
    }

    cell.edges = cell.edges.filter(Boolean);
  }
}

function rebuildTerrainAreaGroup(map) {
  if (!Array.isArray(map?.cells)) return;
  const terrainGroup = Array.isArray(map.areas)
    ? map.areas.find((group) => group?.name === "terrain")
    : null;

  if (terrainGroup && hasRichTerrainAreas(terrainGroup)) {
    return;
  }

  const seaCells = [];
  const landCells = [];
  for (const cell of map.cells) {
    if (cell.type === TERRAIN_SEA) seaCells.push(cell);
    else if (cell.type === TERRAIN_LAND) landCells.push(cell);
  }
  if (!terrainGroup && seaCells.length === 0 && landCells.length === 0) return;

  const otherGroups = Array.isArray(map.areas)
    ? map.areas.filter((group) => group?.name !== "terrain")
    : [];

  map.areas = [
    ...otherGroups,
    AreaGroup("terrain", [
      Area(AREA_NAME_SEA, TERRAIN_SEA, seaCells),
      Area(AREA_NAME_LAND, TERRAIN_LAND, landCells),
    ]),
  ];
}

function hasRichTerrainAreas(terrainGroup) {
  return (terrainGroup?.areas ?? []).some((area) => area?.kind !== undefined);
}

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function collectMapMetrics(map) {
  return {
    nodes: collectEntityMetrics(map.nodes),
    edges: collectEntityMetrics(map.edges),
    cells: collectEntityMetrics(map.cells),
    areas: collectEntityMetrics(flattenAreas(map.areas)),
    rivers: collectEntityMetrics(map.rivers),
  };
}

function flattenAreas(areaGroups) {
  if (!Array.isArray(areaGroups)) return [];
  return areaGroups.flatMap((group) => Array.isArray(group?.areas) ? group.areas : []);
}

function collectEntityMetrics(entities) {
  if (!Array.isArray(entities)) {
    return {
      count: 0,
      types: {},
    };
  }

  return {
    count: entities.length,
    types: countTypes(entities),
  };
}

function countTypes(entities) {
  return entities.reduce((types, entity) => {
    if (!entity?.type) {
      return types;
    }

    types[entity.type] = (types[entity.type] ?? 0) + 1;
    return types;
  }, {});
}
