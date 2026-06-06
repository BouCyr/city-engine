import {cloneDeepKeepFunctions} from "../data/clone.mjs";
import {orderedCellPoints} from "../data/cell.mjs";
import {Edge} from "../data/edge.mjs";
import * as H from "../data/helper.mjs";
import {Node} from "../data/nodes.mjs";
import {TERRAIN_COAST, TERRAIN_LAND, TERRAIN_SEA} from "./004-sea-land.mjs";

export const COAST_EDGE_TYPE = "coast";
export const COAST_GAP_FLAG = "COAST_GAP";
export const FIXED_FLAG = "FIXED";
export const TARGET_COAST_SEGMENT_LENGTH = 10;

const GAP_SIZE = 10;
const FIXED_COLOR = "#ef4444";
const VIOLET_COLOR = "#8b5cf6";
const COAST_COLOR = "var(--coast-edge)";

export function smoothCoast(settings, map) {
  const context = createSmoothCoastContext(map);
  correctSingularCoastNodes(context);
  refreshCoastEdges(map);
  context.coastEdges = map.edges.filter(isSmoothableCoastEdge);
  if (context.coastEdges.length === 0) return map;

  bisectCoastEdges(context);
  sampleCoastEdges(context);
  const plan = planBezierMoves(map);
  applyBezierMoves(plan.moves);
  return map;
}

export function createReplay(settings, inputMap) {
  const map = cloneDeepKeepFunctions(inputMap);
  const context = createSmoothCoastContext(map);
  const frames = [];

  const singular = findSingularCoastNodes(map);
  frames.push(replayFrame(
    map,
    "Singular coast nodes",
    "Land cells that touch only at a point are detected before smoothing.",
    overlayWithPoints(redPoints(singular.map(entry => entry.node)))
  ));

  correctSingularCoastNodes(context);
  refreshCoastEdges(map);
  context.coastEdges = map.edges.filter(isSmoothableCoastEdge);
  frames.push(replayFrame(
    map,
    "Sea gap edges",
    "Small coast edges are inserted between separated land corners to open a sea gap.",
    {
      ...emptyCoastOverlay(),
      lines: redGapLines(context.gapEdges),
      points: redPoints(context.singularNodes),
    }
  ));

  if (context.coastEdges.length === 0) return {frames};

  bisectCoastEdges(context);
  frames.push(replayFrame(
    map,
    "Edge bisection",
    "Coast edges are split at fixed midpoint anchors before regular sampling.",
    emptyCoastOverlay()
  ));

  frames.push(replayFrame(
    map,
    "Fixed points",
    "Fixed coast anchors are displayed in red. These points remain in place.",
    overlayWithPoints(redPoints(context.fixedNodes))
  ));

  sampleCoastEdges(context);
  frames.push(replayFrame(
    map,
    "Edge sampling",
    `Coast sections are subdivided into segments closest to ${TARGET_COAST_SEGMENT_LENGTH} units. Added sample nodes are shown in violet.`,
    overlayWithPoints([...redPoints(context.fixedNodes), ...violetPoints(context.sampleNodes)])
  ));

  const plan = planBezierMoves(map);
  frames.push(replayFrame(
    map,
    "Target Bezier",
    "Thin violet curves show the target quadratic Bezier spans between fixed coast anchors.",
    {
      ...overlayWithPoints([...redPoints(context.fixedNodes), ...violetPoints(context.sampleNodes)]),
      paths: plan.paths,
    }
  ));

  frames.push(replayFrame(
    map,
    "Node movement",
    "Violet guide lines connect each current sample point to its destination on the target coast curve.",
    {
      ...overlayWithPoints([...redPoints(context.fixedNodes), ...violetPoints(context.sampleNodes)]),
      paths: plan.paths,
      lines: movementLines(plan.moves),
    }
  ));

  applyBezierMoves(plan.moves);
  frames.push(replayFrame(
    map,
    "Smoothed coast",
    "Sample nodes have been moved onto the target curves, producing the final smoothed coast.",
    {
      ...overlayWithPoints([...redPoints(context.fixedNodes), ...violetPoints(context.sampleNodes)]),
      paths: finalCoastPaths(map),
    }
  ));

  return {frames};
}

