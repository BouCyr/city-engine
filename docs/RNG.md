# RNG.mjs

Source: `js/data/RNG.mjs`

## Role

Provides a small deterministic pseudo-random API for generation steps.

## Public Exports And Callers

Exports `createRNG(seed = "seed")`. `Settings.createStepRng` calls it with `${seed}:${stepName}`.

## Inputs And Outputs

Input is a string seed. Output is an object with `next()`, `between(min, max)`, and `pick(items)`.

## Control Flow

The seed is hashed with `xmur3` to initialize a 32-bit state. `next` advances a mulberry-style integer generator and returns a float in `[0, 1)`. `between` scales that value into a numeric range. `pick` indexes an array by a random position.

## Mutation And Identity

The RNG object mutates its private `state` on every `next` call. It does not touch map data.

## Determinism

The same seed and call sequence produce the same outputs. Independent RNG objects created with the same seed restart the same sequence.

## Dependencies

No imports.

## Edge Cases And Limitations

`pick([])` returns `undefined` because the computed index is invalid. Seeds are handled as strings by callers; non-string seeds would rely on `.length` and `charCodeAt`.
