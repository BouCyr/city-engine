# cell.mjs

Source: `js/data/cell.mjs`

## Role

Defines the cell factory and helpers for ordering polygon points from a cell's edges.

## Public Exports And Callers

Exports `Cell(id, edges, fill, drawFn = null, flags = [])` and `orderedCellPoints(cell)`. Gather creates cells. Lloyd and Coast read ordered points. Cell draw functions use `orderedCellPoints`.

## Inputs And Outputs

`Cell` takes an id, edge array, fill value, optional draw function, and flags. It returns a plain cell object with `type: "Cell"`, `edges`, `flags`, `fill`, and `draw`.

## Control Flow

The default draw function creates an SVG polygon in the `cells` layer. `orderedCellPoints` walks the cell edge list by following shared node references from one edge to the next.

## Mutation And Identity

Cells reference canonical edge objects from `map.edges`. `orderedCellPoints` depends on identity equality between edge endpoints. It does not mutate the cell.

## Determinism

No RNG is used. Output depends only on cell edge order and endpoint coordinates.

## Dependencies

No imports.

## Edge Cases And Limitations

If cell edges are not ordered or do not form a connected loop, `orderedCellPoints` may stop early or return an odd polygon. Empty cells return no points; one-edge cells return the two endpoints.
