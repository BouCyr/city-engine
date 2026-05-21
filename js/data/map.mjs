
export function Map(settings){
  return {
    size:settings.size,
    nodes:[],
    edges:[],
    cells:[],


    draw:function(svgDomElt){
      console.log("draw");
      this.cells
        .filter(cell => cell.draw)
        .forEach(cell => cell.draw(svgDomElt));

      this.nodes
        .filter(node => node.draw)
        .forEach(node => node.draw(svgDomElt));

      this.edges
        .filter(node => node.draw)
        .forEach(node => node.draw(svgDomElt));
    },

    clear:function(svgDomElt){
      const nodesG = svgDomElt.querySelector("#nodes");
      const edgesG = svgDomElt.querySelector("#edges");
      const cellsG = svgDomElt.querySelector("#cells");
      if (cellsG) cellsG.innerHTML = "";
      if (nodesG) nodesG.innerHTML = "";
      if (edgesG) edgesG.innerHTML = "";
    }
  };


}
