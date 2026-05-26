# validate-agents.mjs

Source: `js/validate-agents.mjs`

## Role

Runs lightweight AGENTS.md compliance checks for clone identity, snapshot isolation, per-step RNG determinism, Voronoi generation, drawing hooks, prune behavior, and sea/land classification.

## Public Exports And Callers

No exports. It is executed as a Node script by `npm test`.

## Inputs And Outputs

Inputs are imported modules and synthetic maps built inside the script. Output is process success or an assertion failure. On success it logs `AGENTS.md compliance validation passed`.

## Control Flow

The script defines focused validation functions, then calls them sequentially. It uses `node:assert/strict` and small SVG probes to exercise drawing functions without a browser.

## Mutation And Identity

Many tests intentionally mutate or inspect graph identity. They check that cloned edges reference cloned nodes, node `edges` sets are populated, snapshots draw from cloned coordinates, and prune rewires remaining edges to merged nodes.

## Determinism

The script verifies that `Settings.createStepRng` returns repeatable streams per step and independent streams between step names.

## Dependencies

Imports clone, map, node, edge, cell, settings, pipeline, Gather, Lloyd, Prune, and Coast modules.

## Edge Cases And Limitations

These are lightweight structural checks, not exhaustive geometry tests. The current sea/land validation builds duplicate split edges and omits one pushed edge (`splitB`) from `map.edges`, so it is sensitive to assumptions about cell-edge and map-edge consistency.

At the time of this documentation, `npm test` fails in `validateSeaLandStepClassifiesAndTags` at the assertion that the synthetic shared edge has the `COAST` flag. This is a validation/runtime consistency issue, not caused by the documentation files.
