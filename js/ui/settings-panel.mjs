import {Settings, SETTING_GROUPS} from "../data/settings.mjs";

const defaultSettings = new Settings();
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const RANDOM_SEED_LENGTH = 8;

export function createDefaultSettings() {
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

function cloneSettings(source, seed = source.seed) {
  const clone = new Settings(seed);
  SETTING_GROUPS.forEach((group) => {
    group.settings.forEach((definition) => {
      if (definition.path !== "seed") {
        setSettingValue(clone, definition.path, cloneSettingValue(getSettingValue(source, definition.path)));
      }
    });
  });
  return clone;
}

function cloneSettingValue(value) {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === "object") return {...value};
  return value;
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

function createReadOnlyValue(value) {
  const output = createElement("div", "setting-readonly-value");
  output.textContent = formatSettingValue(value);
  return output;
}

function createSettingHelp(definition, editable = true) {
  const help = createElement("p", "setting-help");
  if (!editable) {
    help.textContent = definition.help;
    return help;
  }

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "setting-reset";
  reset.dataset.resetPath = definition.path;
  reset.textContent = formatSettingValue(getSettingValue(defaultSettings, definition.path));
  help.append(
    document.createTextNode(`${definition.help} (`),
    reset,
  );

  if (definition.path === "seed") {
    const random = document.createElement("button");
    random.type = "button";
    random.className = "setting-random-seed";
    random.dataset.randomSeedPath = definition.path;
    random.textContent = "random";
    help.append(
      document.createTextNode(", "),
      random,
    );
  }

  help.append(document.createTextNode(")"));

  return help;
}

export function renderStepSettingsForm(panel, initialSettings, stepTitle, onChange) {
  const form = document.createElement("form");
  const definitions = settingsForStep(stepTitle);
  panel.__settingsSource = initialSettings;
  form.className = "step-settings-form";

  if (definitions.length === 0) {
    const empty = createElement("p", "step-settings-empty");
    empty.textContent = "This step has no settings.";
    panel.appendChild(empty);
    return;
  }

  definitions.forEach(({definition, editable, sourceStep}) => {
    const item = createElement("div", `setting-item${editable ? "" : " setting-item-readonly"}`);
    const label = document.createElement("label");
    const labelRow = createElement("div", "setting-label-row");
    const value = getSettingValue(initialSettings, definition.path);
    const control = editable ? createSettingControl(definition, value) : createReadOnlyValue(value);

    label.textContent = definition.label;
    if (definition.type !== "checkbox-list" && control.id) {
      label.htmlFor = control.id;
    }

    labelRow.appendChild(label);
    if (!editable) {
      const badge = createElement("span", "setting-source-badge");
      badge.textContent = `Set in ${sourceStep}`;
      labelRow.appendChild(badge);
    }

    item.append(labelRow, control, createSettingHelp(definition, editable));
    form.appendChild(item);
  });

  form.addEventListener("input", (event) => handleSettingsInput(panel, event, onChange));
  form.addEventListener("change", (event) => handleSettingsInput(panel, event, onChange));
  form.addEventListener("click", (event) => handleSettingsReset(panel, event, onChange));
  panel.appendChild(form);
}

export function settingsForStep(stepTitle) {
  return SETTING_GROUPS.flatMap((group) => group.settings)
    .filter((definition) => definition.ownerStep === stepTitle || (definition.usedBySteps ?? []).includes(stepTitle))
    .map((definition) => ({
      definition,
      editable: definition.ownerStep === stepTitle || definition.path === "seed",
      sourceStep: definition.ownerStep,
    }));
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

function controlsForPath(panel, path) {
  return Array.from(panel.querySelectorAll("[data-setting-path]"))
    .filter((control) => control.dataset.settingPath === path);
}

function readSettingFromControls(panel, definition) {
  const controls = controlsForPath(panel, definition.path);
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

  if (definition.type === "number" || definition.type === "range") {
    const numeric = Number(control.value);
    return Number.isFinite(numeric) ? numeric : defaultValue;
  }

  if (Array.isArray(defaultValue)) {
    const values = String(control.value)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (defaultValue.every((item) => typeof item === "number")) {
      const numericValues = values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
      return numericValues.length > 0 ? numericValues : defaultValue;
    }
    return values.length > 0 ? values : defaultValue;
  }

  return control.value;
}

function readSettingsFromForm(panel) {
  const seedDefinition = getDefinition("seed");
  const nextSettings = new Settings(readSettingFromControls(panel, seedDefinition));

  SETTING_GROUPS.forEach((group) => {
    group.settings.forEach((definition) => {
      if (definition.path === "seed") {
        return;
      }

      setSettingValue(nextSettings, definition.path, readSettingFromControls(panel, definition));
    });
  });

  return nextSettings;
}

function writeSettingToControls(panel, path, value) {
  const definition = getDefinition(path);
  const controls = controlsForPath(panel, path);

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

  control.value = value;
  if (definition.type === "range") {
    updateRangeValue(control);
  }
}

function handleSettingsInput(panel, event, onChange) {
  const control = event.target.closest("[data-setting-path]");
  if (!control) {
    return;
  }

  if (control.type === "range") {
    updateRangeValue(control);
  }

  const definition = getDefinition(control.dataset.settingPath);
  if (!definition) return;

  const sourceSettings = panel.__settingsSource ?? defaultSettings;
  const seed = definition.path === "seed"
    ? readSettingFromControls(panel, definition)
    : sourceSettings.seed;
  const nextSettings = cloneSettings(sourceSettings, seed);
  setSettingValue(nextSettings, definition.path, readSettingFromControls(panel, definition));
  onChange(nextSettings);
}

function randomBase32Word(length = RANDOM_SEED_LENGTH) {
  const values = new Uint8Array(length);
  globalThis.crypto?.getRandomValues?.(values);
  if (!globalThis.crypto?.getRandomValues) {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = Math.floor(Math.random() * BASE32_ALPHABET.length);
    }
  }
  return Array.from(values, (value) => BASE32_ALPHABET[value % BASE32_ALPHABET.length]).join("");
}

function handleSettingsReset(panel, event, onChange) {
  const randomButton = event.target.closest("[data-random-seed-path]");
  if (randomButton) {
    const path = randomButton.dataset.randomSeedPath;
    const seed = randomBase32Word();
    writeSettingToControls(panel, path, seed);
    const nextSettings = cloneSettings(panel.__settingsSource ?? defaultSettings, seed);
    onChange(nextSettings);
    return;
  }

  const button = event.target.closest("[data-reset-path]");
  if (!button) {
    return;
  }

  const path = button.dataset.resetPath;
  writeSettingToControls(panel, path, getSettingValue(defaultSettings, path));
  const definition = getDefinition(path);
  if (!definition) return;

  const sourceSettings = panel.__settingsSource ?? defaultSettings;
  const seed = path === "seed" ? getSettingValue(defaultSettings, path) : sourceSettings.seed;
  const nextSettings = cloneSettings(sourceSettings, seed);
  setSettingValue(nextSettings, path, getSettingValue(defaultSettings, path));
  onChange(nextSettings);
}
