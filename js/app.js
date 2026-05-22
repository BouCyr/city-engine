import {steps} from "./steps.mjs";
import {Settings} from "./data/settings.mjs";
import {runPipeline} from "./pipeline.mjs";

const defaultSettings = new Settings();

export let settings = cloneSettingsDefaults();
export let map;
export let stepResults = [];

const SETTING_GROUPS = [
  {
    title: "Global",
    settings: [
      {
        path: "seed",
        label: "Seed",
        type: "text",
        pattern: "[A-Za-z0-9_-]*",
        help: "Controls the deterministic random streams used by every generation step.",
      },
      {
        path: "size",
        label: "Map size",
        type: "number",
        min: 1,
        step: 25,
        help: "Sets the width and height of the square map in SVG units.",
      },
    ],
  },
  {
    title: "Scatter",
    settings: [
      {
        path: "scatter.nb",
        label: "Point count",
        type: "number",
        min: 1,
        step: 50,
        help: "Sets how many initial city anchor points are sampled.",
      },
      {
        path: "scatter.safeZone",
        label: "Safe zone",
        type: "number",
        min: 0,
        step: 10,
        help: "Keeps scattered points at least this far from the map edge.",
      },
    ],
  },
  {
    title: "Prune",
    settings: [
      {
        path: "prune.threshold",
        label: "Short edge threshold",
        type: "number",
        min: 0,
        step: 5,
        help: "Removes and merges graph edges shorter than this length.",
      },
    ],
  },
  {
    title: "Coast",
    settings: [
      {
        path: "coast.seaBorders",
        label: "Sea borders",
        type: "checkbox-list",
        options: ["NORTH", "SOUTH", "EAST", "WEST"],
        help: "Chooses which map borders are treated as open sea.",
      },
      {
        path: "coast.threshold",
        label: "Land threshold",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        help: "Controls how far land pushes away from selected sea borders.",
      },
      {
        path: "coast.largeScale",
        label: "Large noise scale",
        type: "number",
        min: 1,
        step: 1,
        help: "Sets the broad coastline noise wavelength.",
      },
      {
        path: "coast.mediumScale",
        label: "Medium noise scale",
        type: "number",
        min: 1,
        step: 1,
        help: "Sets the mid-sized coastline noise wavelength.",
      },
      {
        path: "coast.smallScale",
        label: "Small noise scale",
        type: "number",
        min: 1,
        step: 1,
        help: "Sets the fine coastline noise wavelength.",
      },
      {
        path: "coast.largeAmplitude",
        label: "Large noise amplitude",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        help: "Controls how strongly broad noise bends the coastline.",
      },
      {
        path: "coast.mediumAmplitude",
        label: "Medium noise amplitude",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        help: "Controls how strongly medium noise bends the coastline.",
      },
      {
        path: "coast.smallAmplitude",
        label: "Small noise amplitude",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        help: "Controls how strongly fine noise roughens the coastline.",
      },
      {
        path: "coast.sampleCount",
        label: "Extra samples",
        type: "number",
        min: 0,
        step: 1,
        help: "Adds deterministic sample points inside each cell before terrain classification.",
      },
      {
        path: "coast.smoothingPasses",
        label: "Smoothing passes",
        type: "number",
        min: 0,
        step: 1,
        help: "Repeats terrain smoothing across neighboring cell edges.",
      },
      {
        path: "coast.smoothingBias",
        label: "Smoothing bias",
        type: "range",
        min: 0,
        max: 1,
        step: 0.01,
        help: "Sets how dominant neighboring terrain must be to flip a cell.",
      },
      {
        path: "coast.artifactsMax",
        label: "Artifact limit",
        type: "number",
        min: 1,
        step: 1,
        help: "Flips isolated terrain components up to this cell count.",
      },
    ],
  },
];

let svgDomElt;
let currentStepIndex = null;
let pendingRegeneration = null;

