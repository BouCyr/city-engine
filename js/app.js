import {steps} from "./steps.mjs";
import {runPipeline} from "./pipeline.mjs";
import {Map as CityMap} from "./data/map.mjs";
import {hydrateReplay, plainSettings, serializeMap} from "./replay-service.mjs";
import {areaBoundaryPath} from "./data/area.mjs";
import {orderedCellPoints} from "./data/cell.mjs";
import {createDefaultSettings, renderStepSettingsForm} from "./ui/settings-panel.mjs";
import {
  EDGE_TYPE_COAST,
  EDGE_TYPE_CROSSING,
  EDGE_TYPE_RIVER,
  EDGE_TYPE_SEA,
  NODE_TYPE_COAST,
  NODE_TYPE_CROSSING,
  NODE_TYPE_CROSSING_END,
  NODE_TYPE_LAND,
  NODE_TYPE_POI,
  NODE_TYPE_RIVER,
  NODE_TYPE_RIVER_JUNCTION,
  TERRAIN_COAST,
  TERRAIN_LAND,
  TERRAIN_SEA,
} from "./constants.mjs";

export let settings = createDefaultSettings();
export let map;
export let stepResults = [];

let svgDomElt;
let renderedTypeKeys = new Set();
let selectedStepIndex = steps.length - 1;
let hoveredStepIndex = null;
let stepSettingsOpen = false;
let pendingRegeneration = null;
let generationError = null;
let replayFrameIndex = 0;
let replayTimer = null;
let replayWorker = null;
let replayGenerationToken = 0;
let nextReplayRequestId = 1;
const pendingReplayRequests = new Map();

const REPLAY_INTERVAL_MS = 2000;
const ZOOM_IN_FACTOR = 0.9;
const ZOOM_OUT_FACTOR = 1.1;
const MIN_VIEW_RATIO = 0.12;
const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_NODE_RADIUS = 6;
const TERRAIN_NODE_RADIUS = DEFAULT_NODE_RADIUS / 2;
const ENTITY_METRICS = [
  {label: "Nodes", key: "nodes", layerId: "nodes"},
  {label: "Edges", key: "edges", layerId: "edges"},
  {label: "Cells", key: "cells", layerId: "cells"},
  {label: "Areas", key: "areas", layerId: "areas"},
];
const SAMPLE_ATTRS = [
  "class",
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
];

const mapDisplayState = {
  hiddenLayers: new Set(["cells"]),
  hiddenTypes: new Set(),
  debugTypes: new Set(),
  defaultNodeTypes: new Set(),
};

const camera = {
  x: 0,
  y: 0,
  width: settings.size,
  height: settings.size,
  size: settings.size,
};

const panState = {
  active: false,
  pointerId: null,
  lastPoint: null,
};

function activeStepIndex() {
  if (isStepExplanationOpen() || stepSettingsOpen) {
    return selectedStepIndex;
  }

  return hoveredStepIndex ?? selectedStepIndex;
}

function resultForStep(index) {
  return stepResults[index + 1];
}

function renderCurrentMap() {
  if (generationError) {
    const displayMap = map ?? new CityMap(settings);
    applyCameraForSize(displayMap?.size ?? settings.size);
    displayMap.clear(svgDomElt);
    renderGenerationError();
    return;
  }

  const index = activeStepIndex();
  const result = resultForStep(index);
  const replayFrame = activeReplayFrame();
  const displayMap = replayFrame?.map ?? result?.map ?? map;

  applyCameraForSize(displayMap?.size ?? settings.size);
  displayMap.clear(svgDomElt);
  displayMap.draw(svgDomElt);
  renderedTypeKeys = collectRenderedTypeKeys(svgDomElt);
  seedDefaultNodeDisplayTypes(displayMap);
  drawDebugDisplayEntities(displayMap);
  applyMapDisplayVisibility();
  renderStepDetails(steps[index], result);
  renderStepExplanation();
}

