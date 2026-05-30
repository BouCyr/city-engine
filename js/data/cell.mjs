export function Cell(id, edges, fill, drawFn = null, flags = []) {
  return {
    id: id,
    type: "Cell",
    edges: edges,
    flags: new Set(flags),
    fill: fill,
    draw: drawFn ? drawFn : createDrawCellFn(),
  };
}

export function createDrawCellFn(stroke = "none", strokeWidth = "0", fill="none") {
  return function drawCell(svg) {
    const layer = svg.getElementById("cells");
    const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    const points = orderedCellPoints(this)
      .map(point => `${point.x},${point.y}`)
      .join(" ");

    polygon.setAttribute("class", "cell");
    polygon.setAttribute("points", points);
    polygon.setAttribute("stroke", stroke);
    polygon.setAttribute("fill",fill);
    polygon.setAttribute("strokeWidth", strokeWidth);

    layer.appendChild(polygon);
  };
}

export function orderedCellPoints(cell) {
  if (cell.edges.length === 0) return [];
  if (cell.edges.length === 1) return [cell.edges[0].start, cell.edges[0].end];

  const firstEdge = cell.edges[0];
  const secondEdge = cell.edges[1];
  let previous;
  let current;

  if (sharesNode(firstEdge.end, secondEdge)) {
    previous = firstEdge.start;
    current = firstEdge.end;
  } else {
    previous = firstEdge.end;
    current = firstEdge.start;
  }

  const points = [previous, current];

  for (let index = 1; index < cell.edges.length; index += 1) {
    const edge = cell.edges[index];
    const next = nextNode(edge, current, previous);
    if (!next) break;
    previous = current;
    current = next;
    points.push(current);
  }

  return points;
}

function sharesNode(node, edge) {
  return edge.start === node || edge.end === node;
}

function nextNode(edge, current, previous) {
  if (edge.start === current && edge.end !== previous) return edge.end;
  if (edge.end === current && edge.start !== previous) return edge.start;
  if (edge.start === current) return edge.end;
  if (edge.end === current) return edge.start;
  return null;
}
