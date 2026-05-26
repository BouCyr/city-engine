# edge.mjs

Source: `js/data/edge.mjs`

## Role

Defines the edge factory and default edge drawing behavior.

## Public Exports And Callers

Exports `Edge(id, start, end, type, drawFn = null, flags = [])`. Gather, tests, and other graph-building code use it to create edges.

## Inputs And Outputs

Inputs are an id, start node, end node, type, optional draw function, and flags. Output is a plain edge object with endpoint references, `flags`, `leftCell`, `rightCell`, and `draw`.

## Control Flow

The factory creates the edge, registers it in `start.edges` and `end.edges` if those sets exist, and returns the edge. The default draw function appends an SVG path to the `edges` layer.

## Mutation And Identity

`Edge` mutates endpoint node `edges` sets. Callers must pass node objects from the current `map.nodes` array, not detached copies, so graph identity stays deduplicated.

## Determinism

No RNG is used.

## Dependencies

No imports.

## Edge Cases And Limitations

The factory does not validate that endpoints are in a map. It allows self-edges and duplicate edges unless callers deduplicate them.
