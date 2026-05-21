import {steps} from "./steps.mjs";
import {Settings} from "./data/settings.mjs";
import {runPipeline} from "./pipeline.mjs";


export {map, stepResults};

function initUI(){

  const lists = document.getElementById("steps-list");
  steps.forEach((step, index) => {
    const listItem = document.createElement("li");
    listItem.textContent = step.title;
    listItem.addEventListener("mouseenter", () => {
      // +1 because stepResults[0] is "void"
      const result = stepResults[index + 1];
      if (result && result.map) {
        result.map.clear(svgDomElt);
        result.map.draw(svgDomElt);
      }
    });
    lists.appendChild(listItem);
  })

  lists.addEventListener("mouseleave", () => {
    map.clear(svgDomElt);
    map.draw(svgDomElt);
  });

  return document.getElementById("map_svg");
}

const svgDomElt = initUI();


const settings = new Settings();
const {map, stepResults} = runPipeline(settings);

map.draw(svgDomElt);
