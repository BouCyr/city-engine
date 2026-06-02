import * as C from "../constants.mjs";
import {createRNG} from "./RNG.mjs";

export function Settings(seed="seed") {

  return {
    seed: seed,
    createStepRng: (stepName) => createRNG(`${seed}:${stepName}`),
    size : C.SIZE,
    scatter: {
      nb: C.POI_NB,
      safeZone: C.SAFE_ZONE,
    },
    prune: {
      threshold: C.PRUNE_THRESHOLD,
    },
    coast: {
      seaBorders: ["WEST","SOUTH"],
      seaPercent: 0.30,
      largeScale: 900,
      mediumScale: 350,
      smallScale: 120,
      largeAmplitude: 0.4,
      mediumAmplitude: 0.2,
      smallAmplitude: 0.2,
      smoothingPasses: 1,
      smoothingBias: 0.52,
      artifactsMax: 1,
    },
  }
}

export const SETTING_GROUPS = [
  {
    title: "Global",
    settings: [
      {
        path: "seed",
        label: "Seed",
        type: "text",
        pattern: "[A-Za-z0-9_-]*",
        help: "Controls the deterministic random streams used by every generation step.",
      },
      {
        path: "size",
        label: "Map size",
        type: "number",
        min: 1,
        step: 25,
        help: "Sets the width and height of the square map in SVG units.",
      },
    ],
  },
  {
    title: "Scatter",
    settings: [
      {
        path: "scatter.nb",
        label: "Point count",
        type: "number",
        min: 1,
        step: 50,
        help: "Sets how many initial city anchor points are sampled.",
      },
      {
        path: "scatter.safeZone",
        label: "Safe zone",
        type: "number",
        min: 0,
        step: 10,
        help: "Keeps scattered points at least this far from the map edge.",
      },
    ],
  },
  {
    title: "Prune",
    settings: [
      {
        path: "prune.threshold",
        label: "Short edge threshold",
        type: "number",
        min: 0,
        step: 5,
        help: "Removes and merges graph edges shorter than this length.",
      },
    ],
  },
  {
    title: "Coast",
    settings: [
      {
        path: "coast.seaBorders",
        label: "Sea borders",
        type: "checkbox-list",
        options: ["NORTH", "SOUTH", "EAST", "WEST"],
        help: "Chooses which map borders are treated as open sea.",
      },
      {
        path: "coast.seaPercent",
        label: "Sea percentage",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        help: "Sets the portion of the map covered by sea. Lower values are chosen as sea, placing it near selected borders.",
      },
      {
        path: "coast.largeScale",
        label: "Large noise scale",
        type: "number",
        min: 1,
        step: 1,
        help: "Sets the broad coastline noise wavelength.",
      },
      {
        path: "coast.mediumScale",
        label: "Medium noise scale",
        type: "number",
        min: 1,
        step: 1,
        help: "Sets the mid-sized coastline noise wavelength.",
      },
      {
        path: "coast.smallScale",
        label: "Small noise scale",
        type: "number",
        min: 1,
        step: 1,
        help: "Sets the fine coastline noise wavelength.",
      },
      {
        path: "coast.largeAmplitude",
        label: "Large noise amplitude",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        help: "Controls how strongly broad noise bends the coastline.",
      },
      {
        path: "coast.mediumAmplitude",
        label: "Medium noise amplitude",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        help: "Controls how strongly medium noise bends the coastline.",
      },
      {
        path: "coast.smallAmplitude",
        label: "Small noise amplitude",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        help: "Controls how strongly fine noise roughens the coastline.",
      },
      {
        path: "coast.smoothingPasses",
        label: "Smoothing passes",
        type: "number",
        min: 0,
        step: 1,
        help: "Repeats terrain smoothing across neighboring cell edges.",
      },
      {
        path: "coast.smoothingBias",
        label: "Smoothing bias",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        help: "Sets how dominant neighboring terrain must be to flip a cell.",
      },
      {
        path: "coast.artifactsMax",
        label: "Artifact limit",
        type: "number",
        min: 1,
        step: 1,
        help: "Flips isolated terrain components up to this cell count.",
      },
    ],
  },
];
