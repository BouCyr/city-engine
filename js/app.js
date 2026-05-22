import {steps} from "./steps.mjs";
import {runPipeline} from "./pipeline.mjs";
import {createDefaultSettings, initSettingsPanel} from "./ui/settings-panel.mjs";

export let settings = createDefaultSettings();
export let map;
export let stepResults = [];

let svgDomElt;
let selectedStepIndex = steps.length - 1;
let hoveredStepIndex = null;
let settingsPanel;
let pendingRegeneration = null;

function activeStepIndex() {
  return hoveredStepIndex ?? selectedStepIndex;
}

function resultForStep(index) {
  return stepResults[index + 1];
}

function renderCurrentMap() {
  const index = activeStepIndex();
  const result = resultForStep(index);
  const displayMap = result?.map ?? map;

  svgDomElt.setAttribute("viewBox", `0 0 ${settings.size} ${settings.size}`);
  displayMap.clear(svgDomElt);
  displayMap.draw(svgDomElt);

  if (hoveredStepIndex !== null) {
    renderStepDetails(steps[index], result);
  }
}

function regenerate(nextSettings = settingsPanel?.readSettings?.() ?? settings) {
  settings = nextSettings;

  const result = runPipeline(settings);
  map = result.map;
  stepResults = result.stepResults;
  selectedStepIndex = Math.min(selectedStepIndex, steps.length - 1);

  renderCurrentMap();
}

function scheduleRegeneration(nextSettings) {
  clearTimeout(pendingRegeneration);
  pendingRegeneration = setTimeout(() => regenerate(nextSettings), 80);
}

function initStepsUI() {
  const list = document.getElementById("steps-list");
  const details = document.getElementById("details");
  if (!list) {
    return;
  }

  list.innerHTML = "";
  steps.forEach((step, index) => {
    const listItem = document.createElement("li");
    const firstLetter = document.createElement("span");
    const rest = document.createElement("span");

    listItem.className = "step-item";
    listItem.dataset.stepIndex = String(index);
    listItem.tabIndex = 0;
    firstLetter.className = "step-first-letter";
    firstLetter.textContent = step.title.slice(0, 1);
    rest.textContent = step.title.slice(1);
    listItem.append(firstLetter, rest);

    listItem.addEventListener("mouseenter", () => {
      hoveredStepIndex = index;
      renderCurrentMap();
    });

    listItem.addEventListener("click", () => {
      selectedStepIndex = index;
      updateSelectedStep();
      if (hoveredStepIndex === null) {
        renderCurrentMap();
      }
    });

    listItem.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      event.preventDefault();
      selectedStepIndex = index;
      updateSelectedStep();
      renderCurrentMap();
    });

    list.appendChild(listItem);
  });

  list.addEventListener("mouseleave", () => {
    hoveredStepIndex = null;
    renderCurrentMap();
    clearDetails(details);
  });

  updateSelectedStep();
}

function updateSelectedStep() {
  document.querySelectorAll("#steps-list .step-item").forEach((item) => {
    item.classList.toggle("selected-step", Number(item.dataset.stepIndex) === selectedStepIndex);
  });
}

function initSettingsToggle() {
  const container = document.querySelector(".container");
  const button = document.getElementById("settings-toggle");
  const panel = document.getElementById("settings-panel");
  if (!container || !button || !panel) {
    return;
  }

  panel.inert = true;
  button.setAttribute("aria-controls", "settings-panel");
  button.setAttribute("aria-expanded", "false");

  button.addEventListener("click", () => {
    const open = !container.classList.contains("settings-open");
    container.classList.toggle("settings-open", open);
    panel.inert = !open;
    button.setAttribute("aria-expanded", String(open));
  });
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

svgDomElt = document.getElementById("map_svg");
settingsPanel = initSettingsPanel(document.getElementById("settings-panel"), scheduleRegeneration);
initStepsUI();
initSettingsToggle();
regenerate(settings);
clearDetails(document.getElementById("details"));
