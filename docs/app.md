# app.js

Source: `js/app.js`

## Role

This is the browser entry point. It initializes settings, runs the generation pipeline, stores the current final map and all step snapshots, lazily requests replay frames from a worker, and wires the SVG, step list, details panel, and settings panel together.

## Public Exports And Callers

Exports `settings`, `map`, and `stepResults` as live module bindings. Other modules can inspect these values after initialization, but this file is primarily called by the browser bundle.

## Inputs And Outputs

Inputs come from DOM elements (`map_svg`, `steps-list`, `details`, `settings-toggle`, `settings-panel`) and settings read from `initSettingsPanel`. Output is DOM mutation: SVG layers are cleared and redrawn, step list items are rendered, and step detail text is updated.

## Control Flow

On load, the module grabs the SVG, initializes the settings panel, builds the step list UI, initializes the settings toggle, runs `regenerate`, and clears the details panel. `regenerate` calls `runPipeline(settings)`, updates `map` and `stepResults`, and renders the active map. Settings changes are debounced by `scheduleRegeneration`. When a step explanation opens, replay is requested for the selected step through `replay-worker.mjs` and hydrated back into renderable frame maps when ready.

## Mutation And Identity

`app.js` does not directly mutate map graph internals. It stores the final `map` returned by the pipeline and the cloned step snapshots returned in `stepResults`. Lazy replay requests attach hydrated replay frames to the selected step result. Rendering calls `displayMap.clear(svgDomElt)` and `displayMap.draw(svgDomElt)`, relying on entity draw functions preserved or rehydrated in snapshots.

## Determinism

This file does not use random values. Determinism depends on the settings object passed into `runPipeline`.

## Dependencies

Depends on `steps`, `runPipeline`, replay serialization helpers from `js/replay-service.mjs`, and the settings panel helpers from `js/ui/settings-panel.mjs`.

## Edge Cases And Limitations

If expected DOM nodes are missing, some initializers return early. `renderStepDetails` assigns `innerHTML` from step description strings, so descriptions must remain trusted local content.
