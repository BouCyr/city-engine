import {cloneDeepKeepFunctions} from "../data/clone.mjs";
import {Edge} from "../data/edge.mjs";
import * as H from "../data/helper.mjs";
import {Node} from "../data/nodes.mjs";

export const FIXED_FLAG = "FIXED";
export const RIVER_EDGE_TYPE = "river";
export const TARGET_RIVER_SEGMENT_LENGTH = 10;
const FIXED_COLOR = "#ef4444";
const VIOLET_COLOR = "#8b5cf6";
const RIVER_COLOR = "var(--sea-edge)";

function isPrimaryRiverEdge(edge) {
  return edge.riverRole === "PRIMARY" || edge.riverRole === "MAIN";
}

function isTributaryRiverEdge(edge) {
  return edge.riverRole && !isPrimaryRiverEdge(edge);
}

export function smoothRivers(settings, map) {
  return smoothRiversWithOptions(map, {
    shouldProcessEdge: () => true,
    keepMergeAnchors: true,
  });
}

export function smoothPrimaryRivers(settings, map) {
  return smoothRiversWithOptions(map, {
    shouldProcessEdge: isPrimaryRiverEdge,
    keepMergeAnchors: false,
  });
}

export function smoothTributariesRivers(settings, map) {
  return smoothRiversWithOptions(map, {
    shouldProcessEdge: isTributaryRiverEdge,
    keepMergeAnchors: true,
  });
}

export function createReplay(settings, inputMap) {
  return createSmoothRiversReplay(inputMap, {
    label: "Normal river edges",
    shouldProcessEdge: () => true,
    keepMergeAnchors: true,
    mergeText: "merge nodes are kept as fixed anchors",
  });
}

export function createPrimaryReplay(settings, inputMap) {
  return createSmoothRiversReplay(inputMap, {
    label: "Primary river edges",
    shouldProcessEdge: isPrimaryRiverEdge,
    keepMergeAnchors: false,
    mergeText: "no specific merge anchors are kept",
  });
}

export function createTributariesReplay(settings, inputMap) {
  return createSmoothRiversReplay(inputMap, {
    label: "Tributary river edges",
    shouldProcessEdge: isTributaryRiverEdge,
    keepMergeAnchors: true,
    mergeText: "merge nodes are kept as fixed anchors",
  });
}

function smoothRiversWithOptions(map, options) {
  const context = createSmoothRiverContext(map, options);
  if (context.riverEdges.length === 0) return map;

  bisectRiverEdges(context);
  sampleRiverEdges(context);
  const plan = planBezierMoves(context);
  applyBezierMoves(plan.moves);
  updateRiverTopologyEdges(map);
  return map;
}

function createSmoothRiversReplay(inputMap, options) {
  const map = cloneDeepKeepFunctions(inputMap);
  const context = createSmoothRiverContext(map, options);
  if (context.riverEdges.length === 0) {
    return {
      frames: [{
        label: "Edge bisection",
        text: `No ${options.label.toLowerCase()} are available to smooth.`,
        map,
      }],
    };
  }

  const frames = [];
  bisectRiverEdges(context);
  frames.push(replayFrame(
    map,
    "Edge bisection",
    `River topology edges are split at their midpoint; ${options.mergeText}.`,
    emptySmoothRiverOverlay()
  ));

  frames.push(replayFrame(
    map,
    "Fixed points",
    "Fixed anchors are displayed in red. These nodes stay in place while neighboring samples are moved.",
    overlayWithPoints(fixedPoints(context.fixedNodes))
  ));

  sampleRiverEdges(context);
  frames.push(replayFrame(
    map,
    "Edge sampling",
    `River sections are subdivided into segments closest to ${TARGET_RIVER_SEGMENT_LENGTH} units. Added sample nodes are shown in violet.`,
    overlayWithPoints([...fixedPoints(context.fixedNodes), ...samplePoints(context.sampleNodes)])
  ));

  const plan = planBezierMoves(context);
  frames.push(replayFrame(
    map,
    "Target Bezier",
    "Thin violet curves show the target quadratic Bezier spans between each pair of fixed anchors.",
    {
      ...overlayWithPoints([...fixedPoints(context.fixedNodes), ...samplePoints(context.sampleNodes)]),
      paths: plan.paths,
    }
  ));

  frames.push(replayFrame(
    map,
    "Node movement",
    "Violet guide lines connect each current sample point to its destination on the target curve.",
    {
      ...overlayWithPoints([...fixedPoints(context.fixedNodes), ...samplePoints(context.sampleNodes)]),
      paths: plan.paths,
      lines: movementLines(plan.moves),
    }
  ));

  applyBezierMoves(plan.moves);
  updateRiverTopologyEdges(map);
  frames.push(replayFrame(
    map,
    "Smoothed river",
    "Sample nodes have been moved onto the target curves, producing the final smoothed river path.",
    {
      ...overlayWithPoints([...fixedPoints(context.fixedNodes), ...samplePoints(context.sampleNodes)]),
      paths: finalRiverPaths(map),
    }
  ));

  return {frames};
}

