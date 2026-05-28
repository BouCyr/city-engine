export function cloneDeepKeepFunctions(value, seen = new WeakMap()) {
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return seen.get(value);

  if (isMapGraph(value)) return cloneMapGraph(value, seen);

  if (Array.isArray(value)) {
    const arr = [];
    seen.set(value, arr);
    for (const item of value) arr.push(cloneDeepKeepFunctions(item, seen));
    return arr;
  }

  if (value instanceof Set) {
    const set = new Set();
    seen.set(value, set);
    for (const item of value) set.add(cloneDeepKeepFunctions(item, seen));
    return set;
  }

  const clone = Object.create(Object.getPrototypeOf(value));
  seen.set(value, clone);

  for (const key of Reflect.ownKeys(value)) {
    clone[key] = cloneDeepKeepFunctions(value[key], seen);
  }

  return clone;
}

function isMapGraph(value) {
  return Array.isArray(value.nodes)
    && Array.isArray(value.edges)
    && Array.isArray(value.cells)
    && typeof value.draw === "function"
    && typeof value.clear === "function";
}

function cloneMapGraph(map, seen) {
  const clone = Object.create(Object.getPrototypeOf(map));
  seen.set(map, clone);

  for (const key of Reflect.ownKeys(map)) {
    if (key !== "nodes" && key !== "edges" && key !== "cells" && key !== "areas") {
      clone[key] = cloneDeepKeepFunctions(map[key], seen);
    }
  }

  const nodeMap = new globalThis.Map();
  const edgeMap = new globalThis.Map();
  const cellMap = new globalThis.Map();

  clone.nodes = map.nodes.map(node => {
    const nodeClone = clonePlainGraphObject(node, seen, ["edges"]);
    nodeClone.edges = new Set();
    nodeMap.set(node, nodeClone);
    return nodeClone;
  });

  clone.edges = map.edges.map(edge => {
    const edgeClone = clonePlainGraphObject(edge, seen, ["start", "end", "leftCell", "rightCell"]);
    edgeClone.start = nodeMap.get(edge.start);
    edgeClone.end = nodeMap.get(edge.end);
    edgeClone.leftCell = null;
    edgeClone.rightCell = null;
    edgeClone.start?.edges?.add(edgeClone);
    edgeClone.end?.edges?.add(edgeClone);
    edgeMap.set(edge, edgeClone);
    return edgeClone;
  });

  clone.cells = map.cells.map(cell => {
    const cellClone = clonePlainGraphObject(cell, seen, ["edges"]);
    cellClone.edges = cell.edges.map(edge => edgeMap.get(edge));
    cellMap.set(cell, cellClone);
    return cellClone;
  });

  for (const edge of map.edges) {
    const edgeClone = edgeMap.get(edge);
    edgeClone.leftCell = edge.leftCell ? cellMap.get(edge.leftCell) : null;
    edgeClone.rightCell = edge.rightCell ? cellMap.get(edge.rightCell) : null;
  }

  clone.areas = (map.areas ?? []).map((group) => {
    const groupClone = clonePlainGraphObject(group, seen, ["areas"]);
    groupClone.areas = (group.areas ?? []).map((area) => {
      const areaClone = clonePlainGraphObject(area, seen, ["cells"]);
      areaClone.cells = (area.cells ?? []).map((cell) => cellMap.get(cell)).filter(Boolean);
      return areaClone;
    });
    return groupClone;
  });

  return clone;
}

function clonePlainGraphObject(value, seen, skippedKeys) {
  const clone = Object.create(Object.getPrototypeOf(value));
  seen.set(value, clone);

  for (const key of Reflect.ownKeys(value)) {
    if (!skippedKeys.includes(key)) {
      clone[key] = cloneDeepKeepFunctions(value[key], seen);
    }
  }

  return clone;
}