function regenerate(nextSettings = settings) {
  const previousSize = settings.size;
  settings = nextSettings;
  replayGenerationToken += 1;
  pendingReplayRequests.clear();

  try {
    generationError = null;
    const result = runPipeline(settings);
    map = result.map;
    stepResults = result.stepResults;
  } catch (error) {
    console.error("Generation failed", error);
    generationError = error;
    map = map ?? new CityMap(settings);
    stepResults = [];
  }
  selectedStepIndex = Math.min(selectedStepIndex, steps.length - 1);
  replayFrameIndex = 0;
  stopReplayPlayback();
  if (previousSize !== settings.size) {
    resetCamera(settings.size);
  } else {
    applyCameraForSize(settings.size);
  }

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
      if (isStepExplanationOpen() || stepSettingsOpen) {
        return;
      }

      hoveredStepIndex = index;
      renderCurrentMap();
    });

    listItem.addEventListener("click", () => {
      selectedStepIndex = index;
      replayFrameIndex = 0;
      stopReplayPlayback();
      updateSelectedStep();
      requestReplayForSelectedStep();
      if (hoveredStepIndex === null || isStepExplanationOpen()) {
        renderCurrentMap();
      }
    });

    listItem.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      event.preventDefault();
      selectedStepIndex = index;
      replayFrameIndex = 0;
      stopReplayPlayback();
      updateSelectedStep();
      requestReplayForSelectedStep();
      renderCurrentMap();
    });

    list.appendChild(listItem);
  });

  list.addEventListener("mouseleave", () => {
    if (isStepExplanationOpen() || stepSettingsOpen) {
      return;
    }

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

function renderStepDetails(step, result) {
  const details = document.getElementById("details");
  if (!details) {
    return;
  }

  details.innerHTML = "";
  details.appendChild(createDetailsHeader(step));

  const body = document.createElement("div");
  body.className = `details-body ${stepSettingsOpen ? "details-body-settings" : "details-body-overview"}`;
  details.appendChild(body);

  if (stepSettingsOpen) {
    renderStepSettingsForm(body, settings, step.title, scheduleRegeneration);
    return;
  }

  if (step.description) {
    const paragraphs = step.description(settings, result?.map);
    paragraphs.forEach((paragraph) => {
      const p = document.createElement("p");
      p.innerHTML = paragraph;
      body.appendChild(p);
    });
  }

  if (result?.metrics) {
    body.appendChild(createMetricsDetails(result.metrics));
  }
}

function createDetailsHeader(step) {
  const header = document.createElement("div");
  const title = document.createElement("h4");
  const actions = document.createElement("div");

  header.className = "details-header";
  title.textContent = `${step.title} Step`;
  actions.className = "details-actions";
  actions.append(createStepExplanationToggle(), createStepSettingsToggle());
  header.append(title, actions);
  return header;
}

function createStepExplanationToggle() {
  const button = document.createElement("button");
  button.type = "button";
  button.id = "step-explanation-toggle";
  button.className = "details-icon-button step-explanation-toggle";
  button.setAttribute("aria-controls", "step-explanation-panel");
  button.setAttribute("aria-expanded", String(isStepExplanationOpen()));
  button.setAttribute("aria-label", "Step explanation");
  button.innerHTML = infoIconSvg();
  button.addEventListener("click", () => setStepExplanationOpen(!isStepExplanationOpen()));
  return button;
}

function createStepSettingsToggle() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "details-icon-button step-settings-toggle";
  button.setAttribute("aria-expanded", String(stepSettingsOpen));
  button.setAttribute("aria-label", stepSettingsOpen ? "Close step settings" : "Open step settings");
  button.innerHTML = stepSettingsOpen ? closeIconSvg() : settingsIconSvg();
  button.addEventListener("click", () => setStepSettingsOpen(!stepSettingsOpen));
  return button;
}

function initStepExplanationPanel() {
  const panel = document.getElementById("step-explanation-panel");
  if (!panel) {
    return;
  }

  panel.inert = true;
}

function setStepExplanationOpen(open) {
  const container = document.querySelector(".container");
  const details = document.getElementById("details");
  const explanation = document.getElementById("step-explanation-panel");
  if (!container || !explanation) {
    return;
  }

  stopReplayPlayback();
  replayFrameIndex = 0;
  hoveredStepIndex = null;

  if (open) {
    stepSettingsOpen = false;
  }

  container.classList.toggle("step-explanation-open", open);
  explanation.inert = !open;
  details && (details.inert = open);
  requestReplayForSelectedStep();
  renderCurrentMap();
}

function setStepSettingsOpen(open) {
  stepSettingsOpen = open;
  if (open) {
    setStepExplanationOpen(false);
    return;
  }
  renderCurrentMap();
}

function isStepExplanationOpen() {
  return document.querySelector(".container")?.classList.contains("step-explanation-open") ?? false;
}

function activeReplayFrame() {
  if (!isStepExplanationOpen()) {
    return null;
  }

  const frames = resultForStep(selectedStepIndex)?.replay?.frames;
  if (!frames?.length) {
    return null;
  }

  replayFrameIndex = Math.min(replayFrameIndex, frames.length - 1);
  return frames[replayFrameIndex];
}

function renderStepExplanation() {
  const panel = document.getElementById("step-explanation-panel");
  if (!panel) {
    return;
  }

  panel.innerHTML = "";
  if (!isStepExplanationOpen()) {
    return;
  }

  const step = steps[selectedStepIndex];
  const result = resultForStep(selectedStepIndex);
  const header = document.createElement("div");
  const title = document.createElement("h3");
  const closeButton = document.createElement("button");

  header.className = "step-explanation-header";
  title.textContent = `${step.title} Explanation`;
  closeButton.type = "button";
  closeButton.className = "step-explanation-close";
  closeButton.setAttribute("aria-label", "Close step explanation");
  closeButton.textContent = "Close";
  closeButton.addEventListener("click", () => setStepExplanationOpen(false));
  header.append(title, closeButton);
  panel.appendChild(header);

  renderExplanationCopy(panel, step, result);
  step.renderExplanationExtras?.(panel, settings, result);

  if (result?.replay?.frames?.length) {
    panel.appendChild(createReplayControls(result.replay.frames));
  } else if (step.createReplay) {
    panel.appendChild(createReplayStatus(result));
  }
}

function renderExplanationCopy(panel, step, result) {
  const paragraphs = step.explanation
    ? step.explanation(settings, result)
    : step.description?.(settings, result?.map) ?? ["No detailed explanation is available for this step yet."];

  paragraphs.forEach((paragraph) => {
    const p = document.createElement("p");
    p.innerHTML = paragraph;
    panel.appendChild(p);
  });

  const frameText = activeReplayFrame()?.text;
  if (frameText) {
    const p = document.createElement("p");
    p.className = "replay-frame-text";
    p.textContent = frameText;
    panel.appendChild(p);
  }
}

function createReplayControls(frames) {
  const wrapper = document.createElement("div");
  const controls = document.createElement("div");
  const playButton = document.createElement("button");
  const label = document.createElement("span");
  const sliderRow = document.createElement("div");
  const previousButton = document.createElement("button");
  const nextButton = document.createElement("button");
  const range = document.createElement("input");

  replayFrameIndex = Math.min(replayFrameIndex, frames.length - 1);
  wrapper.className = "replay-controls";
  controls.className = "replay-control-row";
  playButton.type = "button";
  playButton.className = "replay-play-toggle";
  playButton.textContent = replayTimer ? "Pause" : "Play";
  playButton.addEventListener("click", toggleReplayPlayback);

  label.className = "replay-frame-label";
  label.textContent = frames[replayFrameIndex]?.label ?? `Frame ${replayFrameIndex}`;

  range.type = "range";
  range.min = "0";
  range.max = String(frames.length - 1);
  range.step = "1";
  range.value = String(replayFrameIndex);
  range.setAttribute("aria-label", "Replay frame");
  range.addEventListener("input", () => {
    stopReplayPlayback();
    replayFrameIndex = Number(range.value);
    renderCurrentMap();
  });

  previousButton.type = "button";
  previousButton.className = "replay-step-button";
  previousButton.setAttribute("aria-label", "Previous replay frame");
  previousButton.innerHTML = chevronLeftSvg();
  previousButton.disabled = replayFrameIndex <= 0;
  previousButton.addEventListener("click", () => stepReplayFrame(-1));

  nextButton.type = "button";
  nextButton.className = "replay-step-button";
  nextButton.setAttribute("aria-label", "Next replay frame");
  nextButton.innerHTML = chevronRightSvg();
  nextButton.disabled = replayFrameIndex >= frames.length - 1;
  nextButton.addEventListener("click", () => stepReplayFrame(1));

  sliderRow.className = "replay-slider-row";
  sliderRow.append(previousButton, range, nextButton);

  controls.append(playButton, label);
  wrapper.append(controls, sliderRow);
  return wrapper;
}

function stepReplayFrame(direction) {
  const frames = resultForStep(selectedStepIndex)?.replay?.frames;
  if (!frames?.length) return;
  stopReplayPlayback();
  replayFrameIndex = Math.max(0, Math.min(frames.length - 1, replayFrameIndex + direction));
  renderCurrentMap();
}

function toggleReplayPlayback() {
  if (replayTimer) {
    stopReplayPlayback();
    renderCurrentMap();
    return;
  }

  startReplayPlayback();
}

function startReplayPlayback() {
  const frames = resultForStep(selectedStepIndex)?.replay?.frames;
  if (!frames?.length || replayFrameIndex >= frames.length - 1) {
    return;
  }

  replayTimer = setInterval(() => {
    const activeFrames = resultForStep(selectedStepIndex)?.replay?.frames;
    if (!activeFrames?.length || replayFrameIndex >= activeFrames.length - 1) {
      stopReplayPlayback();
      renderCurrentMap();
      return;
    }

    replayFrameIndex += 1;
    renderCurrentMap();
  }, REPLAY_INTERVAL_MS);
  renderCurrentMap();
}

function stopReplayPlayback() {
  if (!replayTimer) {
    return;
  }

  clearInterval(replayTimer);
  replayTimer = null;
}

function requestReplayForSelectedStep() {
  if (!isStepExplanationOpen()) {
    return;
  }

  const step = steps[selectedStepIndex];
  const result = resultForStep(selectedStepIndex);
  const inputResult = stepResults[selectedStepIndex];
  if (!step?.createReplay || !result || result.replay?.frames?.length || result.replayStatus === "loading") {
    return;
  }

  const requestId = nextReplayRequestId;
  nextReplayRequestId += 1;
  result.replayStatus = "loading";
  result.replayError = null;
  pendingReplayRequests.set(requestId, {
    generationToken: replayGenerationToken,
    stepIndex: selectedStepIndex,
  });

  try {
    getReplayWorker().postMessage({
      requestId,
      stepIndex: selectedStepIndex,
      settingsData: plainSettings(settings),
      inputMapData: serializeMap(inputResult.map),
    });
  } catch (error) {
    pendingReplayRequests.delete(requestId);
    result.replayStatus = "error";
    result.replayError = error?.message ?? String(error);
  }
}

function getReplayWorker() {
  if (replayWorker) {
    return replayWorker;
  }

  replayWorker = new Worker(new URL("./replay-worker.mjs", import.meta.url), {type: "module"});
  replayWorker.onmessage = handleReplayWorkerMessage;
  replayWorker.onerror = handleReplayWorkerError;
  return replayWorker;
}

function handleReplayWorkerMessage(event) {
  const {requestId, status, replay, error} = event.data ?? {};
  const request = pendingReplayRequests.get(requestId);
  if (!request) {
    return;
  }

  pendingReplayRequests.delete(requestId);
  if (request.generationToken !== replayGenerationToken) {
    return;
  }

  const result = resultForStep(request.stepIndex);
  if (!result) {
    return;
  }

  if (status === "ready") {
    result.replay = hydrateReplay(replay);
    result.replayStatus = "ready";
    result.replayError = null;
  } else {
    result.replayStatus = "error";
    result.replayError = error ?? "Replay unavailable";
  }

  if (isStepExplanationOpen() && selectedStepIndex === request.stepIndex) {
    replayFrameIndex = 0;
    stopReplayPlayback();
    renderCurrentMap();
  }
}

function handleReplayWorkerError(error) {
  for (const [requestId, request] of pendingReplayRequests) {
    if (request.generationToken !== replayGenerationToken) {
      pendingReplayRequests.delete(requestId);
      continue;
    }

    const result = resultForStep(request.stepIndex);
    if (result) {
      result.replayStatus = "error";
      result.replayError = error?.message ?? "Replay unavailable";
    }
    pendingReplayRequests.delete(requestId);
  }

  if (isStepExplanationOpen()) {
    renderCurrentMap();
  }
}

function createReplayStatus(result) {
  const p = document.createElement("p");
  p.className = "replay-frame-text";
  if (result?.replayStatus === "error") {
    p.textContent = `Replay unavailable${result.replayError ? `: ${result.replayError}` : ""}`;
  } else {
    p.textContent = "Replay loading...";
  }
  return p;
}

svgDomElt = document.getElementById("map_svg");
initStepsUI();
initStepExplanationPanel();
initMapInteractions();
regenerate(settings);

function settingsIconSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v3M12 18v3M4.2 7.5l2.6 1.5M17.2 15l2.6 1.5M4.2 16.5l2.6-1.5M17.2 9l2.6-1.5"/><circle cx="12" cy="12" r="3.2"/><path d="M12 6a6 6 0 0 1 0 12 6 6 0 0 1 0-12Z"/></svg>`;
}

function closeIconSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>`;
}

function infoIconSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8h.01"/></svg>`;
}

function chevronLeftSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6 9 12l6 6"/></svg>`;
}

function chevronRightSvg() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;
}

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

  ["Metric", "Sample", "Before", "After"].forEach((label) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    headerRow.appendChild(th);
  });

  thead.appendChild(headerRow);
  table.append(thead, tbody);

  ENTITY_METRICS.forEach((definition) => {
    createEntityMetricRows(definition, metrics.before?.[definition.key], metrics.after?.[definition.key])
      .forEach((row) => tbody.appendChild(row));
  });

  tbody.appendChild(createDurationMetricRow(metrics.durationMs));
  wrapper.appendChild(table);
  return wrapper;
}

function createEntityMetricRows(definition, before = emptyEntityMetrics(), after = emptyEntityMetrics()) {
  const row = document.createElement("tr");
  const labelCell = document.createElement("td");
  const sampleCell = document.createElement("td");
  const beforeCell = document.createElement("td");
  const afterCell = document.createElement("td");
  const typeNames = sortedTypeNames(before, after);
  const activeTypeNames = Object.keys(after?.types ?? {});

  sampleCell.className = "metric-sample-cell";
  sampleCell.appendChild(createMetricLayerSample(definition, activeTypeNames));
  beforeCell.textContent = formatCount(before.count);
  afterCell.textContent = formatCount(after.count);

  if (typeNames.length > 0) {
    const breakdownRow = document.createElement("tr");
    const breakdownCell = document.createElement("td");
    const toggle = document.createElement("button");
    const labelText = document.createElement("span");
    const layerButton = createMetricVisibilityButton(
      definition.label,
      isLayerVisible(definition.layerId, activeTypeNames),
      () => toggleEntityLayer(definition.layerId, activeTypeNames)
    );
    const breakdownId = `metric-breakdown-${definition.key}`;

    breakdownRow.className = "metric-breakdown-row";
    breakdownRow.id = breakdownId;
    breakdownRow.hidden = true;
    breakdownCell.colSpan = 4;

    toggle.type = "button";
    toggle.className = "metric-breakdown-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", breakdownId);
    toggle.textContent = ">";
    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!expanded));
      breakdownRow.hidden = expanded;
      toggle.textContent = expanded ? ">" : "v";
    });

    labelText.appendChild(layerButton);
    labelCell.className = "metric-label-with-toggle";
    labelCell.append(toggle, labelText);
    row.append(labelCell, sampleCell, beforeCell, afterCell);

    breakdownCell.appendChild(createTypeBreakdownTable(definition, typeNames, before, after));
    breakdownRow.appendChild(breakdownCell);
    return [row, breakdownRow];
  }

  labelCell.appendChild(createMetricVisibilityButton(
    definition.label,
    isLayerVisible(definition.layerId, activeTypeNames),
    () => toggleEntityLayer(definition.layerId, activeTypeNames)
  ));
  row.append(labelCell, sampleCell, beforeCell, afterCell);
  return [row];
}

