/* Light control for the MTG table: three positioned bulbs plus the center-table
   LED strip. Two tabs — the Lights tab drives the room by hand, the Players tab
   sets what each player's turn does to each light. Structure follows LightRPG. */

const $ = (selector) => document.querySelector(selector);
const statusBox = $("#status");
let requestSequence = 0;
/* Bumped either side of every change we send. A four-second poll that was
   already in flight when you moved a slider comes back describing the table as
   it was before, and painting that over your change reads as "it did not save"
   until the next poll puts it right. Any status that spans a change is dropped
   instead. */
let mutationStamp = 0;

function setStatus(message, kind = "") {
  statusBox.textContent = message;
  statusBox.className = kind;
}

async function post(path, body = {}, workingMessage = "Sending command to device…") {
  const requestId = ++requestSequence;
  mutationStamp += 1;
  setStatus(workingMessage, "busy");
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error(response.status === 404
        ? "This setting is not available on the running server. Restart the MTG Table server and try again."
        : `The server returned an unexpected ${response.status} response.`);
    }
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "Request failed");
    if (requestId === requestSequence) setStatus(result.message, "success");
    return result;
  } catch (error) {
    if (requestId === requestSequence) setStatus(error.message, "error");
    return null;
  } finally {
    mutationStamp += 1;
    refreshStatus();
  }
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

const DEVICE_NAMES = {
  top_left: "Top left bulb",
  center: "Center bulb",
  bottom_right: "Bottom right bulb",
  strip: "Center table LED",
};
const BULB_IDS = ["top_left", "center", "bottom_right"];
const LINK_STORAGE_KEY = "mtg-table-linked-bulbs";
const SYNC_STORAGE_KEY = "mtg-table-sync-strip";
const TAB_STORAGE_KEY = "mtg-table-lights-tab";
let selectedDevice = "center";
let linkedBulbs = new Set();
let discoveredCandidates = [];
let discoveryIndex = 0;

try {
  const savedLinks = JSON.parse(localStorage.getItem(LINK_STORAGE_KEY) || "[]");
  if (Array.isArray(savedLinks)) linkedBulbs = new Set(savedLinks.filter((id) => BULB_IDS.includes(id)));
} catch (_) { /* Ignore invalid old browser data. */ }

/* --- Tabs: manual room control, or the per-player light plans --- */
function selectTab(name) {
  const tabs = document.querySelectorAll("[data-tab]");
  const known = [...tabs].some((tab) => tab.dataset.tab === name);
  if (!known) name = "room";

  tabs.forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.tabPanel !== name);
  });
  localStorage.setItem(TAB_STORAGE_KEY, name);
  // The canvases cannot measure themselves while their panel is display:none,
  // so redraw once they are visible again.
  if (name === "room") { updateColorPreview(); updateWhitePreview(); }
}

function syncStripEnabled() {
  return $("#sync-strip").checked;
}

function selectedBulbTargets() {
  if (selectedDevice === "strip") return [];
  if (linkedBulbs.has(selectedDevice)) return BULB_IDS.filter((id) => linkedBulbs.has(id));
  return [selectedDevice];
}

/* The bulbs being driven, ignoring any strip sync. */
function bulbLabel() {
  const targets = selectedBulbTargets();
  if (targets.length === 1) return DEVICE_NAMES[targets[0]];
  return targets.map((id) => DEVICE_NAMES[id].replace(" bulb", "")).join(" + ") + " bulbs";
}

function controlLabel() {
  if (selectedDevice === "strip") return DEVICE_NAMES.strip;
  return syncStripEnabled() ? `${bulbLabel()} + LED strip` : bulbLabel();
}

function updateLinkDisplay() {
  document.querySelectorAll("[data-link-device]").forEach((button) => {
    const linked = linkedBulbs.has(button.dataset.linkDevice);
    button.classList.toggle("linked", linked);
    button.setAttribute("aria-pressed", linked ? "true" : "false");
    button.title = linked ? "Remove this bulb from the linked group" : "Add this bulb to the linked group";
  });
  const label = controlLabel();
  $("#selected-device-name").textContent = label;
  document.querySelectorAll(".panel-target").forEach((item) => item.textContent = label);
  // White temperature never reaches the strip, so that card names bulbs only.
  document.querySelectorAll(".panel-target-bulbs").forEach((item) => item.textContent = bulbLabel());
}

function toggleLinkedBulb(bulbId) {
  if (linkedBulbs.has(bulbId)) linkedBulbs.delete(bulbId);
  else linkedBulbs.add(bulbId);
  localStorage.setItem(LINK_STORAGE_KEY, JSON.stringify([...linkedBulbs]));
  updateLinkDisplay();
}

function selectDevice(device) {
  if (!(device in DEVICE_NAMES)) return;
  selectedDevice = device;
  document.querySelectorAll("[data-device]").forEach((item) => {
    const selected = item.dataset.device === device;
    item.classList.toggle("selected", selected);
    item.setAttribute("aria-pressed", selected ? "true" : "false");
  });
  updateLinkDisplay();
  // White temperature is a bulb-only capability; the strip has no white channel.
  document.querySelectorAll(".bulb-only").forEach((item) => item.classList.toggle("hidden", device === "strip"));
  document.querySelectorAll(".strip-only").forEach((item) => item.classList.toggle("hidden", device !== "strip"));
  // Syncing the strip is meaningless when the strip is already the selection.
  $("#sync-strip").closest(".sync-check").classList.toggle("hidden", device === "strip");
  updateColorPreview();
  updateWhitePreview();
}

function currentCandidate() {
  return discoveredCandidates[discoveryIndex] || null;
}

async function showCurrentCandidate(blink = true) {
  const candidate = currentCandidate();
  if (!candidate) {
    $("#discovery-panel").classList.add("hidden");
    setStatus(`Assignment complete: reviewed ${discoveredCandidates.length} bulb${discoveredCandidates.length === 1 ? "" : "s"}.`, "success");
    refreshStatus();
    return;
  }
  $("#discovery-panel").classList.remove("hidden");
  $("#discovery-progress").textContent = `BULB ${discoveryIndex + 1} OF ${discoveredCandidates.length}`;
  $("#discovery-name").textContent = candidate.name || "Tapo bulb";
  $("#discovery-description").textContent = `${candidate.model || "Color bulb"} at ${candidate.ip}. Watch for the bulb that blinks, then choose its room position.`;
  if (blink) {
    await post("/api/bulbs/identify", { ip: candidate.ip }, `Blinking bulb ${discoveryIndex + 1} of ${discoveredCandidates.length} at ${candidate.ip}…`);
  }
}

async function startBulbDiscovery() {
  $("#discovery-panel").classList.add("hidden");
  const result = await post("/api/bulbs/discover", {}, "Searching for Tapo bulbs on the local network…");
  if (!result) return;
  discoveredCandidates = result.bulbs || [];
  discoveryIndex = 0;
  await showCurrentCandidate(true);
}

async function advanceCandidate() {
  discoveryIndex += 1;
  await showCurrentCandidate(true);
}

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: [r, g, b] = [v, t, p]; break;
    case 1: [r, g, b] = [q, v, p]; break;
    case 2: [r, g, b] = [p, v, t]; break;
    case 3: [r, g, b] = [p, q, v]; break;
    case 4: [r, g, b] = [t, p, v]; break;
    default: [r, g, b] = [v, p, q]; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function rgbHex(r, g, b) {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function drawMarker(ctx, x, y) {
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, 2 * Math.PI);
  ctx.strokeStyle = "#141018";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, 2 * Math.PI);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function sizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height };
}