function createSmoothCoastContext(map) {
  refreshCoastEdges(map);
  return {
    map,
    coastEdges: map.edges.filter(isSmoothableCoastEdge),
    fixedNodes: [],
    sampleNodes: [],
    singularNodes: [],
    gapEdges: [],
  };
}

function refreshCoastEdges(map) {
  for (const edge of map.edges) {
    if (edge.flags?.has(TERRAIN_COAST) || edge.flags?.has(COAST_GAP_FLAG)) {
      edge.type = COAST_EDGE_TYPE;
      setTerrainEdgeDraw(edge);
    }
  }
}

function correctSingularCoastNodes(context) {
  for (const entry of findSingularCoastNodes(context.map)) {
    context.singularNodes.push(entry.node);
    const replacements = [];
    for (const component of entry.components) {
      const replacement = createComponentNode(context.map, entry.node, component);
      replacements.push(replacement);
      rewireComponentNode(context.map, entry.node, replacement, component);
    }
    context.gapEdges.push(...createGapEdges(context.map, entry.node, replacements));
  }
}

function findSingularCoastNodes(map) {
  return map.nodes
    .map((node) => ({node, components: landComponentsAtNode(map, node)}))
    .filter(({components}) => components.length > 1);
}

function landComponentsAtNode(map, node) {
  const landCells = map.cells.filter((cell) => cell.type === TERRAIN_LAND && cellUsesNode(cell, node));
  const remaining = new Set(landCells);
  const components = [];

  while (remaining.size > 0) {
    const first = [...remaining].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
    const component = [];
    const queue = [first];
    remaining.delete(first);

    while (queue.length > 0) {
      const current = queue.shift();
      component.push(current);
      for (const other of [...remaining]) {
        if (!H.cellsEdge(current, other)) continue;
        remaining.delete(other);
        queue.push(other);
      }
    }
    components.push(component);
  }

  return components;
}

function cellUsesNode(cell, node) {
  return orderedCellPoints(cell).includes(node);
}

function createComponentNode(map, source, component) {
  const target = averageCentroid(component);
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy) || 1;
  const node = Node(
    `coast-gap-node-${map.nodes.length}`,
    source.x + (dx / length) * GAP_SIZE,
    source.y + (dy / length) * GAP_SIZE,
    "coast"
  );
  map.nodes.push(node);
  return node;
}

function averageCentroid(cells) {
  const total = cells.reduce((sum, cell) => {
    const centroid = H.cellCentroid(cell);
    sum.x += centroid.x;
    sum.y += centroid.y;
    return sum;
  }, {x: 0, y: 0});
  return {
    x: total.x / cells.length,
    y: total.y / cells.length,
  };
}

function rewireComponentNode(map, source, replacement, component) {
  const componentSet = new Set(component);
  const affectedEdges = new Set();
  for (const cell of component) {
    for (const edge of cell.edges) {
      if (edge.start === source || edge.end === source) affectedEdges.add(edge);
    }
  }

  for (const edge of affectedEdges) {
    if (!componentSet.has(edge.leftCell) && !componentSet.has(edge.rightCell)) continue;
    source.edges?.delete(edge);
    if (edge.start === source) edge.start = replacement;
    if (edge.end === source) edge.end = replacement;
    replacement.edges.add(edge);
  }
}

function createGapEdges(map, source, replacements) {
  if (replacements.length < 2) return [];
  const ordered = [...replacements].sort((a, b) => Math.atan2(a.y - source.y, a.x - source.x) - Math.atan2(b.y - source.y, b.x - source.x));
  const edges = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const start = ordered[index];
    const end = ordered[(index + 1) % ordered.length];
    if (start === end) continue;
    const edge = Edge(`coast-gap-edge-${map.edges.length}`, start, end, COAST_EDGE_TYPE, null, [TERRAIN_SEA, COAST_GAP_FLAG]);
    setTerrainEdgeDraw(edge);
    edge.smoothCoastGap = true;
    map.edges.push(edge);
    edges.push(edge);
  }
  return edges;
}