function createDurationMetricRow(durationMs) {
  const row = document.createElement("tr");
  const labelCell = document.createElement("td");
  const valueCell = document.createElement("td");

  labelCell.textContent = "Step duration";
  valueCell.colSpan = 3;
  valueCell.textContent = `${formatDuration(durationMs)} ms`;
  row.append(labelCell, valueCell);
  return row;
}

function createTypeBreakdownTable(definition, typeNames, before, after) {
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  const headerRow = document.createElement("tr");

  table.className = "metric-breakdown-table";
  ["Type", "Sample", "Before", "After"].forEach((label) => {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);

  typeNames.forEach((typeName) => {
    const row = document.createElement("tr");
    const typeCell = document.createElement("td");
    const sampleCell = document.createElement("td");
    const beforeCell = document.createElement("td");
    const afterCell = document.createElement("td");
    const afterCount = after.types?.[typeName] ?? 0;
    const enabled = afterCount > 0;

    typeCell.appendChild(createMetricVisibilityButton(
      formatTypeLabel(typeName),
      isEntityTypeVisible(definition.layerId, typeName),
      () => toggleEntityType(definition.layerId, typeName),
      !enabled
    ));
    sampleCell.className = "metric-sample-cell";
    sampleCell.appendChild(createMetricTypeSample(definition.layerId, typeName, enabled));
    beforeCell.textContent = formatCount(before.types?.[typeName] ?? 0);
    afterCell.textContent = formatCount(afterCount);
    row.append(typeCell, sampleCell, beforeCell, afterCell);
    tbody.appendChild(row);
  });

  table.append(thead, tbody);
  return table;
}

function createMetricVisibilityButton(label, visible, onClick, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "metric-visibility-toggle";
  button.setAttribute("aria-pressed", String(!visible));
  button.disabled = disabled;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function createMetricLayerSample(definition, typeNames) {
  const activeTypes = typeNames.length > 0 ? typeNames : [null];
  if (definition.layerId === "areas" || definition.layerId === "cells") {
    const swatches = document.createElement("button");
    swatches.type = "button";
    swatches.className = "metric-sample-fill metric-sample-fill-stack";
    swatches.setAttribute("aria-label", `${definition.label} visibility`);
    swatches.setAttribute("aria-pressed", String(!isLayerVisible(definition.layerId, typeNames)));
    swatches.addEventListener("click", () => toggleEntityLayer(definition.layerId, typeNames));

    activeTypes.slice(0, 3).forEach((typeName) => {
      const swatch = document.createElement("span");
      swatch.style.background = colorForType(typeName, definition.layerId);
      swatches.appendChild(swatch);
    });
    return swatches;
  }

  const firstType = activeTypes[0];
  return createSampleButton(
    `${definition.label} visibility`,
    isLayerVisible(definition.layerId, typeNames),
    () => toggleEntityLayer(definition.layerId, typeNames),
    createSampleSvg(definition.layerId, firstType)
  );
}

function createMetricTypeSample(layerId, typeName, enabled) {
  if (layerId === "areas" || layerId === "cells") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "metric-sample-fill";
    button.style.background = colorForType(typeName, layerId);
    button.disabled = !enabled;
    button.setAttribute("aria-label", `${formatTypeLabel(typeName)} visibility`);
    button.setAttribute("aria-pressed", String(!isEntityTypeVisible(layerId, typeName)));
    button.addEventListener("click", () => toggleEntityType(layerId, typeName));
    return button;
  }

  return createSampleButton(
    `${formatTypeLabel(typeName)} visibility`,
    isEntityTypeVisible(layerId, typeName),
    () => toggleEntityType(layerId, typeName),
    createSampleSvg(layerId, typeName),
    !enabled
  );
}

function createSampleButton(label, visible, onClick, sample, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "metric-sample-button";
  button.disabled = disabled;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(!visible));
  button.appendChild(sample);
  button.addEventListener("click", onClick);
  return button;
}

