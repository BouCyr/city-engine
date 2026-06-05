import {orderedCellPoints} from "./data/cell.mjs";
import {Area, AreaGroup, drawArea} from "./data/area.mjs";
import {Map as CityMap} from "./data/map.mjs";
import {Settings} from "./data/settings.mjs";
import {steps} from "./steps.mjs";

const TERRAIN_SEA = "SEA";
const TERRAIN_LAND = "LAND";
const TERRAIN_COAST = "COAST";
const GATHER_OVERLAY_COMPETITOR_LIMIT = 6;
const EPSILON = 1e-7;

export function plainSettings(settings) {
  return {
    seed: settings.seed,
    size: settings.size,
    scatter: {...settings.scatter},
    prune: {...settings.prune},
    coast: {...settings.coast},
    rivers: {...settings.rivers},
    tributaries: {...settings.tributaries},
  };
}

export function hydrateSettings(data) {
  const settings = new Settings(data?.seed);
  settings.size = data?.size ?? settings.size;
  settings.scatter = {...settings.scatter, ...(data?.scatter ?? {})};
  settings.prune = {...settings.prune, ...(data?.prune ?? {})};
  settings.coast = {...settings.coast, ...(data?.coast ?? {})};
  settings.rivers = {...settings.rivers, ...(data?.rivers ?? {})};
  settings.tributaries = {...settings.tributaries, ...(data?.tributaries ?? {})};
  return settings;
}

export function buildReplayPayload({settingsData, stepIndex, inputMapData}) {
  const settings = hydrateSettings(settingsData);
  const step = steps[stepIndex];
  if (!step?.createReplay) {
    return {frames: []};
  }

  const replaySettings = {
    ...settings,
    rng: settings.createStepRng(step.title),
  };
  const replay = step.createReplay(replaySettings, hydrateMap(inputMapData));
  return serializeReplay(replay);
}

export function serializeReplay(replay) {
  return {
    frames: (replay?.frames ?? []).map((frame) => ({
      label: frame.label,
      text: frame.text,
      overlay: frame.overlay ?? null,
      map: serializeMap(frame.map),
    })),
  };
}

export function hydrateReplay(data) {
  return {
    frames: (data?.frames ?? []).map((frame) => {
      const map = hydrateMap(frame.map);
      map.drawOverlay = hydrateOverlayDraw(frame.overlay);
      return {
        label: frame.label,
        text: frame.text,
        overlay: frame.overlay ?? null,
        map,
      };
    }),
  };
}

export function serializeMap(map) {
  return {
    size: map.size,
    nodes: map.nodes.map((node) => ({
      id: node.id,
      x: node.x,
      y: node.y,
      type: node.type,
      flags: Array.from(node.flags ?? []),
      draw: node.draw !== null,
    })),
    edges: map.edges.map((edge) => ({
      id: edge.id,
      startId: edge.start?.id ?? null,
      endId: edge.end?.id ?? null,
      type: edge.type,
      flags: Array.from(edge.flags ?? []),
      leftCellId: edge.leftCell?.id ?? null,
      rightCellId: edge.rightCell?.id ?? null,
      draw: edge.draw !== null,
    })),
    cells: map.cells.map((cell) => ({
      id: cell.id,
      type: cell.type,
      edgeIds: (cell.edges ?? []).map((edge) => edge.id),
      flags: Array.from(cell.flags ?? []),
      fill: cell.fill ?? null,
      draw: cell.draw !== null,
    })),
    areas: (map.areas ?? []).map((group) => ({
      name: group.name,
      areas: (group.areas ?? []).map((area) => ({
        name: area.name,
        type: area.type,
        cellIds: (area.cells ?? []).map((cell) => cell.id),
        draw: area.draw !== null,
      })),
    })),
    rivers: (map.rivers ?? []).map((river) => ({
      id: river.id,
      type: river.type,
      role: river.role ?? null,
      order: river.order,
      sourceRiverId: river.sourceRiverId ?? null,
      pathCost: river.pathCost ?? 0,
      mouthExitDistance: river.mouthExitDistance ?? 0,
      sourceExitDistance: river.sourceExitDistance ?? 0,
      riverCellIds: (river.riverCells ?? []).map((cell) => cell.id),
      mouth: river.mouth ? {
        cellId: river.mouth.cell?.id ?? null,
        seaCellId: river.mouth.seaCell?.id ?? null,
        riverCellId: river.mouth.riverCell?.id ?? null,
        riverExitPoint: river.mouth.riverExitPoint ? {...river.mouth.riverExitPoint} : null,
      } : null,
      originalMouthId: river.originalMouth?.id ?? null,
      exitId: river.exit?.id ?? null,
    })),
  };
}

