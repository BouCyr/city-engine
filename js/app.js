import {steps} from "./steps.mjs";
import {runPipeline} from "./pipeline.mjs";
import {hydrateReplay, plainSettings, serializeMap} from "./replay-service.mjs";
import {createDefaultSettings, initSettingsPanel} from "./ui/settings-panel.mjs";

export let settings = createDefaultSettings();
export let map;
export let stepResults = [];

let svgDomElt;
let selectedStepIndex = steps.length - 1;
let hoveredStepIndex = null;
let settingsPanel;
let pendingRegeneration = null;
let replayFrameIndex = 0;
let replayTimer = null;
let replayWorker = null;
let replayGenerationToken = 0;
let nextReplayRequestId = 1;
const pendingReplayRequests = new Map();

const REPLAY_INTERVAL_MS = 500;
const ZOOM_IN_FACTOR = 0.9;
const ZOOM_OUT_FACTOR = 1.1;
const MIN_VIEW_RATIO = 0.12;

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
  if (isStepExplanationOpen()) {
    return selectedStepIndex;
  }

  return hoveredStepIndex ?? selectedStepIndex;
}

function resultForStep(index) {
  return stepResults[index + 1];
}

function renderCurrentMap() {
  const index = activeStepIndex();
  const result = resultForStep(index);
  const replayFrame = activeReplayFrame();
  const displayMap = replayFrame?.map ?? result?.map ?? map;

  applyCameraForSize(displayMap?.size ?? settings.size);
  displayMap.clear(svgDomElt);
  displayMap.draw(svgDomElt);
  renderStepDetails(steps[index], result);
  renderStepExplanation();
}

function regenerate(nextSettings = settingsPanel?.readSettings?.() ?? settings) {
  const previousSize = settings.size;
  settings = nextSettings;
  replayGenerationToken += 1;
  pendingReplayRequests.clear();

  const result = runPipeline(settings);
  map = result.map;
  stepResults = result.stepResults;
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
      if (isStepExplanationOpen()) {
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
    if (isStepExplanationOpen()) {
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
    setSettingsOpen(open);
  });
}

function renderStepDetails(step, result) {
  const details = document.getElementById("details");
  if (!details) {
    return;
  }

  details.innerHTML = "";
  details.appendChild(createStepExplanationToggle());

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

function createStepExplanationToggle() {
  const button = document.createElement("button");
  button.type = "button";
  button.id = "step-explanation-toggle";
  button.className = "step-explanation-toggle";
  button.setAttribute("aria-controls", "step-explanation-panel");
  button.setAttribute("aria-expanded", String(isStepExplanationOpen()));
  button.textContent = "Step explanation";
  button.addEventListener("click", () => setStepExplanationOpen(!isStepExplanationOpen()));
  return button;
}

function initStepExplanationPanel() {
  const panel = document.getElementById("step-explanation-panel");
  if (!panel) {
    return;
  }

  panel.inert = true;
}

function setSettingsOpen(open) {
  const container = document.querySelector(".container");
  const button = document.getElementById("settings-toggle");
  const panel = document.getElementById("settings-panel");
  const details = document.getElementById("details");
  const explanation = document.getElementById("step-explanation-panel");
  if (!container || !button || !panel) {
    return;
  }

  const closedExplanation = open && container.classList.contains("step-explanation-open");
  if (open) {
    stopReplayPlayback();
    container.classList.remove("step-explanation-open");
    explanation && (explanation.inert = true);
  }

  container.classList.toggle("settings-open", open);
  panel.inert = !open;
  details && (details.inert = open || container.classList.contains("step-explanation-open"));
  button.setAttribute("aria-expanded", String(open));

  if (closedExplanation) {
    renderCurrentMap();
  }
}

function setStepExplanationOpen(open) {
  const container = document.querySelector(".container");
  const settingsButton = document.getElementById("settings-toggle");
  const settingsPanelElement = document.getElementById("settings-panel");
  const details = document.getElementById("details");
  const explanation = document.getElementById("step-explanation-panel");
  if (!container || !explanation) {
    return;
  }

  stopReplayPlayback();
  replayFrameIndex = 0;
  hoveredStepIndex = null;

  if (open) {
    container.classList.remove("settings-open");
    settingsPanelElement && (settingsPanelElement.inert = true);
    settingsButton?.setAttribute("aria-expanded", "false");
  }

  container.classList.toggle("step-explanation-open", open);
  explanation.inert = !open;
  details && (details.inert = open);
  requestReplayForSelectedStep();
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

  controls.append(playButton, label);
  wrapper.append(controls, range);
  return wrapper;
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
settingsPanel = initSettingsPanel(document.getElementById("settings-panel"), scheduleRegeneration);
initStepsUI();
initSettingsToggle();
initStepExplanationPanel();
initMapInteractions();
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
    createEntityMetricRows(label, metrics.before?.[key], metrics.after?.[key])
      .forEach((row) => tbody.appendChild(row));
  });

  tbody.appendChild(createDurationMetricRow(metrics.durationMs));
  wrapper.appendChild(table);
  return wrapper;
}

function createEntityMetricRows(label, before = emptyEntityMetrics(), after = emptyEntityMetrics()) {
  const row = document.createElement("tr");
  const labelCell = document.createElement("td");
  const beforeCell = document.createElement("td");
  const afterCell = document.createElement("td");
  const typeNames = sortedTypeNames(before, after);

  beforeCell.textContent = formatCount(before.count);
  afterCell.textContent = formatCount(after.count);

  if (typeNames.length > 0) {
    const breakdownRow = document.createElement("tr");
    const breakdownCell = document.createElement("td");
    const toggle = document.createElement("button");
    const labelText = document.createElement("span");
    const breakdownId = `metric-breakdown-${label.toLowerCase()}`;

    breakdownRow.className = "metric-breakdown-row";
    breakdownRow.id = breakdownId;
    breakdownRow.hidden = true;
    breakdownCell.colSpan = 3;

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

    labelText.textContent = label;
    labelCell.className = "metric-label-with-toggle";
    labelCell.append(toggle, labelText);
    row.append(labelCell, beforeCell, afterCell);

    breakdownCell.appendChild(createTypeBreakdownTable(typeNames, before, after));
    breakdownRow.appendChild(breakdownCell);
    return [row, breakdownRow];
  }

  labelCell.textContent = label;
  row.append(labelCell, beforeCell, afterCell);
  return [row];
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
