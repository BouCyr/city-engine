import {Settings, SETTING_GROUPS} from "../data/settings.mjs";

const defaultSettings = new Settings();

export function createDefaultSettings() {
  return new Settings(defaultSettings.seed);
}

export function initSettingsPanel(panel, onChange) {
  renderSettingsPanel(panel, createDefaultSettings(), onChange);

  return {
    readSettings: () => readSettingsFromForm(panel),
  };
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

function renderSettingsPanel(panel, initialSettings, onChange) {
  if (!panel) {
    return;
  }

  panel.innerHTML = "";
  const title = createElement("h2", "settings-title");
  title.textContent = "Settings";
  panel.appendChild(title);

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

      const value = getSettingValue(initialSettings, definition.path);
      const control = createSettingControl(definition, value);

      if (definition.type !== "checkbox-list" && control.id) {
        label.htmlFor = control.id;
      }

      item.append(label, control, createSettingHelp(definition));
      section.appendChild(item);
    });

    form.appendChild(section);
  });

  form.addEventListener("input", (event) => handleSettingsInput(panel, event, onChange));
  form.addEventListener("change", (event) => handleSettingsInput(panel, event, onChange));
  form.addEventListener("click", (event) => handleSettingsReset(panel, event, onChange));
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

  onChange(readSettingsFromForm(panel));
}

function handleSettingsReset(panel, event, onChange) {
  const button = event.target.closest("[data-reset-path]");
  if (!button) {
    return;
  }

  const path = button.dataset.resetPath;
  writeSettingToControls(panel, path, getSettingValue(defaultSettings, path));
  onChange(readSettingsFromForm(panel));
}
