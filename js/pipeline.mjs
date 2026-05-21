import {steps} from "./steps.mjs";
import {Map} from "./data/map.mjs";
import {cloneDeepKeepFunctions} from "./data/clone.mjs";

export function runPipeline(settings, initialMap = new Map(settings), registeredSteps = steps) {
  let map = initialMap;
  const stepResults = [{
    step: "void",
    map: cloneDeepKeepFunctions(map),
  }];

  for (const step of registeredSteps) {
    console.info(step.title, "Starting");
    const stepSettings = {
      ...settings,
      rng: settings.createStepRng(step.title),
    };
    const stepMap = step.process(stepSettings, cloneDeepKeepFunctions(map));

    stepResults.push({
      step: step.title,
      map: cloneDeepKeepFunctions(stepMap),
    });
    map = stepMap;
    console.info(step.title, "Done");
  }

  return {map, stepResults};
}
