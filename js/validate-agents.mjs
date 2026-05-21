import assert from "node:assert/strict";
import {cloneDeepKeepFunctions} from "./data/clone.mjs";
import {Edge} from "./data/edge.mjs";
import {Map} from "./data/map.mjs";
import {Poi} from "./data/nodes.mjs";
import {Settings} from "./data/settings.mjs";
import {runPipeline} from "./pipeline.mjs";
import {cells} from "./steps/001-gather.mjs";

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
    assert.ok(/^rgb\(\d+,\d+,\d+\)$/.test(cell.fill));
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
  assert.ok(calls[0].attrs.fill.startsWith("rgb("));
}

validateCloneIdentityAndFlags();
validateSnapshotDrawingUsesClonedNodes();
validatePipelineClonesBeforeSteps();
validateStepRngDeterminism();
validateGatherVoronoi();
validateCellDrawing();

console.log("AGENTS.md compliance validation passed");
