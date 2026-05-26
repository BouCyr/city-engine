# settings-panel.mjs

Source: `js/ui/settings-panel.mjs`

## Role

Renders the settings form, reads user input into a `Settings` object, and notifies the app when settings change.

## Public Exports And Callers

Exports `createDefaultSettings()` and `initSettingsPanel(panel, onChange)`. `js/app.js` uses both.

## Inputs And Outputs

Inputs are a panel DOM element and an `onChange` callback. Output is rendered form DOM and an object with `readSettings()`.

## Control Flow

The module renders sections from `SETTING_GROUPS`, creates controls by type, attaches input/change/reset handlers, and reconstructs settings with `readSettingsFromForm`. Reset buttons write default values back to controls.

## Mutation And Identity

It mutates only DOM controls and returns new settings objects. It does not access map graph data.

## Determinism

No RNG is used directly. The seed and numeric values it reads determine the pipeline's deterministic output.

## Dependencies

Imports `Settings` and `SETTING_GROUPS`.

## Edge Cases And Limitations

Number and range controls fall back to default values when input is not finite. Checkbox lists return selected strings. `createDefaultSettings` uses the default seed from a module-level default settings object.
