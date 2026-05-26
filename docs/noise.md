# noise.mjs

Source: `js/data/noise.mjs`

## Role

Provides deterministic 2D value noise helpers used by terrain classification.

## Public Exports And Callers

Exports `valueNoise2D(x, y, scale, seed = 0)` and `fbmNoise2D(x, y, settings = {})`. Coast currently imports `valueNoise2D`.

## Inputs And Outputs

Inputs are coordinates, scale, seed, and optional amplitude/scale layer settings. Outputs are numeric noise values. `valueNoise2D` returns a smooth value in roughly `[0, 1]`; `fbmNoise2D` combines signed octave values and returns a weighted displacement.

## Control Flow

The module hashes integer lattice coordinates, smooths fractional positions with `fade`, interpolates four lattice values, and combines layers for fBm-style output.

## Mutation And Identity

No map data is created or mutated.

## Determinism

All outputs are deterministic for the same inputs. The module does not use the pipeline RNG directly.

## Dependencies

No imports.

## Edge Cases And Limitations

`scale` should be positive. `fbmNoise2D` returns `0` when total amplitude is non-positive.
