# ISSUES

This document lists issues left to be resolved.

## Tributary clipping

When clipping the goemtry with the tributary shape, clipping is done only on tributary cells and not on the main channel..

If the tributary "spills" on a neighboring cell when given width, the neighboring cell is not clipped.

## Crossing

A crossing MUST be a single edge, connecting two LAND_CROSSING nodes, i.e. two LAND nodes.

## Needles correction
see seed `zwjmilop` : something is not working on the south side of the map.
A needle is not removed (or two very close nodes?), making the map shape being distorted on coast smoothing.
