import assert from "node:assert/strict";
import {cloneDeepKeepFunctions} from "./data/clone.mjs";
import {Cell} from "./data/cell.mjs";
import {Edge} from "./data/edge.mjs";
import * as H from "./data/helper.mjs";
import {Map} from "./data/map.mjs";
import {Node, Poi} from "./data/nodes.mjs";
import {Settings} from "./data/settings.mjs";
import {runPipeline} from "./pipeline.mjs";
import {
  buildReplayPayload,
  hydrateMap,
  hydrateReplay,
  plainSettings,
  serializeMap,
  serializeReplay,
} from "./replay-service.mjs";
import {steps} from "./steps.mjs";
import {createReplay as createScatterReplay, scatterPoints} from "./steps/000-scatter.mjs";
import {cells, createReplay as createGatherReplay} from "./steps/001-gather.mjs";
import {relax} from "./steps/002-lloyd.mjs";
import {prune} from "./steps/003-prune.mjs";
import {classifySeaLand, coastLayersAt, createReplay as createCoastReplay, TERRAIN_COAST, TERRAIN_LAND, TERRAIN_SEA} from "./steps/004-sea-land.mjs";
import {computeRivers as computeLegacyRivers, MIN_EDGE_SIZE as LEGACY_MIN_EDGE_SIZE, selectRiver} from "./steps/005-rivers.mjs";
import {
  computeRivers as computeAStarRivers,
  createReplay as createAStarRiversReplay,
  drawRiver,
  findAStarPath,
  findBestAStarRiver,
  findMouthCandidates,
  meanderRiverCandidate,
  MIN_EDGE_SIZE,
  selectSelectedRiver,
} from "./steps/005.2-rivers.mjs";
import {computeTributaries, mouthThirdScore, selectTributary} from "./steps/006-tributaries.mjs";
import {computeRiverTopology} from "./steps/007-river-topology.mjs";

function createSvgProbe() {
  const calls = [];
  const layers = new globalThis.Map();
  globalThis.document = {
    createElementNS(namespace, name) {
      return {
        namespace,
        name,
        attrs: {},
        setAttribute(key, value) {
          this.attrs[key] = value;
        },
      };
    },
  };

  function getLayer(id) {
    if (!layers.has(id)) {
      layers.set(id, {
        id,
        innerHTML: "existing",
        appendChild(element) {
          calls.push({...element, layerId: id});
        },
      });
    }
    return layers.get(id);
  }

  return {
    calls,
    layers,
    svg: {
      getElementById(id) {
        return getLayer(id);
      },
      querySelector(selector) {
        return selector.startsWith("#") ? getLayer(selector.slice(1)) : null;
      },
    },
  };
}

function buildMapWithEdge() {
  const settings = new Settings();
  const map = new Map(settings);
  const first = Poi("first", 1, 2, null, ["gate"]);
  const second = Poi("second", 3, 4);
  map.nodes.push(first, second);
  map.edges.push(Edge("edge", first, second, "road", null, ["primary"]));
  return map;
}

function validateCloneIdentityAndFlags() {
  const map = buildMapWithEdge();
  const cloned = cloneDeepKeepFunctions(map);

  assert.equal(cloned.edges[0].start, cloned.nodes[0]);
  assert.equal(cloned.edges[0].end, cloned.nodes[1]);
  assert.ok(cloned.nodes[0].flags instanceof Set);
  assert.ok(cloned.edges[0].flags instanceof Set);
  assert.ok(cloned.nodes[0].flags.has("gate"));
  assert.ok(cloned.edges[0].flags.has("primary"));
}

function validateSnapshotDrawingUsesClonedNodes() {
  const map = buildMapWithEdge();
  const cloned = cloneDeepKeepFunctions(map);
  map.nodes[0].x = 99;

  const {calls, svg} = createSvgProbe();
  cloned.edges[0].draw(svg);
  assert.equal(calls[0].attrs.d, "M 1 2 L 3 4");
}

function validateClonePreservesCellToSeaReference() {
  const map = buildMapWithEdge();
  const [edge] = map.edges;
  const seaCell = Cell("sea", [edge]);
  const landCell = Cell("land", [edge]);
  seaCell.type = "SEA";
  landCell.type = "LAND";
  landCell.toSea = seaCell;
  edge.leftCell = seaCell;
  edge.rightCell = landCell;
  map.cells.push(seaCell, landCell);

  const cloned = cloneDeepKeepFunctions(map);

  assert.equal(cloned.cells[1].toSea, cloned.cells[0]);
}

function validatePipelineClonesBeforeSteps() {
  const settings = new Settings();
  const pipeline = [{
    title: "Mutate",
    process(stepSettings, map) {
      assert.ok(stepSettings.rng);
      map.nodes.push(Poi("mutated", 10, 20));
      return map;
    },
  }];

  const initialMap = new Map(settings);
  const {map, stepResults} = runPipeline(settings, initialMap, pipeline);

  assert.equal(initialMap.nodes.length, 0);
  assert.equal(stepResults[0].map.nodes.length, 0);
  assert.equal(stepResults[1].map.nodes.length, 1);
  assert.equal(stepResults[1].metrics.before.nodes.count, 0);
  assert.equal(stepResults[1].metrics.after.nodes.count, 1);
  assert.equal(stepResults[1].metrics.after.nodes.types.POI, 1);
  assert.equal(stepResults[1].metrics.before.cells.count, 0);
  assert.equal(stepResults[1].metrics.after.areas.count, 0);
  assert.equal(typeof stepResults[1].metrics.durationMs, "number");
  assert.ok(stepResults[1].metrics.durationMs >= 0);
  assert.equal(map.nodes.length, 1);
}

function validatePipelineSkipsReplayHotpath() {
  const settings = new Settings("pipeline-replay");
  const initialMap = new Map(settings);
  let replayCalled = false;
  const pipeline = [{
    title: "Replay",
    createReplay() {
      replayCalled = true;
      throw new Error("Replay must not run in runPipeline");
    },
    process(stepSettings, map) {
      map.nodes.push(Poi("processed", 10, 20));
      return map;
    },
  }];

  const {stepResults} = runPipeline(settings, initialMap, pipeline);

  assert.equal(initialMap.nodes.length, 0);
  assert.equal(stepResults[0].map.nodes.length, 0);
  assert.equal(stepResults[1].map.nodes.length, 1);
  assert.equal(stepResults[1].replay, undefined);
  assert.equal(replayCalled, false);
}

function validateScatterReplay() {
  const settings = new Settings("scatter-replay");
  settings.scatter.nb = 4;
  const inputMap = new Map(settings);
  const replay = createScatterReplay({
    ...settings,
    rng: settings.createStepRng("Scatter"),
  }, inputMap);
  const processed = scatterPoints({
    ...settings,
    rng: settings.createStepRng("Scatter"),
  }, inputMap);
  const finalReplayMap = replay.frames.at(-1).map;

  assert.equal(replay.frames.length, settings.scatter.nb + 1);
  assert.equal(replay.frames[0].map.nodes.length, 0);
  assert.equal(replay.frames[1].map.nodes.length, 1);
  assert.equal(finalReplayMap.nodes.length, processed.nodes.length);
  assert.deepEqual(
    finalReplayMap.nodes.map((node) => [node.id, node.x, node.y]),
    processed.nodes.map((node) => [node.id, node.x, node.y]),
  );
}

function validateStepRngDeterminism() {
  const settings = new Settings("same-seed");
  const firstScatter = settings.createStepRng("Scatter").next();
  const secondScatter = settings.createStepRng("Scatter").next();
  const gather = settings.createStepRng("Gather").next();

  assert.equal(firstScatter, secondScatter);
  assert.notEqual(firstScatter, gather);

  settings.createStepRng("Inserted").next();
  assert.equal(settings.createStepRng("Scatter").next(), firstScatter);
}

function validateGatherVoronoi() {
  const settings = new Settings("voronoi-test");
  const input = new Map(settings);
  input.nodes.push(
    Poi("A", 750, 750),
    Poi("B", 2250, 750),
    Poi("C", 1500, 2250),
  );

  const result = cells({
    ...settings,
    rng: settings.createStepRng("Gather"),
  }, input);

  assert.equal(result.cells.length, 3);
  assert.ok(result.nodes.length > 0);
  assert.ok(result.edges.length > 0);
  assert.ok(result.nodes.every(node => node.type === "Voronoi"));

  for (const edge of result.edges) {
    assert.ok(result.nodes.includes(edge.start));
    assert.ok(result.nodes.includes(edge.end));
    assert.ok(edge.start.edges.has(edge));
    assert.ok(edge.end.edges.has(edge));
    assert.ok(edge.leftCell || edge.rightCell);
  }

  for (const cell of result.cells) {
    assert.ok(cell.edges.length >= 3);
    assert.ok(cell.edges.every(edge => result.edges.includes(edge)));
  }

  assert.ok(result.nodes.some(node => node.flags.has("Boundary")));
  assert.ok(result.edges.some(edge => edge.flags.has("Boundary")));
}

function validateGatherReplay() {
  const settings = new Settings("gather-replay");
  const input = new Map(settings);
  input.nodes.push(
    Poi("A", 750, 750),
    Poi("B", 2250, 750),
    Poi("C", 1500, 2250),
  );

  const replay = createGatherReplay({
    ...settings,
    rng: settings.createStepRng("Gather"),
  }, input);
  const processed = cells({
    ...settings,
    rng: settings.createStepRng("Gather"),
  }, input);
  const finalReplayMap = replay.frames.at(-1).map;

  assert.equal(replay.frames.length, input.nodes.length + 1);
  assert.equal(replay.frames[0].label, "Before gather");
  assert.equal(replay.frames[0].map.nodes.length, input.nodes.length);
  assert.equal(replay.frames[0].map.cells.length, 0);
  assert.equal(replay.frames[1].map.cells.length, 1);
  assert.equal(replay.frames[2].map.cells.length, 2);
  assert.equal(finalReplayMap.cells.length, processed.cells.length);
  assert.equal(finalReplayMap.nodes.length, processed.nodes.length);
  assert.equal(finalReplayMap.edges.length, processed.edges.length);
  assert.deepEqual(
    finalReplayMap.nodes.map((node) => [node.id, Math.round(node.x * 1000), Math.round(node.y * 1000)]),
    processed.nodes.map((node) => [node.id, Math.round(node.x * 1000), Math.round(node.y * 1000)]),
  );

  const frameMap = replay.frames[1].map;
  const beforeCounts = {
    nodes: frameMap.nodes.length,
    edges: frameMap.edges.length,
    cells: frameMap.cells.length,
  };
  const {calls, layers, svg} = createSvgProbe();
  frameMap.drawOverlay(svg);

  assert.equal(frameMap.nodes.length, beforeCounts.nodes);
  assert.equal(frameMap.edges.length, beforeCounts.edges);
  assert.equal(frameMap.cells.length, beforeCounts.cells);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.layerId === "overlay"));
  assert.equal(layers.get("nodes"), undefined);
  assert.equal(layers.get("edges"), undefined);
  assert.equal(layers.get("cells"), undefined);
}

