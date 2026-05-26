# 001-gather.mjs

Source: `js/steps/001-gather.mjs`

## Role

Gather converts POI nodes into a bounded Voronoi graph: cells, Voronoi vertices, and deduplicated edges.

## Public Exports And Callers

Exports `cells(settings, map)`. It is registered as the `"Gather"` process and is also called by Lloyd after centroid relaxation.

## Inputs And Outputs

Input map nodes of type `POI` are treated as sites. Output is a fresh `Map` whose `cells` cover the square map bounds, whose `nodes` are Voronoi vertices, and whose `edges` are cell boundaries with optional `Boundary` flags.

## Algorithm

For each site, the step starts with the full square map polygon and clips it against every other site's perpendicular bisector, keeping the half-plane closer to the current site. It removes duplicate consecutive points, skips degenerate polygons, creates or reuses nodes by rounded coordinate key, creates or reuses undirected edges by endpoint key, assigns left/right cell references based on side-of-edge, and pushes the cell.

## Mutation And Identity

The incoming map is read only. The output map is built from scratch. Node and edge indexes deduplicate geometry so shared boundaries use the same edge objects and edge endpoints are the same node objects stored in `result.nodes`. Edge factories populate endpoint node `edges` sets.

## Determinism

No RNG is used. Output depends on input POI coordinates, site order, map size, and floating-point math.

## Dependencies

Imports `Cell`, `Edge`, `Map`, and `Node`.

## Edge Cases And Limitations

Very close points or floating-point precision can create tiny edges or skipped polygons. Point keys round to `KEY_PRECISION`, which deduplicates near-identical vertices but can merge coordinates within that tolerance. Empty or missing POI input produces an empty graph.
