import {Edge} from "../data/edge.mjs";

export function cells(settings, map) {


  const first = map.nodes[0];
  const second = map.nodes[1];

  const edge = new Edge("a", first, second, "void");
  map.edges.push(edge);
  return map;

}