function createSmoothRiverContext(map, options = {}) {
  const shouldProcessEdge = options.shouldProcessEdge ?? (() => true);
  const keepMergeAnchors = options.keepMergeAnchors ?? false;

  const riverEdges = map.edges.filter((edge) => edge.type === RIVER_EDGE_TYPE);
  return {
    map,
    riverEdges,
    shouldProcessEdge,
    keepMergeAnchors,
    mergeNodes: keepMergeAnchors ? findMergeNodes(riverEdges) : new globalThis.Set(),
    fixedNodes: [],
    sampleNodes: [],
  };
}

function bisectRiverEdges(context) {
  const {map, mergeNodes, fixedNodes, shouldProcessEdge, keepMergeAnchors} = context;
  const edgesToBisect = [...context.riverEdges].filter(shouldProcessEdge);

  for (const node of mergeNodes) {
    node.flags?.add(FIXED_FLAG);
    fixedNodes.push(node);
  }

  const plannedEdges = [...edgesToBisect].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const edge of plannedEdges) {
    if (!map.edges.includes(edge) || edge.type !== RIVER_EDGE_TYPE) continue;
    if (!shouldProcessEdge(edge)) continue;
    if (keepMergeAnchors && (mergeNodes.has(edge.start) || mergeNodes.has(edge.end))) continue;

    const fixed = createFixedNode(map, edge, H.midpoint(edge.start, edge.end));
    fixedNodes.push(fixed);
    replaceEdgeReferences(map, edge, [
      createSampleEdge(edge, edge.start, fixed, "bisect-0"),
      createSampleEdge(edge, fixed, edge.end, "bisect-1"),
    ]);
  }
}

function sampleRiverEdges(context) {
  const plannedEdges = mapRiverEdges(context.map, context.shouldProcessEdge);
  for (const edge of plannedEdges) {
    if (!context.map.edges.includes(edge) || edge.type !== RIVER_EDGE_TYPE) continue;
    replaceRiverEdgeWithSamples(context, edge);
  }
}

function findMergeNodes(riverEdges) {
  const degree = new globalThis.Map();
  for (const edge of riverEdges) {
    degree.set(edge.start, (degree.get(edge.start) ?? 0) + 1);
    degree.set(edge.end, (degree.get(edge.end) ?? 0) + 1);
  }

  return new Set(
    [...degree.entries()]
      .filter(([node, count]) => node.type === "river-junction" || count > 2)
      .map(([node]) => node)
  );
}

function replaceRiverEdgeWithSamples(context, edge) {
  const replacementEdges = sampleSegment(context, edge, edge.start, edge.end);
  replaceEdgeReferences(context.map, edge, replacementEdges);
}

function createFixedNode(map, edge, point) {
  const node = Node(`river-fixed-${map.nodes.length}`, point.x, point.y, "river", null, [FIXED_FLAG]);
  node.smoothRiverGenerated = true;
  node.smoothRiverSourceEdgeId = edge.id;
  map.nodes.push(node);
  return node;
}

