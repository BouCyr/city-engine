/* dim of map in svg units*/
export const SIZE = 3000;

/* default number of scattered points. */
export const POI_NB = 2000;
/* safe zone/margin for scattering points; no points will be generated nearer from the boundary. */
export const SAFE_ZONE = 75;
/* default threshold for pruning short edges. */
export const PRUNE_THRESHOLD = 0;

export const NODE_TYPE_POI = "POI";
export const NODE_TYPE_VORONOI = "Voronoi";
export const NODE_TYPE_SEA = "sea";
export const NODE_TYPE_LAND = "land";
export const NODE_TYPE_COAST = "coast";
export const NODE_TYPE_RIVER = "river";
export const NODE_TYPE_RIVER_JUNCTION = "river-junction";
export const NODE_TYPE_CROSSING = "CROSSING";

export const CELL_TYPE_CELL = "Cell";
export const TERRAIN_SEA = "SEA";
export const TERRAIN_LAND = "LAND";
export const TERRAIN_COAST = "COAST";

export const EDGE_TYPE_VORONOI = "Voronoi";
export const EDGE_TYPE_SEA = "sea";
export const EDGE_TYPE_LAND = "land";
export const EDGE_TYPE_COAST = "coast";
export const EDGE_TYPE_RIVER = "river";

export const TERRAIN_CLASS_SEA = "sea";
export const TERRAIN_CLASS_LAND = "land";
export const TERRAIN_CLASS_COAST = "coast";
export const AREA_NAME_SEA = "sea";
export const AREA_NAME_LAND = "land";

export const AREA_KIND_OPEN_SEA = "OPEN_SEA";
export const AREA_KIND_INNER_SEA = "INNER_SEA";

export const RIVER_TYPE_MAIN = "MAIN";
export const RIVER_TYPE_TRIBUTARY = "TRIBUTARY";
export const RIVER_ROLE_PRIMARY = "PRIMARY";
export const RIVER_ROLE_FIRST_TRIBUTARY = "FIRST_TRIBUTARY";
export const RIVER_ROLE_SECOND_TRIBUTARY = "SECOND_TRIBUTARY";

export const MAP_FLAG_BOUNDARY = "Boundary";
export const MAP_FLAG_RIVER = "RIVER";
export const MAP_FLAG_NEEDLE = "NEEDLE";
export const MAP_FLAG_FIXED = "FIXED";
export const MAP_FLAG_COAST_GAP = "COAST_GAP";

export const NODE_TYPE_TEST_SPLIT = "split";
export const NODE_TYPE_TEST_GRID = "grid";
export const NODE_TYPE_TEST_FIXTURE = "fixture";
export const EDGE_TYPE_TEST_GRID = "grid";
export const EDGE_TYPE_TEST_FIXTURE = "fixture";
export const EDGE_TYPE_TEST_ROAD = "road";
export const MAP_FLAG_TEST_GATE = "gate";
export const MAP_FLAG_TEST_PRIMARY = "primary";
export const MAP_FLAG_TEST = "test";

export const OVERLAY_TYPE_GATHER = "gather";
export const OVERLAY_TYPE_COAST_FIELD = "coast-field";
export const OVERLAY_TYPE_COAST_CENTROIDS = "coast-centroids";
export const OVERLAY_TYPE_RIVERS = "rivers";
