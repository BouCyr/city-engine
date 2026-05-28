import {orderedCellPoints} from "../data/cell.mjs";
import {cloneDeepKeepFunctions} from "../data/clone.mjs";
import {valueNoise2D} from "../data/noise.mjs";

export const TERRAIN_SEA = "SEA";
export const TERRAIN_LAND = "LAND";
export const TERRAIN_COAST = "COAST";
const EPSILON = 1e-7;
const HEATMAP_GRID_SIZE = 48;

const DEFAULT_COAST = {
  seaBorders: ["WEST"],
  threshold: 0.28,
  largeScale: 900,
  mediumScale: 350,
  smallScale: 120,
  largeAmplitude: 0.18,
  mediumAmplitude: 0.08,
  smallAmplitude: 0.03,
  extraNoise: [],
  sampleCount: 4,
  smoothingPasses: 1,
  smoothingBias: 0.52,
  artifactsMax: 1,
};

function toNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toNumberArray(value, fallback) {
  const numeric = toNumber(value, fallback);
  return Math.max(1, numeric);
}

function normalizeSeed(seed) {
  const source = toNumber(seed, 0);
  return (Math.floor(source * 2147483647) >>> 0);
}

function normalizeBorders(rawBorders) {
  const values = Array.isArray(rawBorders) ? rawBorders : Array.from(rawBorders || []);
  const normalized = new Set(values.map((value) => String(value).toLowerCase()));

  if (normalized.has("all")) {
    return new Set(["north", "south", "east", "west"]);
  }

  if (normalized.size === 0) {
    normalized.add("west");
  }

  return normalized;
}

function normalizeSettings(coastSettings) {
  const safeCoastSettings = coastSettings || {};
  return {
    ...DEFAULT_COAST,
    seaBorders: safeCoastSettings.seaBorders || DEFAULT_COAST.seaBorders,
    threshold: Math.max(0, Math.min(1, toNumber(safeCoastSettings.threshold, DEFAULT_COAST.threshold))),
    largeScale: toNumberArray(safeCoastSettings.largeScale, DEFAULT_COAST.largeScale),
    mediumScale: toNumberArray(safeCoastSettings.mediumScale, DEFAULT_COAST.mediumScale),
    smallScale: toNumberArray(safeCoastSettings.smallScale, DEFAULT_COAST.smallScale),
    largeAmplitude: toNumber(safeCoastSettings.largeAmplitude, DEFAULT_COAST.largeAmplitude),
    mediumAmplitude: toNumber(safeCoastSettings.mediumAmplitude, DEFAULT_COAST.mediumAmplitude),
    smallAmplitude: toNumber(safeCoastSettings.smallAmplitude, DEFAULT_COAST.smallAmplitude),
    sampleCount: Math.max(0, Math.floor(toNumber(safeCoastSettings.sampleCount, DEFAULT_COAST.sampleCount))),
    smoothingPasses: Math.max(0, Math.floor(toNumber(safeCoastSettings.smoothingPasses, DEFAULT_COAST.smoothingPasses))),
    smoothingBias: Math.max(0, Math.min(1, toNumber(safeCoastSettings.smoothingBias, DEFAULT_COAST.smoothingBias))),
    artifactsMax: Math.max(0, Math.floor(toNumber(safeCoastSettings.artifactsMax, DEFAULT_COAST.artifactsMax))),
    extraNoise: (safeCoastSettings.extraNoise || []).map((layer) => ({
      scale: toNumberArray(layer?.scale, DEFAULT_COAST.smallScale),
      amplitude: toNumber(layer?.amplitude, 0),
    })),
  };
}

function ensureSetFlags(entity) {
  if (!(entity.flags instanceof Set)) {
    entity.flags = new Set(Array.isArray(entity.flags) ? entity.flags : []);
  }
  return entity.flags;
}

function near(value, target) {
  return Math.abs(value - target) <= EPSILON;
}

function boundarySide(edge, size) {
  const start = edge.start;
  const end = edge.end;

  if (near(start.x, 0) && near(end.x, 0)) return "west";
  if (near(start.x, size) && near(end.x, size)) return "east";
  if (near(start.y, 0) && near(end.y, 0)) return "north";
  if (near(start.y, size) && near(end.y, size)) return "south";
  return null;
}

