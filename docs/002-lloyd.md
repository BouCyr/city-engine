# 002-lloyd.mjs

Source: `js/steps/002-lloyd.mjs`

## Role

Lloyd relaxes the Voronoi diagram by moving each site to the centroid of its current cell, then rebuilding the Voronoi graph.

## Public Exports And Callers

Exports `relax(settings, map)`. It is registered as the `"Lloyd"` process in `js/steps.mjs`.

## Inputs And Outputs

Input is a map with cells from Gather. Output is a fresh Voronoi map returned by calling Gather on a temporary map of centroid POIs.

## Algorithm

For each cell, the step gets ordered polygon points, skips cells with fewer than three points, computes the polygon centroid using the signed area formula, falls back to an average point for near-zero area, creates a replacement POI, then calls `cells(settings, sitesMap)`.

## Mutation And Identity

The input map is read only. The temporary sites map and returned Voronoi map are fresh objects. Identity invariants are delegated to Gather for the rebuilt graph.

## Determinism

No RNG is used, even though the pipeline supplies `settings.rng`. The same input geometry produces the same relaxed geometry.

## Dependencies

Imports `orderedCellPoints`, `Map`, `Poi`, and Gather's `cells`.

## Edge Cases And Limitations

Cells with invalid or unordered edge loops can produce bad centroids or be skipped. Skipped cells reduce the number of sites in the rebuilt graph.
