
export function Map(settings){
  return {
    size:settings.size,
    nodes:[],
    edges:[],
    cells:[],
    areas:[],


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
            .forEach((area) => area.draw(svgDomElt, groupElement));

          if (areasLayer) areasLayer.appendChild(groupElement);
        });

      this.cells
        .filter(cell => cell.draw)
        .forEach(cell => cell.draw(svgDomElt));

      this.nodes
        .filter(node => node.draw)
        .forEach(node => node.draw(svgDomElt));

      this.edges
        .filter(node => node.draw)
        .forEach(node => node.draw(svgDomElt));

      this.drawOverlay?.(svgDomElt);
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
