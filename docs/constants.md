# constants.mjs

Source: `js/constants.mjs`

## Role

Defines default numeric constants used by `Settings`.

## Public Exports And Callers

Exports `SIZE`, `POI_NB`, `SAFE_ZONE`, and `PRUNE_THRESHOLD`. `js/data/settings.mjs` imports these to build default settings.

## Inputs And Outputs

There are no runtime inputs. The output is a set of module constants.

## Control Flow

The module has no control flow beyond exporting constants.

## Mutation And Identity

No map data is created or mutated.

## Determinism

Constants are stable values and contain no RNG usage.

## Dependencies

No imports.

## Edge Cases And Limitations

Changing these values affects newly constructed default settings, but does not migrate settings already read from the UI.