function createSampleSvg(layerId, typeName) {
  const sample = document.createElementNS(SVG_NS, "svg");
  const source = renderedElementForType(layerId, typeName);
  sample.setAttribute("class", "metric-sample-svg");
  sample.setAttribute("viewBox", "0 0 56 18");
  sample.setAttribute("aria-hidden", "true");

  if (layerId === "nodes") {
    sample.appendChild(createSampleCircle(source, typeName));
  } else if (layerId === "edges") {
    sample.appendChild(createSamplePath(source, typeName));
  } else {
    sample.appendChild(createSamplePolygon(source, typeName, layerId));
  }
  return sample;
}

function createSampleCircle(source, typeName) {
  const circle = document.createElementNS(SVG_NS, "circle");
  copySampleAttrs(source, circle);
  circle.setAttribute("cx", "28");
  circle.setAttribute("cy", "9");
  circle.setAttribute("r", String(nodeRadiusForType(typeName, 5)));
  if (!circle.getAttribute("fill") && !circle.getAttribute("class")) {
    circle.setAttribute("fill", colorForType(typeName, "nodes"));
  }
  return circle;
}

function createSamplePath(source, typeName) {
  const path = document.createElementNS(SVG_NS, "path");
  copySampleAttrs(source, path);
  path.setAttribute("d", "M 3 9 L 53 9");
  if (!path.getAttribute("fill")) path.setAttribute("fill", "none");
  if (!path.getAttribute("stroke") && !path.getAttribute("class")) {
    path.setAttribute("stroke", colorForType(typeName, "edges"));
  }
  if (!path.getAttribute("stroke-width") && !path.getAttribute("class")) {
    path.setAttribute("stroke-width", "2");
  }
  return path;
}

