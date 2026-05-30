import {createDrawCellFn} from "../data/cell.mjs";
import {createDrawEdgeFn} from "../data/edge.mjs";

export function computeRivers(settings, map) {


  //compute distance to land

  //find the (land-side) coast
  const landCoast = map.cells.filter(c => c.type === "LAND")
    .filter(c => hasNeighbour( c, n => {
      if(!n || !n.type)
        return false;
      return n.type === "SEA"
    }).length > 0);
  landCoast.forEach(c => {
    c.draw = createDrawCellFn("none","0", "#AA05");
  });

  let currentDist = 1;
  let current = new Set(landCoast);
  while(current.size > 0){
    current.forEach(c => c.seaD = currentDist)
    const next = new Set();
    current.forEach(c => neighbourWithoutDistance(c).forEach(n => next.add(n)));
    currentDist += 1;
    current = next;
  }
  map.cells
    .filter(c => c.seaD)
    .forEach(c => {
      const ratio = 1/currentDist;
      const color = "rgb(75, 60, 45, "+(Math.floor(c.seaD*ratio*100))/100+")"
      c.draw = createDrawCellFn("none","0", color);
      // c.edges.forEach(e => e.draw = createDrawEdgeFn(e, "none", color))

    })




  //find the (sea-side) coast
  const seaCoast = map.cells.filter(c => c.type === "SEA")
    .filter(c => hasNeighbour( c, n => {
      if(!n || !n.type)
        return false;
      return n.type === "LAND"
    }).length > 0);

  seaCoast.forEach(c => {
    c.draw = createDrawCellFn("none","0", "#A005");
  })



  //any sea cell touching at least 3 land cells may be the (sea-side) mouth
  const seaMouthCandidates = seaCoast.filter(c => hasNeighbour( c, n => {
    if(!n || !n.type)
      return false;
    return n.type === "LAND"
  }).length > 2);

  seaMouthCandidates.forEach(c => {
    c.draw = createDrawCellFn("none","0", "#0A09");
  })

  const landMouthCandidates = new Set();
  seaMouthCandidates
    .map(c => hasNeighbour( c, n => {
      if(!n || !n.type)
        return false;
      return n.type === "LAND"}))
    .forEach(c => landMouthCandidates.add(...c));

  landMouthCandidates.forEach(c => {
    c.draw = createDrawCellFn("none","0", "#8B2a");
  })


  const rivers = [...landMouthCandidates]
    .map(mouth => calcRiver([mouth]));

  const longestRiver = rivers.sort((a,b) => -a.length+b.length)[0];

  longestRiver.forEach(c => c.draw = createDrawCellFn("none","0", "#2B8a"))


  return map;
}

function calcRiver(river){

  const head = river[river.length-1];
  const end = hasNeighbour(head, n => !n).length > 0 ;
  // a boundary neighbour. River ends here.
  if(end){
    return [...river];
  }

  let nextCandidates =
    hasNeighbour(head, n => {
      const isLand = n.type === "LAND";
      const farther = n.seaD > head.seaD;
      //TODO angle
      return isLand && farther;
    });

  // pas de pente, on tente les plats
  if(nextCandidates.length === 0){
    nextCandidates =
      hasNeighbour(head, n => {

        const notAlreadyInRiver = !river.find(c => c.id === n.id);
        const isLand = n.type === "LAND";
        const farther = n.seaD >= head.seaD;

        return notAlreadyInRiver && isLand && farther;
      });
  }

  if(nextCandidates.length === 0){
    return river;
  }
  const result = [];
  nextCandidates.forEach(c => {
    result.push(calcRiver([...river, c]));
  })

  result.sort((a,b) => -a.length+b.length);

  return result[0];


}



function otherSide(e, cell) {
  return e.leftCell.id === cell.id ? e.rightCell : e.leftCell;
}

function hasNeighbour(cell, filterFunction) {

  const neighbours = [];
  cell.edges.forEach(e => {
    const other = otherSide(e, cell);
    if(filterFunction(other)){
      neighbours.push(other);
    }
  })
  return neighbours;
}


function neighbourWithoutDistance(cell){
  return cell.edges
    .map(e => otherSide(e, cell))
    .filter(c => {
      return c && ((!c.seaD) && c.type === "LAND")
    })
}