export function hydrateMap(data) {
  const map = new CityMap({size: data?.size ?? 0});
  const nodeById = new globalThis.Map();
  const edgeById = new globalThis.Map();
  const cellById = new globalThis.Map();

  map.nodes = (data?.nodes ?? []).map((nodeData) => {
    const node = {
      id: nodeData.id,
      x: nodeData.x,
      y: nodeData.y,
      type: nodeData.type,
      flags: new Set(nodeData.flags ?? []),
      edges: new Set(),
      draw: nodeData.draw ? drawPoint : null,
    };
    nodeById.set(node.id, node);
    return node;
  });

  map.edges = (data?.edges ?? []).map((edgeData) => {
    const start = nodeById.get(edgeData.startId);
    const end = nodeById.get(edgeData.endId);
    const edge = {
      id: edgeData.id,
      start,
      end,
      type: edgeData.type,
      flags: new Set(edgeData.flags ?? []),
      leftCell: null,
      rightCell: null,
      draw: edgeData.draw ? drawForEdge(edgeData.flags ?? []) : null,
    };
    start?.edges?.add(edge);
    end?.edges?.add(edge);
    edgeById.set(edge.id, edge);
    return edge;
  });

  map.cells = (data?.cells ?? []).map((cellData) => {
    const cell = {
      id: cellData.id,
      type: cellData.type,
      edges: (cellData.edgeIds ?? []).map((id) => edgeById.get(id)).filter(Boolean),
      flags: new Set(cellData.flags ?? []),
      fill: cellData.fill,
      draw: cellData.draw ? drawForCell(cellData.type) : null,
    };
    cellById.set(cell.id, cell);
    return cell;
  });

  for (const edgeData of data?.edges ?? []) {
    const edge = edgeById.get(edgeData.id);
    if (!edge) continue;
    edge.leftCell = edgeData.leftCellId ? cellById.get(edgeData.leftCellId) ?? null : null;
    edge.rightCell = edgeData.rightCellId ? cellById.get(edgeData.rightCellId) ?? null : null;
  }

  map.areas = (data?.areas ?? []).map((groupData) => (
    AreaGroup(
      groupData.name,
      (groupData.areas ?? []).map((areaData) => (
        Area(
          areaData.name,
          areaData.type,
          (areaData.cellIds ?? []).map((id) => cellById.get(id)).filter(Boolean),
          areaData.draw ? drawArea : null,
        )
      )),
    )
  ));

  map.rivers = (data?.rivers ?? []).map((riverData) => ({
    id: riverData.id,
    type: riverData.type,
    role: riverData.role ?? null,
    order: riverData.order,
    sourceRiverId: riverData.sourceRiverId ?? null,
    pathCost: riverData.pathCost ?? 0,
    mouthExitDistance: riverData.mouthExitDistance ?? 0,
    sourceExitDistance: riverData.sourceExitDistance ?? 0,
    riverCells: (riverData.riverCellIds ?? []).map((id) => cellById.get(id)).filter(Boolean),
    mouth: riverData.mouth ? {
      cell: riverData.mouth.cellId ? cellById.get(riverData.mouth.cellId) ?? null : null,
      seaCell: riverData.mouth.seaCellId ? cellById.get(riverData.mouth.seaCellId) ?? null : null,
      riverCell: riverData.mouth.riverCellId ? cellById.get(riverData.mouth.riverCellId) ?? null : null,
      riverExitPoint: riverData.mouth.riverExitPoint ? {...riverData.mouth.riverExitPoint} : null,
    } : null,
    originalMouth: riverData.originalMouthId ? cellById.get(riverData.originalMouthId) ?? null : null,
    exit: riverData.exitId ? cellById.get(riverData.exitId) ?? null : null,
  }));

  return map;
}

export function hydrateOverlayDraw(overlay) {
  if (!overlay) {
    return null;
  }

  if (overlay.type === "gather") {
    return createGatherOverlayDraw(overlay);
  }

  if (overlay.type === "coast-field") {
    return createCoastFieldOverlayDraw(overlay);
  }

  if (overlay.type === "coast-centroids") {
    return createCoastCentroidOverlayDraw(overlay);
  }

  if (overlay.type === "rivers") {
    return createRiversOverlayDraw(overlay);
  }

  return null;
}

function drawPoint(svg) {
  const layer = svg.getElementById("nodes");
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", this.x);
  circle.setAttribute("cy", this.y);
  circle.setAttribute("r", "5");
  circle.setAttribute("fill", "#BBB");
  circle.setAttribute("stroke", "#CCC");
  circle.setAttribute("strokeWidth", "2");
  layer.appendChild(circle);
}

function drawDefaultEdge(svg) {
  const layer = svg.getElementById("edges");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", `M ${this.start.x} ${this.start.y} L ${this.end.x} ${this.end.y}`);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "#CCC");
  path.setAttribute("strokeWidth", "2");
  layer.appendChild(path);
}