function validateMapClearClearsOverlay() {
  const settings = new Settings("clear-overlay");
  const map = new Map(settings);
  const {layers, svg} = createSvgProbe();
  map.clear(svg);

  assert.equal(layers.get("areas").innerHTML, "");
  assert.equal(layers.get("cells").innerHTML, "");
  assert.equal(layers.get("nodes").innerHTML, "");
  assert.equal(layers.get("edges").innerHTML, "");
  assert.equal(layers.get("overlay").innerHTML, "");
}

function validateCellDrawing() {
  const settings = new Settings("cell-draw-test");
  const input = new Map(settings);
  input.nodes.push(
    Poi("A", 750, 750),
    Poi("B", 2250, 750),
    Poi("C", 1500, 2250),
  );
  const result = cells({
    ...settings,
    rng: settings.createStepRng("Gather"),
  }, input);

  const {calls, svg} = createSvgProbe();
  result.cells[0].draw(svg);
  assert.equal(calls[0].name, "polygon");
  assert.ok(calls[0].attrs.points.length > 0);
  assert.equal(calls[0].attrs.class, "cell");
}

function validateLloydRelaxation() {
  const settings = new Settings("lloyd-test");
  const input = new Map(settings);
  input.nodes.push(
    Poi("A", 700, 700),
    Poi("B", 2300, 700),
    Poi("C", 1500, 2300),
  );
  const gathered = cells({
    ...settings,
    rng: settings.createStepRng("Gather"),
  }, input);
  const relaxed = relax({
    ...settings,
    rng: settings.createStepRng("Lloyd"),
  }, gathered);

  assert.equal(relaxed.cells.length, gathered.cells.length);
  assert.ok(relaxed.nodes.length > 0);
  assert.ok(relaxed.edges.length > 0);
  assert.ok(relaxed.nodes.every(node => node.type === "Voronoi"));
  assert.notDeepEqual(
    relaxed.nodes.map(node => [Math.round(node.x), Math.round(node.y)]),
    gathered.nodes.map(node => [Math.round(node.x), Math.round(node.y)]),
  );

  for (const edge of relaxed.edges) {
    assert.ok(relaxed.nodes.includes(edge.start));
    assert.ok(relaxed.nodes.includes(edge.end));
    assert.ok(edge.start.edges.has(edge));
    assert.ok(edge.end.edges.has(edge));
  }
}

function validatePruneRemovesAndRewires() {
  const settings = new Settings("prune-test");
  settings.prune.threshold = 50;
  const map = new Map(settings);

  const start = Poi("start", 10, 100);
  const middle = Poi("middle", 20, 100);
  const end = Poi("end", 10, 500);

  map.nodes.push(start, middle, end);
  const shortEdge = Edge("short", start, middle, "Voronoi", null, ["Boundary"]);
  const connectedEdge = Edge("connected", middle, end, "Voronoi", null, []);
  map.edges.push(shortEdge, connectedEdge);

  const result = prune(settings, map);

  assert.equal(result.edges.length, 1);
  const remaining = result.edges[0];
  assert.notEqual(remaining.start, start);
  assert.notEqual(remaining.start, middle);
  assert.equal(remaining.start, result.nodes.find((node) => node.id === "V3"));
  assert.equal(remaining.start.y, 100);
  assert.equal(remaining.start.x, 15);
  assert.equal(remaining.end, end);
  assert.equal(remaining.start.flags.size, 0);
}

function validatePruneCellDeletion() {
  const settings = new Settings("prune-cell-test");
  settings.prune.threshold = 50;
  const map = new Map(settings);

  const a = Poi("a", 20, 20);
  const b = Poi("b", 30, 20, null, ["Boundary"]);
  const c = Poi("c", 30, 30);
  const cell = {id: "cell", type: "Cell", edges: [], flags: new Set(), fill: null, draw: () => {}};

  const e1 = Edge("e1", a, b, "Voronoi");
  const e2 = Edge("e2", b, c, "Voronoi");
  const e3 = Edge("e3", c, a, "Voronoi");
  e1.leftCell = cell;
  e2.leftCell = cell;
  e3.leftCell = cell;
  cell.edges.push(e1, e2, e3);

  map.nodes.push(a, b, c);
  map.edges.push(e1, e2, e3);
  map.cells.push(cell);

  const result = prune(settings, map);

  assert.equal(result.cells.length, 0);
  assert.ok(result.edges.every(edge => edge.leftCell === null));
}

function validatePruneBoundaryRules() {
  const sameBoundarySettings = new Settings("prune-boundary");
  sameBoundarySettings.prune.threshold = 50;
  const sameBoundaryMap = new Map(sameBoundarySettings);
  const northA = Poi("northA", 10, 0);
  const northB = Poi("northB", 30, 0);
  sameBoundaryMap.nodes.push(northA, northB);
  sameBoundaryMap.edges.push(Edge("north-edge", northA, northB, "Voronoi", null, ["Boundary"]));

  const sameBoundaryResult = prune(sameBoundarySettings, sameBoundaryMap);
  const mergedSame = sameBoundaryResult.nodes.find((node) => ![northA, northB].includes(node));
  assert.equal(mergedSame.y, 0);
  assert.equal(mergedSame.x, 20);

  const adjacentSettings = new Settings("prune-adjacent");
  adjacentSettings.prune.threshold = 5000;
  const adjacentMap = new Map(adjacentSettings);
  const north = Poi("north", 200, 0);
  const east = Poi("east", adjacentSettings.size, 200);
  adjacentMap.nodes.push(north, east);
  adjacentMap.edges.push(Edge("adjacent", north, east, "Voronoi"));

  const adjacentResult = prune(adjacentSettings, adjacentMap);
  const mergedAdjacent = adjacentResult.nodes.find((node) => ![north, east].includes(node));
  assert.equal(mergedAdjacent.x, adjacentSettings.size);
  assert.equal(mergedAdjacent.y, 0);

  const oppositeSettings = new Settings("prune-opposite");
  oppositeSettings.prune.threshold = 5000;
  const oppositeMap = new Map(oppositeSettings);
  const northOpp = Poi("north-opp", 300, 0);
  const southOpp = Poi("south-opp", 320, oppositeSettings.size);
  oppositeMap.nodes.push(northOpp, southOpp);
  oppositeMap.edges.push(Edge("opp", northOpp, southOpp, "Voronoi"));
  assert.throws(() => prune(oppositeSettings, oppositeMap), /opposite boundaries/);
}

function createTwoCellCoastFixture(seed = "sea-land-test") {
  const settings = new Settings(seed);
  settings.coast = {
    ...settings.coast,
    seaBorders: ["WEST"],
    threshold: 0.28,
    largeScale: 900,
    mediumScale: 350,
    smallScale: 120,
    largeAmplitude: 0,
    mediumAmplitude: 0,
    smallAmplitude: 0,
    smoothingPasses: 0,
    artifactsMax: 0,
  };

  const map = new Map(settings);
  const n1 = Node("a", 0, 0, "split", null, ["Boundary"]);
  const n2 = Node("b", 1500, 0, "split", null, ["Boundary"]);
  const n3 = Node("c", 3000, 0, "split", null, ["Boundary"]);
  const n4 = Node("d", 3000, 3000, "split", null, ["Boundary"]);
  const n5 = Node("e", 1500, 3000, "split", null, ["Boundary"]);
  const n6 = Node("f", 0, 3000, "split", null, ["Boundary"]);
  map.nodes.push(n1, n2, n3, n4, n5, n6);

  const cellA = Cell("A", [], ["test"]);
  const cellB = Cell("B", [], ["test"]);

  const eTopA = Edge("eA_top", n1, n2, "Voronoi", null, ["Boundary"]);
  const eRightA = Edge("eA_right", n2, n5, "Voronoi", null, ["Boundary"]);
  const eBottomA = Edge("eA_bottom", n5, n6, "Voronoi", null, ["Boundary"]);
  const eLeftA = Edge("eA_left", n6, n1, "Voronoi", null, ["Boundary"]);
  const splitA = Edge("eA_split", n2, n5, "Voronoi", null);

  cellA.edges.push(eTopA, splitA, eBottomA, eLeftA);
  eTopA.leftCell = cellA;
  splitA.leftCell = cellA;
  eBottomA.leftCell = cellA;
  eLeftA.leftCell = cellA;

  const eTopB = Edge("eB_top", n2, n3, "Voronoi", null, ["Boundary"]);
  const eRightB = Edge("eB_right", n3, n4, "Voronoi", null, ["Boundary"]);
  const eBottomB = Edge("eB_bottom", n4, n5, "Voronoi", null, ["Boundary"]);
  const splitB = Edge("eB_split", n5, n2, "Voronoi", null);

  cellB.edges.push(eTopB, splitB, eBottomB, splitA);
  eTopB.leftCell = cellB;
  splitA.rightCell = cellB;
  eBottomB.leftCell = cellB;
  splitB.rightCell = cellB;

  map.cells.push(cellA, cellB);
  map.edges.push(eTopA, eRightA, eBottomA, eLeftA, splitA, eTopB, eRightB, eBottomB, splitB);

  return {settings, map, cellA, cellB};
}