function edgeLength(edge) {
  const dx = edge.start.x - edge.end.x;
  const dy = edge.start.y - edge.end.y;
  return Math.hypot(dx, dy);
}

function toSigned(value) {
  return value * 2 - 1;
}

function coastLayersAt(point, size, seaBorders, params, seed) {
  const distances = [];

  if (seaBorders.has("north")) distances.push(point.y / size);
  if (seaBorders.has("south")) distances.push((size - point.y) / size);
  if (seaBorders.has("west")) distances.push(point.x / size);
  if (seaBorders.has("east")) distances.push((size - point.x) / size);

  const baseDistance = distances.length > 0 ? Math.min(...distances) : 1;

  const large = toSigned(valueNoise2D(point.x, point.y, params.largeScale, seed)) * params.largeAmplitude;
  const medium = toSigned(valueNoise2D(point.x, point.y, params.mediumScale, seed + 1)) * params.mediumAmplitude;
  const small = toSigned(valueNoise2D(point.x, point.y, params.smallScale, seed + 2)) * params.smallAmplitude;

  const extra = params.extraNoise.map((layer, index) => (
    toSigned(valueNoise2D(point.x, point.y, layer.scale, seed + index + 10)) * layer.amplitude
  ));
  const extraTotal = extra.reduce((sum, value) => sum + value, 0);

  return {
    distance: baseDistance,
    large,
    medium,
    small,
    extra,
    combined: baseDistance + large + medium + small + extraTotal,
  };
}

function fieldAt(point, size, seaBorders, params, seed) {
  return coastLayersAt(point, size, seaBorders, params, seed).combined;
}

function centerPoint(points) {
  if (points.length === 0) {
    return {x: 0, y: 0};
  }

  const total = points.reduce((acc, point) => {
    acc.x += point.x;
    acc.y += point.y;
    return acc;
  }, {x: 0, y: 0});

  return {x: total.x / points.length, y: total.y / points.length};
}

function sampleCell(points, edges, rng, randomSamples) {
  const samples = [];
  const center = centerPoint(points);

  samples.push(center);

  for (const edge of edges) {
    samples.push({
      x: (edge.start.x + edge.end.x) / 2,
      y: (edge.start.y + edge.end.y) / 2,
    });
  }

  for (let index = 0; index < randomSamples; index += 1) {
    if (points.length === 0) {
      samples.push(center);
      continue;
    }

    const aIndex = Math.floor((rng?.next?.() ?? 0.5) * points.length);
    const bIndex = (aIndex + 1) % points.length;
    const random01 = rng?.next?.() ?? 0.5;
    const random02 = rng?.next?.() ?? 0.5;

    const a = points[aIndex];
    const b = points[bIndex];
    const t = random01;
    const u = random02 * (1 - t);

    samples.push({
      x: center.x * (1 - t - u) + a.x * t + b.x * u,
      y: center.y * (1 - t - u) + a.y * t + b.y * u,
    });
  }

  return samples;
}

function inferMissingCellTerrain(edge, seaBorders, size) {
  const side = boundarySide(edge, size);
  if (!side) return TERRAIN_LAND;
  return seaBorders.has(side) ? TERRAIN_SEA : TERRAIN_LAND;
}

function neighborTerrain(cell, edge, seaBorders, size) {
  const other = edge.leftCell === cell
    ? edge.rightCell
    : edge.rightCell === cell
      ? edge.leftCell
      : null;

  if (other?.type) return other.type;
  return inferMissingCellTerrain(edge, seaBorders, size);
}

function classifyEdgeTerrain(edge, seaBorders, size) {
  if (!edge.leftCell || !edge.rightCell) {
    return edge.leftCell?.type || edge.rightCell?.type || inferMissingCellTerrain(edge, seaBorders, size);
  }

  const leftTerrain = edge.leftCell?.type || inferMissingCellTerrain(edge, seaBorders, size);
  const rightTerrain = edge.rightCell?.type || inferMissingCellTerrain(edge, seaBorders, size);

  if (leftTerrain === rightTerrain) return leftTerrain;
  return TERRAIN_COAST;
}

