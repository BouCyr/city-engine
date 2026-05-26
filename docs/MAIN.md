# JavaScript Pipeline Documentation

This documentation covers the JavaScript generation pipeline only. It excludes CSS, HTML, build configuration, static assets, prompts, IDE files, and `js/vendor/.gitkeep`.

## Architecture

City generation starts with a `Settings` object, runs the ordered generation pipeline, stores a renderable snapshot for each stage, and lets the UI render either the final map or a selected step result.

The main flow is:

1. `js/app.js` creates default settings and initializes the settings panel.
2. `js/pipeline.mjs` creates a `Map`, runs each registered step, and records snapshots.
3. Each step receives `{...settings, rng: settings.createStepRng(step.title)}` so randomness is deterministic per seed and step title.
4. Step outputs are cloned with `cloneDeepKeepFunctions` before storage so earlier snapshots remain inspectable.
5. `js/app.js` renders the active snapshot by calling the map-level `clear` and `draw` functions.

## Generation Flow

The registered steps in `js/steps.mjs` currently run in this order:

1. Scatter: creates initial POI nodes from deterministic random coordinates.
2. Gather: builds Voronoi cells, nodes, and edges from POIs.
3. Lloyd: replaces POIs with cell centroids and rebuilds the Voronoi graph.
4. Prune: repeatedly merges short edges and rewires affected graph references.
5. Coast: classifies cells and edges as sea, land, or coast and changes drawing behavior for terrain display.

## Core Model

`Map` is a plain object with `size`, `nodes`, `edges`, `cells`, `draw`, and `clear`. Nodes and edges are the core graph entities. POIs are nodes with type `POI`; Voronoi vertices are nodes with type `Voronoi`. Cells own ordered edge lists and are first-class map data for the current pipeline.

Nodes, edges, and cells carry `flags` as `Set` instances. Drawing functions live directly on map entities, so snapshots must preserve functions as well as graph references.

## Snapshot And Identity Invariants

The pipeline deep-clones the map before each step and after each step result. `cloneDeepKeepFunctions` has map-specific logic so cloned edges point to cloned nodes from `map.nodes`, cloned cells point to cloned edges from `map.edges`, and node `edges` sets contain the cloned edge objects.

Generation steps may mutate their input map because the pipeline gives them a fresh clone. Stored step results should be treated as snapshots and should not be mutated by later stages.

## Settings And UI

`Settings` supplies defaults, grouped setting metadata, and per-step RNG creation. `js/ui/settings-panel.mjs` renders controls from `SETTING_GROUPS`, reads typed values back into a new `Settings` object, and triggers debounced regeneration through `js/app.js`.

The UI stores all `stepResults`, tracks selected and hovered steps, and renders the map for the active step. Step descriptions are declared beside the registered step metadata in `js/steps.mjs`.

## Index

- [app.md](app.md)
- [constants.md](constants.md)
- [pipeline.md](pipeline.md)
- [steps.md](steps.md)
- [validate-agents.md](validate-agents.md)
- [RNG.md](RNG.md)
- [cell.md](cell.md)
- [clone.md](clone.md)
- [edge.md](edge.md)
- [map.md](map.md)
- [nodes.md](nodes.md)
- [noise.md](noise.md)
- [settings.md](settings.md)
- [settings-panel.md](settings-panel.md)
- [000-scatter.md](000-scatter.md)
- [001-gather.md](001-gather.md)
- [002-lloyd.md](002-lloyd.md)
- [003-prune.md](003-prune.md)
- [004-sea-land.md](004-sea-land.md)
