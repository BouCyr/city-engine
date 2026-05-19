
export function Map(settings){
  return {
    size:settings.size,
    nodes:[],
    edges:[],


    draw:function(svgDomElt){
      console.log("draw");
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
      if (nodesG) nodesG.innerHTML = "";
      if (edgesG) edgesG.innerHTML = "";
    }
  };


}
