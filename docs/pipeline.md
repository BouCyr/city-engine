# pipeline.mjs

Source: `js/pipeline.mjs`

## Role

Runs the ordered generation steps and stores renderable snapshots for the initial and post-step maps.

## Public Exports And Callers

Exports `runPipeline(settings, initialMap = new Map(settings), registeredSteps = steps)`. `js/app.js` calls it for normal generation. Validation code calls it with custom steps.

## Inputs And Outputs

Inputs are a settings object with `createStepRng`, an optional initial `Map`, and an optional step list. It returns `{map, stepResults}`, where `map` is the final step result and `stepResults` contains `{step, map}` snapshots starting with the `"void"` map.

## Control Flow

The pipeline clones the initial map for the first snapshot. For each registered step, it derives a step-scoped RNG from the step title, clones the current map before passing it to the step, stores a clone of the returned step map, then advances `map` to the returned object.

## Mutation And Identity

Steps may mutate their input because the pipeline passes a clone. Stored snapshots are also clones, using graph-aware clone logic that preserves node-edge-cell relationships and draw functions.

## Determinism

The pipeline creates independent RNG streams with `settings.createStepRng(step.title)`. Inserting a step does not consume another step's RNG stream, although changing a step title changes that step's RNG seed.

## Dependencies

Imports `steps`, `Map`, and `cloneDeepKeepFunctions`.

## Edge Cases And Limitations

`runPipeline` expects every step to expose `title` and `process`. It logs progress with `console.info`. If a step returns a malformed map, later cloning or rendering may fail.