function createSamplePolygon(source, typeName, layerId) {
  const polygon = document.createElementNS(SVG_NS, "polygon");
  copySampleAttrs(source, polygon);
  polygon.setAttribute("points", "4,14 18,4 52,6 45,15");
  if (!polygon.getAttribute("fill") && !polygon.getAttribute("class")) {
    polygon.setAttribute("fill", colorForType(typeName, layerId));
  }
  return polygon;
}

function copySampleAttrs(source, target) {
  if (!source?.getAttribute) return;
  for (const attr of SAMPLE_ATTRS) {
    const value = source.getAttribute(attr);
    if (value !== null && value !== "") {
      target.setAttribute(attr, value);
    }
  }
}

function collectRenderedTypeKeys(svg) {
  const keys = new Set();
  const elements = svg?.querySelectorAll?.("[data-legend-layer][data-legend-type]") ?? [];
  for (const element of elements) {
    keys.add(typeKey(element.getAttribute("data-legend-layer"), element.getAttribute("data-legend-type")));
  }
  return keys;
}

function renderedElementForType(layerId, typeName) {
  return svgDomElt?.querySelector?.(`[data-legend-layer="${cssEscape(layerId)}"][data-legend-type="${cssEscape(typeName)}"]`) ?? null;
}

function isLayerVisible(layerId, typeNames) {
  if (typeNames.length === 0) return false;
  return typeNames.some((typeName) => isEntityTypeVisible(layerId, typeName));
}

function isEntityTypeVisible(layerId, typeName) {
  const key = typeKey(layerId, typeName);
  if (mapDisplayState.hiddenLayers.has(layerId) || mapDisplayState.hiddenTypes.has(key)) return false;
  return renderedTypeKeys.has(key) || mapDisplayState.debugTypes.has(key);
}

function seedDefaultNodeDisplayTypes(displayMap) {
  for (const node of displayMap?.nodes ?? []) {
    if (!node?.type) continue;

    const key = typeKey("nodes", node.type);
    if (mapDisplayState.defaultNodeTypes.has(key)) continue;

    mapDisplayState.defaultNodeTypes.add(key);
    if (node.type === NODE_TYPE_CROSSING || node.type === NODE_TYPE_CROSSING_END) {
      if (!renderedTypeKeys.has(key)) {
        mapDisplayState.debugTypes.add(key);
      }
    } else {
      mapDisplayState.hiddenTypes.add(key);
    }
  }
}

function toggleEntityLayer(layerId, typeNames) {
  if (typeNames.length === 0) return;

  const visible = isLayerVisible(layerId, typeNames);
  if (visible) {
    mapDisplayState.hiddenLayers.add(layerId);
    renderCurrentMap();
    return;
  }

  mapDisplayState.hiddenLayers.delete(layerId);
  for (const typeName of typeNames) {
    const key = typeKey(layerId, typeName);
    mapDisplayState.hiddenTypes.delete(key);
    if (!renderedTypeKeys.has(key)) {
      mapDisplayState.debugTypes.add(key);
    }
  }
  renderCurrentMap();
}

function renderGenerationError() {
  const details = document.getElementById("details");
  if (!details) return;

  details.innerHTML = "";
  const header = document.createElement("div");
  const title = document.createElement("h4");
  const body = document.createElement("div");
  const message = document.createElement("p");

  header.className = "details-header";
  title.textContent = "Generation Error";
  header.append(title);
  body.className = "details-body details-error";
  message.textContent = generationError?.message ?? String(generationError ?? "Generation failed");
  body.appendChild(message);
  details.append(header, body);
}

function toggleEntityType(layerId, typeName) {
  const key = typeKey(layerId, typeName);
  const visible = isEntityTypeVisible(layerId, typeName);

  if (visible) {
    if (renderedTypeKeys.has(key)) {
      mapDisplayState.hiddenTypes.add(key);
    } else {
      mapDisplayState.debugTypes.delete(key);
    }
  } else {
    mapDisplayState.hiddenLayers.delete(layerId);
    mapDisplayState.hiddenTypes.delete(key);
    if (!renderedTypeKeys.has(key)) {
      mapDisplayState.debugTypes.add(key);
    }
  }

  renderCurrentMap();
}

function drawDebugDisplayEntities(displayMap) {
  if (!displayMap) return;

  for (const key of mapDisplayState.debugTypes) {
    const [layerId, typeName] = splitTypeKey(key);
    if (!layerId || renderedTypeKeys.has(key)) continue;

    if (layerId === "nodes") {
      drawDebugNodes(displayMap, typeName);
    } else if (layerId === "edges") {
      drawDebugEdges(displayMap, typeName);
    } else if (layerId === "cells") {
      drawDebugCells(displayMap, typeName);
    } else if (layerId === "areas") {
      drawDebugAreas(displayMap, typeName);
    }
  }
}

function applyMapDisplayVisibility() {
  const elements = svgDomElt?.querySelectorAll?.("[data-legend-layer][data-legend-type]") ?? [];
  for (const element of elements) {
    const layerId = element.getAttribute("data-legend-layer");
    const typeName = element.getAttribute("data-legend-type");
    if (layerId === "overlay") {
      element.classList?.remove("legend-hidden");
      continue;
    }
    element.classList?.toggle(
      "legend-hidden",
      mapDisplayState.hiddenLayers.has(layerId) || mapDisplayState.hiddenTypes.has(typeKey(layerId, typeName))
    );
  }
}

