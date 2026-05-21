# AGENTS.md

## Project Goal

This project generates a deterministic medieval-feeling city map from a seed and settings.
Generation is organized as an ordered pipeline of steps. Each step receives the current `Map`
object and returns the next `Map` object, which is then passed to the following step.

Every step result is kept in memory so the UI can display the generation progress step by step.

## Core Architecture Rules

- Keep the `Map` model clean and close to its existing shape in `js/data/map.mjs`.
- Prefer small data modules under `js/data/` and step modules under `js/steps/`.
- A generation step must be deterministic for the same seed and settings.
- Each generation step should derive its own deterministic RNG from the global seed and the step name. Avoid relying on a single shared RNG stream across the full pipeline.
- A generation step must expose a `process(settings, map)`-compatible function and be registered in `js/steps.mjs`.
- Step modules should focus on generation logic. Avoid mixing UI concerns into generation steps.
- Drawing helpers may live on map objects, nodes, or edges as the current model already does, but the data model must remain easy to inspect and reason about.
- Drawing functions are part of the generated map model. Stored step maps should keep their drawing functions so each snapshot remains directly renderable.
- Keep nodes and edges as the core graph entities. POIs are a specific kind of node, not a separate canonical entity type.
- Expected future map entities are `areas` and `cells`; introduce them as first-class map data only when the generation pipeline needs them.

## Map Identity And Deduplication Invariants

The in-memory map graph must stay deduplicated.

- A node referenced by an `Edge` must be the exact same object instance as the corresponding node in `map.nodes`.
- Do not create detached node copies just to attach them to edges.
- When creating an edge, pass node references obtained from the current map, usually from `map.nodes`.
- If cloning or snapshotting maps, preserve internal identity relationships. For example, if two edges reference the same node, their cloned references must point to the same cloned node object.
- Do not use JSON serialization for map snapshots unless it is replaced with a structured clone strategy that preserves the required graph relationships and functions where needed.
- Avoid storing duplicate canonical entities in side arrays. If lookup speed is needed, build temporary indexes from `map.nodes` or `map.edges` instead of creating a second source of truth.

## Step Result Memory

- The UI keeps every generated step result in memory so users can inspect progression.
- Treat stored step results as snapshots. Later steps should not accidentally mutate earlier visible results.
- Generation steps may mutate the incoming `Map`. The pipeline gives each step a fresh deep copy in `js/app.js`, so mutation inside a step is acceptable as long as the step returns the resulting map.
- Map snapshotting is handled by full deep copies in `js/app.js` before each step is called. Preserve this behavior when changing the pipeline.
- If a step mutates and returns the incoming `map`, ensure the snapshot mechanism still protects prior steps.
- If a step creates a fresh `Map`, carry forward any entities that must survive into the next stage by reference-consistent copying.

## Current Files Of Interest

- `js/data/map.mjs`: `Map` factory and map-level drawing/clearing.
- `js/data/nodes.mjs`: node/POI factories.
- `js/data/edge.mjs`: edge factory; edge endpoints must reference nodes from `map.nodes`.
- `js/data/settings.mjs`: deterministic settings and per-step RNG setup.
- `js/data/RNG.mjs`: deterministic random generator.
- `js/steps.mjs`: ordered list of generation steps.
- `js/steps/`: generation step implementations.
- `js/pipeline.mjs`: pipeline execution and step snapshot storage.
- `js/app.js`: UI initialization and rendering.

## Development Commands

- `npm start`: run the webpack dev server.
- `npm run build`: produce a production build.
- `npm test`: run lightweight AGENTS.md compliance validation for deterministic RNG, map cloning, snapshot isolation, and graph identity.

## Coding Guidelines

- Use ES modules consistently.
- Prefer factories and plain objects unless the project intentionally moves to classes.
- Keep deterministic behavior explicit: all random choices should come from the step's deterministic RNG derived from the global seed and step name.
- Keep changes narrowly scoped to the generation model, steps, or UI area being worked on.
- Add tests or lightweight validation when changing identity-sensitive map behavior.
- Before changing cloning/snapshot behavior, verify that edge endpoints still reference the canonical nodes inside the same cloned map.