function attachDrag(canvas, onPick) {
  let dragging = false;
  const handle = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = clamp((event.clientX - rect.left) * (canvas.width / rect.width), 0, canvas.width - 1);
    const y = clamp((event.clientY - rect.top) * (canvas.height / rect.height), 0, canvas.height - 1);
    onPick(x, y);
  };
  canvas.addEventListener("pointerdown", (event) => {
    dragging = true;
    canvas.setPointerCapture(event.pointerId);
    handle(event);
  });
  canvas.addEventListener("pointermove", (event) => { if (dragging) handle(event); });
  const stop = () => { dragging = false; };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
}

// --- Color wheel (hue = angle, saturation = radius) ---
const wheelCanvas = $("#color-wheel");
const wheelCtx = wheelCanvas.getContext("2d");
let wheelBitmap = null;
let colorState = { hue: 26, saturation: 80 };

function buildWheelBitmap(size) {
  const off = document.createElement("canvas");
  off.width = size;
  off.height = size;
  const ctx = off.getContext("2d");
  const image = ctx.createImageData(size, size);
  const center = (size - 1) / 2;
  const data = image.data;
  for (let y = 0; y < size; y++) {
    const dy = center - y;
    for (let x = 0; x < size; x++) {
      const dx = x - center;
      const dist = Math.hypot(dx, dy);
      const idx = (y * size + x) * 4;
      if (dist <= center) {
        const hueDeg = (((Math.atan2(dy, dx) * 180) / Math.PI) % 360 + 360) % 360;
        const saturation = center > 0 ? Math.min(1, dist / center) : 0;
        const [r, g, b] = hsvToRgb(hueDeg / 360, saturation, 1);
        data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
      }
    }
  }
  ctx.putImageData(image, 0, 0);
  return off;
}

function redrawWheel() {
  const { width } = sizeCanvas(wheelCanvas);
  if (!wheelBitmap || wheelBitmap.width !== width) wheelBitmap = buildWheelBitmap(width);
  wheelCtx.clearRect(0, 0, wheelCanvas.width, wheelCanvas.height);
  wheelCtx.drawImage(wheelBitmap, 0, 0);
  const center = (wheelCanvas.width - 1) / 2;
  const radius = center * (colorState.saturation / 100);
  const rad = (colorState.hue * Math.PI) / 180;
  drawMarker(wheelCtx, center + Math.cos(rad) * radius, center - Math.sin(rad) * radius);
}

function updateColorPreview() {
  const v = +$("#color-brightness").value / 100;
  const [r, g, b] = hsvToRgb(colorState.hue / 360, colorState.saturation / 100, v);
  $("#color-swatch").style.background = rgbHex(r, g, b);
  $("#color-hsv-label").textContent = `H:${colorState.hue} S:${colorState.saturation}`;
  redrawWheel();
}

attachDrag(wheelCanvas, (x, y) => {
  const center = (wheelCanvas.width - 1) / 2;
  const dx = x - center, dy = center - y;
  const dist = Math.min(center, Math.hypot(dx, dy));
  colorState.saturation = Math.round((dist / center) * 100);
  if (dist > 0.01) colorState.hue = Math.round((((Math.atan2(dy, dx) * 180) / Math.PI) % 360 + 360) % 360) % 360;
  updateColorPreview();
});
$("#color-brightness").addEventListener("input", updateColorPreview);

// --- White pad (x = warmth, y = brightness) ---
const WHITE_TEMP_MIN = 2500, WHITE_TEMP_MAX = 6500, WHITE_BRIGHTNESS_MIN = 1, WHITE_BRIGHTNESS_MAX = 100;
const whiteCanvas = $("#white-pad");
const whiteCtx = whiteCanvas.getContext("2d");
let whiteBitmap = null;
let whiteState = { temperature: 2700, brightness: 100 };

function kelvinToRgb(tempKelvin) {
  const temp = clamp(tempKelvin, WHITE_TEMP_MIN, WHITE_TEMP_MAX) / 100;
  let red, green, blue;
  if (temp <= 66) {
    red = 255;
    green = 99.4708025861 * Math.log(temp) - 161.1195681661;
    blue = temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
  } else {
    red = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
    green = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
    blue = 255;
  }
  return [clamp(Math.round(red), 0, 255), clamp(Math.round(green), 0, 255), clamp(Math.round(blue), 0, 255)];
}

function whiteRgb(tempKelvin, brightness) {
  const [r, g, b] = kelvinToRgb(tempKelvin);
  const scale = clamp(brightness, WHITE_BRIGHTNESS_MIN, WHITE_BRIGHTNESS_MAX) / 100;
  return [Math.round(r * scale), Math.round(g * scale), Math.round(b * scale)];
}