function drawDebugNodes(displayMap, typeName) {
  const layer = svgDomElt?.getElementById("nodes");
  if (!layer) return;

  for (const node of displayMap.nodes ?? []) {
    if (node.type !== typeName) continue;
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", node.x);
    circle.setAttribute("cy", node.y);
    circle.setAttribute("r", String(nodeRadiusForType(typeName)));
    circle.setAttribute("fill", colorForType(typeName, "nodes"));
    circle.setAttribute("stroke", "var(--bg-color)");
    circle.setAttribute("stroke-width", "2");
    tagDebugElement(circle, "nodes", typeName);
    layer.appendChild(circle);
  }
}

function drawDebugEdges(displayMap, typeName) {
  const layer = svgDomElt?.getElementById("edges");
  if (!layer) return;

  for (const edge of displayMap.edges ?? []) {
    if (edge.type !== typeName || !edge.start || !edge.end) continue;
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", `M ${edge.start.x} ${edge.start.y} L ${edge.end.x} ${edge.end.y}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", colorForType(typeName, "edges"));
    path.setAttribute("stroke-width", edge.type === EDGE_TYPE_RIVER ? "7" : "2");
    tagDebugElement(path, "edges", typeName);
    layer.appendChild(path);
  }
}

function drawDebugCells(displayMap, typeName) {
  const layer = svgDomElt?.getElementById("cells");
  if (!layer) return;

  for (const cell of displayMap.cells ?? []) {
    if (cell.type !== typeName) continue;
    const points = safeOrderedCellPoints(cell);
    if (points.length < 3) continue;
    const polygon = document.createElementNS(SVG_NS, "polygon");
    polygon.setAttribute("points", points.map(point => `${point.x},${point.y}`).join(" "));
    polygon.setAttribute("fill", colorForType(typeName, "cells"));
    polygon.setAttribute("fill-opacity", "0.28");
    polygon.setAttribute("stroke", colorForType(typeName, "cells"));
    polygon.setAttribute("stroke-opacity", "0.75");
    polygon.setAttribute("stroke-width", "2");
    tagDebugElement(polygon, "cells", typeName);
    layer.appendChild(polygon);
  }
}

function drawDebugAreas(displayMap, typeName) {
  const layer = svgDomElt?.getElementById("areas");
  if (!layer) return;

  for (const group of displayMap.areas ?? []) {
    for (const area of group?.areas ?? []) {
      if (area.type !== typeName) continue;
      const d = areaBoundaryPath(area.cells ?? []);
      if (!d) continue;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", colorForType(typeName, "areas"));
      path.setAttribute("fill-opacity", "0.36");
      path.setAttribute("stroke", "none");
      path.setAttribute("fill-rule", "evenodd");
      tagDebugElement(path, "areas", typeName);
      layer.appendChild(path);
    }
  }
}

function safeOrderedCellPoints(cell) {
  try {
    return orderedCellPoints(cell);
  } catch {
    return [];
  }
}

function tagDebugElement(element, layerId, typeName) {
  element.setAttribute("data-legend-layer", layerId);
  element.setAttribute("data-legend-type", typeName);
  element.setAttribute("data-debug-display", "true");
}

function colorForType(typeName, layerId) {
  if (layerId === "nodes") {
    if (typeName === NODE_TYPE_COAST) return "var(--coast-edge)";
    if (typeName === NODE_TYPE_RIVER || typeName === NODE_TYPE_RIVER_JUNCTION) return "var(--sea-edge)";
    if (typeName === NODE_TYPE_LAND) return "var(--land-edge)";
    if (typeName === NODE_TYPE_CROSSING || typeName === NODE_TYPE_CROSSING_END) return "var(--land-edge)";
    return "#8b5cf6";
  }
  if (typeName === TERRAIN_SEA || typeName === EDGE_TYPE_SEA || typeName === "terrain-sea") return "var(--sea-fill)";
  if (typeName === EDGE_TYPE_CROSSING || typeName === "crossing" || typeName === "terrain-crossing") return "var(--crossing-edge)";
  if (typeName === "RIVER" || typeName === EDGE_TYPE_RIVER || typeName === "banks" || typeName === "mouth" || typeName === "terrain-river" || typeName === "terrain-banks" || typeName === "terrain-mouth") return "var(--sea-edge)";
  if (typeName === TERRAIN_LAND || typeName === "terrain-land") return "var(--land-fill)";
  if (typeName === TERRAIN_COAST || typeName === NODE_TYPE_COAST || typeName === EDGE_TYPE_COAST || typeName === "terrain-coast") return "var(--coast-edge)";
  if (layerId === "edges") return "var(--land-edge)";
  return colorFromString(String(typeName ?? layerId));
}

function nodeRadiusForType(typeName, baseRadius = DEFAULT_NODE_RADIUS) {
  if (!isTerrainNodeType(typeName)) return baseRadius;
  return baseRadius === DEFAULT_NODE_RADIUS ? TERRAIN_NODE_RADIUS : baseRadius / 2;
}

