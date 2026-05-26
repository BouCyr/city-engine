# 000-scatter.mjs

Source: `js/steps/000-scatter.mjs`

## Role

Scatter is the first generation step. It creates the initial POI nodes that later steps turn into Voronoi cells.

## Public Exports And Callers

Exports `scatterPoints(settings, map)`. It is registered as the `"Scatter"` process in `js/steps.mjs`.

## Inputs And Outputs

Inputs are step settings with `scatter.nb`, `scatter.safeZone`, `size`, and `rng`. The incoming `map` argument is not used. Output is a fresh `Map` containing `scatter.nb` POI nodes and no edges or cells.

## Algorithm

The step samples `x` and `y` coordinates with `rng.between(margin, mapSize - margin)` for each point, creates `Poi("POI${i}", x, y)`, and pushes it into the result map.

## Mutation And Identity

It creates a fresh map instead of mutating the incoming map. All nodes in the result are canonical entries in `result.nodes`; there are no edges yet.

## Determinism

All random values come from `settings.rng`, which the pipeline derives from the global seed and the `"Scatter"` step title.

## Dependencies

Imports `Poi` through `nodes.mjs` and `Map`.

## Edge Cases And Limitations

If `safeZone` is greater than half the map size, the min/max range is inverted and sampled coordinates can be surprising. The step does not validate `scatter.nb`.