function touchesSeaBorder(cell, seaBorders, size) {
  const points = orderedCellPoints(cell);
  return points.some((point) => {
    if (seaBorders.has("west") && near(point.x, 0)) return true;
    if (seaBorders.has("east") && near(point.x, size)) return true;
    if (seaBorders.has("north") && near(point.y, 0)) return true;
    if (seaBorders.has("south") && near(point.y, size)) return true;
    return false;
  });
}

function removeTinyArtifacts(map, seaBorders, maxSize) {
  if (maxSize <= 0) {
    return;
  }

  const componentMax = Math.max(1, maxSize);
  const visited = new Set();

  for (const startCell of map.cells) {
    if (visited.has(startCell)) continue;

    const queue = [startCell];
    const component = [];
    visited.add(startCell);

    while (queue.length > 0) {
      const current = queue.pop();
      component.push(current);

      for (const edge of current.edges || []) {
        const neighbor = edge.leftCell === current
          ? edge.rightCell
          : edge.rightCell === current
            ? edge.leftCell
            : null;

        if (!neighbor || visited.has(neighbor) || neighbor.type !== current.type) continue;

        visited.add(neighbor);
        queue.push(neighbor);
      }
    }

    if (component.length <= componentMax && !component.some((cell) => touchesSeaBorder(cell, seaBorders, map.size))) {
      const replacement = component[0].type === TERRAIN_SEA ? TERRAIN_LAND : TERRAIN_SEA;
      for (const cell of component) {
        cell.type = replacement;
      }
    }
  }
}

function setTerrainFlags(entity, terrain) {
  const flags = ensureSetFlags(entity);
  flags.delete(TERRAIN_SEA);
  flags.delete(TERRAIN_LAND);
  flags.delete(TERRAIN_COAST);
  flags.add(terrain);
}

function terrainClass(cell) {
  return cell.type === TERRAIN_SEA ? "sea" : "land";
}

function drawTerrainCell(svg) {
  const layer = svg.getElementById("cells");
  if (!layer) return;

  const points = orderedCellPoints(this).map((point) => `${point.x},${point.y}`).join(" ");
  const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  polygon.setAttribute("points", points);
  polygon.setAttribute("class", `cell terrain-${terrainClass(this)}`);
  layer.appendChild(polygon);
}

function drawTerrainEdge(svg) {
  const layer = svg.getElementById("edges");
  if (!layer) return;

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", `M ${this.start.x} ${this.start.y} L ${this.end.x} ${this.end.y}`);

  const flags = ensureSetFlags(this);
  if (flags.has(TERRAIN_COAST)) {
    path.setAttribute("class", "edge terrain-coast");
  } else if (flags.has(TERRAIN_SEA)) {
    path.setAttribute("class", "edge terrain-sea");
  } else {
    path.setAttribute("class", "edge terrain-land");
  }

  layer.appendChild(path);
}

export function classifySeaLand(settings, map) {
  return buildCoast(settings, map).map;
}

export function createReplay(settings, inputMap) {
  return buildCoast(settings, inputMap, {captureReplay: true}).replay;
}

export function renderExplanationExtras(panel, settings) {
  const params = normalizeSettings(settings?.coast);
  const seaBorders = Array.from(normalizeBorders(params.seaBorders))
    .map((border) => border.toUpperCase())
    .sort();
  const section = document.createElement("section");
  const heading = document.createElement("h4");
  const table = document.createElement("table");
  const tbody = document.createElement("tbody");

  section.className = "coast-settings-summary";
  heading.textContent = "Coast Settings";
  section.appendChild(heading);
  table.appendChild(tbody);

  appendSummaryRow(tbody, "Sea borders", seaBorders.join(", ") || "WEST");
  appendSummaryRow(tbody, "Land threshold", createThresholdSummary(params.threshold));
  appendSummaryRow(tbody, "Large noise", `${params.largeScale} scale, ${formatNumber(params.largeAmplitude)} amplitude`);
  appendSummaryRow(tbody, "Medium noise", `${params.mediumScale} scale, ${formatNumber(params.mediumAmplitude)} amplitude`);
  appendSummaryRow(tbody, "Small noise", `${params.smallScale} scale, ${formatNumber(params.smallAmplitude)} amplitude`);

  if (params.extraNoise.length > 0) {
    params.extraNoise.forEach((layer, index) => {
      appendSummaryRow(tbody, `Extra noise ${index + 1}`, `${layer.scale} scale, ${formatNumber(layer.amplitude)} amplitude`);
    });
  } else {
    appendSummaryRow(tbody, "Extra noise", "None");
  }

  appendSummaryRow(tbody, "Samples", `${params.sampleCount} extra per cell`);
  appendSummaryRow(tbody, "Smoothing", `${params.smoothingPasses} pass${params.smoothingPasses === 1 ? "" : "es"}, ${formatNumber(params.smoothingBias)} bias`);
  appendSummaryRow(tbody, "Artifact limit", `${params.artifactsMax} cell${params.artifactsMax === 1 ? "" : "s"}`);

  section.appendChild(table);
  panel.appendChild(section);
}

