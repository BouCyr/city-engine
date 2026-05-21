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
    }
  }
}
