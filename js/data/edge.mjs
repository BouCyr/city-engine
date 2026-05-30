


export function Edge(id, start, end, type, drawFn = null, flags= []){
  const edge = {
    id:id,
    start:start,
    end:end,
    type:type,
    flags: new Set(flags),
    leftCell:null,
    rightCell:null,
    draw:drawFn?drawFn:defaultDraw()
  }
  start.edges?.add(edge);
  end.edges?.add(edge);
  return edge;
}
function defaultDraw(fill="none", stroke="#CCC", strokeWidth="2") {
  return createDrawEdgeFn(this, fill, stroke, strokeWidth);
}

export function createDrawEdgeFn(edge, fill="none", stroke="#CCC", strokeWidth="2") {
  return function drawEdge(svg){
    const layer = svg.getElementById("edges");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const start = edge.start;
    const end = edge.end;
    path.setAttribute("d", `M ${start.x} ${start.y} L ${end.x} ${end.y}`);
    path.setAttribute("fill", fill);
    path.setAttribute("stroke", stroke);
    path.setAttribute("strokeWidth",strokeWidth)

    layer.appendChild(path);
  }
}