function buildWhiteBitmap(width, height) {
  const off = document.createElement("canvas");
  off.width = width;
  off.height = height;
  const ctx = off.getContext("2d");
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const xStep = width > 1 ? 1 / (width - 1) : 0;
  const yStep = height > 1 ? 1 / (height - 1) : 0;
  for (let y = 0; y < height; y++) {
    const brightness = WHITE_BRIGHTNESS_MAX - (y * yStep) * (WHITE_BRIGHTNESS_MAX - WHITE_BRIGHTNESS_MIN);
    for (let x = 0; x < width; x++) {
      const temp = WHITE_TEMP_MIN + (x * xStep) * (WHITE_TEMP_MAX - WHITE_TEMP_MIN);
      const [r, g, b] = whiteRgb(temp, brightness);
      const idx = (y * width + x) * 4;
      data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return off;
}

function redrawWhitePad() {
  const { width, height } = sizeCanvas(whiteCanvas);
  if (!whiteBitmap || whiteBitmap.width !== width || whiteBitmap.height !== height) {
    whiteBitmap = buildWhiteBitmap(width, height);
  }
  whiteCtx.clearRect(0, 0, whiteCanvas.width, whiteCanvas.height);
  whiteCtx.drawImage(whiteBitmap, 0, 0);
  const x = ((whiteState.temperature - WHITE_TEMP_MIN) / (WHITE_TEMP_MAX - WHITE_TEMP_MIN)) * (width - 1);
  const y = ((WHITE_BRIGHTNESS_MAX - whiteState.brightness) / (WHITE_BRIGHTNESS_MAX - WHITE_BRIGHTNESS_MIN)) * (height - 1);
  drawMarker(whiteCtx, x, y);
}

function updateWhitePreview() {
  const [r, g, b] = whiteRgb(whiteState.temperature, whiteState.brightness);
  $("#white-swatch").style.background = rgbHex(r, g, b);
  $("#white-label").textContent = `${whiteState.temperature}K · ${whiteState.brightness}%`;
  redrawWhitePad();
}

attachDrag(whiteCanvas, (x, y) => {
  whiteState.temperature = Math.round(WHITE_TEMP_MIN + (x / (whiteCanvas.width - 1)) * (WHITE_TEMP_MAX - WHITE_TEMP_MIN));
  whiteState.brightness = Math.round(
    WHITE_BRIGHTNESS_MAX - (y / (whiteCanvas.height - 1)) * (WHITE_BRIGHTNESS_MAX - WHITE_BRIGHTNESS_MIN)
  );
  updateWhitePreview();
});

// --- Per-player colors used by the life tracker's turn order ---
let players = [];
let currentPlayer = 0;
let lightCatalog = [];
let effectCatalog = [{ id: "none", label: "Solid" }];
let effectSecondsMin = 0.4;
let effectSecondsMax = 20;
let whiteTempMin = WHITE_TEMP_MIN;
let whiteTempMax = WHITE_TEMP_MAX;
let profileCatalog = [];
let announcerCatalog = [];
let commanderSoundCatalog = [];
let renderedPlayerKey = "";
let renderedProfileKey = "";

function playerHex(player) {
  const [r, g, b] = hsvToRgb(player.hue / 360, player.saturation / 100, player.brightness / 100);
  return rgbHex(r, g, b);
}

function renderPlayers() {
  // Rebuilding on every poll would fight the user's taps, so only redraw on
  // an actual change.
  const key = JSON.stringify([players, currentPlayer, lightCatalog]);
  if (key === renderedPlayerKey) return;
  renderedPlayerKey = key;

  const list = $("#player-list");
  list.innerHTML = "";
  players.forEach((player, index) => {
    const targets = player.targets || [];
    const chips = lightCatalog.map((light) => {
      const on = targets.indexOf(light.id) !== -1;
      const offline = on && !light.ready;
      return `<button type="button" data-player-target="${index}:${light.id}"
        class="${on ? "is-on" : ""}${offline ? " is-offline" : ""}"
        title="${offline ? light.label + " is not connected yet" : light.label}"
        aria-pressed="${on}">${escapeHtml(light.label)}</button>`;
    }).join("");

    const row = document.createElement("li");
    row.className = "player-row" + (index === currentPlayer ? " is-current" : "");
    row.innerHTML = `
      <span class="player-swatch" style="background:${playerHex(player)}"></span>
      <span class="player-name"><b>${escapeHtml(player.name)}</b><small>H:${player.hue} S:${player.saturation} B:${player.brightness}%${index === currentPlayer ? ' <span class="turn-tag">· their turn</span>' : ""}</small></span>
      <button class="assign" data-assign-player="${index}" title="Give this player, and every light they drive, the color picked on the Lights tab">Use picked</button>
      <button class="secondary" data-preview-player="${index}">Show</button>
      <div class="player-display-controls">
        <label>Background
          <input type="range" min="20" max="150" value="${player.background_brightness ?? 100}"
                 data-display-brightness="${index}:background_brightness"
                 aria-label="${escapeHtml(player.name)} background brightness">
          <output data-display-brightness-value="${index}:background_brightness">${player.background_brightness ?? 100}%</output>
        </label>
        <label>Commander
          <input type="range" min="20" max="150" value="${player.commander_brightness ?? 70}"
                 data-display-brightness="${index}:commander_brightness"
                 aria-label="${escapeHtml(player.name)} commander brightness">
          <output data-display-brightness-value="${index}:commander_brightness">${player.commander_brightness ?? 70}%</output>
        </label>
      </div>
      <div class="player-targets">${chips}</div>`;
    list.appendChild(row);
  });
}

function renderTurnSettings(state) {
  const fade = $("#fade-enabled");
  if (document.activeElement !== fade) fade.checked = !!state.fade_enabled;

  const fadeSlider = $("#fade-seconds");
  if (document.activeElement !== fadeSlider) {
    fadeSlider.value = Math.round(state.fade_seconds * 10);
    $("#fade-seconds-value").value = state.fade_seconds.toFixed(1) + "s";
  }
  $("#fade-slider-row").classList.toggle("is-off", !state.fade_enabled);
}

/* --- Light plans: a color and an effect per light, per player --- */

/* The plan editor is built once and then only has its values written, because
   rebuilding it would tear a slider out from under a dragging finger. */
let planBuiltKey = "";
/* A drag does not reliably focus a range input on every mobile browser, so the
   poll is held off by the pointer rather than by focus alone. */
let planInteracting = false;

function planKey(index, lightId) {
  return `${index}:${lightId}`;
}

function effectOptions(selected) {
  return effectCatalog.map((effect) => (
    `<option value="${effect.id}"${effect.id === selected ? " selected" : ""}>${escapeHtml(effect.label)}</option>`
  )).join("");
}

function announcerOptions(selected) {
  const none = `<option value=""${selected ? "" : " selected"}>No announcer</option>`;
  return none + announcerCatalog.map((sound) => (
    `<option value="${escapeHtml(sound.file)}"${sound.file === selected ? " selected" : ""}>${escapeHtml(sound.label)}</option>`
  )).join("");
}

function commanderSoundOptions(selected) {
  const none = `<option value=""${selected ? "" : " selected"}>No commander sound</option>`;
  return none + commanderSoundCatalog.filter((sound) => sound.file.toLowerCase() !== "fire.mp3").map((sound) => (
    `<option value="${escapeHtml(sound.file)}"${sound.file === selected ? " selected" : ""}>${escapeHtml(sound.label)}</option>`
  )).join("");
}

function buildPlanEditor() {
  // One structure per player and light; a rename or a recolor does not change it.
  const key = JSON.stringify([players.length, lightCatalog.map((l) => l.id), effectCatalog.map((e) => e.id),
                              announcerCatalog.map((sound) => sound.file),
                              commanderSoundCatalog.map((sound) => sound.file),
                              whiteTempMin, whiteTempMax]);
  if (key === planBuiltKey) return;
  planBuiltKey = key;

  $("#plan-grid").innerHTML = players.map((player, index) => `
    <article class="plan" data-plan-player="${index}">
      <header class="plan-head">
        <span class="plan-swatch" data-plan-player-swatch="${index}"></span>
        <span class="plan-title"><b data-plan-name="${index}">${escapeHtml(player.name)}</b>
          <small data-plan-summary="${index}"></small></span>
        <button class="secondary" type="button" data-preview-player="${index}">Show</button>
      </header>
      <div class="plan-profile">
        <button class="secondary" type="button" data-profile-save="${index}"
                title="Write this player's whole plan out to the profiles folder">Save as…</button>
        <select data-profile-pick="${index}" aria-label="Saved profiles"></select>
        <button class="secondary" type="button" data-profile-load="${index}"
                title="Put the chosen profile on this player">Load</button>
      </div>
      <label class="plan-announcer">
        <span>Entrance sound</span>
        <select data-announcer-sound="${index}" aria-label="${escapeHtml(player.name)} entrance sound">
          ${announcerOptions(player.announcer_sound || "")}
        </select>
      </label>
      <label class="plan-announcer">
        <span>Commander sound</span>
        <select data-commander-sound="${index}" aria-label="${escapeHtml(player.name)} commander sound">
          ${commanderSoundOptions(player.commander_sound || "")}
        </select>
      </label>
      <label class="plan-announcer"><span>Two commanders</span><input type="checkbox" data-two-commanders="${index}" ${player.two_commanders ? "checked" : ""}></label>
      <label class="plan-announcer" data-commander-name-row="${index}">
        <span data-commander-name-label="${index}">${player.two_commanders ? "Commander 1 name" : "Commander name"}</span>
        <input type="text" maxlength="40" data-commander-name="${index}"
          value="${escapeHtml(player.commander_name || "")}" placeholder="Commander name">
      </label>
      <label class="plan-announcer" data-second-row="${index}" ${player.two_commanders ? "" : "hidden"}>
        <span>Commander 2 sound</span><select data-second-sound="${index}">${commanderSoundOptions(player.second_commander_sound || "")}</select>
      </label>
      <label class="plan-announcer" data-second-name-row="${index}" ${player.two_commanders ? "" : "hidden"}>
        <span>Commander 2 name</span><input type="text" maxlength="40" data-second-commander-name="${index}"
          value="${escapeHtml(player.second_commander_name || "")}" placeholder="Commander 2">
      </label>
      ${lightCatalog.map((light) => planLightMarkup(index, light)).join("")}
    </article>`).join("");
  // These menus were just thrown away with the rest of the card.
  renderedProfileKey = "";
  renderProfileMenus();
}

/* --- Profiles: one file per person, so a table adapts to who turns up --- */

/* Rebuilt only when the set of files changes, so an open menu is not yanked
   shut by the poll. Each menu keeps whatever the user had chosen. */
function renderProfileMenus() {
  const menus = document.querySelectorAll("[data-profile-pick]");
  if (!menus.length) return;
  const key = JSON.stringify(profileCatalog.map((profile) => profile.name));
  if (key === renderedProfileKey) return;
  renderedProfileKey = key;

  menus.forEach((menu) => {
    if (document.activeElement === menu) return;
    const chosen = menu.value;
    menu.innerHTML = profileCatalog.length
      ? profileCatalog.map((profile) => `<option value="${escapeHtml(profile.name)}">${escapeHtml(profile.name)}</option>`).join("")
      : `<option value="">No profiles saved yet</option>`;
    if (chosen && profileCatalog.some((profile) => profile.name === chosen)) menu.value = chosen;
  });
}

async function saveProfile(index) {
  const player = players[index] || {};
  const name = window.prompt("Save this player's lights as:", player.name || `Player ${index + 1}`);
  if (name === null) return;
  await post(`/api/players/${index}/profile`, { profile: name }, `Saving ${name}…`);
  // A new file means a new menu, whoever it belongs to.
  renderedProfileKey = "";
}

async function loadProfile(index) {
  const menu = document.querySelector(`[data-profile-pick="${index}"]`);
  const name = menu && menu.value;
  if (!name) {
    setStatus("Save a profile first, then it will be in this list.", "error");
    return;
  }
  await post(`/api/players/${index}/profile/load`, { profile: name }, `Loading ${name}…`);
  // The plan editor is written from `players`, which the reply just replaced.
  renderedPlayerKey = "";
}

function planLightMarkup(index, light) {
  const key = planKey(index, light.id);
  return `
    <div class="plan-light" data-plan-light="${key}">
      <div class="plan-light-head">
        <button class="plan-enable" type="button" data-plan-enabled="${key}" aria-pressed="false">
          ${escapeHtml(light.label)}</button>
        <input class="plan-color" type="color" data-plan-color="${key}" value="#000000"
               aria-label="${escapeHtml(light.label)} color">
        <button class="secondary plan-pick" type="button" data-plan-pick="${key}"
                title="Use the color picked on the Lights tab">Picked</button>
      </div>
      <div class="plan-row">
        <label for="plan-bri-${key}">Brightness</label>
        <input id="plan-bri-${key}" type="range" min="1" max="100" value="90" data-plan-brightness="${key}">
        <output data-plan-brightness-value="${key}">90%</output>
      </div>
      <div class="plan-row plan-white-row is-off">
        <button class="plan-white" type="button" data-plan-white="${key}" aria-pressed="false"
                title="Use white light instead of a color on this light">White</button>
        <input type="range" min="${whiteTempMin}" max="${whiteTempMax}" step="50" value="2700"
               data-plan-temperature="${key}" aria-label="${escapeHtml(light.label)} white temperature">
        <output data-plan-temperature-value="${key}">2700K</output>
      </div>
      <div class="plan-row">
        <select data-plan-effect="${key}" aria-label="${escapeHtml(light.label)} effect">${effectOptions("none")}</select>
        <input type="range" min="${Math.round(effectSecondsMin * 10)}" max="${Math.round(effectSecondsMax * 10)}"
               value="20" data-plan-seconds="${key}" aria-label="Effect speed">
        <output data-plan-seconds-value="${key}">2.0s</output>
      </div>
    </div>`;
}

/* Written on every poll, so it must never touch whatever the user is holding. */
function updatePlanEditor() {
  if (planInteracting) return;
  players.forEach((player, index) => {
    const name = document.querySelector(`[data-plan-name="${index}"]`);
    if (!name) return;
    name.textContent = player.name;

    const swatch = document.querySelector(`[data-plan-player-swatch="${index}"]`);
    if (swatch) swatch.style.background = playerHex(player);

    const article = document.querySelector(`[data-plan-player="${index}"]`);
    article.classList.toggle("is-current", index === currentPlayer);

    setUnlessHeld(document.querySelector(`[data-announcer-sound="${index}"]`), player.announcer_sound || "");
    setUnlessHeld(document.querySelector(`[data-commander-sound="${index}"]`), player.commander_sound || "");
    document.querySelector(`[data-two-commanders="${index}"]`).checked = !!player.two_commanders;
    document.querySelector(`[data-commander-name-label="${index}"]`).textContent =
      player.two_commanders ? "Commander 1 name" : "Commander name";
    document.querySelector(`[data-second-row="${index}"]`).hidden = !player.two_commanders;
    document.querySelector(`[data-second-name-row="${index}"]`).hidden = !player.two_commanders;
    setUnlessHeld(document.querySelector(`[data-commander-name="${index}"]`), player.commander_name || "");
    setUnlessHeld(document.querySelector(`[data-second-sound="${index}"]`), player.second_commander_sound || "");
    setUnlessHeld(document.querySelector(`[data-second-commander-name="${index}"]`), player.second_commander_name || "");

    const running = (player.targets || []).map((id) => {
      const light = (player.lights || {})[id] || {};
      const effect = effectCatalog.filter((item) => item.id === light.effect)[0];
      return light.effect && light.effect !== "none" ? `${lightLabel(id)} ${effect ? effect.label.toLowerCase() : light.effect}` : null;
    }).filter(Boolean);
    const summary = document.querySelector(`[data-plan-summary="${index}"]`);
    if (summary) {
      summary.textContent = (index === currentPlayer ? "their turn · " : "") +
        (running.length ? running.join(", ") : `${(player.targets || []).length} light${(player.targets || []).length === 1 ? "" : "s"}, solid`);
    }

    lightCatalog.forEach((light) => {
      updatePlanLight(index, light, (player.lights || {})[light.id]);
    });
  });
}

function updatePlanLight(index, light, config) {
  if (!config) return;
  const key = planKey(index, light.id);
  const row = document.querySelector(`[data-plan-light="${key}"]`);
  if (!row) return;

  row.classList.toggle("is-off", !config.enabled);
  row.classList.toggle("is-offline", config.enabled && !light.ready);

  const toggle = row.querySelector(`[data-plan-enabled="${key}"]`);
  toggle.setAttribute("aria-pressed", config.enabled ? "true" : "false");
  toggle.classList.toggle("is-on", !!config.enabled);
  toggle.title = light.ready ? light.label : `${light.label} is not connected yet`;

  const white = config.mode === "white";
  // The swatch shows what the light will actually emit, white included.
  setUnlessHeld(row.querySelector(`[data-plan-color="${key}"]`),
                white ? rgbHex(...kelvinToRgb(config.temperature)) : hsHex(config.hue, config.saturation));
  setUnlessHeld(row.querySelector(`[data-plan-brightness="${key}"]`), config.brightness);
  row.querySelector(`[data-plan-brightness-value="${key}"]`).value = `${config.brightness}%`;

  const whiteButton = row.querySelector(`[data-plan-white="${key}"]`);
  whiteButton.setAttribute("aria-pressed", white ? "true" : "false");
  whiteButton.classList.toggle("is-on", white);
  const temperature = row.querySelector(`[data-plan-temperature="${key}"]`);
  setUnlessHeld(temperature, config.temperature);
  row.querySelector(`[data-plan-temperature-value="${key}"]`).value = `${config.temperature}K`;
  // Dimmed on a color light, but still live: dragging it is how you go white.
  temperature.closest(".plan-row").classList.toggle("is-off", !white);

  setUnlessHeld(row.querySelector(`[data-plan-effect="${key}"]`), config.effect);
  const seconds = row.querySelector(`[data-plan-seconds="${key}"]`);
  setUnlessHeld(seconds, Math.round(config.effect_seconds * 10));
  row.querySelector(`[data-plan-seconds-value="${key}"]`).value = config.effect_seconds.toFixed(1) + "s";
  // A solid light has nothing to time.
  seconds.closest(".plan-row").classList.toggle("is-off", config.effect === "none");
}

function setUnlessHeld(input, value) {
  if (input && document.activeElement !== input) input.value = value;
}

function lightLabel(id) {
  const light = lightCatalog.filter((item) => item.id === id)[0];
  return light ? light.label : id;
}

/* The color inputs carry hue and saturation only; brightness has its own slider,
   because that is how both the bulbs and the strip take it. */
function hsHex(hue, saturation) {
  const [r, g, b] = hsvToRgb(hue / 360, saturation / 100, 1);
  return rgbHex(r, g, b);
}

function hexToHueSaturation(hex) {
  const value = parseInt(hex.slice(1), 16);
  const r = ((value >> 16) & 255) / 255, g = ((value >> 8) & 255) / 255, b = (value & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), span = max - min;
  let hue = 0;
  if (span > 0) {
    if (max === r) hue = ((g - b) / span) % 6;
    else if (max === g) hue = (b - r) / span + 2;
    else hue = (r - g) / span + 4;
    hue = Math.round(hue * 60);
    if (hue < 0) hue += 360;
  }
  return { hue, saturation: Math.round(max > 0 ? (span / max) * 100 : 0) };
}

async function postPlanLight(key, patch, working) {
  const [rawIndex, lightId] = key.split(":");
  const index = +rawIndex;
  const player = players[index];
  if (!player || !player.lights || !player.lights[lightId]) return;

  // The server reads a color as "make this light a color light" and a warmth as
  // "make it white"; mirror that here so the row does not flip back and forth
  // for a poll cycle.
  if (patch.mode === undefined) {
    if (patch.hue !== undefined || patch.saturation !== undefined) patch = { ...patch, mode: "color" };
    else if (patch.temperature !== undefined) patch = { ...patch, mode: "white" };
  }

  // Repaint from the local copy first; the poll is up to four seconds away.
  Object.assign(player.lights[lightId], patch);
  player.targets = lightCatalog.map((light) => light.id).filter((id) => player.lights[id].enabled);
  updatePlanEditor();
  renderedPlayerKey = "";
  renderPlayers();

  await post(`/api/players/${index}/lights/${lightId}`, patch, working);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/* --- Moments: how each game moment looks, built from the server's list --- */
let momentCatalog = [];
let momentSettings = {};
let renderedMomentKey = "";
let momentInteracting = false;

function buildMomentEditor() {
  const key = JSON.stringify(momentCatalog.map((moment) => [moment.id, moment.fields.map((field) => field.key)]))
    + lightCatalog.map((light) => light.id).join(",");
  if (key === renderedMomentKey) return;
  renderedMomentKey = key;
  // Most entries are light moments; one with a "tab" of its own (the sound
  // and timing settings, the coin toss) goes there instead, with no on/off
  // switch or test.
  const cards = (tab) => momentCatalog.filter((moment) => (moment.tab || "moments") === tab).map((moment) => `
    <article class="plan-light moment" data-moment="${moment.id}">
      <div class="plan-light-head">${moment.settings_only
        ? `<h3>${escapeHtml(moment.label)}</h3>`
        : `<button class="plan-enable" type="button" data-moment-enabled="${moment.id}" aria-pressed="false">
          ${escapeHtml(moment.label)}</button>
        <button class="secondary plan-pick" type="button" data-moment-test="${moment.id}">Test</button>`}
      </div>
      <p class="moment-hint">${escapeHtml(moment.hint)}</p>
      ${moment.fields.map((field) => momentFieldMarkup(moment.id, field)).join("")}
    </article>`).join("");
  $("#moment-grid").innerHTML = cards("moments");
  $("#sound-grid").innerHTML = cards("sound");
  $("#settings-grid").innerHTML = cards("settings");
}

function momentFieldMarkup(momentId, field) {
  const key = `${momentId}:${field.key}`;
  const label = escapeHtml(field.label);
  if (field.type === "toggle") {
    return `<div class="plan-row moment-toggle-row">
      <button class="plan-white" type="button" data-moment-toggle="${key}" aria-pressed="false">${label}</button></div>`;
  }
  if (field.type === "lights") {
    return `<div class="plan-row moment-lights-row"><label>${label}</label><div class="moment-lights">${
      lightCatalog.map((light) => `<button class="plan-white" type="button" data-moment-light="${key}"
        data-light-id="${light.id}" aria-pressed="false">${escapeHtml(light.label)}</button>`).join("")}</div></div>`;
  }
  if (field.type === "color" || field.type === "white") {
    // A color is a swatch plus brightness; a white is warmth plus brightness.
    const tone = field.type === "color"
      ? `<input class="plan-color" type="color" data-moment-color="${key}" value="#000000" aria-label="${label}">`
      : `<input type="range" min="${whiteTempMin}" max="${whiteTempMax}" step="50" data-moment-temperature="${key}"
               aria-label="${label} warmth">`;
    return `<div class="plan-row moment-tone-row"><label>${label}</label>${tone}
      <input type="range" min="1" max="100" data-moment-brightness="${key}" aria-label="${label} brightness">
      <output data-moment-output="${key}"></output></div>`;
  }
  return `<div class="plan-row"><label for="moment-${key}">${label}</label>
    <input id="moment-${key}" type="range" min="${field.min}" max="${field.max}" step="${field.step}"
           data-moment-number="${key}">
    <output data-moment-output="${key}"></output></div>`;
}

function momentField(key) {
  const [momentId, fieldKey] = key.split(":");
  const moment = momentCatalog.filter((item) => item.id === momentId)[0];
  const field = moment ? moment.fields.filter((item) => item.key === fieldKey)[0] : null;
  return { momentId, fieldKey, field };
}

function momentOutput(field, value) {
  if (field.type === "seconds") return `${value.toFixed(2)}s`;
  if (field.type === "percent") return `${value}%`;
  if (field.type === "white") return `${value.temperature}K ${value.brightness}%`;
  if (field.type === "color") return `${value.brightness}%`;
  return "";
}

/* Written on every poll, so it must never touch whatever the user is holding. */
function updateMomentEditor() {
  if (momentInteracting) return;
  momentCatalog.forEach((moment) => {
    const look = momentSettings[moment.id];
    const card = document.querySelector(`[data-moment="${moment.id}"]`);
    if (!look || !card) return;
    const toggle = card.querySelector("[data-moment-enabled]");
    if (toggle) {
      card.classList.toggle("is-off", !look.enabled);
      toggle.setAttribute("aria-pressed", look.enabled ? "true" : "false");
      toggle.classList.toggle("is-on", !!look.enabled);
    }
    moment.fields.forEach((field) => {
      const key = `${moment.id}:${field.key}`;
      const value = look[field.key];
      if (field.type === "toggle") {
        const button = card.querySelector(`[data-moment-toggle="${key}"]`);
        button.setAttribute("aria-pressed", value ? "true" : "false");
        button.classList.toggle("is-on", !!value);
        return;
      }
      if (field.type === "lights") {
        card.querySelectorAll(`[data-moment-light="${key}"]`).forEach((button) => {
          const on = value.includes(button.dataset.lightId);
          button.setAttribute("aria-pressed", on ? "true" : "false");
          button.classList.toggle("is-on", on);
        });
        return;
      }
      if (field.type === "color") {
        setUnlessHeld(card.querySelector(`[data-moment-color="${key}"]`), hsHex(value.hue, value.saturation));
      }
      if (field.type === "white") {
        setUnlessHeld(card.querySelector(`[data-moment-temperature="${key}"]`), value.temperature);
      }
      if (field.type === "color" || field.type === "white") {
        setUnlessHeld(card.querySelector(`[data-moment-brightness="${key}"]`), value.brightness);
      } else {
        setUnlessHeld(card.querySelector(`[data-moment-number="${key}"]`), value);
      }
      card.querySelector(`[data-moment-output="${key}"]`).value = momentOutput(field, value);
    });
  });
}

/* What a moment's control says right now, in the shape the server keeps it. */
function momentValue(key) {
  const { field } = momentField(key);
  const read = (name) => document.querySelector(`[data-moment-${name}="${key}"]`);
  if (field.type === "color") {
    return { ...hexToHueSaturation(read("color").value), brightness: +read("brightness").value };
  }
  if (field.type === "white") return { temperature: +read("temperature").value, brightness: +read("brightness").value };
  return +read("number").value;
}

async function postMoment(momentId, patch, working) {
  // Repaint from the local copy first; the poll is up to four seconds away.
  if (momentSettings[momentId]) Object.assign(momentSettings[momentId], patch);
  updateMomentEditor();
  await post(`/api/moments/${momentId}`, patch, working);
}

async function refreshStatus() {
  const stamp = mutationStamp;
  try {
    // no-store: this is the whole picture of the table, and a cached one is
    // worse than none — it shows settings that are no longer true.
    const state = await fetch("/api/status", { cache: "no-store" }).then((r) => r.json());
    // Something was changed while this was in flight, so it describes the table
    // as it was beforehand. The change's own refresh will bring the truth.
    if (stamp !== mutationStamp) return;
    $("#connection-dot").classList.toggle("connected", state.strip_connected);
    if (state.players) {
      players = state.players;
      currentPlayer = state.current_player;
      lightCatalog = state.lights || [];
      if (Array.isArray(state.effects) && state.effects.length) effectCatalog = state.effects;
      if (Number.isFinite(state.effect_seconds_min)) effectSecondsMin = state.effect_seconds_min;
      if (Number.isFinite(state.effect_seconds_max)) effectSecondsMax = state.effect_seconds_max;
      if (Number.isFinite(state.white_temp_min)) whiteTempMin = state.white_temp_min;
      if (Number.isFinite(state.white_temp_max)) whiteTempMax = state.white_temp_max;
      if (Array.isArray(state.profiles)) profileCatalog = state.profiles;
      if (Array.isArray(state.announcer_sounds)) announcerCatalog = state.announcer_sounds;
      if (Array.isArray(state.commander_sounds)) commanderSoundCatalog = state.commander_sounds;
      renderPlayers();
      renderTurnSettings(state);
      buildPlanEditor();
      updatePlanEditor();
      renderProfileMenus();
    }
    if (Array.isArray(state.moments) && state.moment_settings) {
      momentCatalog = state.moments;
      momentSettings = state.moment_settings;
      buildMomentEditor();
      updateMomentEditor();
    }
    const stripFixture = document.querySelector('[data-device="strip"]');
    if (stripFixture) stripFixture.classList.toggle("configured", state.strip_connected);
    if (state.bulbs) {
      Object.entries(state.bulbs).forEach(([id, item]) => {
        const input = $("#ip-" + id);
        if (input && document.activeElement !== input) input.value = item.ip || "";
        const fixture = document.querySelector(`[data-device="${id}"]`);
        if (fixture) fixture.classList.toggle("configured", item.configured);
      });
    }
  } catch (_) { /* Status feedback is handled by commands. */ }
}

/* Stops the server itself, not a light. It answers before it goes, so this
   reports the shutdown instead of the dead connection that follows; the polling
   stops with it, or the page would keep asking a server that is not there. */
async function shutdownServer() {
  const button = $("#shutdown");
  button.disabled = true;
  setStatus("Stopping the server…", "busy");
  try {
    const result = await fetch("/api/shutdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).then((r) => r.json());
    if (!result.ok) throw new Error(result.message || "The server would not stop");
    clearInterval(statusPoll);
    button.closest(".server-stop").classList.add("is-stopped");
    button.textContent = "Local server stopped";
    setStatus(result.message, "success");
  } catch (error) {
    // Either it was already down, or it is up and never heard this.
    button.disabled = false;
    setStatus("No answer from the server — it may already be stopped.", "error");
  }
}

document.addEventListener("click", async (event) => {
  if (event.target.closest("#shutdown")) {
    if (window.confirm("Turn off the local table server? The table display, lights, and leaderboard will all go offline until you start it again on the PC.")) {
      await shutdownServer();
    }
    return;
  }
  const tabButton = event.target.closest("[data-tab]");
  if (tabButton) {
    selectTab(tabButton.dataset.tab);
    return;
  }
  const momentEnable = event.target.closest("[data-moment-enabled]");
  if (momentEnable) {
    const momentId = momentEnable.dataset.momentEnabled;
    const enabled = momentEnable.getAttribute("aria-pressed") !== "true";
    await postMoment(momentId, { enabled }, `Turning ${momentEnable.textContent.trim().toLowerCase()} ${enabled ? "on" : "off"}…`);
    return;
  }
  const momentTest = event.target.closest("[data-moment-test]");
  if (momentTest) {
    await post(`/api/moments/${momentTest.dataset.momentTest}/test`, {}, "Playing it on the room…");
    return;
  }
  const momentToggle = event.target.closest("[data-moment-toggle]");
  if (momentToggle) {
    const { momentId, fieldKey } = momentField(momentToggle.dataset.momentToggle);
    await postMoment(momentId, { [fieldKey]: momentToggle.getAttribute("aria-pressed") !== "true" }, "Saving…");
    return;
  }
  const momentLight = event.target.closest("[data-moment-light]");
  if (momentLight) {
    const { momentId, fieldKey } = momentField(momentLight.dataset.momentLight);
    const chosen = new Set(momentSettings[momentId][fieldKey]);
    if (chosen.has(momentLight.dataset.lightId)) chosen.delete(momentLight.dataset.lightId);
    else chosen.add(momentLight.dataset.lightId);
    await postMoment(momentId, { [fieldKey]: [...chosen] }, "Saving…");
    return;
  }
  const planEnable = event.target.closest("[data-plan-enabled]");
  if (planEnable) {
    const key = planEnable.dataset.planEnabled;
    const enabled = planEnable.getAttribute("aria-pressed") !== "true";
    await postPlanLight(key, { enabled }, `Turning ${planEnable.textContent.trim()} ${enabled ? "on" : "off"} for this player…`);
    return;
  }
  const profileSave = event.target.closest("[data-profile-save]");
  if (profileSave) {
    await saveProfile(+profileSave.dataset.profileSave);
    return;
  }
  const profileLoad = event.target.closest("[data-profile-load]");
  if (profileLoad) {
    await loadProfile(+profileLoad.dataset.profileLoad);
    return;
  }
  const planWhite = event.target.closest("[data-plan-white]");
  if (planWhite) {
    const toWhite = planWhite.getAttribute("aria-pressed") !== "true";
    await postPlanLight(planWhite.dataset.planWhite, { mode: toWhite ? "white" : "color" },
      `Switching this light to ${toWhite ? "white" : "color"}…`);
    return;
  }
  const planPick = event.target.closest("[data-plan-pick]");
  if (planPick) {
    await postPlanLight(planPick.dataset.planPick, {
      hue: colorState.hue,
      saturation: colorState.saturation,
      brightness: +$("#color-brightness").value,
    }, "Copying the picked color onto this light…");
    return;
  }
  const linkButton = event.target.closest("[data-link-device]");
  if (linkButton) {
    toggleLinkedBulb(linkButton.dataset.linkDevice);
    return;
  }
  const deviceButton = event.target.closest("[data-device]");
  if (deviceButton) {
    selectDevice(deviceButton.dataset.device);
    return;
  }
  const power = event.target.dataset.power;
  if (power) {
    const enabled = power === "on";
    post("/api/bulb/power", { target: "all_bulbs", on: enabled }, `Turning all configured bulbs ${enabled ? "on" : "off"}…`);
    return;
  }
  const selectedPower = event.target.dataset.selectedPower;
  if (selectedPower) {
    const enabled = selectedPower === "on";
    if (selectedDevice === "strip") {
      post("/api/strip/power", { on: enabled }, `Turning the LED strip ${enabled ? "on" : "off"}…`);
    } else {
      post("/api/bulb/power", { targets: selectedBulbTargets(), on: enabled }, `Turning ${controlLabel()} ${enabled ? "on" : "off"}…`);
      if (syncStripEnabled()) post("/api/strip/power", { on: enabled }, `Turning the LED strip ${enabled ? "on" : "off"}…`);
    }
    return;
  }
  const setIp = event.target.dataset.setIp;
  if (setIp) {
    post(`/api/bulbs/${setIp}/ip`, { ip: $("#ip-" + setIp).value }, `Saving the ${DEVICE_NAMES[setIp]} IP address…`);
    return;
  }
  const findBulb = event.target.dataset.findBulb;
  if (findBulb) {
    post(`/api/bulbs/${findBulb}/find`, {}, `Scanning Wi-Fi for the ${DEVICE_NAMES[findBulb]} (up to 45 seconds)…`);
    return;
  }
  const assignBulb = event.target.dataset.assignBulb;
  if (assignBulb) {
    const candidate = currentCandidate();
    if (!candidate) return;
    const result = await post("/api/bulbs/assign", { ip: candidate.ip, bulb_id: assignBulb }, `Assigning the blinking bulb to ${DEVICE_NAMES[assignBulb]}…`);
    if (result) await advanceCandidate();
    return;
  }
  const disconnectBulb = event.target.dataset.disconnectBulb;
  if (disconnectBulb) {
    linkedBulbs.delete(disconnectBulb);
    localStorage.setItem(LINK_STORAGE_KEY, JSON.stringify([...linkedBulbs]));
    updateLinkDisplay();
    post(`/api/bulbs/${disconnectBulb}/disconnect`, {}, `Forgetting the ${DEVICE_NAMES[disconnectBulb]} IP address…`);
    return;
  }
  const action = event.target.dataset.action;
  if (action === "discover-bulbs") {
    await startBulbDiscovery();
    return;
  }
  if (action === "blink-candidate") {
    if (currentCandidate()) await showCurrentCandidate(true);
    return;
  }
  if (action === "skip-candidate") {
    await advanceCandidate();
    return;
  }
  if (action === "connect-strip") {
    post("/api/strip/connect", {}, "Scanning Bluetooth and connecting the LED strip (up to 35 seconds)…");
    return;
  }
  if (action === "apply-color") {
    const payload = {
      hue: colorState.hue,
      saturation: colorState.saturation,
      brightness: +$("#color-brightness").value,
      ...(selectedDevice === "strip"
        ? { target: "strip" }
        : { targets: selectedBulbTargets(), include_strip: syncStripEnabled() }),
    };
    post("/api/color", payload, `Applying color to ${controlLabel()}…`);
    return;
  }
  if (action === "apply-white") {
    post("/api/bulb/white", {
      targets: selectedBulbTargets(),
      temperature: whiteState.temperature,
      brightness: whiteState.brightness,
    }, `Applying ${whiteState.temperature}K white to ${controlLabel()}…`);
    return;
  }

  const assignPlayer = event.target.dataset.assignPlayer;
  if (assignPlayer !== undefined) {
    const name = players[+assignPlayer] ? players[+assignPlayer].name : `Player ${+assignPlayer + 1}`;
    await post(`/api/players/${assignPlayer}/color`, {
      hue: colorState.hue,
      saturation: colorState.saturation,
      brightness: +$("#color-brightness").value,
      // One color for the whole player: the per-light plans move with it.
      spread: true,
      preview: true,
    }, `Saving the picked color for ${name}…`);
    return;
  }

  const previewPlayer = event.target.dataset.previewPlayer;
  if (previewPlayer !== undefined) {
    const name = players[+previewPlayer] ? players[+previewPlayer].name : `Player ${+previewPlayer + 1}`;
    await post(`/api/players/${previewPlayer}/preview`, {}, `Showing ${name}'s color on the lights…`);
    return;
  }

  const playerTarget = event.target.dataset.playerTarget;
  if (playerTarget !== undefined) {
    const [rawIndex, lightId] = playerTarget.split(":");
    const index = +rawIndex;
    const player = players[index];
    if (!player) return;

    const targets = (player.targets || []).slice();
    const at = targets.indexOf(lightId);
    if (at === -1) targets.push(lightId);
    else targets.splice(at, 1);

    // Repaint immediately; the poll would otherwise leave the chip looking dead
    // for up to a second.
    player.targets = targets;
    renderedPlayerKey = "";
    renderPlayers();
    await post(`/api/players/${index}/targets`, { targets }, `Updating ${player.name}'s lights…`);
  }
});

$("#fade-enabled").addEventListener("change", (event) => {
  post("/api/table/settings", { fade_enabled: event.target.checked }, "Saving fade setting…");
});

const playerList = $("#player-list");
playerList.addEventListener("input", (event) => {
  const key = event.target.dataset.displayBrightness;
  if (!key) return;
  const output = playerList.querySelector(`[data-display-brightness-value="${key}"]`);
  if (output) output.value = event.target.value + "%";
});
playerList.addEventListener("change", async (event) => {
  const key = event.target.dataset.displayBrightness;
  if (!key) return;
  const [rawIndex, field] = key.split(":");
  const index = +rawIndex;
  if (!players[index]) return;
  players[index][field] = +event.target.value;
  await post(`/api/players/${index}/display`, { [field]: +event.target.value },
    `Saving ${players[index].name}'s display brightness…`);
});

/* Plan sliders and menus: preview the label while moving, commit on release, so
   a drag costs one request instead of one per pixel. */
const planGrid = $("#plan-grid");

planGrid.addEventListener("pointerdown", () => { planInteracting = true; });
["pointerup", "pointercancel"].forEach((type) => {
  document.addEventListener(type, () => { planInteracting = false; });
});

planGrid.addEventListener("input", (event) => {
  const brightness = event.target.dataset.planBrightness;
  if (brightness) {
    planGrid.querySelector(`[data-plan-brightness-value="${brightness}"]`).value = event.target.value + "%";
    return;
  }
  const temperature = event.target.dataset.planTemperature;
  if (temperature) {
    planGrid.querySelector(`[data-plan-temperature-value="${temperature}"]`).value = event.target.value + "K";
    return;
  }
  const seconds = event.target.dataset.planSeconds;
  if (seconds) {
    planGrid.querySelector(`[data-plan-seconds-value="${seconds}"]`).value = (+event.target.value / 10).toFixed(1) + "s";
  }
});

planGrid.addEventListener("change", async (event) => {
  const announcer = event.target.dataset.announcerSound;
  if (announcer !== undefined) {
    const index = +announcer;
    if (players[index]) players[index].announcer_sound = event.target.value;
    await post(`/api/players/${index}/announcer`, { sound: event.target.value }, "Saving this entrance sound…");
    return;
  }
  const dual = event.target.dataset.twoCommanders;
  if (dual !== undefined) {
    await post(`/api/players/${dual}/two-commanders`, { enabled: event.target.checked }, "Saving commander settings?");
    return;
  }
  const second = event.target.dataset.secondSound;
  if (second !== undefined) {
    await post(`/api/players/${second}/commander-sound`, { sound: event.target.value, slot: 2 }, "Saving commander sound?");
    return;
  }
  const firstName = event.target.dataset.commanderName;
  const secondName = event.target.dataset.secondCommanderName;
  if (firstName !== undefined || secondName !== undefined) {
    const index = +(firstName !== undefined ? firstName : secondName);
    const field = firstName !== undefined ? "commander_name" : "second_commander_name";
    if (players[index]) players[index][field] = event.target.value.trim();
    await post(`/api/players/${index}/commander-names`, { [field]: event.target.value }, "Saving commander name…");
    return;
  }
  const commanderSound = event.target.dataset.commanderSound;
  if (commanderSound !== undefined) {
    const index = +commanderSound;
    if (players[index]) players[index].commander_sound = event.target.value;
    await post(`/api/players/${index}/commander-sound`, { sound: event.target.value }, "Saving this commander sound…");
    return;
  }
  const color = event.target.dataset.planColor;
  if (color) {
    await postPlanLight(color, hexToHueSaturation(event.target.value), "Saving this light's color…");
    return;
  }
  const brightness = event.target.dataset.planBrightness;
  if (brightness) {
    await postPlanLight(brightness, { brightness: +event.target.value }, "Saving this light's brightness…");
    return;
  }
  const temperature = event.target.dataset.planTemperature;
  if (temperature) {
    await postPlanLight(temperature, { temperature: +event.target.value }, "Saving this light's white…");
    return;
  }
  const effect = event.target.dataset.planEffect;
  if (effect) {
    await postPlanLight(effect, { effect: event.target.value }, "Saving this light's effect…");
    return;
  }
  const seconds = event.target.dataset.planSeconds;
  if (seconds) {
    await postPlanLight(seconds, { effect_seconds: +event.target.value / 10 }, "Saving this effect's speed…");
  }
});

/* Sliders preview while dragging and only commit on release, so a drag does not
   fire a request per pixel. */
$("#fade-seconds").addEventListener("input", (event) => {
  $("#fade-seconds-value").value = (+event.target.value / 10).toFixed(1) + "s";
});
$("#fade-seconds").addEventListener("change", (event) => {
  post("/api/table/settings", { fade_seconds: +event.target.value / 10 }, "Saving fade time…");
});
$("#color-brightness").addEventListener("input", (event) => {
  $("#color-brightness-value").value = event.target.value + "%";
});

$("#sync-strip").checked = localStorage.getItem(SYNC_STORAGE_KEY) === "true";
$("#sync-strip").addEventListener("change", (event) => {
  localStorage.setItem(SYNC_STORAGE_KEY, event.target.checked ? "true" : "false");
  updateLinkDisplay();
});

updateColorPreview();
updateWhitePreview();
selectDevice(selectedDevice);
["pointerup", "pointercancel"].forEach((type) => {
  document.addEventListener(type, () => { momentInteracting = false; });
});
[$("#moment-grid"), $("#sound-grid"), $("#settings-grid")].forEach((grid) => {
  grid.addEventListener("pointerdown", () => { momentInteracting = true; });
  grid.addEventListener("input", (event) => {
    const key = event.target.dataset.momentNumber || event.target.dataset.momentBrightness
      || event.target.dataset.momentTemperature;
    if (!key) return;
    const { field } = momentField(key);
    document.querySelector(`[data-moment-output="${key}"]`).value = momentOutput(field, momentValue(key));
  });
  grid.addEventListener("change", async (event) => {
    const key = event.target.dataset.momentNumber || event.target.dataset.momentBrightness
      || event.target.dataset.momentTemperature || event.target.dataset.momentColor;
    if (!key) return;
    const { momentId, fieldKey, field } = momentField(key);
    await postMoment(momentId, { [fieldKey]: momentValue(key) }, `Saving ${field.label.toLowerCase()}…`);
  });
});

selectTab(localStorage.getItem(TAB_STORAGE_KEY) || "room");
refreshStatus();

// The tracker advances turns on another device, so poll to keep the current
// player highlight and any renamed players in step.
const statusPoll = setInterval(refreshStatus, 4000);

// Canvas layout size can settle after the initial script run (mobile browsers in
// particular), and backgrounding a tab can evict canvas GPU memory. ResizeObserver
// re-fires once the real box size is known and again on any later change;
// visibilitychange covers the tab-backgrounded-and-restored case.
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(updateColorPreview).observe(wheelCanvas);
  new ResizeObserver(updateWhitePreview).observe(whiteCanvas);
} else {
  window.addEventListener("resize", () => { updateColorPreview(); updateWhitePreview(); });
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    updateColorPreview();
    updateWhitePreview();
    refreshStatus();
  }
});
window.addEventListener("focus", refreshStatus);