function sampleSegment(context, sourceEdge, start, end) {
  const length = H.distance(start, end);
  const count = Math.max(1, Math.round(length / TARGET_RIVER_SEGMENT_LENGTH));
  const nodes = [start];

  for (let step = 1; step < count; step += 1) {
    const t = step / count;
    const node = Node(
      `river-sample-${context.map.nodes.length}`,
      start.x + (end.x - start.x) * t,
      start.y + (end.y - start.y) * t,
      "river"
    );
    node.smoothRiverGenerated = true;
    node.smoothRiverSourceEdgeId = sourceEdge.id;
    context.map.nodes.push(node);
    context.sampleNodes.push(node);
    nodes.push(node);
  }

  nodes.push(end);

  const edges = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    edges.push(createSampleEdge(sourceEdge, nodes[index], nodes[index + 1], `sample-${index}`));
  }
  return edges;
}

function createSampleEdge(sourceEdge, start, end, key) {
  const edge = Edge(`${sourceEdge.id}-smooth-${key}`, start, end, sourceEdge.type, sourceEdge.draw, [...(sourceEdge.flags ?? [])]);
  edge.leftCell = sourceEdge.leftCell;
  edge.rightCell = sourceEdge.rightCell;
  edge.riverId = sourceEdge.riverId ?? null;
  edge.riverRole = sourceEdge.riverRole ?? null;
  edge.smoothRiverSourceEdgeId = sourceEdge.id;
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

function planBezierMoves(context) {
  const adjacency = buildRiverAdjacency(context.map.edges.filter((edge) => edge.type === RIVER_EDGE_TYPE && context.shouldProcessEdge(edge)));
  const paths = collectFixedNodePaths(adjacency);
  const moves = [];
  const curvePaths = [];

  for (const path of paths) {
    if (path.nodes.length < 3) continue;
    const start = path.nodes[0];
    const end = path.nodes.at(-1);
    const control = path.nodes.slice(1, -1).find((node) => !node.smoothRiverGenerated)
      ?? H.midpoint(start, end);
    const ratios = cumulativeRatios(path.nodes);
    curvePaths.push(bezierPath(start, control, end));

    for (let index = 1; index < path.nodes.length - 1; index += 1) {
      const node = path.nodes[index];
      if (node.flags?.has(FIXED_FLAG)) continue;
      const point = quadraticBezier(start, control, end, ratios[index]);
      moves.push({
        node,
        from: {x: node.x, y: node.y},
        to: point,
      });
    }
  }

  return {
    moves,
    paths: curvePaths.map((d) => ({
      d,
      stroke: VIOLET_COLOR,
      strokeWidth: 2,
      opacity: 0.75,
    })),
  };
}

function applyBezierMoves(moves) {
  for (const move of moves) {
    move.node.x = move.to.x;
    move.node.y = move.to.y;
  }
}

function buildRiverAdjacency(riverEdges) {
  const adjacency = new globalThis.Map();
  for (const edge of riverEdges) {
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
  const fixedNodes = [...adjacency.keys()]
    .filter((node) => node.flags?.has(FIXED_FLAG))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  for (const start of fixedNodes) {
    const neighbors = [...(adjacency.get(start) ?? [])].sort(compareAdjacencyEntries);
    for (const neighbor of neighbors) {
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
      .filter((entry) => entry.node !== previous)
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

function compareAdjacencyEntries(a, b) {
  return String(a.edge.id).localeCompare(String(b.edge.id)) || String(a.node.id).localeCompare(String(b.node.id));
}

function cumulativeRatios(nodes) {
  const distances = [0];
  for (let index = 1; index < nodes.length; index += 1) {
    distances[index] = distances[index - 1] + H.distance(nodes[index - 1], nodes[index]);
  }
  const total = distances.at(-1) || 1;
  return distances.map((distance) => distance / total);
}

function quadraticBezier(start, control, end, t) {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
    y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
  };
}

function updateRiverTopologyEdges(map) {
  for (const river of map.rivers ?? []) {
    river.topologyEdges = map.edges.filter((edge) => edge.type === RIVER_EDGE_TYPE && edge.riverId === river.id);
  }
}

function mapRiverEdges(map, shouldProcessEdge = () => true) {
  return map.edges
    .filter((edge) => edge.type === RIVER_EDGE_TYPE && shouldProcessEdge(edge))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function replayFrame(map, label, text, overlay) {
  const frameMap = cloneDeepKeepFunctions(map);
  const frameOverlay = cloneSmoothRiverOverlay(overlay);
  frameMap.drawOverlay = createSmoothRiverOverlayDraw(frameOverlay);
  return {label, text, map: frameMap, overlay: frameOverlay};
}

function emptySmoothRiverOverlay() {
  return {
    type: "rivers",
    polygons: [],
    arrows: [],
    lines: [],
    paths: [],
    points: [],
  };
}

function cloneSmoothRiverOverlay(overlay) {
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
  return {
    ...emptySmoothRiverOverlay(),
    points,
  };
}

function fixedPoints(nodes) {
  return uniqueNodes(nodes).map((node) => ({
    x: node.x,
    y: node.y,
    r: 5,
    fill: FIXED_COLOR,
    stroke: "white",
    strokeWidth: 1.5,
    opacity: 1,
  }));
}

function samplePoints(nodes) {
  return uniqueNodes(nodes).map((node) => ({
    x: node.x,
    y: node.y,
    r: 3.5,
    fill: VIOLET_COLOR,
    stroke: "white",
    strokeWidth: 1,
    opacity: 0.95,
  }));
}

function uniqueNodes(nodes) {
  return nodes.filter((node, index) => nodes.indexOf(node) === index);
}

function movementLines(moves) {
  return moves.map((move) => ({
    x1: move.from.x,
    y1: move.from.y,
    x2: move.to.x,
    y2: move.to.y,
    stroke: VIOLET_COLOR,
    strokeWidth: 1.5,
  }));
}

function finalRiverPaths(map) {
  return (map.rivers ?? [])
    .map((river) => river.topologyEdges ?? [])
    .filter((edges) => edges.length > 0)
    .map((edges) => ({
      d: edgeChainPath(edges),
      stroke: RIVER_COLOR,
      strokeWidth: edges[0]?.riverRole === "PRIMARY" ? 12 : 8,
      opacity: 0.85,
    }));
}

function edgeChainPath(edges) {
  const nodes = orderedEdgeChainNodes(edges);
  return nodes.length > 0
    ? `M ${nodes[0].x} ${nodes[0].y} ${nodes.slice(1).map(node => `L ${node.x} ${node.y}`).join(" ")}`
    : "";
}

function orderedEdgeChainNodes(edges) {
  if (edges.length === 0) return [];
  const adjacency = buildRiverAdjacency(edges);
  const ends = [...adjacency.entries()]
    .filter(([, neighbors]) => neighbors.length === 1)
    .map(([node]) => node)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const start = ends[0] ?? edges[0].start;
  const nodes = [start];
  const used = new Set();
  let previous = null;
  let current = start;

  while (used.size < edges.length) {
    const next = (adjacency.get(current) ?? [])
      .filter((entry) => entry.node !== previous && !used.has(entry.edge))
      .sort(compareAdjacencyEntries)[0];
    if (!next) break;
    used.add(next.edge);
    nodes.push(next.node);
    previous = current;
    current = next.node;
  }
  return nodes;
}

function bezierPath(start, control, end) {
  return `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
}

function createSmoothRiverOverlayDraw(overlay) {
  return function drawSmoothRiverOverlay(svg) {
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

function cellTraversesEdgeForward(cell, edge) {
  const index = cell.edges.indexOf(edge);
  if (index < 0) return true;
  const previous = cell.edges[(index - 1 + cell.edges.length) % cell.edges.length];
  const next = cell.edges[(index + 1) % cell.edges.length];
  const previousNode = edge.start === previous.start || edge.start === previous.end ? edge.start : edge.end;
  const nextNode = edge.start === next.start || edge.start === next.end ? edge.start : edge.end;
  return previousNode === edge.start && nextNode === edge.end;
}