function validateSeaLandStepClassifiesAndTags() {
  const {settings, map, cellA, cellB} = createTwoCellCoastFixture();
  const result = classifySeaLand({
    ...settings,
    rng: settings.createStepRng("Sea-Land"),
    coast: settings.coast,
  }, map);

  const seaLandCells = result.cells.filter((cell) => cell.type === TERRAIN_LAND || cell.type === TERRAIN_SEA);
  assert.equal(seaLandCells.length, result.cells.length);
  assert.ok(result.cells.every((cell) => cell.flags instanceof Set));
  assert.ok(result.cells.every((cell) => cell.flags.has(cell.type)));
  assert.ok(result.cells.every((cell) => cell.draw === null));

  const sharedEdge = result.edges.find((edge) =>
    (edge.leftCell === cellA && edge.rightCell === cellB) ||
    (edge.leftCell === cellB && edge.rightCell === cellA)
  );
  assert.ok(sharedEdge?.flags?.has(TERRAIN_COAST));
  assert.ok(
    (sharedEdge?.leftCell?.type === TERRAIN_SEA && sharedEdge?.rightCell?.type === TERRAIN_LAND) ||
    (sharedEdge?.leftCell?.type === TERRAIN_LAND && sharedEdge?.rightCell?.type === TERRAIN_SEA)
  );

  const boundaryEdge = result.edges.find((edge) =>
    edge.leftCell === cellA && edge.rightCell === null && edge.start?.x === 0 && edge.end?.x === 1500
  );
  assert.ok(boundaryEdge?.flags?.has(TERRAIN_SEA) || boundaryEdge?.flags?.has(TERRAIN_LAND));

  assert.ok(result.edges.every((edge) => edge.flags instanceof Set));
  assert.ok(result.edges.every((edge) =>
    edge.flags.has(TERRAIN_SEA) ||
    edge.flags.has(TERRAIN_LAND) ||
    edge.flags.has(TERRAIN_COAST)
  ));
  assert.equal(result.nodes.every((node) => node.draw === null), true);

  assert.equal(result.areas.length, 1);
  assert.equal(result.areas[0].name, "terrain");
  assert.equal(result.areas[0].areas.length, 2);
  assert.equal(result.areas[0].areas[0].name, "sea");
  assert.equal(result.areas[0].areas[1].name, "land");
  assert.equal(result.areas[0].areas[0].type, TERRAIN_SEA);
  assert.equal(result.areas[0].areas[1].type, TERRAIN_LAND);
  assert.ok(result.areas[0].areas[0].cells.every((cell) => result.cells.includes(cell)));
  assert.ok(result.areas[0].areas[1].cells.every((cell) => result.cells.includes(cell)));
}

function coastBiasTestSettings(seed = "coast-bias") {
  const settings = new Settings(seed);
  settings.size = 1000;
  settings.coast = {
    ...settings.coast,
    seaBorders: ["SOUTH", "EAST"],
    seaPercent: 0.25,
    distanceWeight: 1.35,
    edgeBias: 0.35,
    edgeBiasReach: 0.22,
    cornerBias: 0.55,
    cornerBiasReach: 0.70,
    largeAmplitude: 0,
    mediumAmplitude: 0,
    smallAmplitude: 0,
    smoothingPasses: 0,
    artifactsMax: 0,
  };
  return settings;
}

function validateCoastSeaCornerBiasField() {
  const settings = coastBiasTestSettings();
  const params = settings.coast;
  const seaBorders = new Set(["south", "east"]);
  const seed = 0;
  const field = (point) => coastLayersAt(point, settings.size, seaBorders, params, seed).combined;

  const southEastCorner = field({x: 950, y: 950});
  const eastMiddle = field({x: 950, y: 500});
  const northEastCorner = field({x: 950, y: 50});
  const inland = field({x: 500, y: 500});

  assert.ok(southEastCorner < eastMiddle);
  assert.ok(eastMiddle < northEastCorner);
  assert.ok(eastMiddle < inland);
}

function createCoastBiasGridFixture(seed = "coast-bias-grid") {
  const settings = coastBiasTestSettings(seed);
  const map = new Map(settings);
  const boundaries = [100, 300, 500, 700, 900];

  for (let yIndex = 0; yIndex < boundaries.length - 1; yIndex += 1) {
    for (let xIndex = 0; xIndex < boundaries.length - 1; xIndex += 1) {
      const x0 = boundaries[xIndex];
      const x1 = boundaries[xIndex + 1];
      const y0 = boundaries[yIndex];
      const y1 = boundaries[yIndex + 1];
      const id = `cell-${xIndex}-${yIndex}`;
      const topLeft = Node(`${id}-tl`, x0, y0, "grid");
      const topRight = Node(`${id}-tr`, x1, y0, "grid");
      const bottomRight = Node(`${id}-br`, x1, y1, "grid");
      const bottomLeft = Node(`${id}-bl`, x0, y1, "grid");
      map.nodes.push(topLeft, topRight, bottomRight, bottomLeft);

      const top = Edge(`${id}-top`, topLeft, topRight, "grid");
      const right = Edge(`${id}-right`, topRight, bottomRight, "grid");
      const bottom = Edge(`${id}-bottom`, bottomRight, bottomLeft, "grid");
      const left = Edge(`${id}-left`, bottomLeft, topLeft, "grid");
      const cell = Cell(id, [top, right, bottom, left]);
      top.leftCell = cell;
      right.leftCell = cell;
      bottom.leftCell = cell;
      left.leftCell = cell;
      map.edges.push(top, right, bottom, left);
      map.cells.push(cell);
    }
  }

  return {settings, map};
}

function validateCoastBiasClassificationKeepsSeaPercent() {
  const {settings, map} = createCoastBiasGridFixture();
  const result = classifySeaLand({
    ...settings,
    rng: settings.createStepRng("Coast"),
    coast: settings.coast,
  }, map);

  const seaCells = result.cells.filter((cell) => cell.type === TERRAIN_SEA);
  const southEastCell = result.cells.find((cell) => cell.id === "cell-3-3");
  const northEastCell = result.cells.find((cell) => cell.id === "cell-3-0");
  const northWestCell = result.cells.find((cell) => cell.id === "cell-0-0");

  assert.equal(seaCells.length, Math.floor(settings.coast.seaPercent * result.cells.length));
  assert.equal(southEastCell.type, TERRAIN_SEA);
  assert.equal(northEastCell.type, TERRAIN_LAND);
  assert.equal(northWestCell.type, TERRAIN_LAND);
}

function createGridTerrainFixture({width, height, sea = [], seed = "river-grid"}) {
  const settings = new Settings(seed);
  settings.size = Math.max(width, height) * 100;
  const map = new Map(settings);
  const seaKeys = new Set(sea.map(([x, y]) => `${x},${y}`));
  const nodes = [];
  for (let y = 0; y <= height; y += 1) {
    nodes[y] = [];
    for (let x = 0; x <= width; x += 1) {
      const boundary = x === 0 || y === 0 || x === width || y === height ? ["Boundary"] : [];
      const node = Node(`n-${x}-${y}`, x * 100, y * 100, "grid", null, boundary);
      nodes[y][x] = node;
      map.nodes.push(node);
    }
  }

  const edgeByKey = new globalThis.Map();
  function edgeBetween(a, b) {
    const key = [a.id, b.id].sort().join("|");
    if (!edgeByKey.has(key)) {
      const boundary = (a.x === b.x && (a.x === 0 || a.x === width * 100))
        || (a.y === b.y && (a.y === 0 || a.y === height * 100))
        ? ["Boundary"]
        : [];
      const edge = Edge(`e-${edgeByKey.size}`, a, b, "grid", null, boundary);
      edgeByKey.set(key, edge);
      map.edges.push(edge);
    }
    return edgeByKey.get(key);
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const top = edgeBetween(nodes[y][x], nodes[y][x + 1]);
      const right = edgeBetween(nodes[y][x + 1], nodes[y + 1][x + 1]);
      const bottom = edgeBetween(nodes[y + 1][x + 1], nodes[y + 1][x]);
      const left = edgeBetween(nodes[y + 1][x], nodes[y][x]);
      const cell = Cell(`c-${x}-${y}`, [top, right, bottom, left]);
      cell.type = seaKeys.has(`${x},${y}`) ? TERRAIN_SEA : TERRAIN_LAND;
      map.cells.push(cell);

      for (const edge of cell.edges) {
        if (!edge.leftCell) edge.leftCell = cell;
        else edge.rightCell = cell;
      }
    }
  }

  for (const edge of map.edges) {
    const left = edge.leftCell?.type;
    const right = edge.rightCell?.type;
    if (left === TERRAIN_SEA && right === TERRAIN_SEA) edge.flags.add(TERRAIN_SEA);
    else if (left === TERRAIN_LAND && (right === TERRAIN_LAND || !right)) edge.flags.add(TERRAIN_LAND);
    else if (right === TERRAIN_LAND && !left) edge.flags.add(TERRAIN_LAND);
    else if (left || right) edge.flags.add(TERRAIN_COAST);
  }

  return {settings, map};
}

function createTributaryFixture() {
  const {settings, map} = createGridTerrainFixture({
    width: 16,
    height: 7,
    sea: [[0, 3]],
    seed: "tributary-grid",
  });
  const byId = id => map.cells.find(cell => cell.id === id);
  const mainCells = [6, 5, 4, 3, 2, 1, 0].map(y => byId(`c-4-${y}`));
  map.rivers = [{
    id: "river-0",
    type: "MAIN",
    role: "PRIMARY",
    order: 0,
    sourceRiverId: null,
    riverCells: mainCells,
    mouth: {cell: mainCells[0], seaCell: byId("c-0-3")},
    originalMouth: mainCells[0],
    exit: mainCells.at(-1),
    pathCost: 0,
    mouthExitDistance: H.distance(H.cellCentroid(mainCells[0]), H.cellCentroid(mainCells.at(-1))),
  }];

  return {settings, map};
}

function validateRiversClassifyOpenAndInnerSeas() {
  const {settings, map} = createGridTerrainFixture({
    width: 8,
    height: 5,
    sea: [[0, 2], [3, 2]],
    seed: "river-seas",
  });

  const result = computeLegacyRivers({
    ...settings,
    rng: settings.createStepRng("Rivers"),
  }, map);
  const openSea = result.cells.find(cell => cell.id === "c-0-2");
  const innerSea = result.cells.find(cell => cell.id === "c-3-2");

  assert.equal(openSea.seaKind, "OPEN_SEA");
  assert.equal(innerSea.seaKind, "INNER_SEA");
  assert.ok(openSea.flags.has("OPEN_SEA"));
  assert.ok(innerSea.flags.has("INNER_SEA"));
}

