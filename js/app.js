import {steps} from "./steps.mjs";
import {Settings} from "./data/settings.mjs";
import {runPipeline} from "./pipeline.mjs";


export {map, stepResults};

function initUI(){

  const lists = document.getElementById("steps-list");
  const details = document.getElementById("details");
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
      renderStepDetails(step, result);
    });
    lists.appendChild(listItem);
  })

  lists.addEventListener("mouseleave", () => {
    map.clear(svgDomElt);
    map.draw(svgDomElt);
    clearDetails(details);
  });

  return document.getElementById("map_svg");
}

function renderStepDetails(step, result) {
  const details = document.getElementById("details");
  if (!details) {
    return;
  }

  details.innerHTML = "";
  const heading = document.createElement("h4");
  heading.textContent = `${step.title} Step`;
  details.appendChild(heading);

  if (!step.description) {
    return;
  }

  const paragraphs = step.description(settings, result?.map);
  paragraphs.forEach((paragraph) => {
    const p = document.createElement("p");
    p.innerHTML = paragraph;
    details.appendChild(p);
  });
}

function clearDetails(details) {
  if (!details) {
    return;
  }

  details.innerHTML = "<p>Hover a step to inspect what changed and the settings used.</p>";
}

const svgDomElt = initUI();


const settings = new Settings();
const {map, stepResults} = runPipeline(settings);

clearDetails(document.getElementById("details"));
map.draw(svgDomElt);
