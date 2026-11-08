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
/* Commander card animations, as the server lists them (web.py COMMANDER_FX_EFFECTS). */
let commanderFxCatalog = [{ id: "foil", label: "Foil shimmer" }];
let effectSecondsMin = 0.4;
let effectSecondsMax = 20;
let whiteTempMin = WHITE_TEMP_MIN;
let whiteTempMax = WHITE_TEMP_MAX;
let profileCatalog = [];
/* The leaderboard's decks, each with the profile that is its preset, if any. */
let deckCatalog = [];
let pictureCatalog = [];
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

/* Pictures are the same Backgrounds files the leaderboard roster uses, so a
   deck looks the same on the table as on its leaderboard page. */
/* Backgrounds come from Backgrounds/Players and cards from
   Backgrounds/Commander, each folder's own files only (not VoltiBase). */
const PICTURE_FOLDERS = {
  background_image: "Backgrounds/Players/",
  commander_image: "Backgrounds/Commander/",
  second_commander_image: "Backgrounds/Commander/",
};

function pictureOptions(field, selected) {
  const folder = PICTURE_FOLDERS[field];
  const inFolder = pictureCatalog.filter((path) => path.startsWith(folder) && !path.slice(folder.length).includes("/"));
  const none = `<option value=""${selected ? "" : " selected"}>No picture</option>`;
  // A picture the seat names from elsewhere (an older preset, the roster)
  // still shows, so the menu does not silently claim something else is chosen.
  const files = selected && !inFolder.includes(selected) ? [selected, ...inFolder] : inFolder;
  return none + files.map((path) => {
    const label = path.startsWith(folder) ? path.slice(folder.length) : path.replace(/^Backgrounds\//, "");
    return `<option value="${escapeHtml(path)}"${path === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
}

function pictureUrl(path) {
  return "/" + path.split("/").map(encodeURIComponent).join("/");
}

function pictureRowMarkup(index, field, label) {
  const key = `${index}:${field}`;
  const player = players[index] || {};
  const hidden = field === "second_commander_image" && !player.two_commanders;
  return `
    <div class="plan-picture" data-picture-row="${key}" ${hidden ? "hidden" : ""}>
      <span data-picture-label="${key}">${label}</span>
      <img class="plan-thumb" data-picture-thumb="${key}" alt="" loading="lazy" hidden>
      <select data-picture="${key}" aria-label="${escapeHtml(label)}">${pictureOptions(field, player[field] || "")}</select>
      <label class="secondary plan-upload" title="Upload a picture into ${PICTURE_FOLDERS[field].slice(0, -1)} and use it here">
        Upload<input type="file" accept=".jpg,.jpeg,.jfif,.png,.webp,image/*" data-picture-upload="${key}" hidden>
      </label>
    </div>`;
}

/* --- Commander animations: an effect per commander card, previewed live --- */

/* Each animation's own card, and the picture it animates. */
const COMMANDER_FX_FIELDS = ["commander_fx", "second_commander_fx"];
const COMMANDER_FX_IMAGE = { commander_fx: "commander_image", second_commander_fx: "second_commander_image" };
/* What the two points mean for each effect, shown beside the preview. */
const COMMANDER_FX_HINTS = {
  breath: "Focus on the chest, which swells as it breathes. The eyes / mouth point is where each breath leaves as mist.",
  dragon: "Focus on the chest, which swells as it breathes. The eyes / mouth point is where the fire leaves.",
  radiance: "Focus where the light comes from. An eyes point adds glowing eyes.",
  eyes: "Focus on the eyes; a second point adds another glow.",
  foil: "Sweeps the whole card. An eyes point adds glowing eyes.",
  roar: "Every few seconds the card shakes and sound waves ripple out of the eyes / mouth point (the focus, if that is not placed).",
  quake: "Every few seconds the card rumbles and dust falls. An eyes point adds glowing eyes.",
  heartbeat: "Focus on the heart; the art throbs around it and the edges flush red. An eyes point adds glowing eyes.",
  void: "Focus on the centre of the rift; the art twists around it. An eyes point adds glowing eyes.",
  none: "The card stays still.",
};
const COMMANDER_FX_DEFAULT_HINT = "Moves the art window. An eyes point adds glowing eyes on top.";
/* The table's default focus when none is placed (js/commander-fx.js). */
const COMMANDER_FX_DEFAULT_FOCUS = [0.5, 0.33];
/* Which point a click on each preview places. */
const commanderFxPointMode = {};
/* Live preview handles from js/commander-fx.js, by "index:field". */
let commanderFxPreviews = {};

function commanderFxOf(player, field) {
  return Object.assign({ effect: "foil", focus: "", glow: "", area: "art" }, (player || {})[field] || {});
}

function commanderFxOptions(selected) {
  return commanderFxCatalog.map((effect) => (
    `<option value="${effect.id}"${effect.id === selected ? " selected" : ""}>${escapeHtml(effect.label)}</option>`
  )).join("");
}

function commanderFxRowMarkup(index, field) {
  const key = `${index}:${field}`;
  const player = players[index] || {};
  const fx = commanderFxOf(player, field);
  const hidden = field === "second_commander_fx" && !player.two_commanders;
  const mode = commanderFxPointMode[key] || "focus";
  return `
    <div class="plan-fx" data-fx-row="${key}" ${hidden ? "hidden" : ""}>
      <span data-fx-label="${key}">Animation</span>
      <div class="plan-fx-controls">
        <select data-fx-effect="${key}" aria-label="Commander animation">${commanderFxOptions(fx.effect)}</select>
        <select data-fx-area="${key}" aria-label="What the animation covers">
          <option value="art"${fx.area === "art" ? " selected" : ""}>Art only</option>
          <option value="card"${fx.area === "card" ? " selected" : ""}>Whole card</option>
        </select>
      </div>
      <div class="plan-fx-body">
        ${commanderFxStageMarkup(key, "")}
        <div class="plan-fx-side">
          <button class="plan-white" type="button" data-fx-point="${key}" data-point="focus"
            aria-pressed="${mode === "focus"}"><i class="plan-fx-dot plan-fx-dot--focus"></i>Place focus</button>
          <button class="plan-white" type="button" data-fx-point="${key}" data-point="glow"
            aria-pressed="${mode === "glow"}"><i class="plan-fx-dot plan-fx-dot--glow"></i>Place eyes / mouth</button>
          <button class="secondary" type="button" data-fx-clear="${key}">Remove eyes / mouth</button>
          <button class="secondary" type="button" data-fx-enlarge="${key}">Larger preview</button>
          <small class="plan-fx-hint" data-fx-hint="${key}"></small>
        </div>
      </div>
    </div>`;
}

/* The same stage the editor row uses: the card, its two point markers, and a
   note when there is no picture. */
function commanderFxStageMarkup(key, className) {
  return `
    <div class="plan-fx-stage ${className}" data-fx-stage="${key}" title="Click to place the chosen point">
      <div class="plan-fx-face" data-fx-face="${key}"></div>
      <i class="plan-fx-marker plan-fx-marker--focus" data-fx-marker="${key}:focus" hidden></i>
      <i class="plan-fx-marker plan-fx-marker--glow" data-fx-marker="${key}:glow" hidden></i>
      <span class="plan-fx-empty" data-fx-empty="${key}">No card picture</span>
    </div>`;
}

function commanderFxStrength() {
  const saved = momentSettings.commander_fx;
  return saved && Number.isFinite(saved.strength) ? saved.strength / 100 : 1;
}

/* Writes one commander's animation into a set of controls — the editor row
   or the larger preview — and returns that set's preview handle, created,
   updated or dropped to match. Never touches a menu that is being used. */
function paintCommanderFx(root, key, preview, fps) {
  const [rawIndex, field] = key.split(":");
  const player = players[rawIndex] || {};
  const fx = commanderFxOf(player, field);
  setUnlessHeld(root.querySelector(`[data-fx-effect="${key}"]`), fx.effect);
  setUnlessHeld(root.querySelector(`[data-fx-area="${key}"]`), fx.area);
  root.querySelector(`[data-fx-hint="${key}"]`).textContent = COMMANDER_FX_HINTS[fx.effect] || COMMANDER_FX_DEFAULT_HINT;
  const mode = commanderFxPointMode[key] || "focus";
  root.querySelectorAll(`[data-fx-point="${key}"]`).forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.point === mode));
  });

  const picture = player[COMMANDER_FX_IMAGE[field]] || "";
  const image = picture ? pictureUrl(picture) : "";
  const face = root.querySelector(`[data-fx-face="${key}"]`);
  const background = image ? `url("${image}")` : "";
  if (face.style.backgroundImage !== background) face.style.backgroundImage = background;
  root.querySelector(`[data-fx-empty="${key}"]`).hidden = !!image;

  const animate = image && fx.effect !== "none" && window.CommanderFx;
  if (!animate) {
    if (preview) preview.destroy();
    preview = null;
  } else {
    const options = { image, effect: fx.effect, focus: fx.focus, glow: fx.glow, area: fx.area,
                      strength: commanderFxStrength(), fps };
    if (preview) preview.update(options);
    else preview = window.CommanderFx.attach(face, options);
  }
  placeCommanderFxMarkers(root, key, fx, image ? preview : undefined);
  return preview;
}

/* Written on every poll. */
function updateCommanderFxRow(index, field) {
  const key = `${index}:${field}`;
  const row = document.querySelector(`[data-fx-row="${key}"]`);
  if (!row) return;
  const player = players[index] || {};
  const second = field === "second_commander_fx";
  row.hidden = second && !player.two_commanders;
  row.querySelector(`[data-fx-label="${key}"]`).textContent =
    player.two_commanders ? `Commander ${second ? 2 : 1} animation` : "Commander animation";
  if (row.hidden) {
    if (commanderFxPreviews[key]) commanderFxPreviews[key].destroy();
    delete commanderFxPreviews[key];
  } else {
    const preview = paintCommanderFx(row, key, commanderFxPreviews[key], 30);
    if (preview) commanderFxPreviews[key] = preview;
    else delete commanderFxPreviews[key];
  }
  if (commanderFxDialogKey === key) paintCommanderFxDialog();
}

/* --- The larger preview: one dialog, opened for one commander at a time --- */
let commanderFxDialog = null;
let commanderFxDialogKey = null;
let commanderFxDialogPreview = null;

function commanderFxDialogElement() {
  if (commanderFxDialog) return commanderFxDialog;
  commanderFxDialog = document.createElement("dialog");
  commanderFxDialog.className = "fx-dialog";
  commanderFxDialog.setAttribute("aria-labelledby", "fx-dialog-title");
  document.body.appendChild(commanderFxDialog);
  commanderFxDialog.addEventListener("close", () => {
    if (commanderFxDialogPreview) commanderFxDialogPreview.destroy();
    commanderFxDialogPreview = null;
    commanderFxDialogKey = null;
  });
  // A click on the dimmed backdrop (the dialog box itself, outside its frame) closes it.
  commanderFxDialog.addEventListener("click", (event) => {
    if (event.target === commanderFxDialog || event.target.closest("[data-fx-dialog-close]")) {
      commanderFxDialog.close();
      return;
    }
    handleCommanderFxClick(event, commanderFxDialog);
  });
  commanderFxDialog.addEventListener("change", (event) => handleCommanderFxChange(event));
  return commanderFxDialog;
}

function openCommanderFxDialog(key) {
  const dialog = commanderFxDialogElement();
  if (commanderFxDialogPreview) commanderFxDialogPreview.destroy();
  commanderFxDialogPreview = null;
  commanderFxDialogKey = key;
  const [rawIndex, field] = key.split(":");
  const player = players[rawIndex] || {};
  const fx = commanderFxOf(player, field);
  const second = field === "second_commander_fx";
  const commander = (second ? player.second_commander_name : player.commander_name)
    || (player.two_commanders ? `Commander ${second ? 2 : 1}` : "Commander");
  dialog.innerHTML = `
    <div class="fx-dialog__frame">
      <header class="fx-dialog__head">
        <div><span class="eyebrow">${escapeHtml(player.name || "")}</span>
          <h2 id="fx-dialog-title">${escapeHtml(commander)}</h2></div>
        <button class="secondary" type="button" data-fx-dialog-close>Close</button>
      </header>
      <div class="plan-fx-controls">
        <select data-fx-effect="${key}" aria-label="Commander animation">${commanderFxOptions(fx.effect)}</select>
        <select data-fx-area="${key}" aria-label="What the animation covers">
          <option value="art">Art only</option>
          <option value="card">Whole card</option>
        </select>
      </div>
      ${commanderFxStageMarkup(key, "fx-dialog__stage")}
      <div class="fx-dialog__points">
        <button class="plan-white" type="button" data-fx-point="${key}" data-point="focus">
          <i class="plan-fx-dot plan-fx-dot--focus"></i>Place focus</button>
        <button class="plan-white" type="button" data-fx-point="${key}" data-point="glow">
          <i class="plan-fx-dot plan-fx-dot--glow"></i>Place eyes / mouth</button>
        <button class="secondary" type="button" data-fx-clear="${key}">Remove eyes / mouth</button>
      </div>
      <small class="plan-fx-hint" data-fx-hint="${key}"></small>
      <small class="plan-fx-hint" data-fx-strength></small>
    </div>`;
  dialog.showModal();
  paintCommanderFxDialog();
}

function paintCommanderFxDialog() {
  if (!commanderFxDialog || !commanderFxDialogKey) return;
  // Full frame rate here: this is where an effect is judged.
  commanderFxDialogPreview = paintCommanderFx(commanderFxDialog, commanderFxDialogKey, commanderFxDialogPreview, 60);
  commanderFxDialog.querySelector("[data-fx-strength]").textContent =
    `Shown at ${Math.round(commanderFxStrength() * 100)}% strength, as on the table — change it under Settings → Commander animations.`;
}

/* "x% y%" on the picture, as fractions. */
function commanderFxPoint(text) {
  const match = /^\s*([\d.]+)%\s+([\d.]+)%\s*$/.exec(text || "");
  return match ? [+match[1] / 100, +match[2] / 100] : null;
}

/* `preview` is undefined when there is no picture (no markers at all), and
   null when there is one but nothing animating it (picture = box). */
function placeCommanderFxMarkers(root, key, fx, preview) {
  ["focus", "glow"].forEach((point) => {
    const marker = root.querySelector(`[data-fx-marker="${key}:${point}"]`);
    // An unplaced focus is shown where the animation puts it by default.
    const at = commanderFxPoint(fx[point]) || (point === "focus" ? COMMANDER_FX_DEFAULT_FOCUS : null);
    marker.hidden = preview === undefined || !at;
    if (marker.hidden) return;
    const box = preview ? preview.imageToBox(at[0], at[1]) : at;
    marker.style.left = `${clamp(box[0], 0, 1) * 100}%`;
    marker.style.top = `${clamp(box[1], 0, 1) * 100}%`;
  });
}

async function saveCommanderFx(key, patch, message) {
  const [rawIndex, field] = key.split(":");
  const index = +rawIndex;
  const player = players[index];
  if (!player) return;
  // Show it straight away; the poll is up to four seconds behind.
  player[field] = Object.assign(commanderFxOf(player, field), patch);
  updateCommanderFxRow(index, field);
  await post(`/api/players/${index}/commander-fx`,
    Object.assign({ slot: field === "second_commander_fx" ? 2 : 1 }, patch), message);
}

function buildPlanEditor() {
  // One structure per player and light; a rename or a recolor does not change it.
  const key = JSON.stringify([players.length, lightCatalog.map((l) => l.id), effectCatalog.map((e) => e.id),
                              announcerCatalog.map((sound) => sound.file),
                              commanderSoundCatalog.map((sound) => sound.file),
                              pictureCatalog, commanderFxCatalog.map((effect) => effect.id),
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
                title="Save lights, sounds, commanders and pictures as a preset in the profiles folder">Save as…</button>
        <select data-profile-pick="${index}" aria-label="Deck presets"></select>
        <button class="secondary" type="button" data-profile-load="${index}"
                title="Put the chosen preset or leaderboard deck on this player">Load</button>
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
      <div class="plan-deck">
        <label class="plan-announcer">
          <span>Deck</span>
          <input type="text" maxlength="80" data-deck-name="${index}" list="deck-names"
            value="${escapeHtml(player.deck || "")}" placeholder="Deck name, as on the leaderboard">
        </label>
        ${pictureRowMarkup(index, "background_image", "Background")}
        ${pictureRowMarkup(index, "commander_image", player.two_commanders ? "Commander 1 card" : "Commander card")}
        ${commanderFxRowMarkup(index, "commander_fx")}
        ${pictureRowMarkup(index, "second_commander_image", "Commander 2 card")}
        ${commanderFxRowMarkup(index, "second_commander_fx")}
        <button class="secondary plan-roster" type="button" data-deck-roster="${index}"
          title="Give this deck a page on the public leaderboard site with these pictures and sound. It goes online with the next Publish on /public">Put on public leaderboard</button>
      </div>
      ${lightCatalog.map((light) => planLightMarkup(index, light)).join("")}
    </article>`).join("");
  // These menus were just thrown away with the rest of the card, and so
  // were the animated previews (their canvases stop with their elements).
  renderedProfileKey = "";
  commanderFxPreviews = {};
  renderProfileMenus();
}

/* --- Deck presets: a saved profile per deck, or a leaderboard deck to start one --- */

/* Rebuilt only when the set of files changes, so an open menu is not yanked
   shut by the poll. Each menu keeps whatever the user had chosen. A
   leaderboard deck with a preset is listed once, as its preset. */
function presetKey(name) {
  return String(name || "").toLowerCase().replace(/[^0-9a-z]+/g, "");
}

/* The menu entry for what the seat is playing: its preset, or else its
   leaderboard deck. */
function presetValueFor(player) {
  const deck = presetKey(player && player.deck);
  if (!deck) return "";
  const profile = profileCatalog.find((item) => presetKey(item.deck) === deck) ||
    profileCatalog.find((item) => presetKey(item.name) === deck);
  if (profile) return `profile:${profile.name}`;
  const listed = deckCatalog.find((item) => presetKey(item.name) === deck);
  return listed ? (listed.profile ? `profile:${listed.profile}` : `deck:${listed.name}`) : "";
}

/* Each menu shows what its seat is playing, until it is used to pick another. */
function syncPresetMenus() {
  players.forEach((player, index) => {
    const menu = document.querySelector(`[data-profile-pick="${index}"]`);
    if (!menu || menu.dataset.picked || document.activeElement === menu) return;
    const value = presetValueFor(player);
    menu.value = [...menu.options].some((option) => option.value === value) ? value : "";
  });
}

function renderProfileMenus() {
  const menus = document.querySelectorAll("[data-profile-pick]");
  if (!menus.length) return;
  const key = JSON.stringify([profileCatalog.map((profile) => [profile.name, profile.deck]), deckCatalog]);
  if (key === renderedProfileKey) return;
  renderedProfileKey = key;

  const presets = profileCatalog.map((profile) => {
    const label = profile.deck && profile.deck !== profile.name ? `${profile.name} (${profile.deck})` : profile.name;
    return `<option value="profile:${escapeHtml(profile.name)}">${escapeHtml(label)}</option>`;
  }).join("");
  const decks = deckCatalog.filter((deck) => !deck.profile)
    .map((deck) => `<option value="deck:${escapeHtml(deck.name)}">${escapeHtml(deck.name)}</option>`).join("");
  const markup = `<option value="">Choose a preset…</option>` +
    (presets ? `<optgroup label="Saved presets">${presets}</optgroup>` : "") +
    (decks ? `<optgroup label="Leaderboard decks, no preset yet">${decks}</optgroup>` : "");

  menus.forEach((menu) => {
    if (document.activeElement === menu) return;
    const chosen = menu.value;
    menu.innerHTML = markup;
    if (chosen && [...menu.options].some((option) => option.value === chosen)) menu.value = chosen;
  });
  syncPresetMenus();

  let names = document.getElementById("deck-names");
  if (!names) {
    names = document.createElement("datalist");
    names.id = "deck-names";
    document.body.appendChild(names);
  }
  names.innerHTML = deckCatalog.map((deck) => `<option value="${escapeHtml(deck.name)}"></option>`).join("");
}

async function saveProfile(index) {
  const player = players[index] || {};
  const name = window.prompt("Save this preset (lights, sounds, commanders and pictures) as:",
    player.deck || player.name || `Player ${index + 1}`);
  if (name === null) return;
  await post(`/api/players/${index}/profile`, { profile: name }, `Saving ${name}…`);
  // A new file means a new menu, whoever it belongs to.
  renderedProfileKey = "";
}

async function loadProfile(index) {
  const menu = document.querySelector(`[data-profile-pick="${index}"]`);
  const value = (menu && menu.value) || "";
  const [kind, ...rest] = value.split(":");
  const name = rest.join(":");
  if (!name) {
    setStatus("Choose a saved preset or a leaderboard deck first.", "error");
    return;
  }
  if (kind === "deck") {
    await post(`/api/players/${index}/deck/load`, { deck: name }, `Loading the ${name} deck…`);
  } else {
    await post(`/api/players/${index}/profile/load`, { profile: name }, `Loading ${name}…`);
  }
  // The menu goes back to showing what the seat now plays.
  if (menu) delete menu.dataset.picked;
  // The plan editor is written from `players`, which the reply just replaced.
  renderedPlayerKey = "";
}

async function uploadPicture(key, input) {
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  const [rawIndex, field] = key.split(":");
  const form = new FormData();
  form.append("picture", file);
  form.append("folder", field === "background_image" ? "players" : "commander");
  setStatus(`Uploading ${file.name}…`, "busy");
  try {
    const result = await fetch("/api/public/pictures", { method: "POST", body: form }).then((r) => r.json());
    if (!result.ok) throw new Error(result.message || "Upload failed");
    pictureCatalog = result.pictures || pictureCatalog;
    await post(`/api/players/${rawIndex}/deck`, { [field]: result.path }, `Using ${result.path}…`);
  } catch (error) {
    setStatus(error.message, "error");
  }
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
    setUnlessHeld(document.querySelector(`[data-deck-name="${index}"]`), player.deck || "");
    ["background_image", "commander_image", "second_commander_image"].forEach((field) => {
      const key = `${index}:${field}`;
      const value = player[field] || "";
      const menu = document.querySelector(`[data-picture="${key}"]`);
      if (menu && document.activeElement !== menu) {
        if (![...menu.options].some((option) => option.value === value)) menu.innerHTML = pictureOptions(field, value);
        menu.value = value;
      }
      const thumb = document.querySelector(`[data-picture-thumb="${key}"]`);
      if (thumb) {
        thumb.hidden = !value;
        const src = value ? pictureUrl(value) : "";
        if (thumb.getAttribute("src") !== src) {
          if (src) thumb.setAttribute("src", src);
          else thumb.removeAttribute("src");
        }
      }
    });
    document.querySelector(`[data-picture-row="${index}:second_commander_image"]`).hidden = !player.two_commanders;
    COMMANDER_FX_FIELDS.forEach((field) => updateCommanderFxRow(index, field));
    document.querySelector(`[data-picture-label="${index}:commander_image"]`).textContent =
      player.two_commanders ? "Commander 1 card" : "Commander card";

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
      if (Array.isArray(state.commander_fx_effects) && state.commander_fx_effects.length) {
        commanderFxCatalog = state.commander_fx_effects;
      }
      if (Number.isFinite(state.effect_seconds_min)) effectSecondsMin = state.effect_seconds_min;
      if (Number.isFinite(state.effect_seconds_max)) effectSecondsMax = state.effect_seconds_max;
      if (Number.isFinite(state.white_temp_min)) whiteTempMin = state.white_temp_min;
      if (Number.isFinite(state.white_temp_max)) whiteTempMax = state.white_temp_max;
      if (Array.isArray(state.profiles)) profileCatalog = state.profiles;
      if (Array.isArray(state.decks)) deckCatalog = state.decks;
      if (Array.isArray(state.pictures)) pictureCatalog = state.pictures;
      if (Array.isArray(state.announcer_sounds)) announcerCatalog = state.announcer_sounds;
      if (Array.isArray(state.commander_sounds)) commanderSoundCatalog = state.commander_sounds;
      renderPlayers();
      renderTurnSettings(state);
      buildPlanEditor();
      updatePlanEditor();
      renderProfileMenus();
      syncPresetMenus();
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

/* Off and straight back on: the server starts a fresh copy of itself and goes.
   The old one answers for half a second more, so the wait for the new one
   starts after that; the status polling carries on and picks it up. */
async function restartServer() {
  const button = $("#restart-server");
  button.disabled = true;
  setStatus("Restarting the server…", "busy");
  try {
    const result = await fetch("/api/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).then((r) => r.json());
    if (!result.ok) throw new Error(result.message || "The server would not restart");
    setStatus(result.message, "busy");
  } catch (error) {
    button.disabled = false;
    setStatus(error.message === "Failed to fetch" ? "No answer from the server — it may be stopped." : error.message, "error");
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  for (let tries = 0; tries < 30; tries += 1) {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      if (response.ok) {
        button.disabled = false;
        setStatus("Server restarted.", "success");
        refreshStatus();
        return;
      }
    } catch (_) { /* Not back yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  button.disabled = false;
  setStatus("The server has not come back yet — check the PC.", "error");
}

document.addEventListener("click", async (event) => {
  if (event.target.closest("#restart-server")) {
    if (window.confirm("Restart the local table server? The table display, lights, and leaderboard go offline for a few seconds while it turns off and back on.")) {
      await restartServer();
    }
    return;
  }
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
  const deckRoster = event.target.closest("[data-deck-roster]");
  if (deckRoster) {
    const player = players[+deckRoster.dataset.deckRoster] || {};
    if (!player.deck) {
      setStatus("Give the deck a name first.", "error");
      return;
    }
    if (window.confirm(`Give ${player.deck} a page on the public leaderboard with this background, commander card and sound? It goes online when you next press Publish on /public.`)) {
      await post(`/api/players/${deckRoster.dataset.deckRoster}/deck/roster`, {}, `Adding ${player.deck} to the leaderboard…`);
      renderedProfileKey = "";
    }
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

/* Commander animation points: pick which point, then click the card. Shared
   by the editor rows and the larger preview (`root` is whichever was used). */
async function handleCommanderFxClick(event, root) {
  const enlarge = event.target.closest("[data-fx-enlarge]");
  if (enlarge) {
    openCommanderFxDialog(enlarge.dataset.fxEnlarge);
    return;
  }
  const pick = event.target.closest("[data-fx-point]");
  if (pick) {
    const key = pick.dataset.fxPoint;
    commanderFxPointMode[key] = pick.dataset.point;
    // Both places show the same choice.
    document.querySelectorAll(`[data-fx-point="${key}"]`).forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.point === pick.dataset.point));
    });
    return;
  }
  const clear = event.target.closest("[data-fx-clear]");
  if (clear) {
    await saveCommanderFx(clear.dataset.fxClear, { glow: "" }, "Removing the eyes / mouth point…");
    return;
  }
  const stage = event.target.closest("[data-fx-stage]");
  if (stage) {
    const key = stage.dataset.fxStage;
    const [rawIndex, field] = key.split(":");
    if (!(players[rawIndex] || {})[COMMANDER_FX_IMAGE[field]]) return;
    const rect = stage.getBoundingClientRect();
    let at = [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height];
    const preview = root === commanderFxDialog ? commanderFxDialogPreview : commanderFxPreviews[key];
    if (preview) at = preview.boxToImage(at[0], at[1]);
    const point = commanderFxPointMode[key] || "focus";
    const value = `${(clamp(at[0], 0, 1) * 100).toFixed(1)}% ${(clamp(at[1], 0, 1) * 100).toFixed(1)}%`;
    await saveCommanderFx(key, { [point]: value },
      point === "focus" ? "Saving the animation's focus…" : "Saving the eyes / mouth point…");
  }
}

/* The animation and coverage menus, in the editor rows or the larger preview.
   Returns true when the event was one of them. */
async function handleCommanderFxChange(event) {
  const fxEffect = event.target.dataset.fxEffect;
  if (fxEffect) {
    await saveCommanderFx(fxEffect, { effect: event.target.value }, "Saving the commander animation…");
    return true;
  }
  const fxArea = event.target.dataset.fxArea;
  if (fxArea) {
    await saveCommanderFx(fxArea, { area: event.target.value }, "Saving what the animation covers…");
    return true;
  }
  return false;
}

planGrid.addEventListener("click", (event) => handleCommanderFxClick(event, planGrid));
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
  if (await handleCommanderFxChange(event)) return;
  if (event.target.dataset.profilePick !== undefined) {
    event.target.dataset.picked = "1";
    return;
  }
  const upload = event.target.dataset.pictureUpload;
  if (upload) {
    await uploadPicture(upload, event.target);
    return;
  }
  const picture = event.target.dataset.picture;
  if (picture) {
    const [rawIndex, field] = picture.split(":");
    if (players[rawIndex]) players[rawIndex][field] = event.target.value;
    await post(`/api/players/${rawIndex}/deck`, { [field]: event.target.value }, "Saving this picture…");
    return;
  }
  const deckName = event.target.dataset.deckName;
  if (deckName !== undefined) {
    if (players[deckName]) players[deckName].deck = event.target.value.trim();
    await post(`/api/players/${deckName}/deck`, { deck: event.target.value }, "Saving the deck name…");
    return;
  }
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