function buildCoast(settings, map, options = {}) {
  const params = normalizeSettings(settings?.coast);
  const seaBorders = normalizeBorders(params.seaBorders);
  const randomSamples = Math.max(0, Number(params.sampleCount) || 0);
  const passes = Math.max(0, Number(params.smoothingPasses) || 0);
  const noiseSeed = normalizeSeed(settings?.rng?.next?.() ?? 0.12);
  const frames = options.captureReplay ? [{
    label: "Before coast",
    text: "Coast starts from the pruned cell graph before any terrain is assigned.",
    map: cloneDeepKeepFunctions(map),
  }] : null;
  const samplePoints = [];

  if (frames) {
    pushFieldReplayFrames(frames, settings, map, seaBorders, params, noiseSeed);
  }

  map.cells.forEach((cell) => {
    const points = orderedCellPoints(cell);
    const samples = sampleCell(points, cell.edges || [], settings?.rng, randomSamples);
    samplePoints.push(...samples);
    const landSamples = samples.reduce((count, point) => (
      fieldAt(point, map.size, seaBorders, params, noiseSeed) >= params.threshold
        ? count + 1
        : count
    ), 0);

    const terrain = landSamples > (samples.length / 2) ? TERRAIN_LAND : TERRAIN_SEA;
    cell.type = terrain;
    setTerrainFlags(cell, terrain);
    cell.draw = drawTerrainCell;
  });

  pushTerrainFrame(frames, map, "Initial terrain", "Cells are classified from sampled field values before neighbor smoothing.", samplePoints);

  for (let pass = 0; pass < passes; pass += 1) {
    const nextTypes = new Map();

    for (const cell of map.cells) {
      let seaWeight = 0;
      let landWeight = 0;

      for (const edge of cell.edges || []) {
        const neighborType = neighborTerrain(cell, edge, seaBorders, map.size);
        const weight = edgeLength(edge);
        if (neighborType === TERRAIN_SEA) seaWeight += weight;
        else landWeight += weight;
      }

      const total = seaWeight + landWeight;
      if (total <= 0) {
        nextTypes.set(cell, cell.type);
        continue;
      }

      if (seaWeight > total * params.smoothingBias) nextTypes.set(cell, TERRAIN_SEA);
      else if (landWeight > total * params.smoothingBias) nextTypes.set(cell, TERRAIN_LAND);
      else nextTypes.set(cell, cell.type);
    }

    for (const [cell, terrain] of nextTypes) {
      cell.type = terrain;
      setTerrainFlags(cell, terrain);
    }

    pushTerrainFrame(
      frames,
      map,
      `Smoothing pass ${pass + 1} / ${passes}`,
      "Neighbor edge lengths vote cells toward the dominant adjacent terrain when the configured bias is exceeded.",
      samplePoints,
    );
  }

  removeTinyArtifacts(map, seaBorders, params.artifactsMax);
  pushTerrainFrame(frames, map, "Artifact cleanup", "Tiny isolated terrain components are flipped unless they touch a selected sea border.", samplePoints);

  for (const edge of map.edges) {
    const terrain = classifyEdgeTerrain(edge, seaBorders, map.size);
    setTerrainFlags(edge, terrain);
    edge.draw = drawTerrainEdge;
  }

  for (const cell of map.cells) {
    setTerrainFlags(cell, cell.type);
  }

  for (const node of map.nodes) {
    node.draw = null;
  }

  if (frames) {
    frames.push({
      label: "Final coast",
      text: "The final terrain map hides nodes and draws sea, land, and coast edges from the finished cell classification.",
      map: cloneDeepKeepFunctions(map),
    });
  }

  return {
    map,
    replay: frames ? {frames} : null,
  };
}