function cloneSettingsDefaults() {
  return new Settings(defaultSettings.seed);
}

function getSettingValue(source, path) {
  return path.split(".").reduce((value, key) => value?.[key], source);
}

function setSettingValue(target, path, value) {
  const keys = path.split(".");
  const lastKey = keys.pop();
  const parent = keys.reduce((container, key) => container[key], target);
  parent[lastKey] = value;
}

function formatSettingValue(value) {
  if (Array.isArray(value)) {
    return value.join(", ");
  }

  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }

  return String(value);
}

function settingInputId(path) {
  return `setting-${path.replaceAll(".", "-")}`;
}

function createElement(tagName, className) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  return element;
}

function updateRangeValue(input) {
  const output = input.closest(".setting-item")?.querySelector(".setting-range-value");
  if (output) {
    output.textContent = input.value;
  }
}

function createSettingControl(definition, value) {
  if (definition.type === "checkbox-list") {
    const list = createElement("div", "setting-checkbox-list");
    const selected = new Set(Array.isArray(value) ? value : []);

    definition.options.forEach((option) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = option;
      input.dataset.settingPath = definition.path;
      input.checked = selected.has(option);
      label.append(input, document.createTextNode(option));
      list.appendChild(label);
    });

    return list;
  }

  if (definition.type === "json") {
    const textarea = document.createElement("textarea");
    textarea.id = settingInputId(definition.path);
    textarea.dataset.settingPath = definition.path;
    textarea.rows = 3;
    textarea.spellcheck = false;
    textarea.value = JSON.stringify(value, null, 2);
    return textarea;
  }

  const input = document.createElement("input");
  input.id = settingInputId(definition.path);
  input.dataset.settingPath = definition.path;
  input.type = definition.type;

  ["min", "max", "step", "pattern"].forEach((attribute) => {
    if (definition[attribute] !== undefined) {
      input.setAttribute(attribute, definition[attribute]);
    }
  });

  input.value = value;

  if (definition.type === "range") {
    const row = createElement("div", "setting-control-row");
    const output = createElement("span", "setting-range-value");
    output.textContent = input.value;
    row.append(input, output);
    return row;
  }

  return input;
}

function createSettingHelp(definition) {
  const help = createElement("p", "setting-help");
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "setting-reset";
  reset.dataset.resetPath = definition.path;
  reset.textContent = formatSettingValue(getSettingValue(defaultSettings, definition.path));

  help.append(
    document.createTextNode(`${definition.help} (`),
    reset,
    document.createTextNode(")"),
  );

  return help;
}

function renderSettingsPanel() {
  const panel = document.getElementById("settings-panel");
  if (!panel) {
    return;
  }

  settings = cloneSettingsDefaults();
  panel.innerHTML = "";

  const form = document.createElement("form");
  form.id = "settings-form";

  SETTING_GROUPS.forEach((group) => {
    const section = createElement("section", "setting-group");
    const heading = document.createElement("h3");
    heading.textContent = group.title;
    section.appendChild(heading);

    group.settings.forEach((definition) => {
      const item = createElement("div", "setting-item");
      const label = document.createElement("label");
      label.textContent = definition.label;

      const value = getSettingValue(settings, definition.path);
      const control = createSettingControl(definition, value);

      if (definition.type !== "checkbox-list" && control.id) {
        label.htmlFor = control.id;
      }

      item.append(label, control, createSettingHelp(definition));
      section.appendChild(item);
    });

    form.appendChild(section);
  });

  form.addEventListener("input", handleSettingsInput);
  form.addEventListener("change", handleSettingsInput);
  form.addEventListener("click", handleSettingsReset);
  panel.appendChild(form);
}

function getDefinition(path) {
  for (const group of SETTING_GROUPS) {
    const definition = group.settings.find((item) => item.path === path);
    if (definition) {
      return definition;
    }
  }

  return null;
}