function setTerrainEdgeDraw(edge) {
  edge.draw = function drawTerrainEdge(svg) {
    const layer = svg.getElementById("edges");
    if (!layer) return;

    const target = this;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${target.start.x} ${target.start.y} L ${target.end.x} ${target.end.y}`);
    if (target.flags?.has(TERRAIN_SEA)) {
      path.setAttribute("class", "edge terrain-sea");
    } else if (target.flags?.has(TERRAIN_COAST)) {
      path.setAttribute("class", "edge terrain-coast");
    } else {
      path.setAttribute("class", "edge terrain-land");
    }
    layer.appendChild(path);
  };
}

function bisectCoastEdges(context) {
  for (const edge of [...context.coastEdges].sort(compareEdges)) {
    if (!context.map.edges.includes(edge) || !isSmoothableCoastEdge(edge)) continue;
    const fixed = createFixedNode(context.map, edge, H.midpoint(edge.start, edge.end));
    context.fixedNodes.push(fixed);
    replaceEdgeReferences(context.map, edge, [
      createSampleEdge(edge, edge.start, fixed, "bisect-0"),
      createSampleEdge(edge, fixed, edge.end, "bisect-1"),
    ]);
  }
}

function sampleCoastEdges(context) {
  for (const edge of context.map.edges.filter(isSmoothableCoastEdge).sort(compareEdges)) {
    if (!context.map.edges.includes(edge)) continue;
    replaceEdgeReferences(context.map, edge, sampleSegment(context, edge));
  }
}

function createFixedNode(map, edge, point) {
  const node = Node(`coast-fixed-${map.nodes.length}`, point.x, point.y, "coast", null, [FIXED_FLAG]);
  node.smoothCoastGenerated = true;
  node.smoothCoastSourceEdgeId = edge.id;
  map.nodes.push(node);
  return node;
}

function sampleSegment(context, sourceEdge) {
  const length = H.edgeLength(sourceEdge);
  const count = Math.max(1, Math.round(length / TARGET_COAST_SEGMENT_LENGTH));
  const nodes = [sourceEdge.start];

  for (let step = 1; step < count; step += 1) {
    const t = step / count;
    const node = Node(
      `coast-sample-${context.map.nodes.length}`,
      sourceEdge.start.x + (sourceEdge.end.x - sourceEdge.start.x) * t,
      sourceEdge.start.y + (sourceEdge.end.y - sourceEdge.start.y) * t,
      "coast"
    );
    node.smoothCoastGenerated = true;
    node.smoothCoastSourceEdgeId = sourceEdge.id;
    context.map.nodes.push(node);
    context.sampleNodes.push(node);
    nodes.push(node);
  }

  nodes.push(sourceEdge.end);
  const edges = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    edges.push(createSampleEdge(sourceEdge, nodes[index], nodes[index + 1], `sample-${index}`));
  }
  return edges;
}

function createSampleEdge(sourceEdge, start, end, key) {
  const edge = Edge(`${sourceEdge.id}-smooth-${key}`, start, end, COAST_EDGE_TYPE, null, [...(sourceEdge.flags ?? [])]);
  setTerrainEdgeDraw(edge);
  edge.leftCell = sourceEdge.leftCell;
  edge.rightCell = sourceEdge.rightCell;
  edge.smoothCoastSourceEdgeId = sourceEdge.id;
  return edge;
}

function replaceEdgeReferences(map, edge, replacementEdges) {
  edge.start.edges?.delete(edge);
  edge.end.edges?.delete(edge);

  const edgeIndex = map.edges.indexOf(edge);
  if (edgeIndex >= 0) map.edges.splice(edgeIndex, 1, ...replacementEdges);
  else map.edges.push(...replacementEdges);

  for (const cell of [edge.leftCell, edge.rightCell].filter(Boolean)) {
    const index = cell.edges.indexOf(edge);
    if (index < 0) continue;
    const ordered = cellTraversesEdgeForward(cell, edge) ? replacementEdges : [...replacementEdges].reverse();
    cell.edges.splice(index, 1, ...ordered);
  }
}

function planBezierMoves(map) {
  const adjacency = buildAdjacency(map.edges.filter(isSmoothableCoastEdge));
  const paths = collectFixedNodePaths(adjacency);
  const moves = [];
  const curvePaths = [];

  for (const path of paths) {
    if (path.nodes.length < 3) continue;
    const start = path.nodes[0];
    const end = path.nodes.at(-1);
    const control = path.nodes.slice(1, -1).find((node) => !node.smoothCoastGenerated)
      ?? H.midpoint(start, end);
    const ratios = cumulativeRatios(path.nodes);
    curvePaths.push(bezierPath(start, control, end));

    for (let index = 1; index < path.nodes.length - 1; index += 1) {
      const node = path.nodes[index];
      if (node.flags?.has(FIXED_FLAG)) continue;
      moves.push({
        node,
        from: {x: node.x, y: node.y},
        to: quadraticBezier(start, control, end, ratios[index]),
      });
    }
  }

  return {
    moves,
    paths: curvePaths.map((d) => ({d, stroke: VIOLET_COLOR, strokeWidth: 2, opacity: 0.75})),
  };
}

function applyBezierMoves(moves) {
  for (const move of moves) {
    move.node.x = move.to.x;
    move.node.y = move.to.y;
  }
}

function buildAdjacency(edges) {
  const adjacency = new globalThis.Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.start)) adjacency.set(edge.start, []);
    if (!adjacency.has(edge.end)) adjacency.set(edge.end, []);
    adjacency.get(edge.start).push({node: edge.end, edge});
    adjacency.get(edge.end).push({node: edge.start, edge});
  }
  return adjacency;
}

function collectFixedNodePaths(adjacency) {
  const paths = [];
  const visitedEdges = new Set();
  const fixedNodes = [...adjacency.keys()].filter(node => node.flags?.has(FIXED_FLAG)).sort(compareNodes);

  for (const start of fixedNodes) {
    for (const neighbor of [...(adjacency.get(start) ?? [])].sort(compareAdjacencyEntries)) {
      if (visitedEdges.has(neighbor.edge)) continue;
      const path = walkToFixedNode(start, neighbor, adjacency, visitedEdges);
      if (path.nodes.at(-1)?.flags?.has(FIXED_FLAG)) paths.push(path);
    }
  }
  return paths;
}

function walkToFixedNode(start, first, adjacency, visitedEdges) {
  const nodes = [start, first.node];
  const edges = [first.edge];
  visitedEdges.add(first.edge);
  let previous = start;
  let current = first.node;

  while (!current.flags?.has(FIXED_FLAG)) {
    const next = (adjacency.get(current) ?? [])
      .filter(entry => entry.node !== previous)
      .sort(compareAdjacencyEntries)[0];
    if (!next || visitedEdges.has(next.edge)) break;
    visitedEdges.add(next.edge);
    edges.push(next.edge);
    nodes.push(next.node);
    previous = current;
    current = next.node;
  }
  return {nodes, edges};
}

function isSmoothableCoastEdge(edge) {
  return edge.type === COAST_EDGE_TYPE || edge.flags?.has(TERRAIN_COAST) || edge.flags?.has(COAST_GAP_FLAG);
}

function compareEdges(a, b) {
  return String(a.id).localeCompare(String(b.id));
}

function compareNodes(a, b) {
  return String(a.id).localeCompare(String(b.id));
}

function compareAdjacencyEntries(a, b) {
  return compareEdges(a.edge, b.edge) || compareNodes(a.node, b.node);
}

function cumulativeRatios(nodes) {
  const distances = [0];
  for (let index = 1; index < nodes.length; index += 1) {
    distances[index] = distances[index - 1] + H.distance(nodes[index - 1], nodes[index]);
  }
  const total = distances.at(-1) || 1;
  return distances.map(distance => distance / total);
}

function quadraticBezier(start, control, end, t) {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
    y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
  };
}

function cellTraversesEdgeForward(cell, edge) {
  const index = cell.edges.indexOf(edge);
  if (index < 0) return true;
  const previous = cell.edges[(index - 1 + cell.edges.length) % cell.edges.length];
  const next = cell.edges[(index + 1) % cell.edges.length];
  const previousNode = edge.start === previous.start || edge.start === previous.end ? edge.start : edge.end;
  const nextNode = edge.start === next.start || edge.start === next.end ? edge.start : edge.end;
  return previousNode === edge.start && nextNode === edge.end;
}

function replayFrame(map, label, text, overlay) {
  const frameMap = cloneDeepKeepFunctions(map);
  const frameOverlay = cloneOverlay(overlay);
  frameMap.drawOverlay = createOverlayDraw(frameOverlay);
  return {label, text, map: frameMap, overlay: frameOverlay};
}

function emptyCoastOverlay() {
  return {type: "rivers", polygons: [], arrows: [], lines: [], paths: [], points: []};
}

function cloneOverlay(overlay) {
  return {
    type: "rivers",
    polygons: (overlay.polygons ?? []).map(polygon => ({...polygon, points: (polygon.points ?? []).map(point => ({...point}))})),
    arrows: (overlay.arrows ?? []).map(arrow => ({...arrow})),
    lines: (overlay.lines ?? []).map(line => ({...line})),
    paths: (overlay.paths ?? []).map(path => ({...path})),
    points: (overlay.points ?? []).map(point => ({...point})),
  };
}

function overlayWithPoints(points) {
  return {...emptyCoastOverlay(), points};
}

function redPoints(nodes) {
  return uniqueNodes(nodes).map(node => ({x: node.x, y: node.y, r: 5, fill: FIXED_COLOR, stroke: "white", strokeWidth: 1.5, opacity: 1}));
}

function violetPoints(nodes) {
  return uniqueNodes(nodes).map(node => ({x: node.x, y: node.y, r: 3.5, fill: VIOLET_COLOR, stroke: "white", strokeWidth: 1, opacity: 0.95}));
}

function uniqueNodes(nodes) {
  return nodes.filter((node, index) => nodes.indexOf(node) === index);
}

function redGapLines(edges) {
  return edges.map(edge => ({
    x1: edge.start.x,
    y1: edge.start.y,
    x2: edge.end.x,
    y2: edge.end.y,
    stroke: FIXED_COLOR,
    strokeWidth: 4,
  }));
}

function movementLines(moves) {
  return moves.map(move => ({
    x1: move.from.x,
    y1: move.from.y,
    x2: move.to.x,
    y2: move.to.y,
    stroke: VIOLET_COLOR,
    strokeWidth: 1.5,
  }));
}

function finalCoastPaths(map) {
  return map.edges
    .filter(isSmoothableCoastEdge)
    .map(edge => ({
      d: `M ${edge.start.x} ${edge.start.y} L ${edge.end.x} ${edge.end.y}`,
      stroke: COAST_COLOR,
      strokeWidth: 2,
      opacity: 0.85,
    }));
}

function bezierPath(start, control, end) {
  return `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
}

function createOverlayDraw(overlay) {
  return function drawSmoothCoastOverlay(svg) {
    const layer = svg.getElementById("overlay");
    if (!layer) return;

    for (const line of overlay.lines ?? []) {
      const element = document.createElementNS("http://www.w3.org/2000/svg", "line");
      element.setAttribute("x1", line.x1);
      element.setAttribute("y1", line.y1);
      element.setAttribute("x2", line.x2);
      element.setAttribute("y2", line.y2);
      element.setAttribute("stroke", line.stroke);
      element.setAttribute("stroke-width", line.strokeWidth);
      layer.appendChild(element);
    }

    for (const path of overlay.paths ?? []) {
      const element = document.createElementNS("http://www.w3.org/2000/svg", "path");
      element.setAttribute("fill", "none");
      element.setAttribute("stroke", path.stroke);
      element.setAttribute("stroke-width", path.strokeWidth);
      element.setAttribute("stroke-opacity", path.opacity);
      element.setAttribute("d", path.d);
      layer.appendChild(element);
    }

    for (const point of overlay.points ?? []) {
      const element = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      element.setAttribute("cx", point.x);
      element.setAttribute("cy", point.y);
      element.setAttribute("r", point.r);
      element.setAttribute("fill", point.fill);
      element.setAttribute("stroke", point.stroke);
      element.setAttribute("stroke-width", point.strokeWidth);
      element.setAttribute("opacity", point.opacity);
      layer.appendChild(element);
    }
  };
}
