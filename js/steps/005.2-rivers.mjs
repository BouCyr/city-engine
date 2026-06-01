import {createDrawCellFn} from "../data/cell.mjs";
import {createDrawEdgeFn} from "../data/edge.mjs";
import * as H from "../data/helper.mjs";

const MIN_EDGE_SIZE = 10;


export function computeRivers(settings, map) {


  map.edges
    .filter(e => e.flags.has("LAND"))
    .filter(e => {
      return H.distance(e.start, e.end) < MIN_EDGE_SIZE;
    })
    .forEach(e => {e.draw = createDrawEdgeFn(e, "none", "red", "7")})


  //compute distance to land
  distanceToSea(map);
  //find land mouths candidates
  const landMouthCandidates = findMouthCandidates(map);

  landMouthCandidates.forEach(c => {
    c.draw = createDrawCellFn("none","0", "#8B2a");
  });


  const rivers = [];
  landMouthCandidates.forEach(c => {
    let currentCell = c;
    const river = [c];
    while (true) {

      //river stop when reaching boundary
      if(currentCell.edges.find(e => e.flags.has("Boundary"))){
        break;
      }

      const next = filteredNeighbors(currentCell, n => {
        //any neighbours whose seaD is greater than current
        if (!n || !n.seaD)
          return false;
        //but not another mouth candidate
        if (landMouthCandidates.find(m => m.id === n.id))
          return false;

        // no other cell in river next to the sea
        if(n.edges.find(e => e.flags.has("COAST"))){
          return false;
        }

        const sharedEdge = H.cellsEdge(currentCell, n);
        if (H.edgeLength(sharedEdge) < MIN_EDGE_SIZE)
          return false;

        return n.seaD > currentCell.seaD;
      }).sort((a, b) => b.seaD - a.seaD)[0];
      if (!next) {
        break;
      }
      river.push(next);
      currentCell = next;
    }
    rivers.push(river);
  })

  const river = rivers.sort((a, b) => b.length-a.length)[0]
  drawRiver(river, map);


  return map;
}

function findMouthCandidates(map) {


  const seaCoast = map.cells.filter(c => c.type === "SEA")
    .filter(c => filteredNeighbors(c, n => {
      if (!n || !n.type)
        return false;
      return n.type === "LAND"
    }).length > 0);

  //any sea cell touching at least 3 land cells may be the (sea-side) mouth
  const seaMouthCandidates = seaCoast.filter(c => filteredNeighbors(c, n => {
    if (!n || !n.type)
      return false;
    return n.type === "LAND"
  }).length > 2);


  //land cells touching sea mouth
  const touchingSeaMouth = [];
  seaMouthCandidates
    .map(c => filteredNeighbors(c, n => {
      if (!n || !n.type)
        return false;
      return n.type === "LAND"
    }))
    .forEach(c => {
      c.forEach(c => touchingSeaMouth.push(c));
    });


  //only keep land cells whose only sea neighbor is the seamouth
  return touchingSeaMouth.filter(mouth => filteredNeighbors(mouth, n => {
    if (!n || !n.type)
      return false;
    return n.type === "SEA"
  }).length === 1);
}

function distanceToSea(map) {
  //find the (sea-side) coast
  let frontier =
    map.cells.filter(c => c.type === "SEA")
      .filter(c => filteredNeighbors(c, n => {
        if (!n || !n.type)
          return false;
        return n.type === "LAND"
      }).length > 0);
  frontier.forEach(c => {
    c.seaD = 0;
    c.cellToSea = 0;
  });


  while (frontier.length > 0) {
    const nextFrontier = [];
    frontier.forEach(frontierCell => {
      const neighbors = filteredNeighbors(frontierCell, n => {
        if (!n || !n.type)
          return false;
        return n.type === "LAND"
      });

      const frontierCellCenter = H.cellCentroid(frontierCell);
      neighbors.forEach(neighbor => {
        const neighborCenter = H.cellCentroid(neighbor);
        const dist = H.distance(frontierCellCenter, neighborCenter)
          + frontierCell.seaD;
        if (!neighbor.seaD || dist < neighbor.seaD) {
          neighbor.seaD = dist;
          neighbor.toSea = frontierCell;
          neighbor.cellToSea = frontierCell.cellToSea+1;
          nextFrontier.push(neighbor);
        }
      })
      frontier = nextFrontier;
    })
  }

  const maxD =
    map.cells.filter(c => c.type === "LAND")
      .reduce((max, c) => Math.max(max, c.seaD), 0);

  map.cells.filter(c => c.type === "LAND")
    .filter(c => c.seaD)
    .forEach(c => {
      const ratio = c.seaD / maxD;
      const color = "rgb(75, 60, 45, " + (Math.floor(ratio * 100)) / 100 + ")"
      c.draw = createDrawCellFn("none", "0", color);
    });
}

function otherSide(edge, cell) {
  if(edge.leftCell && edge.rightCell)
    return edge.leftCell.id === cell.id ? edge.rightCell : edge.leftCell;
  return null;
}

function filteredNeighbors(cell, filterFunction) {

  const neighbors = [];
  cell.edges.forEach(e => {
    const other = otherSide(e, cell);

    if(other && filterFunction(other)){
      neighbors.push(other);
    }
  })
  return neighbors;
}



function drawRiver(river, map) {
  const seaMouth = filteredNeighbors(river[0], n => {
    return n.type === "SEA"
  })[0];
  const mouthEdge = H.cellsEdge(seaMouth, river[0]);
  const mouth = H.midpoint(mouthEdge.start, mouthEdge.end);


  let d = `M ${mouth.x} ${mouth.y} `;
  for (let i = 0; i < river.length ; i++) {

    console.log(i,river[i].id);
    const cell = river[i];
    const cellM = H.cellCentroid(cell);
    d += `L ${cellM.x} ${cellM.y} `;
    const next = river[i + 1];
    if (next) {
      const nextEdge = H.cellsEdge(cell, next);
      const edgeM = H.midpoint(nextEdge.start, nextEdge.end);
      d += `L ${edgeM.x} ${edgeM.y} `;
    } else {
      const exit = cell.edges.filter(e => e.flags.has("Boundary"))[0];
      if(exit){
        const exitM = H.midpoint(exit.start, exit.end);
        d += `L ${exitM.x} ${exitM.y} `;
      }
    }

  }

  map.drawOverlay = (svg) => {
    const layer = svg.getElementById("cells");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "blue");
    path.setAttribute("stroke-width", "7")
    path.setAttribute("d", d);
    layer.appendChild(path);
  }
}
