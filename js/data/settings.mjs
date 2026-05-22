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
    },
  }
}
