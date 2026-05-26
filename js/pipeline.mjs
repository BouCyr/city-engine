import {steps} from "./steps.mjs";
import {Map} from "./data/map.mjs";
import {cloneDeepKeepFunctions} from "./data/clone.mjs";

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
    const replaySettings = {
      ...settings,
      rng: settings.createStepRng(step.title),
    };
    const beforeMetrics = collectMapMetrics(map);
    const startedAt = now();
    const stepMap = step.process(stepSettings, cloneDeepKeepFunctions(map));
    const durationMs = now() - startedAt;
    const replay = step.createReplay
      ? cloneReplay(step.createReplay(replaySettings, cloneDeepKeepFunctions(map)))
      : null;

    stepResults.push({
      step: step.title,
      map: cloneDeepKeepFunctions(stepMap),
      replay,
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

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function collectMapMetrics(map) {
  return {
    nodes: collectEntityMetrics(map.nodes),
    cells: collectEntityMetrics(map.cells),
    areas: collectEntityMetrics(map.areas),
  };
}

function cloneReplay(replay) {
  if (!replay?.frames) {
    return null;
  }

  return {
    ...replay,
    frames: replay.frames.map((frame) => ({
      ...frame,
      map: cloneDeepKeepFunctions(frame.map),
    })),
  };
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