function validateRiversComputeDistanceAndBanks() {
  const {settings, map} = createGridTerrainFixture({
    width: 8,
    height: 5,
    sea: [[0, 2], [3, 2]],
    seed: "river-banks",
  });

  const result = computeLegacyRivers({
    ...settings,
    rng: settings.createStepRng("Rivers"),
  }, map);
  const bankGroup = result.areas.find(group => group.name === "river-banks");
  const bankA = bankGroup?.areas.find(area => area.name === "BANK-A");
  const bankB = bankGroup?.areas.find(area => area.name === "BANK-B");
  const exitCandidates = result.cells.filter(cell => cell.type === TERRAIN_LAND && cell.edges.some(edge => edge.flags.has("Boundary")) && cell.seaD >= 5);

  assert.ok(exitCandidates.length > 0);
  assert.ok(bankA?.cells.length > 0);
  assert.ok(bankB?.cells.length > 0);
  assert.ok(bankA.cells.every(cell => result.cells.includes(cell)));
  assert.ok(bankB.cells.every(cell => result.cells.includes(cell)));
}

function validateRiversRejectShortEdges() {
  const {settings, map} = createGridTerrainFixture({
    width: 8,
    height: 5,
    sea: [[0, 2]],
    seed: "river-short-edge",
  });
  const firstLand = map.cells.find(cell => cell.id === "c-1-2");
  const nextLand = map.cells.find(cell => cell.id === "c-2-2");
  const shared = firstLand.edges.find(edge => edge.leftCell === nextLand || edge.rightCell === nextLand);
  shared.end.x = shared.start.x + LEGACY_MIN_EDGE_SIZE;
  shared.end.y = shared.start.y;

  const result = computeLegacyRivers({
    ...settings,
    rng: settings.createStepRng("Rivers"),
  }, map);
  const {calls, svg} = createSvgProbe();
  shared.draw(svg);

  assert.equal(calls[0].attrs.stroke, "red");
  assert.ok(result.cells.every(cell => cell !== firstLand || cell.seaD !== undefined));
}

function validateRiverSelectionFallsBackToNearestBankRatio() {
  const {map} = createGridTerrainFixture({
    width: 4,
    height: 3,
    sea: [],
    seed: "river-ratio-fallback",
  });
  const landmass = map.cells;
  const riverCells = [
    map.cells.find(cell => cell.id === "c-1-0"),
    map.cells.find(cell => cell.id === "c-1-1"),
    map.cells.find(cell => cell.id === "c-1-2"),
  ];

  const selected = selectRiver([{riverCells}], landmass);

  assert.ok(selected);
  assert.equal(selected.matchesBankRatio, false);
  assert.equal(selected.bankRatio, 0.25);
  assert.equal(selected.bankA.length, 3);
}

function setGridSeaD(map, seaDById) {
  for (const cell of map.cells) {
    cell.seaD = seaDById(cell);
    cell.cellToSea = cell.seaD;
  }
}

function sharedCellEdge(cellA, cellB) {
  return cellA.edges.find(edge => edge.leftCell === cellB || edge.rightCell === cellB);
}

function shortenSharedCellEdge(cellA, cellB) {
  const edge = sharedCellEdge(cellA, cellB);
  edge.end.x = edge.start.x + MIN_EDGE_SIZE;
  edge.end.y = edge.start.y;
  return edge;
}

function makeSharedCellEdgeShorterThanMinimum(cellA, cellB) {
  const edge = sharedCellEdge(cellA, cellB);
  edge.end.x = edge.start.x + MIN_EDGE_SIZE - 1;
  edge.end.y = edge.start.y;
  return edge;
}

function assertNoRepeatedRiverCells(candidate) {
  const ids = candidate.riverCells.map(cell => cell.id);
  assert.equal(new Set(ids).size, ids.length);
}

function validateAStarRiversRegisteredInPipeline() {
  const riverStep = steps.find(step => step.title === "Rivers");
  assert.equal(riverStep?.process, computeAStarRivers);
}

function validateAStarRiversComputeDistanceFromInnerSeas() {
  const {settings, map} = createGridTerrainFixture({
    width: 8,
    height: 5,
    sea: [[0, 2], [4, 2]],
    seed: "river-astar-inner-sea-distance",
  });

  const result = computeAStarRivers({
    ...settings,
    rng: settings.createStepRng("Rivers"),
  }, map);
  const innerSea = result.cells.find(cell => cell.id === "c-4-2");
  const innerAdjacentLand = result.cells.find(cell => cell.id === "c-5-2");

  assert.equal(innerSea.seaKind, "INNER_SEA");
  assert.equal(innerAdjacentLand.seaD, 1);
  assert.equal(innerAdjacentLand.toSea, innerSea);
}

function validateAStarRiversSeaDIgnoresMinimumEdgeSize() {
  const {settings, map} = createGridTerrainFixture({
    width: 8,
    height: 5,
    sea: [[0, 2]],
    seed: "river-astar-sead-short-edge",
  });
  const firstLand = map.cells.find(cell => cell.id === "c-1-2");
  const nextLand = map.cells.find(cell => cell.id === "c-2-2");
  makeSharedCellEdgeShorterThanMinimum(firstLand, nextLand);

  const result = computeAStarRivers({
    ...settings,
    rng: settings.createStepRng("Rivers"),
  }, map);

  assert.equal(firstLand.seaD, 1);
  assert.equal(nextLand.seaD, 2);
  assert.equal(result.cells.find(cell => cell.id === "c-2-2").seaD, 2);
}

function validateAStarRiverRejectsShortCoastMouthEdges() {
  const {map} = createGridTerrainFixture({
    width: 3,
    height: 3,
    sea: [[1, 1]],
    seed: "river-astar-short-mouth-edge",
  });
  const seaCell = map.cells.find(cell => cell.id === "c-1-1");
  const rejectedLandCell = map.cells.find(cell => cell.id === "c-2-1");
  makeSharedCellEdgeShorterThanMinimum(seaCell, rejectedLandCell);

  const mouths = findMouthCandidates(map, [{
    id: "sea-0",
    kind: "OPEN_SEA",
    cells: [seaCell],
  }]);

  assert.ok(mouths.length > 0);
  assert.equal(mouths.some(mouth => mouth.cell === rejectedLandCell), false);
  assert.ok(mouths.every(mouth => H.edgeLength(sharedCellEdge(mouth.seaCell, mouth.cell)) >= MIN_EDGE_SIZE));
}

function validateAStarRiverRejectsShortEdges() {
  const {map} = createGridTerrainFixture({
    width: 2,
    height: 1,
    sea: [],
    seed: "river-astar-short-edge",
  });
  const start = map.cells.find(cell => cell.id === "c-0-0");
  const exit = map.cells.find(cell => cell.id === "c-1-0");
  setGridSeaD(map, cell => cell === start ? 1 : 2);
  shortenSharedCellEdge(start, exit);

  const candidate = findAStarPath({
    mouth: {cell: start, seaCell: null},
    exit,
    selectedLandSet: new Set(map.cells),
  });

  assert.equal(candidate, null);
}

function validateAStarRiverRequiresInitialSeaDIncrease() {
  const {map} = createGridTerrainFixture({
    width: 6,
    height: 4,
    sea: [],
    seed: "river-astar-sead",
  });
  const byId = id => map.cells.find(cell => cell.id === id);
  const start = byId("c-1-1");
  const exit = byId("c-5-2");
  setGridSeaD(map, cell => {
    if (cell.id === "c-1-1") return 1;
    if (cell.id === "c-2-1") return 1;
    const [, x, y] = cell.id.match(/^c-(\d+)-(\d+)$/).map(Number);
    return x + y - 1;
  });

  const candidate = findAStarPath({
    mouth: {cell: start, seaCell: null},
    exit,
    selectedLandSet: new Set(map.cells),
  });

  assert.ok(candidate);
  assertNoRepeatedRiverCells(candidate);
  assert.deepEqual(
    candidate.riverCells.slice(0, 5).map(cell => cell.id),
    ["c-1-1", "c-1-2", "c-2-2", "c-3-2", "c-4-2"],
  );
}

function validateAStarRiverCannotReturnNearSeaAfterFourCellsAway() {
  const {map} = createGridTerrainFixture({
    width: 6,
    height: 1,
    sea: [],
    seed: "river-astar-no-return-near-sea",
  });
  const byId = id => map.cells.find(cell => cell.id === id);
  const start = byId("c-0-0");
  const exit = byId("c-5-0");
  setGridSeaD(map, cell => {
    const x = Number(cell.id.match(/^c-(\d+)-/)[1]);
    if (x <= 4) return x + 1;
    return 3;
  });

  const candidate = findAStarPath({
    mouth: {cell: start, seaCell: null},
    exit,
    selectedLandSet: new Set(map.cells),
  });

  assert.equal(candidate, null);
}

function validateAStarRiverSupportsCustomSeaDThreshold() {
  const {map} = createGridTerrainFixture({
    width: 10,
    height: 3,
    sea: [],
    seed: "river-astar-custom-sead",
  });
  const byId = id => map.cells.find(cell => cell.id === id);
  const start = byId("c-0-1");
  const exit = byId("c-9-1");
  const thresholdOptions = {
    initialSeaDIncreaseSteps: 8,
    lockedSeaDistance: 8,
  };

  setGridSeaD(map, cell => {
    const x = Number(cell.id.match(/^c-(\d+)-/)[1]);
    if (x === 8) return 7;
    return x + 1;
  });

  const rejected = findAStarPath({
    mouth: {cell: start, seaCell: null},
    exit,
    selectedLandSet: new Set(map.cells),
    ...thresholdOptions,
  });
  assert.equal(rejected, null);

  setGridSeaD(map, cell => Number(cell.id.match(/^c-(\d+)-/)[1]) + 1);
  const accepted = findAStarPath({
    mouth: {cell: start, seaCell: null},
    exit,
    selectedLandSet: new Set(map.cells),
    ...thresholdOptions,
  });
  assert.ok(accepted);
  assertNoRepeatedRiverCells(accepted);
}

function validateAStarRiverFailsOnIntermediateBoundaryCell() {
  const {map} = createGridTerrainFixture({
    width: 6,
    height: 2,
    sea: [],
    seed: "river-astar-intermediate-boundary",
  });
  const byId = id => map.cells.find(cell => cell.id === id);
  const start = byId("c-0-0");
  const exit = byId("c-5-0");
  setGridSeaD(map, cell => {
    const [, x, y] = cell.id.match(/^c-(\d+)-(\d+)$/).map(Number);
    if (y === 0) return x + 1;
    return x + 2;
  });

  const candidate = findAStarPath({
    mouth: {cell: start, seaCell: null},
    exit,
    selectedLandSet: new Set(map.cells),
  });

  assert.equal(candidate, null);
}

