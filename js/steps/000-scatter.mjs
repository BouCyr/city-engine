import * as Nodes from "../data/nodes.mjs";
import {Map} from "../data/map.mjs";
import {cloneDeepKeepFunctions} from "../data/clone.mjs";

export function scatterPoints(settings, map) {
  return buildScatter(settings).map;
}

export function createReplay(settings, inputMap) {
  const frames = [{
    label: "Before scatter",
    text: "The map starts with the incoming state before any points of interest are placed.",
    map: cloneDeepKeepFunctions(inputMap),
  }];

  buildScatter(settings, (scatterMap, pointIndex) => {
    frames.push({
      label: `Point ${pointIndex + 1} / ${settings.scatter.nb}`,
      text: `Point ${pointIndex + 1} is sampled from the Scatter step's deterministic random stream.`,
      map: cloneDeepKeepFunctions(scatterMap),
    });
  });

  return {frames};
}

function buildScatter(settings, afterPoint) {
  const points = settings.scatter.nb;
  const rng = settings.rng;
  const margin = settings.scatter.safeZone;
  const mapSize = settings.size;

  console.log("Scattering points", settings.scatter.nb);
  const result = new Map(settings);
  for (let i = 0; i < points; i++) {
    const x = rng.between(margin, mapSize - margin);
    const y = rng.between(margin, mapSize - margin);
    const point = new Nodes.Poi(`POI${i}`, x, y);
    result.nodes.push(point);
    afterPoint?.(result, i);
  }

  return {map: result};
}
