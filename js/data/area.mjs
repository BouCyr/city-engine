import {orderedCellPoints} from "./cell.mjs";

export function AreaGroup(name, areas = []) {
  return {
    name,
    areas,
  };
}

export function Area(name, type, cells = [], drawFn = drawArea) {
  return {
    name,
    type,
    cells,
    draw: drawFn,
  };
}

export function drawArea(svg, groupElement = null) {
  const layer = groupElement ?? svg.getElementById("areas");
  if (!layer || this.cells.length === 0) return;

  const pathData = areaBoundaryPath(this.cells);
  if (!pathData) return;

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathData);
  path.setAttribute("class", `area terrain-${terrainClass(this.type)}`);
  path.setAttribute("fill-rule", "evenodd");
  const filterId = areaInnerBorderFilterId(this.type);
  if (filterId) {
    path.setAttribute("filter", `url(#${filterId})`);
  }
  layer.appendChild(path);

  if (this.tint) {
    const tint = document.createElementNS("http://www.w3.org/2000/svg", "path");
    tint.setAttribute("d", pathData);
    tint.setAttribute("class", "area area-tint");
    tint.setAttribute("fill", this.tint);
    tint.setAttribute("fill-opacity", String(this.tintOpacity ?? 0.2));
    tint.setAttribute("fill-rule", "evenodd");
    layer.appendChild(tint);
  }
}

export function areaBoundaryPath(cells) {
  const cellSet = new Set(cells);
  const segments = [];

  for (const cell of cells) {
    for (const edge of cell.edges || []) {
      if (!edge) continue;

      const other = edge.leftCell === cell
        ? edge.rightCell
        : edge.rightCell === cell
          ? edge.leftCell
          : null;

      if (other && cellSet.has(other)) continue;

      segments.push({
        start: edge.start,
        end: edge.end,
      });
    }
  }

  return segmentsToPath(segments);
}

function segmentsToPath(segments) {
  const remaining = segments.map((segment) => ({
    start: pointKey(segment.start),
    end: pointKey(segment.end),
    startPoint: segment.start,
    endPoint: segment.end,
  }));
  const loops = [];

  while (remaining.length > 0) {
    const first = remaining.pop();
    const loop = [first.startPoint, first.endPoint];
    let currentKey = first.end;
    const targetKey = first.start;

    while (currentKey !== targetKey && remaining.length > 0) {
      const nextIndex = remaining.findIndex((segment) => segment.start === currentKey || segment.end === currentKey);
      if (nextIndex < 0) break;

      const [next] = remaining.splice(nextIndex, 1);
      if (next.start === currentKey) {
        loop.push(next.endPoint);
        currentKey = next.end;
      } else {
        loop.push(next.startPoint);
        currentKey = next.start;
      }
    }

    if (loop.length >= 3) {
      loops.push(loop);
    }
  }

  if (loops.length === 0) return "";
  return loops.map((loop) => (
    `M ${loop.map((point) => `${point.x} ${point.y}`).join(" L ")} Z`
  )).join(" ");
}

function terrainClass(type) {
  return type === "SEA" ? "sea" : "land";
}

function areaInnerBorderFilterId(type) {
  if (type === "SEA") return "area-inner-border-sea";
  if (type === "LAND") return "area-inner-border-land";
  return null;
}

function pointKey(point) {
  return `${Math.round(point.x * 1000000)},${Math.round(point.y * 1000000)}`;
}