function drawTerrainEdge(svg) {
  const layer = svg.getElementById("edges");
  if (!layer) return;

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", `M ${this.start.x} ${this.start.y} L ${this.end.x} ${this.end.y}`);

  if (this.flags.has(TERRAIN_COAST)) {
    path.setAttribute("class", "edge terrain-coast");
  } else if (this.flags.has(TERRAIN_SEA)) {
    path.setAttribute("class", "edge terrain-sea");
  } else {
    path.setAttribute("class", "edge terrain-land");
  }

  layer.appendChild(path);
}

function drawDefaultCell(svg) {
  const layer = svg.getElementById("cells");
  const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  const points = orderedCellPoints(this)
    .map(point => `${point.x},${point.y}`)
    .join(" ");

  polygon.setAttribute("class", "cell");
  polygon.setAttribute("points", points);
  polygon.setAttribute("stroke", "none");
  polygon.setAttribute("strokeWidth", "0");
  layer.appendChild(polygon);
}

function drawTerrainCell(svg) {
  const layer = svg.getElementById("cells");
  if (!layer) return;

  const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  polygon.setAttribute("points", orderedCellPoints(this).map((point) => `${point.x},${point.y}`).join(" "));
  polygon.setAttribute("class", `cell terrain-${this.type === TERRAIN_SEA ? "sea" : "land"}`);
  layer.appendChild(polygon);
}

function drawForEdge(flags) {
  return flags.includes(TERRAIN_SEA)
    || flags.includes(TERRAIN_LAND)
    || flags.includes(TERRAIN_COAST)
    ? drawTerrainEdge
    : drawDefaultEdge;
}

function drawForCell(type) {
  return type === TERRAIN_SEA || type === TERRAIN_LAND ? drawTerrainCell : drawDefaultCell;
}

function createGatherOverlayDraw({size, site, sites, polygon}) {
  const competitors = nearestCompetitors(site, sites, GATHER_OVERLAY_COMPETITOR_LIMIT);

  return function drawGatherOverlay(svg) {
    const layer = svg.getElementById("overlay");
    if (!layer) return;

    appendPolygon(layer, polygon, "gather-overlay-polygon");

    for (const competitor of competitors) {
      appendLine(layer, site, competitor, "gather-overlay-link");
      const segment = bisectorSegment(site, competitor, size);
      if (segment) appendLine(layer, segment.start, segment.end, "gather-overlay-bisector");
      appendCircle(layer, competitor.x, competitor.y, 9, "gather-overlay-competitor");
    }

    appendCircle(layer, site.x, site.y, 14, "gather-overlay-active-site");
  };
}

function createCoastFieldOverlayDraw({size, seaBorders, cells}) {
  const borders = new Set(seaBorders);
  return function drawCoastFieldOverlay(svg) {
    const layer = svg.getElementById("overlay");
    if (!layer) return;

    for (const cell of cells ?? []) {
      appendRect(layer, cell.x, cell.y, cell.width, cell.height, "coast-heatmap-cell", {
        fill: cell.fill,
        opacity: cell.opacity,
      });
    }

    appendSelectedBorderHighlights(layer, size, borders);
  };
}

function createCoastCentroidOverlayDraw({points}) {
  return function drawCoastCentroidOverlay(svg) {
    const layer = svg.getElementById("overlay");
    if (!layer) return;

    for (const point of points ?? []) {
      appendCircle(layer, point.x, point.y, 3.5, "coast-centroid-point");
    }
  };
}

function createRiversOverlayDraw({polygons = [], arrows = [], lines = [], paths = []}) {
  return function drawRiversOverlay(svg) {
    const layer = svg.getElementById("overlay");
    if (!layer) return;

    for (const polygon of polygons) {
      const element = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      element.setAttribute("points", (polygon.points ?? []).map(point => `${point.x},${point.y}`).join(" "));
      element.setAttribute("fill", polygon.fill);
      element.setAttribute("stroke", polygon.stroke);
      layer.appendChild(element);
    }

    for (const arrow of arrows) {
      appendRiverArrow(layer, arrow);
    }

    for (const line of lines) {
      const element = document.createElementNS("http://www.w3.org/2000/svg", "line");
      element.setAttribute("x1", line.x1);
      element.setAttribute("y1", line.y1);
      element.setAttribute("x2", line.x2);
      element.setAttribute("y2", line.y2);
      element.setAttribute("stroke", line.stroke);
      element.setAttribute("stroke-width", line.strokeWidth);
      layer.appendChild(element);
    }

    for (const path of paths) {
      const element = document.createElementNS("http://www.w3.org/2000/svg", "path");
      element.setAttribute("fill", "none");
      element.setAttribute("stroke", path.stroke);
      element.setAttribute("stroke-width", path.strokeWidth);
      element.setAttribute("stroke-opacity", path.opacity);
      element.setAttribute("d", path.d);
      layer.appendChild(element);
    }
  };
}