function validateAStarRiverFallsBackFromBlockedFarthestExit() {
  const {map} = createGridTerrainFixture({
    width: 3,
    height: 1,
    sea: [],
    seed: "river-astar-exit-fallback",
  });
  const byId = id => map.cells.find(cell => cell.id === id);
  const start = byId("c-0-0");
  const nearExit = byId("c-1-0");
  const farExit = byId("c-2-0");
  setGridSeaD(map, cell => Number(cell.id.match(/^c-(\d+)-/)[1]) + 1);
  shortenSharedCellEdge(nearExit, farExit);

  const search = findBestAStarRiver({
    openMouths: [{cell: start, seaCell: null}],
    exitCells: [nearExit, farExit],
    selectedLandSet: new Set(map.cells),
    mapSize: map.size,
  });

  assert.equal(search.attemptedPaths, 2);
  assert.equal(search.selected?.exit, nearExit);
  assertNoRepeatedRiverCells(search.selected);
  assert.deepEqual(search.selected?.riverCells.map(cell => cell.id), ["c-0-0", "c-1-0"]);
}

function validateAStarRiverSelectsHighestSeaDExitWithinTopFiveDistance() {
  const {map} = createGridTerrainFixture({
    width: 6,
    height: 3,
    sea: [],
    seed: "river-astar-longest",
  });
  const byId = id => map.cells.find(cell => cell.id === id);
  setGridSeaD(map, cell => Number(cell.id.match(/^c-(\d+)-/)[1]) + 1);

  const mouth = {cell: byId("c-1-1"), seaCell: null};
  const search = findBestAStarRiver({
    openMouths: [mouth],
    exitCells: [byId("c-3-1"), byId("c-5-1")],
    selectedLandSet: new Set(map.cells),
    mapSize: map.size,
  });

  assert.ok(search.selected);
  assertNoRepeatedRiverCells(search.selected);
  assert.equal(search.selected.exit, byId("c-5-1"));
  assert.ok(search.selected.mouthExitDistance > search.validRivers.find(candidate => candidate.exit === byId("c-3-1")).mouthExitDistance);
}

function validateAStarRiverSelectedUsesTopFiveDistanceThenExitSeaD() {
  const cell = id => ({id});
  const candidate = (id, mouthExitDistance, seaD) => ({
    riverCells: [cell(`${id}-a`), cell(`${id}-b`)],
    pathCost: mouthExitDistance,
    mouthExitDistance,
    exit: {id: `${id}-exit`, seaD},
  });
  const outsideTopFive = candidate("outside", 50, 99);
  const topFiveLowSeaD = candidate("top-low", 100, 2);
  const selectedBySeaD = candidate("top-best", 99, 9);
  const candidates = [
    topFiveLowSeaD,
    selectedBySeaD,
    candidate("top-3", 98, 4),
    candidate("top-4", 97, 3),
    candidate("top-5", 96, 5),
    outsideTopFive,
  ];

  const selected = selectSelectedRiver(candidates);

  assert.equal(selected, selectedBySeaD);
}

function validateAStarRiverMeanderReplacesInteriorSegment() {
  const {map} = createGridTerrainFixture({
    width: 20,
    height: 15,
    sea: [],
    seed: "river-astar-meander",
  });
  const byId = id => map.cells.find(cell => cell.id === id);
  const riverCells = Array.from({length: 20}, (_, x) => byId(`c-${x}-7`));
  const candidate = {
    riverCells,
    mouth: {cell: riverCells[0], seaCell: null},
    originalMouth: riverCells[0],
    exit: riverCells.at(-1),
    pathCost: 0,
    mouthExitDistance: H.distance(H.cellCentroid(riverCells[0]), H.cellCentroid(riverCells.at(-1))),
  };

  const meandered = meanderRiverCandidate({
    candidate,
    selectedLandSet: new Set(map.cells),
    riverSettings: {
      ...new Settings().rivers,
      meanderMaxPathFactor: 6,
    },
  });

  assert.notEqual(meandered, candidate);
  assert.equal(meandered.riverCells[0], riverCells[0]);
  assert.equal(meandered.riverCells.at(-1), riverCells.at(-1));
  assert.ok(meandered.riverCells.length > riverCells.length);
  assertNoRepeatedRiverCells(meandered);
  assert.ok(meandered.riverCells.every(cell => map.cells.includes(cell)));
  assert.equal(meandered.riverCells.filter(cell => cell.id === "c-8-7").length, 0);
  assert.equal(meandered.riverCells.some(cell => Number(cell.id.match(/^c-\d+-(\d+)$/)[1]) !== 7), true);
}

function validateAStarRiverMeanderFallsBackToRadiusTwo() {
  const {map} = createGridTerrainFixture({
    width: 20,
    height: 15,
    sea: [],
    seed: "river-astar-meander-radius-two-fallback",
  });
  const byId = id => map.cells.find(cell => cell.id === id);
  const riverCells = Array.from({length: 20}, (_, x) => byId(`c-${x}-7`));
  const candidate = {
    riverCells,
    mouth: {cell: riverCells[0], seaCell: null},
    originalMouth: riverCells[0],
    exit: riverCells.at(-1),
    pathCost: 0,
    mouthExitDistance: H.distance(H.cellCentroid(riverCells[0]), H.cellCentroid(riverCells.at(-1))),
  };

  const meandered = meanderRiverCandidate({
    candidate,
    selectedLandSet: new Set(map.cells),
    riverSettings: {
      ...new Settings().rivers,
      meanderMaxPathFactor: 6,
    },
  });
  assert.ok(meandered.riverCells.length > riverCells.length);
  assert.equal(meandered.riverCells.includes(byId("c-8-7")), false);
  assert.equal(meandered.riverCells.some(cell => cell !== riverCells[0] && cell !== riverCells.at(-1) && cell.id.endsWith("-7")), true);
  assert.equal(meandered.riverCells.some(cell => !cell.id.endsWith("-7")), true);
}

function validateTributaryMeanderSupportsRiverMouths() {
  const {map} = createGridTerrainFixture({
    width: 26,
    height: 15,
    sea: [],
    seed: "tributary-meander",
  });
  const byId = id => map.cells.find(cell => cell.id === id);
  const riverCells = Array.from({length: 20}, (_, x) => byId(`c-${x + 5}-7`));
  const candidate = {
    riverCells,
    mouth: {cell: riverCells[0], riverCell: byId("c-4-7")},
    originalMouth: riverCells[0],
    exit: riverCells.at(-1),
    pathCost: 0,
    mouthExitDistance: H.distance(H.cellCentroid(riverCells[0]), H.cellCentroid(riverCells.at(-1))),
  };

  const meandered = meanderRiverCandidate({
    candidate,
    selectedLandSet: new Set(map.cells),
    riverSettings: {
      ...new Settings().rivers,
      meanderMaxPathFactor: 6,
    },
  });

  assert.equal(meandered.mouth.riverCell, candidate.mouth.riverCell);
  assert.equal(meandered.originalMouth, candidate.originalMouth);
  assert.ok(meandered.riverCells.length > riverCells.length);
  assertNoRepeatedRiverCells(meandered);
}

function validateAStarRiverMeanderNoOpWhenNoDetourExists() {
  const {map} = createGridTerrainFixture({
    width: 20,
    height: 15,
    sea: [],
    seed: "river-astar-meander-noop",
  });
  const byId = id => map.cells.find(cell => cell.id === id);
  const riverCells = Array.from({length: 20}, (_, x) => byId(`c-${x}-7`));
  const candidate = {
    riverCells,
    mouth: {cell: riverCells[0], seaCell: null},
    originalMouth: riverCells[0],
    exit: riverCells.at(-1),
    pathCost: 0,
    mouthExitDistance: H.distance(H.cellCentroid(riverCells[0]), H.cellCentroid(riverCells.at(-1))),
  };

  const meandered = meanderRiverCandidate({
    candidate,
    selectedLandSet: new Set(riverCells),
  });

  assert.deepEqual(meandered.riverCells.map(cell => cell.id), riverCells.map(cell => cell.id));
}

function validateAStarRiverMeanderRespectsSeaDThreshold() {
  const {map} = createGridTerrainFixture({
    width: 20,
    height: 15,
    sea: [],
    seed: "river-astar-meander-sead-threshold",
  });
  const byId = id => map.cells.find(cell => cell.id === id);
  const riverCells = Array.from({length: 20}, (_, x) => byId(`c-${x}-7`));
  for (const cell of map.cells) {
    cell.seaD = 4;
  }
  ["c-7-5", "c-8-5", "c-9-5", "c-10-5"].forEach((id) => {
    byId(id).seaD = 1;
  });

  const candidate = {
    riverCells,
    mouth: {cell: riverCells[0], seaCell: null},
    originalMouth: riverCells[0],
    exit: riverCells.at(-1),
    pathCost: 0,
    mouthExitDistance: H.distance(H.cellCentroid(riverCells[0]), H.cellCentroid(riverCells.at(-1))),
  };

  const meandered = meanderRiverCandidate({
    candidate,
    selectedLandSet: new Set(map.cells),
    riverSettings: {
      minLockedSeaDistance: 4,
      minExitOpenSeaDistance: 5,
      meanderForbiddenRadii: [4, 3, 2],
      meanderMaxPathFactor: 4,
      minEdgeSize: 40,
      initialSeaDIncreaseSteps: 4,
      maxComputeMs: 1000,
    },
  });

  assert.equal(meandered.riverCells.some(cell => (cell.seaD ?? 0) < 4), false);
  assert.equal(meandered.riverCells.some(cell => cell.id === "c-8-5"), false);
}

function validateAStarRiversPersistSelectedRiver() {
  const {settings, map} = createGridTerrainFixture({
    width: 8,
    height: 5,
    sea: [[0, 2]],
    seed: "river-astar-persist",
  });

  const result = computeAStarRivers({
    ...settings,
    rng: settings.createStepRng("Rivers"),
  }, map);

  assert.equal(result.rivers.length, 1);
  assert.equal(result.rivers[0].type, "MAIN");
  assert.equal(result.rivers[0].role, "PRIMARY");
  assert.equal(result.rivers[0].id, "river-0");
  assert.ok(result.rivers[0].riverCells.length > 0);
  assert.ok(result.rivers[0].riverCells.every(cell => result.cells.includes(cell)));
  assert.equal(result.rivers[0].originalMouth, result.rivers[0].mouth.cell);
  assert.ok(result.cells.includes(result.rivers[0].exit));
  assertNoRepeatedRiverCells(result.rivers[0]);
}

