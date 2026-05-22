You are given an already-generated planar map made of polygonal cells.

Each cell:

* has a polygon shape
* has a center point `(x,y)`
* knows its neighboring cells
* belongs to a map of size `3000 x 3000`
* the map contains roughly `600` cells total

Your task is to classify each cell as either:

* `SEA`
* `LAND`

Input:

* a set of sea-facing borders among `{NORTH, SOUTH, EAST, WEST}`

Examples:

* `{WEST}`
* `{NORTH, WEST}`
* `{ALL}`
* `{SOUTH}`

Goal:
Generate coastlines that feel organic and geographical rather than geometric or grid-like.

Important constraints:

* Preserve the existing cell topology
* Do not modify cell adjacency
* Do not split or merge cells
* The coastline should emerge naturally from the classification
* Coastlines should contain:

  * bays
  * peninsulas
  * coves
  * occasional islands
  * irregular large-scale shapes
* Avoid:

  * straight coastlines
  * checkerboard noise
  * isolated one-cell artifacts
  * obvious Voronoi patterns

Algorithm requirements:

1. Build a continuous "distance-from-sea" field

For every point `(x,y)`, compute a normalized distance to the nearest sea-designated border.

Examples:

WEST sea:

```text
distance = x / width
```

EAST sea:

```text
distance = (width - x) / width
```

NORTH sea:

```text
distance = y / height
```

SOUTH sea:

```text
distance = (height - y) / height
```

If multiple sea borders exist:

```text
distance = minimum(distance_to_each_sea_border)
```

2. Warp the field using layered coherent noise

Use multiple scales of smooth noise (Perlin/Simplex/Fbm/etc.):

* large continental deformation
* medium coastal variation
* small local irregularities

Suggested scales for a `3000x3000` map:

```text
large scale  ≈ 900
medium scale ≈ 350
small scale  ≈ 120
```

Suggested amplitudes:

```text
0.18 large
0.08 medium
0.03 small
```

Combine:

```text
field =
    baseDistance
  + largeNoise
  + mediumNoise
  + smallNoise
```

3. Generate land/sea classification

Choose a coastline threshold.

Example:

```text
SEA if field < 0.28
LAND otherwise
```

4. Support islands and sea intrusions

Allow secondary noise perturbations to create:

* islands
* inland bays
* narrow peninsulas

But:

* keep them sparse
* preserve readability
* avoid speckled noise

5. Classify cells robustly

Do NOT classify using only the cell center.

Instead:

* sample several points inside each polygon
* center
* edge midpoints
* random interior samples

Compute:

```text
landRatio = landSamples / totalSamples
```

Then:

```text
LAND if landRatio > 0.5
SEA otherwise
```

6. Post-process topology

Run smoothing passes.

Examples:

* isolated sea cells inside land become land
* isolated land cells inside sea become sea

Use neighbor counts weighted by shared edge length if available.

Preserve:

* connectivity between sea cells and designated sea borders
* large coherent coastlines

Optionally:

* remove tiny disconnected seas
* preserve larger islands

Desired visual result:

* believable coastlines
* smooth continental masses
* natural asymmetry
* readable silhouettes
* geography-like shapes rather than procedural-looking noise

Output:
Return the original cells with:

```text
cell.type = LAND | SEA
```

Optionally also output:

* coastline cells
* island groups
* connected sea regions
* distance field values