function appendRiverArrow(layer, arrow) {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", arrow.x1);
  line.setAttribute("y1", arrow.y1);
  line.setAttribute("x2", arrow.x2);
  line.setAttribute("y2", arrow.y2);
  line.setAttribute("stroke", arrow.stroke);
  line.setAttribute("stroke-width", arrow.strokeWidth);
  layer.appendChild(line);

  const head = riverArrowHead(arrow);
  if (!head) return;

  const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  polygon.setAttribute("points", head.map(point => `${point.x},${point.y}`).join(" "));
  polygon.setAttribute("fill", arrow.stroke);
  layer.appendChild(polygon);
}

function riverArrowHead({x1, y1, x2, y2}) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;

  const ux = dx / length;
  const uy = dy / length;
  const size = 16;
  const width = 9;
  const baseX = x2 - ux * size;
  const baseY = y2 - uy * size;
  const px = -uy * width;
  const py = ux * width;
  return [
    {x: x2, y: y2},
    {x: baseX + px, y: baseY + py},
    {x: baseX - px, y: baseY - py},
  ];
}

function nearestCompetitors(site, sites, limit) {
  return sites
    .filter(other => !samePoint(other, site))
    .map(other => ({site: other, distance: distanceSquared(site, other)}))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map(item => item.site);
}

function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function bisectorSegment(site, other, size) {
  const a = 2 * (other.x - site.x);
  const b = 2 * (other.y - site.y);
  const c = site.x * site.x + site.y * site.y - other.x * other.x - other.y * other.y;
  const points = [];

  if (Math.abs(b) > EPSILON) {
    addUniquePoint(points, {x: 0, y: -c / b}, size);
    addUniquePoint(points, {x: size, y: -(a * size + c) / b}, size);
  }

  if (Math.abs(a) > EPSILON) {
    addUniquePoint(points, {x: -c / a, y: 0}, size);
    addUniquePoint(points, {x: -(b * size + c) / a, y: size}, size);
  }

  if (points.length < 2) return null;
  return {start: points[0], end: points[1]};
}

function addUniquePoint(points, point, size) {
  if (point.x < -EPSILON || point.x > size + EPSILON || point.y < -EPSILON || point.y > size + EPSILON) {
    return;
  }

  const clamped = {
    x: clamp(point.x, size),
    y: clamp(point.y, size),
  };

  if (!points.some(existing => samePoint(existing, clamped))) {
    points.push(clamped);
  }
}

function samePoint(a, b) {
  return Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON;
}

function clamp(value, size) {
  if (Math.abs(value) <= EPSILON) return 0;
  if (Math.abs(value - size) <= EPSILON) return size;
  return value;
}

function appendSelectedBorderHighlights(layer, size, seaBorders) {
  const strokeWidth = Math.max(8, size / 240);
  if (seaBorders.has("north")) appendLine(layer, {x: 0, y: 0}, {x: size, y: 0}, "coast-selected-border", strokeWidth);
  if (seaBorders.has("south")) appendLine(layer, {x: 0, y: size}, {x: size, y: size}, "coast-selected-border", strokeWidth);
  if (seaBorders.has("west")) appendLine(layer, {x: 0, y: 0}, {x: 0, y: size}, "coast-selected-border", strokeWidth);
  if (seaBorders.has("east")) appendLine(layer, {x: size, y: 0}, {x: size, y: size}, "coast-selected-border", strokeWidth);
}

function appendPolygon(layer, polygon, className) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  element.setAttribute("class", className);
  element.setAttribute("points", polygon.map(point => `${point.x},${point.y}`).join(" "));
  layer.appendChild(element);
}

function appendLine(layer, start, end, className, strokeWidth = null) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", "line");
  element.setAttribute("class", className);
  element.setAttribute("x1", start.x);
  element.setAttribute("y1", start.y);
  element.setAttribute("x2", end.x);
  element.setAttribute("y2", end.y);
  if (strokeWidth !== null) {
    element.setAttribute("stroke-width", strokeWidth);
  }
  layer.appendChild(element);
}

function appendCircle(layer, cx, cy, radius, className) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  element.setAttribute("class", className);
  element.setAttribute("cx", cx);
  element.setAttribute("cy", cy);
  element.setAttribute("r", radius);
  layer.appendChild(element);
}

function appendRect(layer, x, y, width, height, className, attrs = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  element.setAttribute("x", x);
  element.setAttribute("y", y);
  element.setAttribute("width", width);
  element.setAttribute("height", height);
  element.setAttribute("class", className);
  for (const [key, value] of Object.entries(attrs)) {
    element.setAttribute(key, value);
  }
  layer.appendChild(element);
}
