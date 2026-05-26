# map.mjs

Source: `js/data/map.mjs`

## Role

Defines the map factory and map-level SVG clearing and drawing.

## Public Exports And Callers

Exports `Map(settings)`. The pipeline creates the initial map, steps create fresh maps when rebuilding geometry, and tests use it for synthetic maps.

## Inputs And Outputs

Input is a settings object with `size`. Output is a plain map object with `size`, `nodes`, `edges`, `cells`, `draw`, and `clear`.

## Control Flow

`draw` renders cells first, then nodes, then edges, filtering for entities with a `draw` function. `clear` empties the `#cells`, `#nodes`, and `#edges` SVG groups if they exist.

## Mutation And Identity

The map arrays are canonical stores for graph entities. Drawing does not mutate graph data, but `clear` mutates the DOM. Steps are expected to keep edge endpoints aligned with objects in `map.nodes`.

## Determinism

No RNG is used.

## Dependencies

No imports.

## Edge Cases And Limitations

`draw` logs `"draw"` on every render. If the SVG lacks expected layers, drawing functions on entities may fail unless they guard against missing layers.
