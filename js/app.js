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
  renderStepDetails(steps[index], result);
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

  if (step.description) {
    const paragraphs = step.description(settings, result?.map);
    paragraphs.forEach((paragraph) => {
      const p = document.createElement("p");
      p.innerHTML = paragraph;
      details.appendChild(p);
    });
  }

  if (result?.metrics) {
    details.appendChild(createMetricsDetails(result.metrics));
  }
}

svgDomElt = document.getElementById("map_svg");
settingsPanel = initSettingsPanel(document.getElementById("settings-panel"), scheduleRegeneration);
initStepsUI();
initSettingsToggle();
regenerate(settings);

function createMetricsDetails(metrics) {
  const wrapper = document.createElement("details");
  const summary = document.createElement("summary");
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  const headerRow = document.createElement("tr");

  wrapper.className = "metrics-section";
  wrapper.open = true;
  summary.textContent = "Metrics";
  wrapper.appendChild(summary);

  ["Metric", "Before", "After"].forEach((label) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    headerRow.appendChild(th);
  });

  thead.appendChild(headerRow);
  table.append(thead, tbody);

  [
    ["Nodes", "nodes"],
    ["Cells", "cells"],
    ["Areas", "areas"],
  ].forEach(([label, key]) => {
    tbody.appendChild(createEntityMetricRow(label, metrics.before?.[key], metrics.after?.[key]));
  });

  tbody.appendChild(createDurationMetricRow(metrics.durationMs));
  wrapper.appendChild(table);
  return wrapper;
}

function createEntityMetricRow(label, before = emptyEntityMetrics(), after = emptyEntityMetrics()) {
  const row = document.createElement("tr");
  const labelCell = document.createElement("td");
  const beforeCell = document.createElement("td");
  const afterCell = document.createElement("td");
  const typeNames = sortedTypeNames(before, after);

  if (typeNames.length > 0) {
    const typeDetails = document.createElement("details");
    const typeSummary = document.createElement("summary");
    typeDetails.className = "metric-breakdown";
    typeSummary.textContent = label;
    typeDetails.append(typeSummary, createTypeBreakdownTable(typeNames, before, after));
    labelCell.appendChild(typeDetails);
  } else {
    labelCell.textContent = label;
  }

  beforeCell.textContent = formatCount(before.count);
  afterCell.textContent = formatCount(after.count);
  row.append(labelCell, beforeCell, afterCell);
  return row;
}

function createDurationMetricRow(durationMs) {
  const row = document.createElement("tr");
  const labelCell = document.createElement("td");
  const valueCell = document.createElement("td");

  labelCell.textContent = "Step duration";
  valueCell.colSpan = 2;
  valueCell.textContent = `${formatDuration(durationMs)} ms`;
  row.append(labelCell, valueCell);
  return row;
}

function createTypeBreakdownTable(typeNames, before, after) {
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  const headerRow = document.createElement("tr");

  table.className = "metric-breakdown-table";
  ["Type", "Before", "After"].forEach((label) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);

  typeNames.forEach((typeName) => {
    const row = document.createElement("tr");
    [typeName, formatCount(before.types?.[typeName] ?? 0), formatCount(after.types?.[typeName] ?? 0)]
      .forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      });
    tbody.appendChild(row);
  });

  table.append(thead, tbody);
  return table;
}

function sortedTypeNames(before, after) {
  return Array.from(new Set([
    ...Object.keys(before?.types ?? {}),
    ...Object.keys(after?.types ?? {}),
  ])).sort((left, right) => left.localeCompare(right));
}

function emptyEntityMetrics() {
  return {
    count: 0,
    types: {},
  };
}

function formatCount(value) {
  return String(value ?? 0);
}

function formatDuration(value) {
  if (!Number.isFinite(value)) {
    return "0.0";
  }

  return value.toFixed(1);
}
