
export function Map(settings){
  return {
    size:settings.size,
    nodes:[],
    edges:[],
    cells:[],
    areas:[],
    rivers:[],


    draw:function(svgDomElt){
      console.log("draw");
      const areasLayer = svgDomElt.getElementById("areas");
      this.areas
        .filter(group => Array.isArray(group?.areas) && group.areas.length > 0)
        .forEach((group) => {
          const groupElement = document.createElementNS("http://www.w3.org/2000/svg", "g");
          groupElement.setAttribute("class", "area-group");
          if (group.name) groupElement.setAttribute("data-area-group", group.name);

          group.areas
            .filter(area => area?.draw)
            .forEach((area) => drawAndTag(groupElement, "areas", area, () => area.draw(svgDomElt, groupElement)));

          if (areasLayer) areasLayer.appendChild(groupElement);
        });

      const layerCountsBeforeOverlay = layerChildCounts(svgDomElt);

      this.cells
        .filter(cell => cell.draw)
        .forEach(cell => drawEntityOnLayer(svgDomElt, "cells", cell));

      this.nodes
        .filter(node => node.draw)
        .forEach(node => drawEntityOnLayer(svgDomElt, "nodes", node));

      this.edges
        .filter(node => node.draw)
        .forEach(edge => drawEntityOnLayer(svgDomElt, "edges", edge));

      this.drawOverlay?.(svgDomElt);
      tagOverlayAdditions(svgDomElt, layerCountsBeforeOverlay);
    },

    clear:function(svgDomElt){
      const areasG = svgDomElt.querySelector("#areas");
      const nodesG = svgDomElt.querySelector("#nodes");
      const edgesG = svgDomElt.querySelector("#edges");
      const cellsG = svgDomElt.querySelector("#cells");
      const overlayG = svgDomElt.querySelector("#overlay");
      if (areasG) areasG.innerHTML = "";
      if (cellsG) cellsG.innerHTML = "";
      if (nodesG) nodesG.innerHTML = "";
      if (edgesG) edgesG.innerHTML = "";
      if (overlayG) overlayG.innerHTML = "";
    }
  };


}

const LEGEND_LAYER_IDS = ["areas", "cells", "edges", "nodes", "overlay"];

function drawEntityOnLayer(svgDomElt, layerId, entity) {
  const layer = svgDomElt.getElementById(layerId);
  drawAndTag(layer, layerId, entity, () => entity.draw(svgDomElt));
}

function drawAndTag(parent, layerId, entity, drawFn) {
  const beforeCount = childCount(parent);
  drawFn();
  tagNewChildren(parent, beforeCount, layerId, entity?.type ?? entity?.name ?? "unknown");
}

function tagOverlayAdditions(svgDomElt, beforeCounts) {
  for (const layerId of LEGEND_LAYER_IDS) {
    const layer = svgDomElt.getElementById(layerId);
    tagNewChildren(layer, beforeCounts.get(layerId) ?? 0, layerId, null);
  }
}

function layerChildCounts(svgDomElt) {
  const counts = new globalThis.Map();
  for (const layerId of LEGEND_LAYER_IDS) {
    counts.set(layerId, childCount(svgDomElt.getElementById(layerId)));
  }
  return counts;
}

function childCount(parent) {
  return parent?.children?.length ?? parent?.childNodes?.length ?? 0;
}

function tagNewChildren(parent, beforeCount, layerId, type) {
  const children = parent?.children ?? parent?.childNodes;
  if (!children || typeof beforeCount !== "number") return;

  for (let index = beforeCount; index < children.length; index += 1) {
    const child = children[index];
    if (!child?.setAttribute || child.getAttribute?.("data-legend-layer")) continue;

    child.setAttribute("data-legend-layer", layerId);
    child.setAttribute("data-legend-type", String(type ?? inferLegendType(child)));
  }
}

function inferLegendType(element) {
  const className = typeof element.getAttribute === "function"
    ? element.getAttribute("class")
    : element.attrs?.class;
  if (className) {
    return String(className).split(/\s+/).filter(Boolean).at(-1);
  }

  return String(element.tagName ?? element.name ?? "overlay").toLowerCase();
}
