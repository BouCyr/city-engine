import * as Nodes from "../data/nodes.mjs";
import {Map} from "../data/map.mjs";

export function scatterPoints(settings, map) {


  const points = settings.scatter.nb;
  const rng = settings.rng;
  const margin = settings.scatter.safeZone;
  const mapSize = settings.size;

  console.log("Scattering points", settings.scatter.nb);
  const result = new Map(settings)
  for(let i=0; i<points; i++) {
    const x = rng.between(margin, mapSize-margin);
    const y = rng.between(margin, mapSize-margin);
    const point = new Nodes.Poi(`POI${i}`, x,y)
    result.nodes.push(point);
  }

  return result;
}
