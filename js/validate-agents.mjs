import assert from "node:assert/strict";
import {cloneDeepKeepFunctions} from "./data/clone.mjs";
import {Cell} from "./data/cell.mjs";
import {Edge} from "./data/edge.mjs";
import {Map} from "./data/map.mjs";
import {Node, Poi} from "./data/nodes.mjs";
import {Settings} from "./data/settings.mjs";
import {runPipeline} from "./pipeline.mjs";
import {createReplay as createScatterReplay, scatterPoints} from "./steps/000-scatter.mjs";
import {cells} from "./steps/001-gather.mjs";
import {relax} from "./steps/002-lloyd.mjs";
import {prune} from "./steps/003-prune.mjs";
import {classifySeaLand, TERRAIN_COAST, TERRAIN_LAND, TERRAIN_SEA} from "./steps/004-sea-land.mjs";

function createSvgProbe() {
  const calls = [];
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

  return {
    calls,
    svg: {
      getElementById() {
        return {
          appendChild(element) {
            calls.push(element);
          },
        };
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

function validatePipelineStoresReplayWithoutMutatingPriorMaps() {
  const settings = new Settings("pipeline-replay");
  settings.scatter.nb = 2;
  const initialMap = new Map(settings);
  const pipeline = [{
    title: "Replay",
    createReplay(stepSettings, inputMap) {
      const firstFrame = cloneDeepKeepFunctions(inputMap);
      inputMap.nodes.push(Poi("replay-only", 1, 1));
      const secondFrame = cloneDeepKeepFunctions(inputMap);
      return {
        frames: [
          {label: "Before", map: firstFrame},
          {label: "After", map: secondFrame},
        ],
      };
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
  assert.equal(stepResults[1].replay.frames.length, 2);
  assert.equal(stepResults[1].replay.frames[0].map.nodes.length, 0);
  assert.equal(stepResults[1].replay.frames[1].map.nodes.length, 1);
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

function validateSeaLandStepClassifiesAndTags() {
  const settings = new Settings("sea-land-test");
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
    extraNoise: [],
    sampleCount: 1,
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
  map.edges.push(eTopA, eRightA, eBottomA, eLeftA, splitA, eTopB, eRightB, eBottomB);

  const result = classifySeaLand({
    ...settings,
    rng: settings.createStepRng("Sea-Land"),
    coast: settings.coast,
  }, map);

  const seaLandCells = result.cells.filter((cell) => cell.type === TERRAIN_LAND || cell.type === TERRAIN_SEA);
  assert.equal(seaLandCells.length, result.cells.length);
  assert.ok(result.cells.every((cell) => cell.flags instanceof Set));
  assert.ok(result.cells.every((cell) => cell.flags.has(cell.type)));

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
}

validateCloneIdentityAndFlags();
validateSnapshotDrawingUsesClonedNodes();
validatePipelineClonesBeforeSteps();
validatePipelineStoresReplayWithoutMutatingPriorMaps();
validateScatterReplay();
validateStepRngDeterminism();
validateGatherVoronoi();
validateCellDrawing();
validateLloydRelaxation();
validatePruneRemovesAndRewires();
validatePruneCellDeletion();
validatePruneBoundaryRules();
validateSeaLandStepClassifiesAndTags();

console.log("AGENTS.md compliance validation passed");
