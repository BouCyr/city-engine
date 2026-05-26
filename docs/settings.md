# settings.mjs

Source: `js/data/settings.mjs`

## Role

Defines the runtime settings object and the metadata used to render the settings UI.

## Public Exports And Callers

Exports `Settings(seed = "seed")` and `SETTING_GROUPS`. The app and settings panel create settings. The pipeline relies on `createStepRng`.

## Inputs And Outputs

`Settings` takes a seed string and returns a plain object with seed, map size, grouped generation settings, and `createStepRng(stepName)`. `SETTING_GROUPS` is an array of UI definitions with paths, labels, control types, constraints, and help text.

## Control Flow

Defaults are pulled from `constants.mjs`. `createStepRng` combines the global seed and step name before calling `createRNG`.

## Mutation And Identity

Settings are plain mutable objects. The settings panel creates new settings objects from form values rather than mutating the currently running map.

## Determinism

Per-step RNG seeding is the main determinism mechanism. The same seed and step title produce the same stream regardless of other step streams.

## Dependencies

Imports constants and `createRNG`.

## Edge Cases And Limitations

Changing a step title changes its RNG stream. UI metadata paths must match properties on the `Settings` object or reads and resets will fall back incorrectly.