function validateRiverCloneAndHydrationPreserveRivers() {
  const {settings, map} = createGridTerrainFixture({
    width: 8,
    height: 5,
    sea: [[0, 2]],
    seed: "river-clone-hydrate",
  });
  const result = computeAStarRivers({
    ...settings,
    rng: settings.createStepRng("Rivers"),
  }, map);

  const cloned = cloneDeepKeepFunctions(result);
  assert.notEqual(cloned.rivers[0].riverCells[0], result.rivers[0].riverCells[0]);
  assert.equal(cloned.rivers[0].riverCells[0], cloned.cells.find(cell => cell.id === result.rivers[0].riverCells[0].id));
  assert.equal(cloned.rivers[0].mouth.cell, cloned.cells.find(cell => cell.id === result.rivers[0].mouth.cell.id));
  assert.equal(cloned.rivers[0].exit, cloned.cells.find(cell => cell.id === result.rivers[0].exit.id));
  assert.equal(cloned.rivers[0].role, result.rivers[0].role);
  if (result.rivers[0].mouth.riverExitPoint) {
    assert.deepEqual(cloned.rivers[0].mouth.riverExitPoint, result.rivers[0].mouth.riverExitPoint);
  }

  const hydrated = hydrateMap(serializeMap(result));
  assert.equal(hydrated.rivers[0].riverCells[0], hydrated.cells.find(cell => cell.id === result.rivers[0].riverCells[0].id));
  assert.equal(hydrated.rivers[0].mouth.cell, hydrated.cells.find(cell => cell.id === result.rivers[0].mouth.cell.id));
  assert.equal(hydrated.rivers[0].exit, hydrated.cells.find(cell => cell.id === result.rivers[0].exit.id));
  assert.equal(hydrated.rivers[0].role, result.rivers[0].role);
  if (result.rivers[0].mouth.riverExitPoint) {
    assert.deepEqual(hydrated.rivers[0].mouth.riverExitPoint, result.rivers[0].mouth.riverExitPoint);
  }
}

function validateRiverTopologyRegisteredInPipeline() {
  const tributaryIndex = steps.findIndex(step => step.title === "Tributaries");
  const topologyIndex = steps.findIndex(step => step.title === "River topology");
  assert.ok(tributaryIndex >= 0);
  assert.equal(topologyIndex, tributaryIndex + 1);
  assert.equal(steps[topologyIndex]?.process, computeRiverTopology);
}

function validateRiverTopologySplitsMainRiverCell() {
  const {settings, map} = createGridTerrainFixture({
    width: 3,
    height: 3,
    sea: [[0, 1]],
    seed: "river-topology-main",
  });
  const byId = id => map.cells.find(cell => cell.id === id);
  const mainCells = [byId("c-1-1"), byId("c-2-1")];
  map.rivers = [{
    id: "river-0",
    type: "MAIN",
    role: "PRIMARY",
    order: 0,
    riverCells: mainCells,
    mouth: {cell: mainCells[0], seaCell: byId("c-0-1")},
    originalMouth: mainCells[0],
    exit: mainCells[1],
  }];

  const result = computeRiverTopology(settings, map);
  const children = result.cells.filter(cell => cell.parentCellId === "c-1-1");
  const riverEdges = result.edges.filter(edge => edge.type === "river");

  assert.equal(children.length, 2);
  assert.ok(!result.cells.includes(mainCells[0]));
  assert.ok(riverEdges.some(edge => edge.leftCell && edge.rightCell && children.includes(edge.leftCell) && children.includes(edge.rightCell)));
  assert.ok(result.rivers[0].riverCells.every(cell => result.cells.includes(cell)));
  assertRiverTopologyGraphIdentity(result);
}

function validateRiverTopologySplitsTributaryMergeCellInThree() {
  const {settings, map} = createGridTerrainFixture({
    width: 5,
    height: 5,
    sea: [[2, 4]],
    seed: "river-topology-merge",
  });
  const byId = id => map.cells.find(cell => cell.id === id);
  const mainCells = [byId("c-2-3"), byId("c-2-2"), byId("c-2-1"), byId("c-2-0")];
  const tributaryCells = [byId("c-1-2"), byId("c-0-2")];
  map.rivers = [
    {
      id: "river-0",
      type: "MAIN",
      role: "PRIMARY",
      order: 0,
      riverCells: mainCells,
      mouth: {cell: mainCells[0], seaCell: byId("c-2-4")},
      originalMouth: mainCells[0],
      exit: mainCells.at(-1),
    },
    {
      id: "river-1",
      type: "TRIBUTARY",
      role: "FIRST_TRIBUTARY",
      order: 1,
      sourceRiverId: "river-0",
      riverCells: tributaryCells,
      mouth: {cell: tributaryCells[0], riverCell: byId("c-2-2")},
      originalMouth: tributaryCells[0],
      exit: tributaryCells.at(-1),
    },
  ];

  const result = computeRiverTopology(settings, map);
  const mergeChildren = result.cells.filter(cell => cell.parentCellId === "c-2-2");
  const junction = result.nodes.find(node => node.type === "river-junction");
  const junctionEdges = result.edges.filter(edge => edge.type === "river" && (edge.start === junction || edge.end === junction));

  assert.equal(mergeChildren.length, 3);
  assert.ok(junction);
  assert.equal(junctionEdges.length, 3);
  assert.ok(mergeChildren.every(cell => cell.type === TERRAIN_LAND));
  assertRiverTopologyGraphIdentity(result);
}

function validateRiverTopologyRecomputesAreasAndColors() {
  const {settings, map} = createGridTerrainFixture({
    width: 3,
    height: 3,
    sea: [[0, 1]],
    seed: "river-topology-areas",
  });
  const byId = id => map.cells.find(cell => cell.id === id);
  const mainCells = [byId("c-1-1"), byId("c-2-1")];
  map.rivers = [{
    id: "river-0",
    type: "MAIN",
    role: "PRIMARY",
    order: 0,
    riverCells: mainCells,
    mouth: {cell: mainCells[0], seaCell: byId("c-0-1")},
    originalMouth: mainCells[0],
    exit: mainCells.at(-1),
  }];

  const result = computeRiverTopology(settings, map);
  const terrain = result.areas.find(group => group.name === "terrain");
  const landAreas = terrain.areas.filter(area => area.type === TERRAIN_LAND);
  const seaAreas = terrain.areas.filter(area => area.type === TERRAIN_SEA);

  assert.ok(landAreas.length >= 2);
  assert.ok(landAreas.every(area => area.tint));
  assert.ok(landAreas.every(area => area.tintOpacity === 0.2));
  assert.ok(seaAreas.some(area => area.kind === "OPEN_SEA"));
  assertLandAreaColorsAreUniqueWhenAvoidable(landAreas);
  assertNeighboringLandAreasUseDifferentColors(landAreas);
}

function validateRiverTopologyAreaTintDrawsOverlay() {
  const {settings, map} = createGridTerrainFixture({
    width: 3,
    height: 3,
    sea: [[0, 1]],
    seed: "river-topology-draw",
  });
  const byId = id => map.cells.find(cell => cell.id === id);
  map.rivers = [{
    id: "river-0",
    type: "MAIN",
    role: "PRIMARY",
    order: 0,
    riverCells: [byId("c-1-1"), byId("c-2-1")],
    mouth: {cell: byId("c-1-1"), seaCell: byId("c-0-1")},
    originalMouth: byId("c-1-1"),
    exit: byId("c-2-1"),
  }];

  const result = computeRiverTopology(settings, map);
  const landArea = result.areas[0].areas.find(area => area.type === TERRAIN_LAND && area.tint);
  const {calls, svg} = createSvgProbe();
  landArea.draw(svg);

  assert.ok(calls.some(call => call.attrs.class === "area area-tint"));
  assert.ok(calls.some(call => call.attrs["fill-opacity"] === "0.2"));
}

function assertRiverTopologyGraphIdentity(map) {
  for (const edge of map.edges) {
    assert.ok(map.nodes.includes(edge.start), `edge ${edge.id} start is detached`);
    assert.ok(map.nodes.includes(edge.end), `edge ${edge.id} end is detached`);
    if (edge.leftCell) assert.ok(map.cells.includes(edge.leftCell), `edge ${edge.id} leftCell is detached`);
    if (edge.rightCell) assert.ok(map.cells.includes(edge.rightCell), `edge ${edge.id} rightCell is detached`);
  }

  for (const cell of map.cells) {
    for (const edge of cell.edges) {
      assert.ok(map.edges.includes(edge), `cell ${cell.id} references detached edge ${edge.id}`);
      assert.ok(edge.leftCell === cell || edge.rightCell === cell, `cell ${cell.id} is not assigned to edge ${edge.id}`);
    }
  }

  for (const river of map.rivers ?? []) {
    assert.ok((river.riverCells ?? []).every(cell => map.cells.includes(cell)), `river ${river.id} references detached riverCells`);
    assert.ok((river.topologyEdges ?? []).every(edge => map.edges.includes(edge)), `river ${river.id} references detached topologyEdges`);
    if (river.originalMouth) assert.ok(map.cells.includes(river.originalMouth), `river ${river.id} originalMouth is detached`);
    if (river.exit) assert.ok(map.cells.includes(river.exit), `river ${river.id} exit is detached`);
    if (river.mouth?.cell) assert.ok(map.cells.includes(river.mouth.cell), `river ${river.id} mouth.cell is detached`);
    if (river.mouth?.seaCell) assert.ok(map.cells.includes(river.mouth.seaCell), `river ${river.id} mouth.seaCell is detached`);
    if (river.mouth?.riverCell) assert.ok(map.cells.includes(river.mouth.riverCell), `river ${river.id} mouth.riverCell is detached`);
  }
}

function assertNeighboringLandAreasUseDifferentColors(landAreas) {
  const areaByCell = new globalThis.Map();
  landAreas.forEach(area => area.cells.forEach(cell => areaByCell.set(cell, area)));

  for (const area of landAreas) {
    for (const cell of area.cells) {
      for (const edge of cell.edges) {
        const neighbor = edge.leftCell === cell ? edge.rightCell : edge.rightCell === cell ? edge.leftCell : null;
        const neighborArea = areaByCell.get(neighbor);
        if (!neighborArea || neighborArea === area) continue;
        assert.notEqual(area.tint, neighborArea.tint);
      }
    }
  }
}

function assertLandAreaColorsAreUniqueWhenAvoidable(landAreas) {
  const colors = landAreas.map(area => area.tint);
  const uniqueColors = new Set(colors);
  if (landAreas.length <= 8) {
    assert.equal(uniqueColors.size, landAreas.length);
  }
}

