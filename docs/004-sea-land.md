# 004-sea-land.mjs

Source: `js/steps/004-sea-land.mjs`

## Role

Coast classifies cells as sea or land, marks coast edges, and switches rendering to terrain-oriented cell and edge draw functions.

## Public Exports And Callers

Exports `classifySeaLand(settings, map)` plus `TERRAIN_SEA`, `TERRAIN_LAND`, and `TERRAIN_COAST`. It is registered as the `"Coast"` process and is tested directly by validation.

## Inputs And Outputs

Input is a map with cells and edges. Settings come from `settings.coast` and `settings.rng`. Output is the same map object after mutation, with cell `type` set to `SEA` or `LAND`, edge flags set to `SEA`, `LAND`, or `COAST`, terrain draw functions installed, and node drawing disabled.

## Algorithm

The step normalizes coast settings and sea borders, derives a numeric noise seed from the step RNG, samples each cell at its center, edge midpoints, and optional deterministic interior samples, then classifies the cell by whether most samples exceed the land threshold. It optionally smooths terrain by weighted neighboring edge length, removes tiny isolated terrain artifacts, classifies each edge from adjacent terrain or inferred boundary terrain, and updates flags and draw functions.

## Mutation And Identity

The step mutates cells, edges, flags, and draw functions in place. It does not create or remove graph entities. Edge classification relies on `leftCell` and `rightCell` references remaining valid.

## Determinism

Random interior samples and the noise seed come from `settings.rng`. Noise itself is deterministic for the derived seed and coordinates.

## Dependencies

Imports `orderedCellPoints` and `valueNoise2D`.

## Edge Cases And Limitations

Missing neighboring cells are inferred from boundary side and configured sea borders; non-boundary missing neighbors default to land. The current validation case has a known inconsistency in its synthetic map setup, which can expose assumptions about whether all cell edges are also present in `map.edges`.

The current `npm test` failure is in `validateSeaLandStepClassifiesAndTags`, where the expected shared edge is not flagged as `COAST`. The failure is relevant when changing this module because edge classification depends on valid `leftCell` and `rightCell` references and on the edge being part of `map.edges`.