function controlsForPath(path) {
  return Array.from(document.querySelectorAll("[data-setting-path]"))
    .filter((control) => control.dataset.settingPath === path);
}

function readSettingFromControls(definition) {
  const controls = controlsForPath(definition.path);
  const defaultValue = getSettingValue(defaultSettings, definition.path);

  if (definition.type === "checkbox-list") {
    return controls
      .filter((control) => control.checked)
      .map((control) => control.value);
  }

  const control = controls[0];
  if (!control) {
    return defaultValue;
  }

  if (definition.type === "json") {
    try {
      control.classList.remove("setting-invalid");
      return JSON.parse(control.value || "[]");
    } catch (error) {
      control.classList.add("setting-invalid");
      throw error;
    }
  }

  if (definition.type === "number" || definition.type === "range") {
    const numeric = Number(control.value);
    return Number.isFinite(numeric) ? numeric : defaultValue;
  }

  return control.value;
}

function readSettingsFromForm() {
  const seedDefinition = getDefinition("seed");
  const nextSettings = new Settings(readSettingFromControls(seedDefinition));

  SETTING_GROUPS.forEach((group) => {
    group.settings.forEach((definition) => {
      if (definition.path === "seed") {
        return;
      }

      setSettingValue(nextSettings, definition.path, readSettingFromControls(definition));
    });
  });

  return nextSettings;
}

function writeSettingToControls(path, value) {
  const definition = getDefinition(path);
  const controls = controlsForPath(path);

  if (!definition) {
    return;
  }

  if (definition.type === "checkbox-list") {
    const selected = new Set(Array.isArray(value) ? value : []);
    controls.forEach((control) => {
      control.checked = selected.has(control.value);
    });
    return;
  }

  const control = controls[0];
  if (!control) {
    return;
  }

  if (definition.type === "json") {
    control.value = JSON.stringify(value, null, 2);
    control.classList.remove("setting-invalid");
    return;
  }

  control.value = value;
  if (definition.type === "range") {
    updateRangeValue(control);
  }
}

function handleSettingsInput(event) {
  const control = event.target.closest("[data-setting-path]");
  if (!control) {
    return;
  }

  if (control.type === "range") {
    updateRangeValue(control);
  }

  scheduleRegeneration();
}

function handleSettingsReset(event) {
  const button = event.target.closest("[data-reset-path]");
  if (!button) {
    return;
  }

  const path = button.dataset.resetPath;
  writeSettingToControls(path, getSettingValue(defaultSettings, path));
  scheduleRegeneration();
}

function scheduleRegeneration() {
  clearTimeout(pendingRegeneration);
  pendingRegeneration = setTimeout(regenerate, 80);
}

function regenerate() {
  try {
    settings = readSettingsFromForm();
  } catch (error) {
    return;
  }

  const result = runPipeline(settings);
  map = result.map;
  stepResults = result.stepResults;

  renderCurrentMap();
}

function renderCurrentMap() {
  svgDomElt.setAttribute("viewBox", `0 0 ${settings.size} ${settings.size}`);

  if (currentStepIndex === null) {
    map.clear(svgDomElt);
    map.draw(svgDomElt);
    return;
  }

  const step = steps[currentStepIndex];
  const result = stepResults[currentStepIndex + 1];
  if (result?.map) {
    result.map.clear(svgDomElt);
    result.map.draw(svgDomElt);
  }
  renderStepDetails(step, result);
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
    listItem.textContent = step.title;
    listItem.addEventListener("mouseenter", () => {
      currentStepIndex = index;
      renderCurrentMap();
    });
    list.appendChild(listItem);
  });

  list.addEventListener("mouseleave", () => {
    currentStepIndex = null;
    map.clear(svgDomElt);
    map.draw(svgDomElt);
    clearDetails(details);
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
renderSettingsPanel();
initStepsUI();
initSettingsToggle();
regenerate();
clearDetails(document.getElementById("details"));
