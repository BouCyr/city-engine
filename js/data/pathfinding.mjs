function defaultEdgeLength(edge) {
  const start = edge?.start;
  const end = edge?.end;
  if (!start || !end) return 0;
  return Math.hypot(end.x - start.x, end.y - start.y);
}

export function buildWeightedNodeGraph(
  map,
  {
    edgeFilter = () => true,
    edgeLength = defaultEdgeLength,
    edgeWeight = ({length}) => length,
  } = {},
) {
  const nodesById = new globalThis.Map();
  const adjacency = new globalThis.Map();

  for (const node of map?.nodes ?? []) {
    if (!node?.id) continue;
    nodesById.set(node.id, node);
    adjacency.set(node.id, []);
  }

  for (const edge of map?.edges ?? []) {
    if (!edge?.start?.id || !edge?.end?.id || !edgeFilter(edge)) continue;

    const length = edgeLength(edge);
    const start = edge.start;
    const end = edge.end;
    const startEntries = adjacency.get(start.id);
    const endEntries = adjacency.get(end.id);
    if (!startEntries || !endEntries) continue;

    const startToEnd = {
      edge,
      node: end,
      length,
      weight: edgeWeight({edge, from: start, to: end, length}),
    };
    const endToStart = {
      edge,
      node: start,
      length,
      weight: edgeWeight({edge, from: end, to: start, length}),
    };

    startEntries.push(startToEnd);
    endEntries.push(endToStart);
  }

  return {
    map,
    nodesById,
    adjacency,
    getNode(nodeOrId) {
      if (!nodeOrId) return null;
      if (typeof nodeOrId === "string") return nodesById.get(nodeOrId) ?? null;
      return nodesById.get(nodeOrId.id) ?? null;
    },
    getNeighbors(nodeOrId) {
      const node = this.getNode(nodeOrId);
      if (!node) return [];
      return adjacency.get(node.id) ?? [];
    },
  };
}

export function computeShortestPathTree(graph, startNodeOrId) {
  const startNode = graph?.getNode?.(startNodeOrId);
  if (!graph || !startNode?.id) {
    return {
      graph,
      startNode: null,
      distances: new globalThis.Map(),
      previous: new globalThis.Map(),
    };
  }

  const distances = new globalThis.Map();
  const previous = new globalThis.Map();
  const queue = new MinHeap();

  distances.set(startNode.id, 0);
  queue.push({nodeId: startNode.id, distance: 0});

  while (!queue.isEmpty()) {
    const current = queue.pop();
    if (!current) break;
    if (current.distance !== distances.get(current.nodeId)) continue;

    for (const neighbor of graph.getNeighbors(current.nodeId)) {
      const nextDistance = current.distance + neighbor.weight;
      const knownDistance = distances.get(neighbor.node.id);
      if (knownDistance !== undefined && knownDistance <= nextDistance) continue;

      distances.set(neighbor.node.id, nextDistance);
      previous.set(neighbor.node.id, {
        node: graph.getNode(current.nodeId),
        edge: neighbor.edge,
        length: neighbor.length,
        weight: neighbor.weight,
      });
      queue.push({nodeId: neighbor.node.id, distance: nextDistance});
    }
  }

  return {
    graph,
    startNode,
    distances,
    previous,
  };
}

export function reconstructShortestPath(tree, targetNodeOrId) {
  const targetNode = tree?.graph?.getNode?.(targetNodeOrId);
  if (!tree?.startNode?.id || !targetNode?.id) return null;
  if (targetNode.id === tree.startNode.id) {
    return {
      nodes: [tree.startNode],
      edges: [],
      totalLength: 0,
      totalWeight: 0,
    };
  }
  if (!tree.previous?.has(targetNode.id)) return null;

  const nodes = [targetNode];
  const edges = [];
  let totalLength = 0;
  let totalWeight = 0;
  let cursorId = targetNode.id;

  while (cursorId !== tree.startNode.id) {
    const entry = tree.previous.get(cursorId);
    if (!entry?.node?.id || !entry.edge) return null;

    nodes.push(entry.node);
    edges.push(entry.edge);
    totalLength += entry.length ?? 0;
    totalWeight += entry.weight ?? 0;
    cursorId = entry.node.id;
  }

  nodes.reverse();
  edges.reverse();

  return {
    nodes,
    edges,
    totalLength,
    totalWeight,
  };
}

class MinHeap {
  constructor() {
    this.items = [];
  }

  isEmpty() {
    return this.items.length === 0;
  }

  push(value) {
    this.items.push(value);
    this.bubbleUp(this.items.length - 1);
  }

  pop() {
    if (this.items.length === 0) return null;
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return first;
  }

  bubbleUp(index) {
    let cursor = index;
    while (cursor > 0) {
      const parent = Math.floor((cursor - 1) / 2);
      if (this.items[parent].distance <= this.items[cursor].distance) break;
      [this.items[parent], this.items[cursor]] = [this.items[cursor], this.items[parent]];
      cursor = parent;
    }
  }

  bubbleDown(index) {
    let cursor = index;
    while (true) {
      const left = cursor * 2 + 1;
      const right = left + 1;
      let next = cursor;

      if (left < this.items.length && this.items[left].distance < this.items[next].distance) {
        next = left;
      }
      if (right < this.items.length && this.items[right].distance < this.items[next].distance) {
        next = right;
      }
      if (next === cursor) break;

      [this.items[cursor], this.items[next]] = [this.items[next], this.items[cursor]];
      cursor = next;
    }
  }
}