function appendSummaryRow(tbody, label, value) {
  const row = document.createElement("tr");
  const labelCell = document.createElement("th");
  const valueCell = document.createElement("td");

  labelCell.scope = "row";
  labelCell.textContent = label;

  if (typeof value === "string") {
    valueCell.textContent = value;
  } else {
    valueCell.appendChild(value);
  }

  row.append(labelCell, valueCell);
  tbody.appendChild(row);
}

function createThresholdSummary(threshold) {
  const wrapper = document.createElement("span");
  const value = document.createElement("span");
  const bar = document.createElement("span");
  const marker = document.createElement("span");

  wrapper.className = "coast-threshold-summary";
  value.textContent = formatNumber(threshold);
  bar.className = "coast-threshold-bar";
  marker.className = "coast-threshold-marker";
  marker.style.left = `${Math.max(0, Math.min(1, threshold)) * 100}%`;
  bar.appendChild(marker);
  wrapper.append(value, bar);
  return wrapper;
}

function pushFieldReplayFrames(frames, settings, map, seaBorders, params, noiseSeed) {
  const layers = [
    {
      label: "Sea border distance",
      text: "A base distance field measures how far each point is from the selected sea border set.",
      kind: "distance",
      signed: false,
    },
    {
      label: "Large noise",
      text: `Large noise bends the broad coastline at scale ${params.largeScale} with amplitude ${formatNumber(params.largeAmplitude)}.`,
      kind: "large",
      signed: true,
    },
    {
      label: "Medium noise",
      text: `Medium noise adds regional variation at scale ${params.mediumScale} with amplitude ${formatNumber(params.mediumAmplitude)}.`,
      kind: "medium",
      signed: true,
    },
    {
      label: "Small noise",
      text: `Small noise roughens the coast at scale ${params.smallScale} with amplitude ${formatNumber(params.smallAmplitude)}.`,
      kind: "small",
      signed: true,
    },
    ...params.extraNoise.map((layer, index) => ({
      label: `Extra noise ${index + 1}`,
      text: `Extra noise layer ${index + 1} contributes scale ${layer.scale} with amplitude ${formatNumber(layer.amplitude)}.`,
      kind: `extra:${index}`,
      signed: true,
    })),
    {
      label: "Combined field",
      text: `Distance and noise layers are added together; sampled values at or above ${formatNumber(params.threshold)} become land votes.`,
      kind: "combined",
      signed: false,
      threshold: params.threshold,
    },
  ];

  for (const layer of layers) {
    const frameMap = cloneDeepKeepFunctions(map);
    frameMap.drawOverlay = createCoastFieldOverlayDraw({
      size: settings.size,
      seaBorders,
      params,
      noiseSeed,
      layer,
    });
    frames.push({
      label: layer.label,
      text: layer.text,
      map: frameMap,
    });
  }
}

function pushTerrainFrame(frames, map, label, text, samplePoints) {
  if (!frames) return;

  const frameMap = cloneDeepKeepFunctions(map);
  frameMap.drawOverlay = createSamplePointsOverlayDraw(samplePoints);
  frames.push({label, text, map: frameMap});
}

function createCoastFieldOverlayDraw({size, seaBorders, params, noiseSeed, layer}) {
  const cells = createHeatmapCells(size, seaBorders, params, noiseSeed, layer);
  return function drawCoastFieldOverlay(svg) {
    const overlay = svg.getElementById("overlay");
    if (!overlay) return;

    for (const cell of cells) {
      appendRect(overlay, cell.x, cell.y, cell.width, cell.height, "coast-heatmap-cell", {
        fill: cell.fill,
        opacity: cell.opacity,
      });
    }

    appendSelectedBorderHighlights(overlay, size, seaBorders);
  };
}

