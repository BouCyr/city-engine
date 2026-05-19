import {steps} from "./steps.mjs";
import {Settings} from "./data/settings.mjs";
import {Map} from "./data/map.mjs";


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


let map = new Map(settings);

const stepResults = [];
stepResults.push({
  step:"void",map:map
});

for(let i = 0; i < steps.length; i++){
  const step = steps[i];
  console.info(step.title, "Starting");
  const stepMap  = step.process(settings, map);

  stepResults.push({
    step:step.title,
    map:cloneDeepKeepFunctions(stepMap)
  })
  map=stepMap;
  console.info(step.title, "Done");
}

map.draw(svgDomElt);




function cloneDeepKeepFunctions(value, seen = new WeakMap()) {
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const arr = [];
    seen.set(value, arr);
    for (const item of value) arr.push(cloneDeepKeepFunctions(item, seen));
    return arr;
  }

  const clone = Object.create(Object.getPrototypeOf(value));
  seen.set(value, clone);

  for (const key of Reflect.ownKeys(value)) {
    clone[key] = cloneDeepKeepFunctions(value[key], seen);
  }

  return clone;
}
