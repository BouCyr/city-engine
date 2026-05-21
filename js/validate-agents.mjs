import assert from "node:assert/strict";
import {cloneDeepKeepFunctions} from "./data/clone.mjs";
import {Edge} from "./data/edge.mjs";
import {Map} from "./data/map.mjs";
import {Poi} from "./data/nodes.mjs";
import {Settings} from "./data/settings.mjs";
import {runPipeline} from "./pipeline.mjs";
import {cells} from "./steps/001-gather.mjs";
import {relax} from "./steps/002-lloyd.mjs";
import {prune} from "./steps/003-prune.mjs";

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
  assert.equal(map.nodes.length, 1);
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

validateCloneIdentityAndFlags();
validateSnapshotDrawingUsesClonedNodes();
validatePipelineClonesBeforeSteps();
validateStepRngDeterminism();
validateGatherVoronoi();
validateCellDrawing();
validateLloydRelaxation();
validatePruneRemovesAndRewires();
validatePruneCellDeletion();
validatePruneBoundaryRules();

console.log("AGENTS.md compliance validation passed");
