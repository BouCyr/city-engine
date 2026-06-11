

import {
  NODE_TYPE_PARISH_CENTER,
  NODE_TYPE_POI,
} from "../constants.mjs";

export function Poi(id, x,y, drawFn = null, flags= []){
  return Node(id, x,y, NODE_TYPE_POI, drawFn, flags)
}

export function Node(id, x,y, type, drawFn = null, flags= []){
  return {
    id:id,
    x:x,
    y:y,
    type:type,
    flags: new Set(flags),
    edges: new Set(),
    draw:drawFn?drawFn:createDrawPointFn()
  }
}


function createDrawPointFn(r="5",fill="#BBB", stroke="#CCC", strokeWidth="2") {
  return function drawPoint(svg){
    const layer = svg.getElementById("nodes");
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    const parishCenter = this.type === NODE_TYPE_PARISH_CENTER;
    circle.setAttribute("cx", this.x);
    circle.setAttribute("cy", this.y);
    circle.setAttribute("r", parishCenter ? "11" : r);
    circle.setAttribute("fill", parishCenter ? "var(--land-edge)" : fill);
    circle.setAttribute("stroke", parishCenter ? "var(--bg-color)" : stroke);
    circle.setAttribute("strokeWidth", parishCenter ? "3" : strokeWidth)

    layer.appendChild(circle);
  }
}