function isTerrainNodeType(typeName) {
  return typeName === NODE_TYPE_COAST
    || typeName === NODE_TYPE_RIVER
    || typeName === NODE_TYPE_RIVER_JUNCTION
    || typeName === NODE_TYPE_LAND
    || typeName === NODE_TYPE_CROSSING
    || typeName === NODE_TYPE_CROSSING_END;
}

function colorFromString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return `hsl(${Math.abs(hash) % 360} 58% 62%)`;
}

function formatTypeLabel(type) {
  const value = String(type ?? "unknown");
  if (value === NODE_TYPE_POI) return NODE_TYPE_POI;

  return value
    .replace(/^terrain-/, "")
    .replace(/-/g, " ")
    .replace(/_/g, " ")
    .toLowerCase();
}

function typeKey(layerId, typeName) {
  return `${layerId}:${typeName}`;
}

function splitTypeKey(key) {
  const separator = key.indexOf(":");
  if (separator < 0) return [null, null];
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function toggleSet(set, value) {
  if (set.has(value)) {
    set.delete(value);
  } else {
    set.add(value);
  }
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
  return String(value).replace(/["\\]/g, "\\$&");
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

function initMapInteractions() {
  if (!svgDomElt) return;

  svgDomElt.addEventListener("wheel", onMapWheel, {passive: false});
  svgDomElt.addEventListener("pointerdown", onMapPointerDown);
  svgDomElt.addEventListener("pointermove", onMapPointerMove);
  svgDomElt.addEventListener("pointerup", onMapPointerUp);
  svgDomElt.addEventListener("pointercancel", onMapPointerUp);
  svgDomElt.addEventListener("dblclick", () => resetCamera(settings.size));
}

function onMapWheel(event) {
  event.preventDefault();
  if (!svgDomElt) return;

  const scale = event.deltaY < 0 ? ZOOM_IN_FACTOR : ZOOM_OUT_FACTOR;
  zoomAtClientPoint(event.clientX, event.clientY, scale);
}

function onMapPointerDown(event) {
  if (event.button !== 0 || !svgDomElt) return;

  const point = clientToMapPoint(event.clientX, event.clientY);
  if (!point) return;

  event.preventDefault();
  panState.active = true;
  panState.pointerId = event.pointerId;
  panState.lastPoint = point;
  svgDomElt.classList.add("is-panning");
  svgDomElt.setPointerCapture?.(event.pointerId);
}

function onMapPointerMove(event) {
  if (!panState.active || panState.pointerId !== event.pointerId || !svgDomElt) return;

  const nextPoint = clientToMapPoint(event.clientX, event.clientY);
  if (!nextPoint || !panState.lastPoint) return;

  const dx = nextPoint.x - panState.lastPoint.x;
  const dy = nextPoint.y - panState.lastPoint.y;

  camera.x -= dx;
  camera.y -= dy;
  panState.lastPoint = nextPoint;
  applyCameraViewBox();
}

function onMapPointerUp(event) {
  if (!panState.active || panState.pointerId !== event.pointerId || !svgDomElt) return;

  panState.active = false;
  panState.pointerId = null;
  panState.lastPoint = null;
  svgDomElt.classList.remove("is-panning");
  svgDomElt.releasePointerCapture?.(event.pointerId);
}

function zoomAtClientPoint(clientX, clientY, scale) {
  const anchor = clientToMapPoint(clientX, clientY);
  if (!anchor) return;

  const minSize = camera.size * MIN_VIEW_RATIO;
  const nextWidth = clamp(camera.width * scale, minSize, camera.size);
  const nextHeight = clamp(camera.height * scale, minSize, camera.size);
  const ratioX = (anchor.x - camera.x) / camera.width;
  const ratioY = (anchor.y - camera.y) / camera.height;

  camera.x = anchor.x - ratioX * nextWidth;
  camera.y = anchor.y - ratioY * nextHeight;
  camera.width = nextWidth;
  camera.height = nextHeight;
  applyCameraViewBox();
}

function clientToMapPoint(clientX, clientY) {
  if (!svgDomElt) return null;

  const rect = svgDomElt.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const relX = (clientX - rect.left) / rect.width;
  const relY = (clientY - rect.top) / rect.height;

  return {
    x: camera.x + relX * camera.width,
    y: camera.y + relY * camera.height,
  };
}

function applyCameraForSize(size) {
  if (!Number.isFinite(size) || size <= 0) return;

  if (camera.size !== size) {
    resetCamera(size);
    return;
  }

  applyCameraViewBox();
}

function resetCamera(size = settings.size) {
  camera.size = size;
  camera.x = 0;
  camera.y = 0;
  camera.width = size;
  camera.height = size;
  applyCameraViewBox();
}

function applyCameraViewBox() {
  if (!svgDomElt) return;

  clampCamera();
  svgDomElt.setAttribute("viewBox", `${camera.x} ${camera.y} ${camera.width} ${camera.height}`);
}

function clampCamera() {
  const minSize = camera.size * MIN_VIEW_RATIO;
  camera.width = clamp(camera.width, minSize, camera.size);
  camera.height = clamp(camera.height, minSize, camera.size);

  const maxX = Math.max(0, camera.size - camera.width);
  const maxY = Math.max(0, camera.size - camera.height);
  camera.x = clamp(camera.x, 0, maxX);
  camera.y = clamp(camera.y, 0, maxY);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
