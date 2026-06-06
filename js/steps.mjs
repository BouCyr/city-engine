import * as SCATTER  from "./steps/000-scatter.mjs";
import * as GATHER  from "./steps/001-gather.mjs";
import * as LLOYD  from "./steps/002-lloyd.mjs";
import * as PRUNE  from "./steps/003-prune.mjs";
import * as SEA_LAND from "./steps/004-sea-land.mjs";
import * as RIVERS from "./steps/005.2-rivers.mjs";
import * as TRIBUTARIES from "./steps/006-tributaries.mjs";
import * as RIVER_TOPOLOGY from "./steps/007-river-topology.mjs";
import * as SMOOTH_RIVERS from "./steps/008-smooth-rivers.mjs";


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
    createReplay: RIVERS.createReplay,
    description: (settings, stepMap) => [
      `This step separates open sea from inner seas, recomputes distance-to-open-sea data, and searches from open-sea mouths toward distant boundary exits.`,
      `For each mouth, it tries A* paths to exits from farthest to nearest, rejects short-edge crossings, and selects the highest-seaD exit among the five longest straight mouth-to-exit candidates.`,
      `After selection, it tries short local reroutes on the main river to replace straight interior segments with deterministic meanders while keeping the same mouth and exit.`,
    ],
    explanation: (settings, stepResult) => [
      `Rivers starts only from mouth candidates on the largest landmass and adjacent to open sea. Mouths are tried from farthest to nearest relative to the map center, then exits are tried from farthest to nearest relative to each mouth.`,
      `A* moves cell to cell through shared edges, costs each move through the shared-edge midpoint, requires the first four moves to increase distance from the nearest sea, and blocks routes that return near sea after reaching seaD 4.`,
      `Once the winning path is chosen, a second pass scans interior river cells and attempts bounded A* detours around them. Each detour must avoid nearby cells around the tested bend point, must stay off the rest of the river, and must remain short enough to keep the overall route controlled.`,
      `The overlay draws the selected top-five/highest-seaD winner with the same blue used for sea edges.`,
    ],
    renderExplanationExtras: null,
  },
  {
    title:"Tributaries",
    process:TRIBUTARIES.computeTributaries,
    description: (settings, stepMap) => [
      `This step reads the selected main river from <em>map.rivers</em>, splits its landmass into river banks, and tries to add one tributary per bank.`,
      `Tributary mouths must be land cells next to the main river, at least four land-cell steps away from sea, and the second tributary mouth must stay at least two cell steps away from the first.`,
      `Each tributary measures distance from either sea or the main river, requires the first eight path cells to grow that distance, and selects the route with the best combined main-exit distance, exit seaD, and first-third mouth-position score.`,
      `After selection, each tributary also gets the same local meander refinement when the bank still contains a valid short detour.`,
    ],
    explanation: (settings, stepResult) => [
      `Tributaries are stored after the main river in <em>map.rivers</em>. The step keeps the main river as the first entry and appends up to two tributaries.`,
      `Each bank is searched independently, starting with the larger bank. Tributary exits must have seaD at least eight, and banks with no valid route within the computation limit are skipped.`,
    ],
    renderExplanationExtras: null,
  },
  {
    title:"River topology",
    process:RIVER_TOPOLOGY.computeRiverTopology,
    description: (settings, stepMap) => [
      `This step turns the selected river and tributary paths into graph topology by splitting each traversed land cell along the river centerline.`,
      `Normal river cells become two land cells separated by a <em>river</em> edge, while tributary merge cells are split around a three-way river junction.`,
      `After the split, terrain areas are recomputed so rivers, sea, and the map boundary separate land areas.`,
    ],
    explanation: (settings, stepResult) => [
      `River topology reads <em>map.rivers</em> from the previous steps and promotes those visual routes into real edges and cells.`,
      `The step preserves graph identity by splitting existing cell boundary edges at river entry and exit points, then replacing each traversed cell with canonical child cells that reference canonical nodes and edges.`,
      `Land areas are rebuilt as connected components separated by river edges, coast, sea, and map boundaries. Each land area keeps the existing land-area rendering path and receives a deterministic translucent tint.`,
    ],
    renderExplanationExtras: null,
  },
  {
    title:"Smooth rivers",
    process:SMOOTH_RIVERS.smoothRivers,
    createReplay: SMOOTH_RIVERS.createReplay,
    description: (settings, stepMap) => [
      `This step samples river topology edges into regular sub-edges with a target segment length of <em>${SMOOTH_RIVERS.TARGET_RIVER_SEGMENT_LENGTH}</em> map units.`,
      `Normal river sections receive a fixed midpoint anchor, while merge junctions are kept fixed and only their incoming sections are subdivided.`,
      `Intermediate river nodes between fixed anchors are moved onto quadratic Bezier curves so rivers become smoother while preserving canonical graph references.`,
    ],
    explanation: (settings, stepResult) => [
      `Smooth rivers works on the real river edges created by River topology, not on the earlier visual overlay.`,
      `Each fixed anchor is stored as a node flag, and each replacement edge keeps the same river metadata so river ownership remains inspectable after smoothing.`,
      `Mouth and exit tails that do not lie between two fixed anchors stay as straight sampled sections.`,
    ],
    renderExplanationExtras: null,
  }
]
