import {cloneDeepKeepFunctions} from "../data/clone.mjs";
import {Area, AreaGroup} from "../data/area.mjs";
import {cellCentroid} from "../data/helper.mjs";
import {orderedCellPoints} from "../data/cell.mjs";
import {TERRAIN_COAST, TERRAIN_LAND, TERRAIN_SEA} from "./004-sea-land.mjs";

export const NEEDLE = "NEEDLE";
const NEEDLE_MARKER_RADIUS = 4;
const NEEDLE_MARKER_FILL = "#ff0000";
const NEEDLE_MARKER_STROKE = "#fff";
const NEEDLE_MARKER_STROKE_WIDTH = 1.2;
const NEEDLE_PREVIEW_MARKER_RADIUS = 15;
const NEEDLE_PREVIEW_SEA_STROKE = "#6d28d9";
const NEEDLE_PREVIEW_SEA_STROKE_WIDTH = 1.5;
const NEEDLE_PREVIEW_OPACITY = 0.55;

export function markNeedles(_settings, map) {
  const needleCells = detectNeedleCells(map);

  if (needleCells.length === 0) {
    return map;
  }

  for (const cell of needleCells) {
    cell.type = TERRAIN_SEA;
    cell.draw = drawNeedleMarker;
  }

  for (const cell of needleCells) {
    refreshTerrainFlags(cell, TERRAIN_SEA);
    cell.flags?.add?.(NEEDLE);
  }

  for (const edge of map.edges || []) {
    const terrain = classifyEdgeTerrain(edge);
    refreshTerrainFlags(edge, terrain);
    edge.draw = terrainEdgeDraw;
  }

  rebuildTerrainAreas(map);

  return map;
}

export function createReplay(_settings, inputMap) {
  const map = cloneDeepKeepFunctions(inputMap);
  const needleCellsByNode = detectNeedleCellsByNode(map);
  const needleCells = collectNeedleCells(needleCellsByNode);

  if (needleCells.length === 0) {
    return {
      frames: [{
        label: "No needles",
        text: "No SEA-LAND-SEA-LAND pattern was found on this map.",
        map: cloneDeepKeepFunctions(map),
      }],
    };
  }

  const needleNodes = new Set(Array.from(needleCellsByNode.keys()).map((node) => node.id));
  const needleCellIds = new Set(needleCells.map((cell) => cell.id));
  const frames = [
    replayFrame(map, "Needles found", "Needle nodes are shown with red preview dots.", createNeedleNodeOverlay(map, needleNodes)),
    replayFrame(
      map,
      "Needle cells to sea",
      "Needle cells are highlighted in violet before conversion.",
      createNeedleCellOverlay(map, needleCellIds),
    ),
  ];

  const finalMap = cloneDeepKeepFunctions(map);
  markNeedles(_settings, finalMap);
  frames.push({
    label: "Needles applied",
    text: "Needle cells are converted to SEA and terrain edges/areas are rebuilt.",
    map: finalMap,
  });

  return {frames};
}

function detectNeedleCells(map) {
  return collectNeedleCells(detectNeedleCellsByNode(map));
}

function detectNeedleCellsByNode(map) {
  const needleCellsById = new Map();

  for (const node of map.nodes || []) {
    const candidates = findNeedleLandCellsForNode(node);
    for (const cell of candidates) {
      const existing = needleCellsById.get(node) ?? new Map();
      existing.set(cell.id, cell);
      needleCellsById.set(node, existing);
    }
  }

  const detected = [];
  for (const [node, cellsById] of needleCellsById.entries()) {
    detected.push({node, cells: [...cellsById.values()]});
  }

  return detected;
}

function collectNeedleCells(detectedNeedleCellsByNode) {
  const needleCellsById = new Set();
  for (const entry of detectedNeedleCellsByNode) {
    for (const cell of entry.cells) {
      needleCellsById.add(cell);
    }
  }

  return [...needleCellsById];
}

function createNeedleNodeOverlay(map, needleNodeIds) {
  const nodeById = new Map(map.nodes.map((node) => [node.id, node]));

  return {
    type: "rivers",
    points: [...needleNodeIds]
      .map((nodeId) => {
        const node = nodeById.get(nodeId);
        if (!node) return null;

        return {
          x: node.x,
          y: node.y,
          r: NEEDLE_PREVIEW_MARKER_RADIUS,
          fill: NEEDLE_MARKER_FILL,
          stroke: NEEDLE_MARKER_STROKE,
          strokeWidth: NEEDLE_MARKER_STROKE_WIDTH,
          opacity: 1,
        };
      })
      .filter(Boolean),
    polygons: [],
    arrows: [],
    lines: [],
    paths: [],
  };
}

function createNeedleCellOverlay(map, needleCellIds) {
  return {
    type: "rivers",
    polygons: map.cells
      .filter((cell) => needleCellIds.has(cell.id))
      .map((cell) => ({
        points: orderedCellPoints(cell).map((point) => ({x: point.x, y: point.y})),
        fill: `rgba(139, 92, 246, ${NEEDLE_PREVIEW_OPACITY})`,
        stroke: NEEDLE_PREVIEW_SEA_STROKE,
        strokeWidth: NEEDLE_PREVIEW_SEA_STROKE_WIDTH,
      })),
    points: [],
    arrows: [],
    lines: [],
    paths: [],
  };
}

