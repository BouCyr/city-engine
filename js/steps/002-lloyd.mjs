import {orderedCellPoints} from "../data/cell.mjs";
import {Map as CityMap} from "../data/map.mjs";
import {Poi} from "../data/nodes.mjs";
import {cells} from "./001-gather.mjs";

const EPSILON = 1e-7;

export function relax(settings, map) {
  const sitesMap = new CityMap(settings);

  map.cells.forEach((cell, index) => {
    const points = orderedCellPoints(cell);
    if (points.length < 3) return;

    const centroid = polygonCentroid(points);
    sitesMap.nodes.push(Poi(`POI${index}`, centroid.x, centroid.y));
  });

  return cells(settings, sitesMap);
}

function polygonCentroid(points) {
  let areaTwice = 0;
  let centroidX = 0;
  let centroidY = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = current.x * next.y - next.x * current.y;

    areaTwice += cross;
    centroidX += (current.x + next.x) * cross;
    centroidY += (current.y + next.y) * cross;
  }

  if (Math.abs(areaTwice) <= EPSILON) {
    return averagePoint(points);
  }

  return {
    x: centroidX / (3 * areaTwice),
    y: centroidY / (3 * areaTwice),
  };
}

function averagePoint(points) {
  const total = points.reduce((sum, point) => {
    sum.x += point.x;
    sum.y += point.y;
    return sum;
  }, {x: 0, y: 0});

  return {
    x: total.x / points.length,
    y: total.y / points.length,
  };
}
