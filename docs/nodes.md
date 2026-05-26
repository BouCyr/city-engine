# nodes.mjs

Source: `js/data/nodes.mjs`

## Role

Defines factories for graph nodes and POI nodes.

## Public Exports And Callers

Exports `Poi(id, x, y, drawFn = null, flags = [])` and `Node(id, x, y, type, drawFn = null, flags = [])`. Scatter creates POIs; Gather and Prune create Voronoi or merged nodes.

## Inputs And Outputs

Inputs are identifiers, coordinates, type, optional draw function, and flags. Output is a plain node object with `id`, `x`, `y`, `type`, `flags`, `edges`, and `draw`.

## Control Flow

`Poi` delegates to `Node` with type `POI`. `Node` initializes `flags` and `edges` as `Set` instances and assigns either a caller-supplied draw function or the default SVG circle draw function.

## Mutation And Identity

The node `edges` set is maintained by `Edge` creation and by graph rewiring code. Nodes should live in `map.nodes` and be referenced directly by edges.

## Determinism

No RNG is used.

## Dependencies

No imports.

## Edge Cases And Limitations

The default draw function assumes an SVG `nodes` layer exists. The factory does not enforce unique ids or map membership.