function replayFrame(map, label, text, overlay) {
  const frameMap = cloneDeepKeepFunctions(map);
  return {label, text, map: frameMap, overlay};
}

function findNeedleLandCellsForNode(node) {
  const sectors = sectorsAroundNode(node);
  if (sectors.length < 3) {
    return [];
  }

  const qualifying = sectors
    .filter((sector, index, all) => {
      if (sector.type !== TERRAIN_LAND) return false;
      const previous = all[(index - 1 + all.length) % all.length];
      const next = all[(index + 1) % all.length];
      return previous.type === TERRAIN_SEA && next.type === TERRAIN_SEA;
    })
    .map((sector) => sector.cell)
    .filter(Boolean);

  if (qualifying.length < 2) {
    return [];
  }

  return uniqueById(qualifying);
}

function sectorsAroundNode(node) {
  const sectors = [];
  const seenCellIds = new Set();

  for (const edge of node.edges || []) {
    const other = edge.start === node
      ? edge.end
      : edge.start;

    const edgeAngle = Math.atan2(other.y - node.y, other.x - node.x);
    const sides = [edge.leftCell, edge.rightCell].filter(Boolean);

    if (sides.length === 1) {
      sectors.push({type: TERRAIN_SEA, angle: edgeAngle});
    }

    for (const cell of sides) {
      if (seenCellIds.has(cell.id)) continue;
      sectors.push({
        type: cell.type,
        angle: sectorAngle(node, cell),
        cell,
      });
      seenCellIds.add(cell.id);
    }
  }

  return sectors.sort((a, b) => a.angle - b.angle);
}

function sectorAngle(node, cell) {
  const center = cellCentroid(cell);
  return Math.atan2(center.y - node.y, center.x - node.x);
}

function refreshTerrainFlags(entity, terrainType) {
  if (!(entity?.flags instanceof Set)) {
    entity.flags = new Set(Array.isArray(entity?.flags) ? entity.flags : []);
  }

  entity.flags.delete(TERRAIN_SEA);
  entity.flags.delete(TERRAIN_LAND);
  entity.flags.delete(TERRAIN_COAST);
  entity.flags.add(terrainType);
}

function classifyEdgeTerrain(edge) {
  const leftType = edge.leftCell?.type ?? TERRAIN_SEA;
  const rightType = edge.rightCell?.type ?? TERRAIN_SEA;

  if (leftType === rightType) {
    return leftType;
  }

  return TERRAIN_COAST;
}

function rebuildTerrainAreas(map) {
  const seaCells = [];
  const landCells = [];

  for (const cell of map.cells || []) {
    if (cell.type === TERRAIN_SEA) {
      seaCells.push(cell);
    } else if (cell.type === TERRAIN_LAND) {
      landCells.push(cell);
    }
  }

  const terrainGroup = AreaGroup("terrain", [
    Area("sea", TERRAIN_SEA, seaCells),
    Area("land", TERRAIN_LAND, landCells),
  ]);

  map.areas = (map.areas || []).filter((group) => group?.name !== "terrain");
  map.areas.push(terrainGroup);
}

function uniqueById(values) {
  const seen = new Set();
  const uniqueValues = [];

  for (const value of values) {
    if (seen.has(value.id)) continue;
    seen.add(value.id);
    uniqueValues.push(value);
  }

  return uniqueValues;
}

const drawNeedleMarker = function(svg) {
  const layer = svg?.getElementById?.("cells");
  if (!layer) return;

  const center = cellCentroid(this);
  const circle = svg?.createElementNS?.("http://www.w3.org/2000/svg", "circle");
  if (!circle) return;

  circle.setAttribute("cx", String(center.x));
  circle.setAttribute("cy", String(center.y));
  circle.setAttribute("r", String(NEEDLE_MARKER_RADIUS));
  circle.setAttribute("fill", NEEDLE_MARKER_FILL);
  circle.setAttribute("stroke", NEEDLE_MARKER_STROKE);
  circle.setAttribute("stroke-width", String(NEEDLE_MARKER_STROKE_WIDTH));
  layer.appendChild(circle);
};

function terrainEdgeDraw(svg) {
  const layer = svg?.getElementById?.("edges");
  if (!layer) return;

  const path = svg?.createElementNS?.("http://www.w3.org/2000/svg", "path");
  if (!path) return;

  path.setAttribute("d", `M ${this.start.x} ${this.start.y} L ${this.end.x} ${this.end.y}`);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", this.flags?.has(TERRAIN_COAST)
    ? "var(--coast-edge)"
    : this.flags?.has(TERRAIN_SEA)
      ? "var(--sea-edge)"
      : "var(--land-edge)");
  path.setAttribute("stroke-width", "var(--edge-stroke-width)");
  layer.appendChild(path);
}
