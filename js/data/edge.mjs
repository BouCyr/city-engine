


export function Edge(id, start, end, type, drawFn = null, flags= []){
  return {
    id:id,
    start:start,
    end:end,
    type:type,
    flags: new Set(flags),
    draw:drawFn?drawFn:createDrawEdgeFn()
  }
}


function createDrawEdgeFn(fill="none", stroke="#CCC", strokeWidth="2") {
  return function drawEdge(svg){
    const layer = svg.getElementById("edges");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const start = this.start;
    const end = this.end;
    path.setAttribute("d", `M ${start.x} ${start.y} L ${end.x} ${end.y}`);
    path.setAttribute("fill", fill);
    path.setAttribute("stroke", stroke);
    path.setAttribute("strokeWidth",strokeWidth)

    layer.appendChild(path);
  }
}
