# clone.mjs

Source: `js/data/clone.mjs`

## Role

Deep-clones arbitrary values while preserving functions and providing special graph-aware cloning for map objects.

## Public Exports And Callers

Exports `cloneDeepKeepFunctions(value, seen = new WeakMap())`. `runPipeline` uses it for pre-step clones and stored snapshots. Validation imports it directly.

## Inputs And Outputs

Input is any value. Primitive values and functions are returned as-is. Arrays, sets, plain objects, and map graphs are cloned. Map graph clones contain cloned nodes, edges, and cells with internal references rebuilt consistently.

## Control Flow

The function uses a `WeakMap` to handle cycles and shared references. If a value looks like a map graph, `cloneMapGraph` clones non-graph properties, clones nodes without their edge sets, clones edges while replacing endpoints with cloned nodes, clones cells while replacing edge references with cloned edges, then reconnects cloned edge cell references.

## Mutation And Identity

This module is central to graph identity invariants. In a cloned map, every edge endpoint should be the same object instance as a node in `clone.nodes`, every cell edge should be from `clone.edges`, and cloned node `edges` sets should contain the corresponding cloned edges.

## Determinism

No RNG is used. Clones preserve array order and object property traversal order.

## Dependencies

No imports. It uses `globalThis.Map` to avoid colliding with the project `Map` factory name.

## Edge Cases And Limitations

The special map path is selected structurally by `nodes`, `edges`, `cells`, `draw`, and `clear`. Detached edge endpoints or cell edges not present in the source map arrays can clone to `undefined` references.
