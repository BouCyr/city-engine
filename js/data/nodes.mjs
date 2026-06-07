

import {NODE_TYPE_POI} from "../constants.mjs";

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
    circle.setAttribute("cx", this.x);
    circle.setAttribute("cy", this.y);
    circle.setAttribute("r", r);
    circle.setAttribute("fill", fill);
    circle.setAttribute("stroke", stroke);
    circle.setAttribute("strokeWidth",strokeWidth)

    layer.appendChild(circle);
  }
}
