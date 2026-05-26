# 003-prune.mjs

Source: `js/steps/003-prune.mjs`

## Role

Prune removes short edges by repeatedly merging their endpoint nodes and rewiring affected edges.

## Public Exports And Callers

Exports `prune(settings, map)`. It is registered as the `"Prune"` process and is tested directly by validation.

## Inputs And Outputs

Input is a graph map with nodes, edges, and optionally cells. It returns the same map object after mutation. `settings.prune.threshold` controls the maximum edge length to remove.

## Algorithm

The step finds the shortest edge whose squared length is below the threshold. It merges endpoint coordinates, respecting boundary sides and rejecting opposite-boundary merges, creates a new node, removes the old edge and endpoint nodes, rewires all touching edges to the merged node, and removes any touched cells with fewer than three remaining edges. The loop repeats until no short edge remains.

## Mutation And Identity

This step mutates `map.nodes`, `map.edges`, cells, edge endpoints, and node `edges` sets. Remaining edges should point to nodes in the current `map.nodes`. The removed edge is detached from its endpoint sets before deletion.

## Determinism

No RNG is used. The result depends on current edge order when equal-length candidates exist, because the first shortest candidate encountered wins.

## Dependencies

Imports `Node`.

## Edge Cases And Limitations

The cleanup only starts from the removed edge's left and right cells. Neighboring cells affected by rewired adjacent edges are not explicitly revalidated, so adjacency metadata can become stale in more complex cases. Merging nodes on opposite map boundaries throws an error.
