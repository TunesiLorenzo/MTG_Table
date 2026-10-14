/* The editor on /public, the local preview of the public leaderboard.
 *
 * web.py adds this file to site/index.html when it serves the preview; the
 * published site never loads it. It runs after site/site.js and leans on that
 * file's top-level bindings (app, stats, keyOf, escapeHtml, start), then hooks
 * its afterRender to put an edit form at the foot of every player and deck
 * page. What it edits is site/roster.json: which commander, art, cards,
 * portrait and background belong to which name.
 *
 * The bar along the bottom commits and pushes, which is what republishes the
 * real site. */

(function () {
  let source = { players: {}, decks: {} };
  let pictures = [];
  /* The commander recordings in sound/Commander, as { file, label }. */
  let sounds = [];
  const soundPreview = new Audio();
  let publish = { changed: [], unpushed: 0 };
  /* No form until the roster's sources are here: one drawn from an empty
     roster would save over the real entry. */
  let loaded = false;

  async function call(path, payload) {
    const response = await fetch(path, payload === undefined
      ? { cache: "no-store" }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "Request failed");
    return result;
  }

  /* ---------------------------------------------------------- publish bar -- */

  const bar = document.createElement("div");
  bar.id = "publish-bar";
  bar.innerHTML = '<span class="publish-tag">LOCAL PREVIEW</span><span id="publish-state"></span><button type="button" id="publish-button">Commit &amp; push</button>';
  document.body.append(bar);
  const stateBox = bar.querySelector("#publish-state");
  const publishButton = bar.querySelector("#publish-button");

  function showPublishState(message, kind = "") {
    const pending = publish.changed.length || publish.unpushed;
    const parts = [];
    if (publish.changed.length) parts.push(`${publish.changed.length} changed file${publish.changed.length === 1 ? "" : "s"}`);
    if (publish.unpushed) parts.push(`${publish.unpushed} commit${publish.unpushed === 1 ? "" : "s"} not pushed`);
    stateBox.textContent = message || (pending ? `Not published yet: ${parts.join(", ")}` : "Everything here is published");
    stateBox.title = publish.changed.join("\n");
    stateBox.className = kind;
    publishButton.disabled = !pending;
  }

  publishButton.addEventListener("click", async () => {
    const files = publish.changed.length ? `\n\n${publish.changed.join("\n")}` : "";
    if (!window.confirm(`Commit and push to GitHub? This updates the public site.${files}`)) return;
    publishButton.disabled = true;
    showPublishState("Pushing…");
    publishButton.disabled = true;
    try {
      const result = await call("/api/public/publish", {});
      publish = result.publish;
      showPublishState(result.message, "success");
    } catch (error) {
      showPublishState(error.message, "error");
      publishButton.disabled = false;
    }
  });

  /* ---------------------------------------------------------------- forms -- */

  const sourceEntry = (group, name) => {
    const key = Object.keys(source[group]).find((saved) => keyOf(saved) === keyOf(name));
    return key ? source[group][key] : {};
  };

  function pictureField(field, label, value, blank) {
    const options = pictures.map((path) => `<option value="${escapeHtml(path)}"${path === value ? " selected" : ""}>${escapeHtml(path.replace(/^Backgrounds\//, ""))}</option>`).join("");
    return `<div class="editor-field" data-picture="${field}"><span>${escapeHtml(label)}</span>
      <div class="editor-picture"><img alt=""${value ? ` src="/${escapeHtml(encodeURI(value))}"` : " hidden"}>
      <select><option value="">${escapeHtml(blank)}</option>${options}</select>
      <label class="editor-upload" title="Upload a picture from this computer into Backgrounds/Uploads">Upload<input type="file" accept=".jpg,.jpeg,.jfif,.png,.webp,image/jpeg,image/png,image/webp" hidden></label>
      ${field === "cards" ? '<button type="button" class="editor-remove" data-remove-card title="Remove this card">&times;</button>' : ""}</div></div>`;
  }

  /* The deck's sound, from the same folder as the table's commander sounds. */
  const soundOptions = (value) => sounds.map((sound) => `<option value="${escapeHtml(sound.file)}"${sound.file === value ? " selected" : ""}>${escapeHtml(sound.label)}</option>`).join("");
  function soundField(value, volume) {
    return `<div class="editor-field" data-sound-field><span>Sound</span>
      <div class="editor-sound"><select data-sound><option value="">No sound</option>${soundOptions(value)}</select>
      <button type="button" class="editor-add" data-preview-sound>Play</button>
      <label class="editor-upload" title="Upload a sound from this computer into sound/Commander">Upload<input type="file" data-sound-upload accept=".mp3,.wav,.ogg,.m4a,audio/*" hidden></label></div></div>
      <label class="editor-field" data-volume-field><span>Volume</span>
      <div class="editor-volume"><input type="range" data-volume min="1" max="100" step="1" value="${Number(volume) || DECK_SOUND_VOLUME}"><output data-volume-label></output></div></label>
      <p class="editor-hint">Plays as the deck's page opens. New files in sound/Commander are listed here and at the table.</p>`;
  }

  /* The slider applies to the preview as it moves, so the level can be set by ear. */
  const chosenVolume = () => Number(app.querySelector("[data-volume]").value);
  function paintPreview() {
    const button = app.querySelector("[data-preview-sound]");
    if (!button) return;
    const sound = app.querySelector("[data-sound]").value;
    button.textContent = soundPreview.paused ? "Play" : "Stop";
    button.disabled = !sound;
    app.querySelector("[data-volume-field]").hidden = !sound;
    app.querySelector("[data-volume-label]").textContent = `${chosenVolume()}%`;
    soundPreview.volume = chosenVolume() / 100;
  }
  for (const event of ["play", "pause", "ended"]) soundPreview.addEventListener(event, paintPreview);

  /* The crop of a picture that banners and tiles show: click or drag on the
     whole picture, and a banner-shaped preview shows the result. Stored as
     "x% y%"; empty means the default in site.css. */
  const FOCUS_DEFAULT = "50% 25%";
  function focusField(field, value) {
    return `<div class="editor-field" data-focus-for="${field}" data-focus="${escapeHtml(value || "")}"><span>Banner crop</span>
      <div class="editor-focus">
        <div class="focus-source" title="Click or drag on the part the banner should show"><img alt="" draggable="false"><span class="focus-dot" aria-hidden="true"></span></div>
        <div class="focus-side"><div class="focus-preview" aria-hidden="true"></div>
          <button type="button" class="editor-add" data-reset-focus>Reset crop</button></div>
      </div></div>`;
  }

  /* A toggle per mana colour. C excludes the others, as a colourless deck has none. */
  function colorField(value) {
    const chosen = new Set(String(value || "").toUpperCase());
    const toggles = ["W", "U", "B", "R", "G", "C"].map((color) => `<label class="editor-mana" title="${MANA_NAMES[color]}">
      <input type="checkbox" value="${color}"${chosen.has(color) ? " checked" : ""}><i class="ms ms-${color.toLowerCase()} ms-cost ms-shadow" aria-hidden="true"></i>
      <span class="visually-hidden">${MANA_NAMES[color]}</span></label>`).join("");
    return `<div class="editor-field" data-colors><span>Colours</span>
      <div class="editor-colors">${toggles}<button type="button" class="editor-add" data-lookup-colors>Look up on Scryfall</button></div></div>`;
  }

  /* The page's theme: Auto follows the commander's colours (see THEMES and
     deckTheme() in site.js), anything else overrides them. Picking one
     previews it on the page straight away. */
  function themeField(deckName, value) {
    const automatic = THEMES[autoTheme(deckName)];
    const options = Object.entries(THEMES).map(([key, label]) => `<option value="${key}"${key === value ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
    return `<label class="editor-field"><span>Theme</span><select data-theme><option value="">Auto${automatic ? ` (${escapeHtml(automatic)})` : ""}</option>${options}</select></label>
      <p class="editor-hint">Auto follows the commander card's colours, or its colour identity until those are looked up. An Eldrazi commander brings the void.</p>`;
  }

  /* A player's decks added by hand. Decks they have played list themselves. */
  const deckChip = (name) => `<li data-deck="${escapeHtml(name)}">${escapeHtml(name)}<button type="button" data-remove-deck title="Remove ${escapeHtml(name)}">&times;</button></li>`;
  function decksField(list) {
    const known = stats.decks.map((deck) => `<option value="${escapeHtml(deck.name)}">`).join("");
    return `<div class="editor-field" data-decks><span>Decks</span>
      <div class="editor-decks"><ul class="editor-deck-list">${list.map(deckChip).join("")}</ul>
        <div class="editor-deck-add"><input data-new-deck list="editor-deck-names" maxlength="80" placeholder="Add a deck by name"><button type="button" class="editor-add" data-add-deck>Add</button></div>
        <datalist id="editor-deck-names">${known}</datalist></div></div>
      <p class="editor-hint">For decks not played yet. Played decks appear on their own; a new deck gets a page where its commander and art can be set.</p>`;
  }

  function mountEditor() {
    const [, kind, ...rest] = window.location.hash.replace(/^#/, "").split("/");
    let name = rest.join("/");
    try { name = decodeURIComponent(name); } catch (error) { /* as typed */ }
    const group = kind === "player" ? "players" : kind === "deck" ? "decks" : null;
    const subject = group && (group === "players" ? stats.playerIndex : stats.deckIndex).get(keyOf(name));
    if (!loaded || !subject || app.querySelector(".editor-card")) return;
    const entry = sourceEntry(group, subject.name);
    const form = document.createElement("form");
    form.className = "card editor-card";
    form.innerHTML = `<div class="section-heading"><div><span class="eyebrow">LOCAL EDITOR</span><h2>Edit ${escapeHtml(subject.name)}</h2></div><span class="muted">Saved to site/roster.json</span></div>
      ${group === "decks"
        ? `<label class="editor-field"><span>Commander</span><input name="commander" maxlength="120" value="${escapeHtml(entry.commander || "")}" placeholder="Shown under the deck name"></label>
           ${colorField(entry.colors)}
           <p class="editor-hint">Left empty, the colours are looked up from the commander when you save.</p>
           ${themeField(subject.name, entry.theme || "")}
           ${pictureField("art", "Art", entry.art || "", "No art")}
           ${focusField("art", entry.art_focus)}
           <div class="editor-cards">${(entry.cards || []).map((card) => pictureField("cards", "Card", card, "No card")).join("")}</div>
           <button type="button" class="editor-add" data-add-card>+ Add a commander card</button>
           ${soundField(entry.sound || "", entry.volume)}`
        : `${pictureField("portrait", "Profile photo", entry.portrait || "", "Initial only")}
           ${pictureField("background", "Banner", entry.background || "", "Cycle through their decks")}
           ${focusField("background", entry.background_focus)}
           <p class="editor-hint" data-cycle-hint>While the banner cycles, each deck's own crop is used: set it on that deck's page.</p>
           ${decksField(entry.decks || [])}`}
      <div class="editor-actions"><button type="submit">Save</button><span class="editor-status" role="status"></span></div>`;

    const status = form.querySelector(".editor-status");
    form.dataset.cardColors = entry.card_colors || "";
    form.dataset.typeLine = entry.type_line || "";
    form.dataset.cardColorsFor = entry.commander || "";
    form.querySelector("[data-theme]")?.addEventListener("change", (event) => applyTheme(deckTheme(subject.name, event.target.value), deckColors(subject.name)));
    form.querySelector("[data-volume]")?.addEventListener("input", paintPreview);

    /* Shows the crop control only while its picture is chosen, and draws the
       picture, the chosen point and the banner preview from data-focus. */
    function paintFocus(box) {
      const picture = form.querySelector(`[data-picture="${box.dataset.focusFor}"] select`).value;
      box.hidden = !picture;
      const hint = form.querySelector("[data-cycle-hint]");
      if (hint && box.dataset.focusFor === "background") hint.hidden = Boolean(picture);
      if (!picture) return;
      const url = `/${encodeURI(picture)}`;
      const focus = box.dataset.focus || FOCUS_DEFAULT;
      const [x, y] = focus.split(" ");
      const image = box.querySelector(".focus-source img");
      if (image.getAttribute("src") !== url) image.src = url;
      Object.assign(box.querySelector(".focus-dot").style, { left: x, top: y });
      Object.assign(box.querySelector(".focus-preview").style, { backgroundImage: `url("${url}")`, backgroundPosition: focus });
    }
    const setFocus = (box, event) => {
      const rect = box.querySelector(".focus-source img").getBoundingClientRect();
      const share = (value, start, size) => Math.round(Math.min(Math.max((value - start) / size, 0), 1) * 1000) / 10;
      box.dataset.focus = `${share(event.clientX, rect.left, rect.width)}% ${share(event.clientY, rect.top, rect.height)}%`;
      paintFocus(box);
    };
    const focusBoxes = () => [...form.querySelectorAll("[data-focus-for]")];
    form.addEventListener("pointerdown", (event) => {
      const source = event.target.closest(".focus-source");
      if (!source) return;
      event.preventDefault();
      const box = source.closest("[data-focus-for]");
      source.setPointerCapture(event.pointerId);
      setFocus(box, event);
      const move = (moveEvent) => setFocus(box, moveEvent);
      source.addEventListener("pointermove", move);
      source.addEventListener("pointerup", () => source.removeEventListener("pointermove", move), { once: true });
    });
    const colorBoxes = () => [...form.querySelectorAll("[data-colors] input")];
    form.addEventListener("change", (event) => {
      if (event.target.matches("[data-colors] input") && event.target.checked) {
        const colourless = event.target.value === "C";
        for (const box of colorBoxes()) if (box !== event.target && (colourless || box.value === "C")) box.checked = false;
        return;
      }
      if (event.target.matches("[data-sound-upload]")) {
        uploadSound(event.target);
        return;
      }
      if (event.target.matches("[data-sound]")) {
        soundPreview.pause();
        paintPreview();
        return;
      }
      if (event.target.matches(".editor-upload input")) {
        uploadPicture(event.target);
        return;
      }
      if (!event.target.matches(".editor-picture select")) return;
      const preview = event.target.parentElement.querySelector("img");
      preview.hidden = !event.target.value;
      if (event.target.value) preview.src = `/${encodeURI(event.target.value)}`;
      /* A different picture starts again from the default crop. */
      const field = event.target.closest("[data-picture]").dataset.picture;
      const box = form.querySelector(`[data-focus-for="${field}"]`);
      if (box) {
        box.dataset.focus = "";
        paintFocus(box);
      }
    });
    /* The upload is stored straight away; the entry only uses it once saved. */
    async function uploadPicture(input) {
      const file = input.files[0];
      if (!file) return;
      const body = new FormData();
      body.append("picture", file);
      status.textContent = `Uploading ${file.name}…`;
      status.className = "editor-status";
      try {
        const response = await fetch("/api/public/pictures", { method: "POST", body });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.message || "Upload failed");
        pictures = result.pictures;
        publish = result.publish;
        showPublishState();
        for (const select of form.querySelectorAll(".editor-picture select")) {
          if (![...select.options].some((option) => option.value === result.path)) select.add(new Option(result.path.replace(/^Backgrounds\//, ""), result.path));
        }
        const select = input.closest(".editor-picture").querySelector("select");
        select.value = result.path;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        status.textContent = `${result.message}. Save to use it.`;
      } catch (error) {
        status.textContent = error.message;
        status.className = "editor-status error";
      } finally {
        input.value = "";
      }
    }

    /* Play previews the chosen sound, and stops it again while it plays. */
    function togglePreview() {
      if (!soundPreview.paused) {
        soundPreview.pause();
        return;
      }
      deckSound.pause();
      soundPreview.src = `/sound/Commander/${encodeURIComponent(form.querySelector("[data-sound]").value)}`;
      soundPreview.play().catch((error) => {
        status.textContent = `Could not play that sound: ${error.message}`;
        status.className = "editor-status error";
      });
    }

    async function uploadSound(input) {
      const file = input.files[0];
      if (!file) return;
      const body = new FormData();
      body.append("sound", file);
      status.textContent = `Uploading ${file.name}…`;
      status.className = "editor-status";
      try {
        const response = await fetch("/api/public/sounds", { method: "POST", body });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.message || "Upload failed");
        sounds = result.sounds;
        publish = result.publish;
        showPublishState();
        const select = form.querySelector("[data-sound]");
        select.innerHTML = `<option value="">No sound</option>${soundOptions(result.file)}`;
        soundPreview.pause();
        paintPreview();
        status.textContent = `${result.message}. Save to use it.`;
      } catch (error) {
        status.textContent = error.message;
        status.className = "editor-status error";
      } finally {
        input.value = "";
      }
    }

    const addDeck = () => {
      const input = form.querySelector("[data-new-deck]");
      const name = input.value.replace(/\s+/g, " ").trim();
      if (!name) return;
      const list = form.querySelector(".editor-deck-list");
      if (![...list.children].some((item) => keyOf(item.dataset.deck) === keyOf(name))) list.insertAdjacentHTML("beforeend", deckChip(name));
      input.value = "";
      input.focus();
    };
    form.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target.matches("[data-new-deck]")) {
        event.preventDefault();
        addDeck();
      }
    });

    form.addEventListener("click", (event) => {
      if (event.target.closest("[data-add-deck]")) addDeck();
      if (event.target.closest("[data-preview-sound]")) togglePreview();
      const resetFocus = event.target.closest("[data-reset-focus]");
      if (resetFocus) {
        const box = resetFocus.closest("[data-focus-for]");
        box.dataset.focus = "";
        paintFocus(box);
      }
      const removeDeck = event.target.closest("[data-remove-deck]");
      if (removeDeck) removeDeck.closest("li").remove();
      if (event.target.closest("[data-add-card]")) form.querySelector(".editor-cards").insertAdjacentHTML("beforeend", pictureField("cards", "Card", "", "No card"));
      const remove = event.target.closest("[data-remove-card]");
      if (remove) remove.closest(".editor-field").remove();
      const lookup = event.target.closest("[data-lookup-colors]");
      if (lookup) {
        lookup.disabled = true;
        call(`/api/public/color-identity?commander=${encodeURIComponent(form.elements.commander.value)}`)
          .then((result) => {
            for (const box of colorBoxes()) box.checked = result.colors.includes(box.value);
            form.dataset.cardColors = result.card_colors;
            form.dataset.typeLine = result.type_line;
            form.dataset.cardColorsFor = form.elements.commander.value;
            status.textContent = `${result.message}. Save to keep it.`;
            status.className = "editor-status";
          })
          .catch((error) => {
            status.textContent = error.message;
            status.className = "editor-status error";
          })
          .finally(() => { lookup.disabled = false; });
      }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const picked = (field) => [...form.querySelectorAll(`[data-picture="${field}"] select`)].map((select) => select.value).filter(Boolean);
      const edited = group === "decks"
        ? { commander: form.elements.commander.value, colors: colorBoxes().filter((box) => box.checked).map((box) => box.value).join(""),
            /* Kept only while they still belong to the commander typed in; else the server looks them up again. */
            card_colors: form.dataset.cardColorsFor === form.elements.commander.value ? form.dataset.cardColors : "",
            type_line: form.dataset.cardColorsFor === form.elements.commander.value ? form.dataset.typeLine : "", theme: form.querySelector("[data-theme]").value, art: picked("art")[0] || "", art_focus: form.querySelector('[data-focus-for="art"]').dataset.focus, cards: picked("cards"), sound: form.querySelector("[data-sound]").value, volume: chosenVolume() }
        : { portrait: picked("portrait")[0] || "", background: picked("background")[0] || "", background_focus: form.querySelector('[data-focus-for="background"]').dataset.focus, decks: [...form.querySelectorAll(".editor-deck-list [data-deck]")].map((item) => item.dataset.deck) };
      soundPreview.pause();
      try {
        const result = await call("/api/public/roster", { group, name: subject.name, entry: edited });
        source = result.roster;
        publish = result.publish;
        showPublishState();
        /* Reloads the roster and redraws, which mounts a fresh form. */
        await start();
      } catch (error) {
        status.textContent = error.message;
        status.className = "editor-status error";
      }
    });
    app.append(form);
    focusBoxes().forEach(paintFocus);
    soundPreview.pause();
    paintPreview();
  }

  async function refresh() {
    try {
      const result = await call("/api/public/roster");
      source = result.roster;
      pictures = result.pictures;
      sounds = result.sounds;
      publish = result.publish;
      loaded = true;
      showPublishState();
    } catch (error) {
      showPublishState(error.message, "error");
    }
  }

  afterRender = mountEditor;
  /* The first view is usually drawn before this returns. */
  refresh().then(mountEditor);
  /* Results recorded from the table show up as unpublished without a reload. */
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) call("/api/public/roster").then((result) => { publish = result.publish; showPublishState(); }).catch(() => {});
  });
})();