function createSamplePointsOverlayDraw(samplePoints) {
  const points = samplePoints.map((point) => ({x: point.x, y: point.y}));
  return function drawSamplePointsOverlay(svg) {
    const overlay = svg.getElementById("overlay");
    if (!overlay) return;

    for (const point of points) {
      appendCircle(overlay, point.x, point.y, 3.5, "coast-sample-point");
    }
  };
}

function createHeatmapCells(size, seaBorders, params, noiseSeed, layer) {
  const grid = Math.max(1, HEATMAP_GRID_SIZE);
  const step = size / grid;
  const values = [];

  for (let yIndex = 0; yIndex < grid; yIndex += 1) {
    for (let xIndex = 0; xIndex < grid; xIndex += 1) {
      const point = {
        x: (xIndex + 0.5) * step,
        y: (yIndex + 0.5) * step,
      };
      const layers = coastLayersAt(point, size, seaBorders, params, noiseSeed);
      const value = valueForReplayLayer(layers, layer.kind);
      values.push({
        x: xIndex * step,
        y: yIndex * step,
        width: step + 0.75,
        height: step + 0.75,
        value,
      });
    }
  }

  const maxAbs = values.reduce((max, cell) => Math.max(max, Math.abs(cell.value)), 0) || 1;
  return values.map((cell) => ({
    ...cell,
    fill: heatmapFill(cell.value, layer, maxAbs),
    opacity: layer.signed ? 0.74 : 0.68,
  }));
}

function valueForReplayLayer(layers, kind) {
  if (kind.startsWith("extra:")) {
    return layers.extra[Number(kind.split(":")[1])] ?? 0;
  }

  return layers[kind] ?? 0;
}

function heatmapFill(value, layer, maxAbs) {
  if (layer.signed) {
    const intensity = Math.min(1, Math.abs(value) / maxAbs);
    const channel = Math.round(235 - intensity * 95);
    return value >= 0
      ? `rgb(${channel}, ${Math.round(170 - intensity * 55)}, 78)`
      : `rgb(54, ${Math.round(128 + intensity * 58)}, ${Math.round(185 + intensity * 48)})`;
  }

  if (Number.isFinite(layer.threshold)) {
    return value >= layer.threshold ? "rgb(180, 173, 112)" : "rgb(74, 147, 179)";
  }

  const normalized = Math.max(0, Math.min(1, value));
  const sea = Math.round(155 - normalized * 55);
  const land = Math.round(122 + normalized * 78);
  return `rgb(${sea}, ${land}, ${Math.round(180 - normalized * 82)})`;
}

function appendSelectedBorderHighlights(layer, size, seaBorders) {
  const strokeWidth = Math.max(8, size / 240);
  if (seaBorders.has("north")) appendLine(layer, 0, 0, size, 0, "coast-selected-border", strokeWidth);
  if (seaBorders.has("south")) appendLine(layer, 0, size, size, size, "coast-selected-border", strokeWidth);
  if (seaBorders.has("west")) appendLine(layer, 0, 0, 0, size, "coast-selected-border", strokeWidth);
  if (seaBorders.has("east")) appendLine(layer, size, 0, size, size, "coast-selected-border", strokeWidth);
}

function appendRect(layer, x, y, width, height, className, attrs = {}) {
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", x);
  rect.setAttribute("y", y);
  rect.setAttribute("width", width);
  rect.setAttribute("height", height);
  rect.setAttribute("class", className);
  for (const [key, value] of Object.entries(attrs)) {
    rect.setAttribute(key, value);
  }
  layer.appendChild(rect);
}

function appendLine(layer, x1, y1, x2, y2, className, strokeWidth) {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", x1);
  line.setAttribute("y1", y1);
  line.setAttribute("x2", x2);
  line.setAttribute("y2", y2);
  line.setAttribute("class", className);
  line.setAttribute("stroke-width", strokeWidth);
  layer.appendChild(line);
}

function appendCircle(layer, cx, cy, r, className) {
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", cx);
  circle.setAttribute("cy", cy);
  circle.setAttribute("r", r);
  circle.setAttribute("class", className);
  layer.appendChild(circle);
}

function formatNumber(value) {
  return Number(value).toLocaleString(undefined, {maximumFractionDigits: 3});
}
