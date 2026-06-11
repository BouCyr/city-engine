import polygonClipping from "polygon-clipping";
import {TERRAIN_CLASS_LAND, TERRAIN_CLASS_RIVER, TERRAIN_CLASS_SEA, TERRAIN_LAND, TERRAIN_RIVER, TERRAIN_SEA} from "../constants.mjs";
import {orderedCellPoints} from "./cell.mjs";

export function AreaGroup(name, areas = []) {
  return {
    name,
    areas,
  };
}

export function Area(name, type, cells = [], drawFn = drawArea) {
  return {
    name,
    type,
    cells,
    draw: drawFn,
  };
}

export function drawArea(svg, groupElement = null) {
  const layer = groupElement ?? svg.getElementById("areas");
  if (!layer || this.cells.length === 0) return;

  const pathData = areaBoundaryPath(this.cells);
  if (!pathData) return;

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathData);
  path.setAttribute("class", `area terrain-${terrainClass(this.type)}`);
  path.setAttribute("fill-rule", "evenodd");
  const filterId = areaInnerBorderFilterId(this.type);
  if (filterId) {
    path.setAttribute("filter", `url(#${filterId})`);
  }
  layer.appendChild(path);

}

export function areaBoundaryPath(cells) {
  const polygons = (cells ?? [])
    .map(cellRing)
    .filter((ring) => ring.length >= 3)
    .map((ring) => [ring]);

  if (polygons.length === 0) return "";

  const geometry = polygons.length === 1
    ? polygons
    : polygonClipping.union(...polygons);

  return geometryToPath(geometry);
}

function cellRing(cell) {
  return cleanupRing((orderedCellPoints(cell) ?? []).map((point) => [point.x, point.y]));
}

function geometryToPath(geometry) {
  const paths = [];

  for (const polygon of geometry ?? []) {
    for (const ring of polygon ?? []) {
      const cleaned = cleanupRing(ring);
      if (cleaned.length < 3) continue;
      paths.push(`M ${cleaned.map(([x, y]) => `${x} ${y}`).join(" L ")} Z`);
    }
  }

  return paths.join(" ");
}

function cleanupRing(ring) {
  const unique = [];

  for (const point of ring ?? []) {
    if (!point) continue;
    if (unique.length === 0 || !samePair(unique[unique.length - 1], point)) {
      unique.push([point[0], point[1]]);
    }
  }

  if (unique.length > 1 && samePair(unique[0], unique[unique.length - 1])) {
    unique.pop();
  }

  return unique;
}

function terrainClass(type) {
  if (type === TERRAIN_SEA) return TERRAIN_CLASS_SEA;
  if (type === TERRAIN_RIVER) return TERRAIN_CLASS_RIVER;
  return TERRAIN_CLASS_LAND;
}

function areaInnerBorderFilterId(type) {
  if (type === TERRAIN_SEA) return "area-inner-border-sea";
  if (type === TERRAIN_LAND) return "area-inner-border-land";
  return null;
}

function samePair(a, b) {
  return Math.abs(a[0] - b[0]) <= 1e-9 && Math.abs(a[1] - b[1]) <= 1e-9;
}
