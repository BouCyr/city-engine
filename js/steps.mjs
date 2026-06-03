import * as SCATTER  from "./steps/000-scatter.mjs";
import * as GATHER  from "./steps/001-gather.mjs";
import * as LLOYD  from "./steps/002-lloyd.mjs";
import * as PRUNE  from "./steps/003-prune.mjs";
import * as SEA_LAND from "./steps/004-sea-land.mjs";
import * as RIVERS from "./steps/005.2-rivers.mjs";


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
    createReplay: GATHER.createReplay,
    description: (settings, stepMap) => [
      `This step turns the scattered points into a Voronoi diagram. In practical terms, each point owns a polygonal territory: every location inside a given polygon is closer to that point than to any other point.`,
      `The result is a partition of the map into neighboring cells, so the full map of size <em>${settings.size}x${settings.size}</em> becomes fully covered by cell boundaries and shared edges.`,
      `After this pass, the map contains <em>${stepMap?.cells?.length ?? 0}</em> cells, <em>${stepMap?.nodes?.length ?? 0}</em> Voronoi nodes, and <em>${stepMap?.edges?.length ?? 0}</em> boundary-aware edges, which gives the rest of the pipeline concrete geometry to work with.`,
    ],
    explanation: (settings, stepResult) => [
      `Gather builds one bounded Voronoi cell per valid POI by starting with the full <em>${settings.size}x${settings.size}</em> square and repeatedly clipping it to the half-plane closer to the active POI than to each competing POI.`,
      `The replay advances by completed cell, while the current frame overlays the active site, nearby competitors, perpendicular bisectors, and the final clipped polygon so the clipping process remains readable even with many POIs.`,
      `When a cell polygon is accepted, its vertices and edges are deduplicated through rounded coordinate and endpoint keys, so neighboring cells share the same node and edge objects in the generated graph. The final frame contains <em>${stepResult?.map?.cells?.length ?? 0}</em> cells, <em>${stepResult?.map?.nodes?.length ?? 0}</em> nodes, and <em>${stepResult?.map?.edges?.length ?? 0}</em> edges.`,
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
    createReplay: SEA_LAND.createReplay,
    description: (settings, stepMap) => [
      `This step classifies each current cell into <em>SEA</em> or <em>LAND</em> by combining a weighted distance-from-sea-border field, selected sea-corner bias, and layered deterministic noise.`,
      `It stores terrain in <em>cell.type</em> and flags, updates every edge as <em>SEA</em>, <em>LAND</em>, or <em>COAST</em>, and then renders nodes as hidden for this terrain-only view.`,
    ],
    explanation: (settings, stepResult) => [
      `Coast turns the pruned cell graph into terrain by measuring weighted distance from the selected sea borders, then favoring selected sea-border corners before bending the field with deterministic large, medium, and small noise layers.`,
      `Each cell is classified only from its centroid. If the centroid field value meets the land threshold, the cell starts as <em>LAND</em>; otherwise it starts as <em>SEA</em>.`,
      `The replay then shows each smoothing pass, artifact cleanup for tiny isolated components, and final edge classification. Edges between unlike terrain become <em>COAST</em>, while matching neighbors remain <em>SEA</em> or <em>LAND</em>.`,
      `The final Coast result contains <em>${stepResult?.map?.cells?.length ?? 0}</em> terrain cells and <em>${stepResult?.map?.edges?.length ?? 0}</em> classified edges.`,
    ],
    renderExplanationExtras: SEA_LAND.renderExplanationExtras,
  },
  {
    title:"Rivers",
    process:RIVERS.computeRivers,
    createReplay: null,
    description: (settings, stepMap) => [
      `This step separates open sea from inner seas, recomputes distance-to-open-sea data, and searches from open-sea mouths toward distant boundary exits.`,
      `For each mouth, it tries A* paths to exits from farthest to nearest, rejects short-edge crossings, and displays the best valid rivers by three length measures.`,
    ],
    explanation: (settings, stepResult) => [
      `Rivers starts only from mouth candidates on the largest landmass and adjacent to open sea. Mouths are tried from farthest to nearest relative to the map center, then exits are tried from farthest to nearest relative to each mouth.`,
      `A* moves cell to cell through shared edges, costs each move through the shared-edge midpoint, requires the first four moves to increase distance from open sea, and blocks routes that return near sea after reaching seaD 4.`,
      `The overlay draws the longest river by cell count in blue, the longest routed geometric path in green, and the longest straight mouth-to-exit geometric distance in violet.`,
    ],
    renderExplanationExtras: null,
  }
]
