import * as SCATTER  from "./steps/000-scatter.mjs";
import * as GATHER  from "./steps/001-gather.mjs";
import * as LLOYD  from "./steps/002-lloyd.mjs";
import * as PRUNE  from "./steps/003-prune.mjs";
import * as SEA_LAND from "./steps/004-sea-land.mjs";
import * as NEEDLES from "./steps/005.1-needles.mjs";
import * as RIVERS from "./steps/005.2-rivers.mjs";
import * as TRIBUTARIES from "./steps/006-tributaries.mjs";
import * as RIVER_CORRIDOR_TOPOLOGY from "./steps/007-river-corridor-topology.mjs";
import * as SMOOTH_COAST from "./steps/009-smooth-coast.mjs";
import * as PARISHES from "./steps/010-parishes.mjs";


export const steps = [

  {
    title: "Initialization",
    process: (settings, map) => map,
    description: (settings) => [
      `This initial step stores global generation settings before any map geometry is created.`,
      `The seed <em>${settings.seed}</em> drives deterministic per-step random streams, and the map size is <em>${settings.size}</em> SVG units.`,
    ],
    explanation: (settings) => [
      `Initialization does not modify the map. It exists so global settings have a dedicated place in the step workflow.`,
      `Later steps read these global settings as read-only context where needed.`,
    ],
  },
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
    title:"Needles",
    process:NEEDLES.markNeedles,
    createReplay: NEEDLES.createReplay,
    description: (settings, stepMap) => [
      `This step scans every node that connects multiple terrain sectors, marks SEA-LAND-SEA separators as NEEDLE cells, then flips those land cells to SEA before rivers are computed.`,
      `Detected needle cells keep a red marker to make the correction visible in the step view.`,
    ],
    explanation: (settings, stepResult) => [
      `Needles looks at each node's ordered sectors and finds land cells that are isolated by sea on both sides.`,
      `When two or more land sectors around the same node satisfy that condition, the step flags all of them as <em>NEEDLE</em> and converts them to SEA.`,
      `After conversion, terrain edge classes and terrain areas are recomputed so the subsequent terrain state is consistent for the next step.`,
      `Replay shows the candidate nodes as red dots (r=15), paints affected cells violet before flipping them, then shows the final post-flip terrain.`,
    ],
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
    createReplay: TRIBUTARIES.createReplay,
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
    title:"Smooth coast",
    process:SMOOTH_COAST.smoothCoast,
    createReplay: SMOOTH_COAST.createReplay,
    description: (settings, stepMap) => [
      `This step smooths sea-to-land transition edges using the same fixed-anchor and Bezier sampling workflow used for rivers.`,
      `Only non-boundary coast edges are smoothed so the map border remains visually stable.`,
      `Coast edges are sampled into regular sub-edges, then intermediate nodes are moved onto quadratic Bezier curves between fixed anchors.`,
    ],
    explanation: (settings, stepResult) => [
      `Smooth coast splits each eligible coast edge at a fixed midpoint and then inserts regular sample nodes by target segment length.`,
      `It builds a path graph from fixed anchor nodes and non-fixed sample nodes, then moves non-fixed nodes onto quadratic Bezier curves constrained by neighboring anchors.`,
    ],
    renderExplanationExtras: null,
  },
  {
    title:"River corridor topology",
    process:RIVER_CORRIDOR_TOPOLOGY.computeRiverCorridorTopology,
    createReplay: RIVER_CORRIDOR_TOPOLOGY.createReplay,
    description: (settings, stepMap) => [
      `This step converts the selected primary river path into first-class <em>RIVER</em> terrain using a total corridor width of <em>${settings.riverCells?.primaryWidth ?? 40}</em> map units.`,
      `It subtracts the corridor from <em>LAND</em> cells only, ignores the corridor over sea, and rebuilds the map graph from canonical land, sea, and river polygons.`,
    ],
    explanation: (settings, stepResult) => [
      `River corridor topology reads the ordered primary river cells selected by the river search, smooths their centroid path geometrically, offsets it into a corridor polygon, and applies polygon boolean operations to carve land cells.`,
      `Where the carved corridor bisects an original land edge, the step restores a <em>CROSSING</em> edge through the river and marks its endpoints as <em>CROSSING_END</em> nodes.`,
    ],
    renderExplanationExtras: null,
  },
  {
    title: "Parishes",
    process: PARISHES.process,
    createReplay: PARISHES.createReplay,
    description: (settings) => [
      `This final step splits land into isolated land masses delimited by coast, rivers, crossings, and the map boundary, then dispatches parishes independently inside each land mass.`,
      `Each land mass receives one parish per <em>${settings.parishes?.parishSize ?? 16}</em> land cells, rounded up with a minimum of one, and graph-distance k-means assignment runs until convergence or until its 200ms computation budget is reached.`,
      `Left-click a node connected to at least one <em>LAND</em> edge to set a preview start point, then hover another node to preview a weighted shortest path over <em>LAND</em> edges only.`,
      `Right-click anywhere on the map clears the start point and the current preview without changing the generated graph.`,
    ],
    explanation: (settings) => [
      `Parishes first finds connected components of <em>LAND</em> cells using only shared <em>LAND</em> edges. Coast edges, river banks, crossings, and map boundaries stop connectivity, so parish assignments cannot spill from one land mass to another.`,
      `For each land mass, the number of parishes is <em>ceil(cell count / ${settings.parishes?.parishSize ?? 16})</em>. K-means assigns each land cell by shortest graph distance from the closest map node to each current parish center, with temporary LAND-cost links from every cell centroid to that cell's nodes.`,
      `LAND and temporary centroid links cost 12 times geometric length. COAST edges are allowed at double LAND cost, while water, river, boundary, and crossing edges are blocked.`,
      `While this step is selected, the map still supports weighted path preview over <em>LAND</em> edges only, with each edge costing 12 times its geometric length.`,
    ],
    renderExplanationExtras: null,
  }
]
