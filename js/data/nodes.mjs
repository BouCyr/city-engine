

export function Poi(id, x,y, type, layer, drawFn){
  return Node(id, x,y, "POI")
}

function Node(id, x,y, type, drawFn = null, flags= []){
  return {
    id:id,
    x:x,
    y:y,
    type:type,
    flags: new Set(flags),
    draw:drawFn?drawFn:createDrawPointFn(x,y)
  }
}


function createDrawPointFn(x,y,r="5",fill="#BBB", stroke="#CCC", strokeWidth="2") {
  return (svg)=>{
    const layer = svg.getElementById("nodes");
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", x);
    circle.setAttribute("cy", y);
    circle.setAttribute("r", r);
    circle.setAttribute("fill", fill);
    circle.setAttribute("stroke", stroke);
    circle.setAttribute("strokeWidth",strokeWidth)

    layer.appendChild(circle);
  }
}