function validateTributariesRegisteredInPipeline() {
  const riverIndex = steps.findIndex(step => step.title === "Rivers");
  const tributaryIndex = steps.findIndex(step => step.title === "Tributaries");

  assert.ok(riverIndex >= 0);
  assert.equal(tributaryIndex, riverIndex + 1);
  assert.equal(steps[tributaryIndex]?.process, computeTributaries);
}

function validateTributarySelectionUsesCombinedDistanceAndSeaD() {
  const cell = id => ({id});
  const candidate = (id, sourceExitDistance, seaD) => ({
    riverCells: [cell(`${id}-a`), cell(`${id}-b`)],
    pathCost: sourceExitDistance,
    sourceExitDistance,
    exit: {id: `${id}-exit`, seaD},
  });
  const farthestOnly = candidate("far", 100, 8);
  const selectedByCombinedScore = candidate("combined", 50, 20);
  const weaker = candidate("weak", 60, 10);

  const selected = selectTributary([farthestOnly, selectedByCombinedScore, weaker]);

  assert.equal(selected, selectedByCombinedScore);
}

function validateTributaryMouthThirdScore() {
  const cells = Array.from({length: 7}, (_, index) => ({id: `r-${index}`}));
  const mainRiver = {riverCells: cells};
  const atFirstThird = {mouth: {riverCell: cells[2]}};
  const nearExit = {mouth: {riverCell: cells[6]}};
  const missing = {mouth: {riverCell: {id: "missing"}}};

  assert.equal(mouthThirdScore(atFirstThird, mainRiver), 1);
  assert.ok(mouthThirdScore(nearExit, mainRiver) < mouthThirdScore(atFirstThird, mainRiver));
  assert.equal(mouthThirdScore(missing, mainRiver), 0);
}

function validateTributarySelectionPrefersFirstThirdMouthBonus() {
  const mainCells = Array.from({length: 7}, (_, index) => ({id: `r-${index}`}));
  const mainRiver = {riverCells: mainCells};
  const cell = id => ({id});
  const candidate = (id, riverCell, sourceExitDistance, seaD) => ({
    riverCells: [cell(`${id}-a`), cell(`${id}-b`)],
    pathCost: sourceExitDistance,
    sourceExitDistance,
    mouth: {riverCell},
    exit: {id: `${id}-exit`, seaD},
  });
  const exitHeuristicOnly = candidate("exit", mainCells[6], 100, 20);
  const selectedByMouth = candidate("mouth", mainCells[2], 95, 19);

  const selected = selectTributary([exitHeuristicOnly, selectedByMouth], mainRiver);

  assert.equal(selected, selectedByMouth);
  assert.equal(selected.mouthThirdScore, 1);
}

function validateTributariesAddAdjacentBankRiver() {
  const {settings, map} = createTributaryFixture();
  const result = computeTributaries({
    ...settings,
    rng: settings.createStepRng("Tributaries"),
  }, map);
  const mainRiver = result.rivers[0];
  const tributaries = result.rivers.filter(river => river.type === "TRIBUTARY");

  assert.ok(tributaries.length >= 1);
  assert.ok(tributaries.length <= 2);

  const tributary = tributaries[0];
  assert.equal(mainRiver.role, "PRIMARY");
  assert.equal(tributary.role, "FIRST_TRIBUTARY");
  assert.equal(tributary.sourceRiverId, mainRiver.id);
  assert.ok(tributary.riverCells.every(cell => result.cells.includes(cell)));
  assert.equal(tributary.originalMouth, tributary.mouth.cell);
  assert.ok(mainRiver.riverCells.includes(tributary.mouth.riverCell));
  assert.ok(H.cellsEdge(tributary.mouth.cell, tributary.mouth.riverCell));
  assert.ok(tributary.mouth.cell.seaD >= 1);
  assert.ok(tributary.exit.edges.some(edge => edge.flags.has("Boundary")));
  assert.ok(tributary.exit.seaD >= 8);
  assertNoRepeatedRiverCells(tributary);
  assert.equal(tributary.sourceExitDistance, H.distance(H.cellCentroid(tributary.exit), H.cellCentroid(mainRiver.exit)));
  assert.equal(tributary.mouth.riverCell, mainRiver.riverCells.find(cell => cell.id === tributary.mouth.riverCell.id));
  assert.ok(tributary.mouth.riverExitPoint);

  const {calls, svg} = createSvgProbe();
  result.drawOverlay(svg);
  const paths = calls.filter(call => call.name === "path");
  assert.equal(paths.length, result.rivers.length);
  assert.ok(paths.every(path => path.attrs.stroke === "var(--sea-edge)"));
  assert.ok(paths.every(path => path.attrs.d.includes(" L ")));
  assert.equal(paths[0].attrs["stroke-width"], "12");
  assert.ok(paths.slice(1).every(path => path.attrs["stroke-width"] === "8"));
  assert.ok(paths[1].attrs.d.startsWith(`M ${tributary.mouth.riverExitPoint.x} ${tributary.mouth.riverExitPoint.y}`));
}

function validateAStarRiverDrawsStraightPath() {
  const {map} = createGridTerrainFixture({
    width: 3,
    height: 2,
    sea: [[0, 1]],
    seed: "river-astar-draw-straight",
  });
  const byId = id => map.cells.find(cell => cell.id === id);
  const candidate = {
    originalMouth: byId("c-1-1"),
    riverCells: [byId("c-1-1"), byId("c-2-1")],
  };
  const mouthEdge = H.cellsEdge(byId("c-0-1"), byId("c-1-1"));
  const riverEdge = H.cellsEdge(byId("c-1-1"), byId("c-2-1"));
  const exitEdge = byId("c-2-1").edges.find(edge => edge.flags?.has("Boundary"));
  const mouthMid = H.midpoint(mouthEdge.start, mouthEdge.end);
  const riverMid = H.midpoint(riverEdge.start, riverEdge.end);
  const exitMid = H.midpoint(exitEdge.start, exitEdge.end);
  const {calls, svg} = createSvgProbe();

  drawRiver(candidate, map, "var(--sea-edge)");
  map.drawOverlay(svg);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].attrs["stroke-opacity"], "1");
  assert.ok(calls[0].attrs.d.includes(" L "));
  assert.equal(calls[0].attrs.d.includes(" Q "), false);
  assert.equal(calls[0].attrs.d, `M ${mouthMid.x} ${mouthMid.y} L ${riverMid.x} ${riverMid.y} L ${exitMid.x} ${exitMid.y}`);
  assert.equal(calls[0].attrs.stroke, "var(--sea-edge)");
}

function validateTributaryDrawStartsFromPrimaryRiverExitPoint() {
  const {map} = createGridTerrainFixture({
    width: 4,
    height: 2,
    sea: [],
    seed: "tributary-draw-entry",
  });
  const byId = id => map.cells.find(cell => cell.id === id);
  const primaryCell = byId("c-1-0");
  const primaryNextCell = byId("c-2-0");
  const tributaryCell = byId("c-1-1");
  const primaryExitEdge = H.cellsEdge(primaryCell, primaryNextCell);
  const primaryExitPoint = H.midpoint(primaryExitEdge.start, primaryExitEdge.end);
  const candidate = {
    originalMouth: tributaryCell,
    mouth: {cell: tributaryCell, riverCell: primaryCell, riverExitPoint: primaryExitPoint},
    riverCells: [tributaryCell, byId("c-2-1")],
  };
  const {calls, svg} = createSvgProbe();

  drawRiver(candidate, map, "var(--sea-edge)");
  map.drawOverlay(svg);

  assert.equal(calls.length, 1);
  assert.ok(calls[0].attrs.d.startsWith(`M ${primaryExitPoint.x} ${primaryExitPoint.y}`));
  assert.ok(calls[0].attrs.d.includes(" L "));
}

function validateAStarRiversReplayFrames() {
  const {settings, map} = createGridTerrainFixture({
    width: 8,
    height: 5,
    sea: [[0, 2], [4, 2]],
    seed: "river-astar-replay",
  });

  const replay = createAStarRiversReplay({
    ...settings,
    rng: settings.createStepRng("Rivers"),
  }, map);

  assert.deepEqual(replay.frames.map(frame => frame.label), [
    "SeaD threshold",
    "Mouth computation",
    "Exit computation",
    "Forbidden edges",
    "Failed river attempt",
    "Valid unselected river",
    "Selected river",
    "Meander refinement",
  ]);
  assert.ok(replay.frames.every(frame => frame.overlay?.type === "rivers"));
  assert.ok(replay.frames[0].overlay.polygons.length > 0);
  assert.ok(replay.frames[1].overlay.arrows.length > replay.frames[0].overlay.arrows.length);
  assert.ok(replay.frames[1].overlay.arrows.every(arrow => arrow.stroke === "black"));
  assert.ok(replay.frames[2].overlay.arrows.length > replay.frames[1].overlay.arrows.length);
  assert.ok(replay.frames[3].overlay.lines.length >= replay.frames[2].overlay.lines.length);
  assert.ok(replay.frames[4].overlay.paths.length >= replay.frames[3].overlay.paths.length);
  if (replay.frames[4].overlay.paths.length > replay.frames[3].overlay.paths.length) {
    assert.ok(replay.frames[4].overlay.paths.at(-1).d.includes(" L "));
    assert.ok(replay.frames[4].overlay.paths.every(path => path.stroke === "var(--sea-edge)"));
  }
  if (replay.frames[6].overlay.paths.length > 1) {
    assert.ok(replay.frames[6].overlay.paths.slice(0, -1).every(path => path.opacity === 0.25));
    assert.equal(replay.frames[6].overlay.paths.at(-1).opacity, 1);
  }
  assert.ok(replay.frames[7].overlay.paths.length >= replay.frames[6].overlay.paths.length);
  assert.ok(replay.frames[7].overlay.paths.at(-1).d.includes(" L "));

  const hydrated = hydrateReplay(serializeReplay(replay));
  const mouthFrame = hydrated.frames[0];
  const {calls, svg} = createSvgProbe();
  mouthFrame.map.drawOverlay(svg);

  assert.ok(calls.length > 0);
  assert.ok(calls.some(call => call.name === "polygon"));
}

