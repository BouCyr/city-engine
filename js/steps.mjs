import * as SCATTER  from "./steps/000-scatter.mjs";
import * as GATHER  from "./steps/001-gather.mjs";
import * as LLOYD  from "./steps/002-lloyd.mjs";
import * as PRUNE  from "./steps/003-prune.mjs";
import * as SEA_LAND from "./steps/004-sea-land.mjs";

export const steps = [

  {title:"Scatter",
    process: SCATTER.scatterPoints,
    createReplay: SCATTER.createReplay,
    description: (settings, stepMap) => [
      `The first generation step creates the initial city anchors, called <em>points of interest</em>, by sampling random coordinates in the map.`,
      `Using the step seed stream, it places <em>${settings.scatter.nb}</em> points so every run stays deterministic.`,
      `Each point is constrained to stay inside the map bounds, between <em>${settings.scatter.safeZone}</em> and <em>${settings.size - settings.scatter.safeZone}</em> on both X and Y axes, which leaves a free border margin of <em>${settings.scatter.safeZone}</em> around the map.`,
    ],
    explanation: (settings, stepResult) => [
      `Scatter is the point-seeding step. It creates the initial POI nodes that later steps convert into cells and edges.`,
      `The replay starts with the incoming map, then adds one POI per frame. Each point uses the Scatter-specific RNG stream derived from <em>${settings.seed}</em> and the step name, so replay and generation stay in lockstep.`,
      `For these settings, the sampled coordinates stay within <em>${settings.scatter.safeZone}</em> and <em>${settings.size - settings.scatter.safeZone}</em> on both axes, producing <em>${stepResult?.map?.nodes?.length ?? settings.scatter.nb}</em> POIs in the final frame.`,
    ],

  },
  {
    title:"Gather",
    process:GATHER.cells,
    description: (settings, stepMap) => [
      `This step turns the scattered points into a Voronoi diagram. In practical terms, each point owns a polygonal territory: every location inside a given polygon is closer to that point than to any other point.`,
      `The result is a partition of the map into neighboring cells, so the full map of size <em>${settings.size}x${settings.size}</em> becomes fully covered by cell boundaries and shared edges.`,
      `After this pass, the map contains <em>${stepMap?.cells?.length ?? 0}</em> cells, <em>${stepMap?.nodes?.length ?? 0}</em> Voronoi nodes, and <em>${stepMap?.edges?.length ?? 0}</em> boundary-aware edges, which gives the rest of the pipeline concrete geometry to work with.`,
    ],
  },
  {
    title:"Lloyd",
    process:LLOYD.relax,
    description: (settings, stepMap) => [
      `Lloyd relaxation relocates each city anchor to the center of its current cell, smoothing the diagram and making cell areas more regular and balanced.`,
      `It computes a centroid for each existing cell, replaces each original point, and then rebuilds a fresh Voronoi pass from those new points so the map is rebalanced without changing map size or bounds (<em>${settings.size}</em> by <em>${settings.size}</em>).`,
      `The operation is deterministic: the same seed and map state always produce the same relaxed layout.`,
    ],
  },
  {
    title:"Prune",
    process:PRUNE.prune,
    description: (settings, stepMap) => [
      `This step removes geometric noise by deleting short edges repeatedly until the entire graph has no edge shorter than <em>${settings.prune.threshold}</em>.`,
      `When a short edge is removed, its two endpoint nodes are merged and neighboring edges are rewired to keep the graph connected with consistent node references inside the current map.`,
      `The process is repeated after each merge so the result remains stable and clean, while keeping node identities and boundary constraints consistent with the existing map.`,
    ],
  },
  {
    title:"Coast",
    process:SEA_LAND.classifySeaLand,
    description: (settings, stepMap) => [
      `This step classifies each current cell into <em>SEA</em> or <em>LAND</em> by combining a distance-from-sea-border field with layered deterministic noise.`,
      `It stores terrain in <em>cell.type</em> and flags, updates every edge as <em>SEA</em>, <em>LAND</em>, or <em>COAST</em>, and then renders nodes as hidden for this terrain-only view.`,
    ],
  },
]
