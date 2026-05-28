# steps.mjs

Source: `js/steps.mjs`

## Role

Registers generation steps in execution order and provides UI descriptions for each step.

## Public Exports And Callers

Exports `steps`, an array consumed by `runPipeline`, `app.js`, and the replay worker service. Each entry has `title`, `process`, and `description`; replay-capable steps also expose `createReplay`.

## Inputs And Outputs

The step list references functions from the step modules. Description functions receive `(settings, stepMap)` and return HTML strings for the details panel.

## Control Flow

Execution order is Scatter, Gather, Lloyd, Prune, Coast. `runPipeline` iterates this array directly, so array order is the generation order. The replay worker uses the same step index to generate replay for one selected step on demand.

## Mutation And Identity

This module does not mutate graph data. It names the step title used to derive RNG streams, so title changes affect deterministic output.

## Determinism

Step title strings are part of per-step RNG seeding. Descriptions are deterministic reads of settings and step maps.

## Dependencies

Imports all generation step modules under `js/steps/`.

## Edge Cases And Limitations

Descriptions contain trusted HTML and are injected with `innerHTML` by `app.js`. The Coast step title is `"Coast"`, but tests currently derive one validation RNG with `"Sea-Land"`; the step itself only consumes the supplied `settings.rng`.