function validateCoastReplayMatchesFinalClassification() {
  const {settings, map} = createTwoCellCoastFixture("coast-replay-final");
  const processed = classifySeaLand({
    ...settings,
    rng: settings.createStepRng("Coast"),
  }, cloneDeepKeepFunctions(map));
  const replay = createCoastReplay({
    ...settings,
    rng: settings.createStepRng("Coast"),
  }, cloneDeepKeepFunctions(map));
  const finalReplayMap = replay.frames.at(-1).map;

  assert.equal(finalReplayMap.cells.length, processed.cells.length);
  assert.equal(finalReplayMap.edges.length, processed.edges.length);
  assert.equal(finalReplayMap.nodes.length, processed.nodes.length);
  assert.deepEqual(
    finalReplayMap.cells.map((cell) => [cell.id, cell.type]),
    processed.cells.map((cell) => [cell.id, cell.type]),
  );
  assert.deepEqual(
    finalReplayMap.edges.map((edge) => [edge.id, terrainFlag(edge)]),
    processed.edges.map((edge) => [edge.id, terrainFlag(edge)]),
  );
  assert.deepEqual(
    finalReplayMap.nodes.map((node) => node.draw),
    processed.nodes.map((node) => node.draw),
  );
}

function validateCoastReplayDefaultFrames() {
  const {settings, map} = createTwoCellCoastFixture("coast-replay-frames");
  settings.coast = {
    ...settings.coast,
    largeAmplitude: 0.18,
    mediumAmplitude: 0.08,
    smallAmplitude: 0.03,
    smoothingPasses: 1,
  };

  const replay = createCoastReplay({
    ...settings,
    rng: settings.createStepRng("Coast"),
  }, cloneDeepKeepFunctions(map));
  const labels = replay.frames.map((frame) => frame.label);

  [
    "Before coast",
    "Sea border distance",
    "Large noise",
    "Medium noise",
    "Small noise",
    "Combined field",
    "Initial terrain",
    "Smoothing pass 1 / 1",
    "Artifact cleanup",
    "Final coast",
  ].forEach((label) => assert.ok(labels.includes(label), label));
}

function validateCoastReplayOverlayIsolation() {
  const {settings, map} = createTwoCellCoastFixture("coast-replay-overlay");
  const replay = createCoastReplay({
    ...settings,
    rng: settings.createStepRng("Coast"),
  }, cloneDeepKeepFunctions(map));
  const fieldFrame = replay.frames.find((frame) => frame.label === "Sea border distance");
  assert.ok(fieldFrame);
  const before = summarizeMapState(fieldFrame.map);
  const {calls, layers, svg} = createSvgProbe();

  fieldFrame.map.drawOverlay(svg);

  assert.deepEqual(summarizeMapState(fieldFrame.map), before);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.layerId === "overlay"));
  assert.equal(layers.get("nodes"), undefined);
  assert.equal(layers.get("edges"), undefined);
  assert.equal(layers.get("cells"), undefined);
}

function validateCoastSmoothingFramesDeterministic() {
  const {settings, map} = createTwoCellCoastFixture("coast-replay-smoothing");
  settings.coast = {
    ...settings.coast,
    largeAmplitude: 0.12,
    mediumAmplitude: 0.06,
    smallAmplitude: 0.02,
    smoothingPasses: 2,
  };

  const first = createCoastReplay({
    ...settings,
    rng: settings.createStepRng("Coast"),
  }, cloneDeepKeepFunctions(map));
  const second = createCoastReplay({
    ...settings,
    rng: settings.createStepRng("Coast"),
  }, cloneDeepKeepFunctions(map));

  assert.deepEqual(
    smoothingFrameTypes(first),
    smoothingFrameTypes(second),
  );
}

function validateReplaySerializationHydration() {
  const settings = new Settings("replay-serialization");
  const input = new Map(settings);
  input.nodes.push(
    Poi("A", 750, 750),
    Poi("B", 2250, 750),
    Poi("C", 1500, 2250),
  );
  const replay = createGatherReplay({
    ...settings,
    rng: settings.createStepRng("Gather"),
  }, input);
  const payload = structuredClone(serializeReplay(replay));
  const hydrated = hydrateReplay(payload);
  const frameMap = hydrated.frames[1].map;

  assertGraphIdentity(frameMap);

  const {calls, layers, svg} = createSvgProbe();
  frameMap.drawOverlay(svg);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.layerId === "overlay"));
  assert.equal(layers.get("nodes"), undefined);
  assert.equal(layers.get("edges"), undefined);
  assert.equal(layers.get("cells"), undefined);
}

function validateReplayServiceBuildsSelectedStepPayload() {
  const {settings, map} = createTwoCellCoastFixture("replay-service-coast");
  const payload = structuredClone(buildReplayPayload({
    settingsData: plainSettings(settings),
    stepIndex: steps.findIndex((step) => step.title === "Coast"),
    inputMapData: serializeMap(map),
  }));
  const hydrated = hydrateReplay(payload);
  const processed = classifySeaLand({
    ...settings,
    rng: settings.createStepRng("Coast"),
  }, cloneDeepKeepFunctions(map));
  const finalReplayMap = hydrated.frames.at(-1).map;

  assertGraphIdentity(finalReplayMap);
  assert.deepEqual(
    finalReplayMap.cells.map((cell) => [cell.id, cell.type]),
    processed.cells.map((cell) => [cell.id, cell.type]),
  );
  assert.deepEqual(
    finalReplayMap.edges.map((edge) => [edge.id, terrainFlag(edge)]),
    processed.edges.map((edge) => [edge.id, terrainFlag(edge)]),
  );
  assert.deepEqual(
    summarizeAreas(finalReplayMap),
    summarizeAreas(processed),
  );
}

function assertGraphIdentity(map) {
  for (const edge of map.edges) {
    assert.ok(map.nodes.includes(edge.start));
    assert.ok(map.nodes.includes(edge.end));
    assert.ok(edge.start.edges.has(edge));
    assert.ok(edge.end.edges.has(edge));
    if (edge.leftCell) assert.ok(map.cells.includes(edge.leftCell));
    if (edge.rightCell) assert.ok(map.cells.includes(edge.rightCell));
  }

  for (const cell of map.cells) {
    assert.ok(cell.edges.every((edge) => map.edges.includes(edge)));
  }

  for (const group of map.areas ?? []) {
    assert.ok(Array.isArray(group.areas));
    for (const area of group.areas ?? []) {
      assert.ok(area.cells.every((cell) => map.cells.includes(cell)));
    }
  }
}

function terrainFlag(edge) {
  if (edge.flags?.has(TERRAIN_COAST)) return TERRAIN_COAST;
  if (edge.flags?.has(TERRAIN_SEA)) return TERRAIN_SEA;
  if (edge.flags?.has(TERRAIN_LAND)) return TERRAIN_LAND;
  return null;
}

function summarizeMapState(map) {
  return {
    nodes: map.nodes.map((node) => [node.id, node.x, node.y, node.type, node.draw]),
    edges: map.edges.map((edge) => [edge.id, edge.type, terrainFlag(edge)]),
    cells: map.cells.map((cell) => [cell.id, cell.type, cell.draw]),
    areas: summarizeAreas(map),
  };
}

function summarizeAreas(map) {
  return (map.areas ?? []).map((group) => ({
    name: group.name,
    areas: (group.areas ?? []).map((area) => ({
      name: area.name,
      type: area.type,
      cellIds: (area.cells ?? []).map((cell) => cell.id).sort(),
    })),
  }));
}

function smoothingFrameTypes(replay) {
  return replay.frames
    .filter((frame) => frame.label.startsWith("Smoothing pass"))
    .map((frame) => frame.map.cells.map((cell) => [cell.id, cell.type]));
}

validateCloneIdentityAndFlags();
validateSnapshotDrawingUsesClonedNodes();
validateClonePreservesCellToSeaReference();
validatePipelineClonesBeforeSteps();
validatePipelineSkipsReplayHotpath();
validateScatterReplay();
validateStepRngDeterminism();
validateGatherVoronoi();
validateGatherReplay();
validateMapClearClearsOverlay();
validateCellDrawing();
validateLloydRelaxation();
validatePruneRemovesAndRewires();
validatePruneCellDeletion();
validatePruneBoundaryRules();
validateSeaLandStepClassifiesAndTags();
validateCoastSeaCornerBiasField();
validateCoastBiasClassificationKeepsSeaPercent();
validateRiversClassifyOpenAndInnerSeas();
validateRiversComputeDistanceAndBanks();
validateRiversRejectShortEdges();
validateRiverSelectionFallsBackToNearestBankRatio();
validateAStarRiversRegisteredInPipeline();
validateAStarRiversComputeDistanceFromInnerSeas();
validateAStarRiversSeaDIgnoresMinimumEdgeSize();
validateAStarRiverRejectsShortCoastMouthEdges();
validateAStarRiverRejectsShortEdges();
validateAStarRiverRequiresInitialSeaDIncrease();
validateAStarRiverCannotReturnNearSeaAfterFourCellsAway();
validateAStarRiverSupportsCustomSeaDThreshold();
validateAStarRiverFailsOnIntermediateBoundaryCell();
validateAStarRiverFallsBackFromBlockedFarthestExit();
validateAStarRiverSelectsHighestSeaDExitWithinTopFiveDistance();
validateAStarRiverSelectedUsesTopFiveDistanceThenExitSeaD();
validateAStarRiverMeanderReplacesInteriorSegment();
validateAStarRiverMeanderFallsBackToRadiusTwo();
validateAStarRiverMeanderNoOpWhenNoDetourExists();
validateAStarRiverMeanderRespectsSeaDThreshold();
validateTributaryMeanderSupportsRiverMouths();
validateAStarRiversPersistSelectedRiver();
validateRiverCloneAndHydrationPreserveRivers();
validateTributariesRegisteredInPipeline();
validateTributarySelectionUsesCombinedDistanceAndSeaD();
validateTributaryMouthThirdScore();
validateTributarySelectionPrefersFirstThirdMouthBonus();
validateTributariesAddAdjacentBankRiver();
validateRiverTopologyRegisteredInPipeline();
validateRiverTopologySplitsMainRiverCell();
validateRiverTopologySplitsTributaryMergeCellInThree();
validateRiverTopologyRecomputesAreasAndColors();
validateRiverTopologyAreaTintDrawsOverlay();
validateAStarRiverDrawsStraightPath();
validateTributaryDrawStartsFromPrimaryRiverExitPoint();
validateAStarRiversReplayFrames();
validateCoastReplayMatchesFinalClassification();
validateCoastReplayDefaultFrames();
validateCoastReplayOverlayIsolation();
validateCoastSmoothingFramesDeterministic();
validateReplaySerializationHydration();
validateReplayServiceBuildsSelectedStepPayload();

console.log("AGENTS.md compliance validation passed");
