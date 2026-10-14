/* The editor on /public, the local preview of the public leaderboard.
 *
 * web.py adds this file to site/index.html when it serves the preview; the
 * published site never loads it. It runs after site/site.js and leans on that
 * file's top-level bindings (app, stats, keyOf, escapeHtml, start), then hooks
 * its afterRender to put an edit form at the foot of every player and deck
 * page. What it edits is site/roster.json: which commander, art, cards,
 * portrait and background belong to which name. The home page gets one for
 * the intro and the mana burst sounds instead, which edit site/intro.json and
 * site/mana_sounds.json.
 *
 * The bar along the bottom commits and pushes, which is what republishes the
 * real site. */

(function () {
  let source = { players: {}, decks: {} };
  let pictures = [];
  /* The commander recordings in sound/Commander, as { file, label }. */
  let sounds = [];
  const soundPreview = createClipPlayer();
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

  /* ---------------------------------------------------------- site volume -- */

  /* The site's own volume joins the speaker's panel here, above the visitor's
     slider. It is saved to site/settings.json and published for everyone;
     every visitor's slider tops out at it. */
  settingsPanel.querySelector(".eyebrow").insertAdjacentHTML("afterend", `${volumeRow("Site", percentToDb(siteVolume), "data-site-volume")}
    <p data-site-volume-note>Published for everyone. A visitor's slider goes up to this.</p>`);
  const siteSlider = settingsPanel.querySelector("[data-site-volume]");
  const siteNote = settingsPanel.querySelector("[data-site-volume-note]");
  volumeSlider.previousElementSibling.textContent = "Yours";
  function showSiteVolume(volume) {
    siteVolume = volume;
    siteSlider.value = Math.round(percentToDb(volume));
    paintSlider(siteSlider);
    applySiteVolume();
  }
  showSiteVolume(siteVolume);
  siteSlider.addEventListener("input", () => showSiteVolume(dbToGain(Number(siteSlider.value)) * 100));
  siteSlider.addEventListener("change", async () => {
    try {
      const result = await call("/api/public/settings", { volume: siteVolume });
      publish = result.publish;
      showPublishState();
      siteNote.textContent = `Site volume set to ${volumeLabel(Number(siteSlider.value))}. Commit & push to publish it.`;
      siteNote.className = "";
      thud();
    } catch (error) {
      siteNote.textContent = error.message;
      siteNote.className = "error";
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

  /* The slider applies to the preview as it moves, so the level can be set by ear.
     Looked up inside the form: the deck's sound button in site.js carries
     data-sound and data-volume too, and comes first on the page. */
  const editorPart = (selector) => app.querySelector(`.editor-card ${selector}`);
  const chosenVolume = () => Number(editorPart("[data-volume]").value);
  function paintPreview() {
    const button = editorPart("[data-preview-sound]");
    if (!button) return;
    const sound = editorPart("[data-sound]").value;
    soundPreview.src = sound ? `/sound/Commander/${encodeURIComponent(sound)}` : "";
    button.textContent = soundPreview.loading ? "Cancel loading" : soundPreview.paused ? "Play" : "Stop";
    button.disabled = !sound;
    editorPart("[data-volume-field]").hidden = !sound;
    editorPart("[data-volume-label]").textContent = `${chosenVolume()}%`;
    /* The shared master applies visitor/site volume and mute exactly once. */
    soundPreview.volume = chosenVolume() / 100;
  }
  for (const event of ["loading", "play", "pause", "ended", "error"]) soundPreview.addEventListener(event, paintPreview);
  document.addEventListener("sitevolumechange", paintPreview);

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
    form.querySelector("[data-theme]")?.addEventListener("change", () => previewColors());
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
    /* The wheel, the embers and the bursts follow the colours as they are
       toggled, before anything is saved. */
    const previewColors = () => applyTheme(deckTheme(subject.name, form.querySelector("[data-theme]")?.value),
      colorBoxes().filter((box) => box.checked).map((box) => box.value));
    form.addEventListener("change", (event) => {
      if (event.target.matches("[data-colors] input")) {
        if (event.target.checked) {
          const colourless = event.target.value === "C";
          for (const box of colorBoxes()) if (box !== event.target && (colourless || box.value === "C")) box.checked = false;
        }
        previewColors();
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
            previewColors();
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

  /* ---------------------------------------------------------------- intro -- */

  /* The opening's settings, at the foot of the home page: its sound and how
     the grimoire moves. Saved to site/intro.json. Preview plays the intro
     with what is set now, saved or not (playGrimoire() in site.js). */
  let intro = null;
  /* The sounds in sound/Intro, as { file, label }, and each number's
     [lowest, highest, default] from INTRO_NUMBERS in web.py. */
  let introSounds = [];
  let introNumbers = {};
  const introPreview = new Audio();
  /* Repaints the form on the page now; each mount replaces it. */
  let paintIntro = () => {};
  for (const event of ["play", "pause", "ended"]) introPreview.addEventListener(event, () => paintIntro());
  const INTRO_SLIDERS = [
    ["volume", "Volume", "%", 1],
    ["rattle", "Rattle strength", "%", 1],
    ["rattle_every", "Pause between rattles", " s", 0.1],
    ["pages", "Pages to riffle", "", 1],
    ["shuffle_seconds", "Riffle time", " s", 0.1],
    ["glow_seconds", "Glow time", " s", 0.1],
    ["flight_seconds", "Flight time", " s", 0.1],
    ["rotation_speed", "Rotation speed", "×", 0.1],
  ];
  /* Each sound's row: its key in intro.json, its label, and its blank choice. */
  const INTRO_SOUND_ROWS = [["chain", "Chain unlock", "Built-in chain rattle"], ["sound", "Opening sound", "No sound"], ["thud", "Thud", "Built-in thud"], ["page", "Page turn", "Built-in rustle"]];

  function mountIntroEditor() {
    const [, kind] = window.location.hash.replace(/^#/, "").split("/");
    if (!loaded || !intro || kind === "player" || kind === "deck" || app.querySelector(".intro-editor")) return;
    /* Each sound: a file from sound/Intro, or for the thud and the page turn
       the ones site.js makes itself. */
    const fileOptions = (value) => introSounds.map((sound) => `<option value="${escapeHtml(sound.file)}"${sound.file === value ? " selected" : ""}>${escapeHtml(sound.label)}</option>`).join("");
    const soundRows = INTRO_SOUND_ROWS.map(([key, label, blank]) => `<div class="editor-field"><span>${label}</span>
        <div class="editor-sound"><select data-intro-file="${key}"><option value="">${blank}</option>${fileOptions(intro[key])}</select>
        <button type="button" class="editor-add" data-intro-play="${key}">Play</button>
        <label class="editor-upload" title="Upload a sound from this computer into sound/Intro">Upload<input type="file" data-intro-upload="${key}" accept=".mp3,.wav,.ogg,.m4a,audio/*" hidden></label></div></div>`).join("");
    const sliders = INTRO_SLIDERS.map(([key, label, unit, step]) => {
      const [lowest, highest, fallback] = introNumbers[key] || [0.5, 8, 2];
      return `<label class="editor-field"><span>${label}</span><div class="editor-volume"><input type="range" data-intro="${key}" min="${lowest}" max="${highest}" step="${step}" value="${intro[key] ?? fallback}"><output data-intro-label="${key}" data-unit="${unit}"></output></div></label>`;
    }).join("");
    const form = document.createElement("form");
    form.className = "card editor-card intro-editor";
    form.innerHTML = `<div class="section-heading"><div><span class="eyebrow">LOCAL EDITOR</span><h2>Intro</h2></div><span class="muted">Saved to site/intro.json</span></div>
      ${soundRows}
      <p class="editor-hint">The first tap releases the chain and plays Chain unlock for up to 2.5 seconds, then the book starts thudding. Tap again to open it. The opening sound starts when the pentacle glows, with a rustle for each turning page.</p>
      <label class="editor-field"><span>Plays</span><select data-intro-repeat>
        <option value="always"${intro.repeat === "always" ? " selected" : ""}>Every time the site loads</option>
        <option value="visit"${intro.repeat === "visit" ? " selected" : ""}>Once per visit (per browser tab)</option></select></label>
      ${sliders}
      <p class="editor-hint">The wheel glows and begins rotating over the page for Glow time, then keeps rotating as it flies to the corner over Flight time. Rotation speed also controls the corner wheel; 2× is the current speed. Visitors who have asked their device for reduced motion never see the intro.</p>
      <div class="editor-actions"><button type="submit">Save</button><button type="button" class="editor-add" data-intro-preview>Preview intro</button><span class="editor-status" role="status"></span></div>`;
    const status = form.querySelector(".editor-status");
    const say = (message, kind = "") => {
      status.textContent = message;
      status.className = `editor-status ${kind}`;
    };
    const chosenFile = (key) => form.querySelector(`[data-intro-file="${key}"]`).value;
    /* As saved: file names. */
    const values = () => {
      const chosen = { repeat: form.querySelector("[data-intro-repeat]").value };
      for (const [key] of INTRO_SOUND_ROWS) chosen[key] = chosenFile(key);
      for (const input of form.querySelectorAll("[data-intro]")) chosen[input.dataset.intro] = Number(input.value);
      return chosen;
    };
    /* As site.js plays them: addresses. */
    const soundUrl = (file) => (file ? `/sound/Intro/${encodeURIComponent(file)}` : "");
    const playable = () => {
      const chosen = values();
      for (const [key] of INTRO_SOUND_ROWS) chosen[key] = soundUrl(chosen[key]);
      return chosen;
    };

    function paint() {
      for (const label of form.querySelectorAll("[data-intro-label]")) {
        label.textContent = `${form.querySelector(`[data-intro="${label.dataset.introLabel}"]`).value}${label.dataset.unit}`;
      }
      const play = form.querySelector('[data-intro-play="sound"]');
      play.textContent = introPreview.paused ? "Play" : "Stop";
      play.disabled = !chosenFile("sound");
      introPreview.volume = values().volume / 100;
    }
    paintIntro = paint;

    form.addEventListener("input", paint);
    form.addEventListener("change", async (event) => {
      if (event.target.matches('[data-intro-file="sound"]')) {
        introPreview.pause();
        paint();
      }
      const key = event.target.dataset.introUpload;
      if (!key) return;
      const file = event.target.files[0];
      if (!file) return;
      const body = new FormData();
      body.append("sound", file);
      body.append("folder", "intro");
      say(`Uploading ${file.name}…`);
      try {
        const response = await fetch("/api/public/sounds", { method: "POST", body });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.message || "Upload failed");
        introSounds = result.sounds;
        publish = result.publish;
        showPublishState();
        /* Every list gains the file; the row it was uploaded from picks it. */
        for (const [row, , blank] of INTRO_SOUND_ROWS) {
          const select = form.querySelector(`[data-intro-file="${row}"]`);
          select.innerHTML = `<option value="">${blank}</option>${fileOptions(row === key ? result.file : select.value)}`;
        }
        introPreview.pause();
        paint();
        say(`${result.message}. Save to use it.`);
      } catch (error) {
        say(error.message, "error");
      } finally {
        event.target.value = "";
      }
    });
    form.addEventListener("click", (event) => {
      const play = event.target.closest("[data-intro-play]");
      if (play?.dataset.introPlay === "sound") {
        if (!introPreview.paused) {
          introPreview.pause();
          return;
        }
        introPreview.src = soundUrl(chosenFile("sound"));
        introPreview.currentTime = 0;
        introPreview.play().catch((error) => say(`Could not play that sound: ${error.message}`, "error"));
      } else if (play) {
        /* Through site.js, as the intro plays it: one thud, or a short riffle. */
        const kind = play.dataset.introPlay;
        const chosen = playable();
        const awake = introContext()?.resume();
        Promise.all([awake, introBuffer(chosen[kind])]).then(() => {
          for (let turn = 0; turn < (kind === "page" ? 6 : 1); turn += 1) introSound(kind, chosen, turn * 0.09);
        });
      }
      if (event.target.closest("[data-intro-preview]")) {
        introPreview.pause();
        playGrimoire(playable());
      }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      introPreview.pause();
      const submitted = values();
      try {
        if (!introNumbers.rotation_speed) throw new Error("Restart web.py, then reload the editor before saving rotation speed.");
        const result = await call("/api/public/intro", { intro: submitted });
        if (result.intro.chain !== submitted.chain) throw new Error("The chain sound was not saved. Reload the editor and try again.");
        if (result.intro.rotation_speed !== submitted.rotation_speed) throw new Error("Rotation speed was not saved. Restart web.py, then reload the editor and save again.");
        intro = result.intro;
        applyIntroRotationSpeed(intro.rotation_speed);
        publish = result.publish;
        showPublishState();
        say(`${result.message}${intro.chain ? `: ${intro.chain} selected for Chain unlock` : ": built-in chain rattle selected"}. Commit & push to publish it.`);
      } catch (error) {
        say(error.message, "error");
      }
    });
    app.append(form);
    introPreview.pause();
    paint();
  }

  /* ----------------------------------------------------------- mana sounds -- */

  /* The sound each colour's burst makes, on the home page under the intro:
     built in, none, or a file from sound/Mana, at its own volume. Changes
     reach the page's bursts as they are made (manaSounds in site.js); Test
     sets one off, and Save writes site/mana_sounds.json. */
  let manaSettings = null;
  let manaFiles = [];
  const MANA_ROWS = [["W", "White"], ["U", "Blue"], ["B", "Black"], ["R", "Red"], ["G", "Green"], ["C", "Colourless"]];
  const manaUrl = (sound) => (sound && sound !== "none" ? `/sound/Mana/${encodeURIComponent(sound)}` : sound);

  function mountManaEditor() {
    const [, kind] = window.location.hash.replace(/^#/, "").split("/");
    if (!loaded || !manaSettings || kind === "player" || kind === "deck" || app.querySelector(".mana-editor")) return;
    const options = (value) => `<option value=""${value === "" ? " selected" : ""}>Built in</option><option value="none"${value === "none" ? " selected" : ""}>None</option>`
      + manaFiles.map((sound) => `<option value="${escapeHtml(sound.file)}"${sound.file === value ? " selected" : ""}>${escapeHtml(sound.label)}</option>`).join("");
    const form = document.createElement("form");
    form.className = "card editor-card mana-editor";
    form.innerHTML = `<div class="section-heading"><div><span class="eyebrow">LOCAL EDITOR</span><h2>Mana sounds</h2></div><span class="muted">Saved to site/mana_sounds.json</span></div>
      ${MANA_ROWS.map(([color, label]) => `<div class="editor-field mana-sound-row" data-mana="${color}"><span><i class="ms ms-${color.toLowerCase()} ms-cost ms-shadow" aria-hidden="true"></i> ${label}</span>
        <div class="editor-sound"><select data-mana-sound>${options(manaSettings[color].sound)}</select>
        <div class="editor-volume"><input type="range" data-mana-volume min="0" max="100" step="5" value="${manaSettings[color].volume}"><output></output></div>
        <button type="button" class="editor-add" data-mana-test>Test</button></div></div>`).join("")}
      <p class="editor-hint">A burst a visitor sets off with a click or a touch plays its colour's sound; the ones that appear on their own stay silent. "Built in" is made by the site itself; other choices are the files in sound/Mana.
        <label class="editor-upload" title="Upload a sound from this computer into sound/Mana">Upload a sound<input type="file" data-mana-upload accept=".mp3,.wav,.ogg,.m4a,audio/*" hidden></label></p>
      <div class="editor-actions"><button type="submit">Save</button><span class="editor-status" role="status"></span></div>`;
    const status = form.querySelector(".editor-status");
    const say = (message, tone = "") => {
      status.textContent = message;
      status.className = `editor-status ${tone}`;
    };
    const values = () => Object.fromEntries([...form.querySelectorAll("[data-mana]")].map((row) => [row.dataset.mana, {
      sound: row.querySelector("[data-mana-sound]").value,
      volume: Number(row.querySelector("[data-mana-volume]").value),
    }]));
    /* The page's bursts follow the form as it changes. */
    const apply = () => {
      for (const [color, entry] of Object.entries(values())) {
        manaSounds[color] = { sound: manaUrl(entry.sound), volume: entry.volume };
        if (entry.sound && entry.sound !== "none") audioBuffer(manaSounds[color].sound);
      }
      for (const output of form.querySelectorAll(".mana-editor output")) output.textContent = `${output.previousElementSibling.value}%`;
    };
    form.addEventListener("input", apply);
    form.addEventListener("change", async (event) => {
      apply();
      if (!event.target.matches("[data-mana-upload]")) return;
      const file = event.target.files[0];
      if (!file) return;
      const body = new FormData();
      body.append("sound", file);
      body.append("folder", "mana");
      say(`Uploading ${file.name}…`);
      try {
        const response = await fetch("/api/public/sounds", { method: "POST", body });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.message || "Upload failed");
        manaFiles = result.sounds;
        publish = result.publish;
        showPublishState();
        for (const select of form.querySelectorAll("[data-mana-sound]")) {
          const chosen = select.value;
          select.innerHTML = options(chosen);
        }
        say(`${result.message}. Pick it for a colour, then Save.`);
      } catch (error) {
        say(error.message, "error");
      } finally {
        event.target.value = "";
      }
    });
    form.addEventListener("click", (event) => {
      const test = event.target.closest("[data-mana-test]");
      if (!test) return;
      const color = test.closest("[data-mana]").dataset.mana;
      apply();
      const box = test.getBoundingClientRect();
      /* A burst where the button is, which plays the sound itself; without
         the embers (reduced motion), just the sound. */
      if (reducedMotion.matches) playManaSound(color);
      else embers.burst(box.left + box.width / 2, box.top + box.height / 2, color, true);
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const result = await call("/api/public/mana-sounds", { sounds: values() });
        manaSettings = result.sounds;
        publish = result.publish;
        showPublishState();
        say(`${result.message}. Commit & push to publish them.`);
      } catch (error) {
        say(error.message, "error");
      }
    });
    app.append(form);
    apply();
  }

  async function refresh() {
    try {
      const result = await call("/api/public/roster");
      source = result.roster;
      pictures = result.pictures;
      sounds = result.sounds;
      intro = result.intro;
      introSounds = result.intro_sounds;
      introNumbers = result.intro_numbers;
      manaSettings = result.mana_sounds;
      manaFiles = result.mana_sound_files;
      showSiteVolume(result.settings.volume);
      publish = result.publish;
      loaded = true;
      showPublishState();
    } catch (error) {
      showPublishState(error.message, "error");
    }
  }

  /* Each panel on its own, so one that fails to draw leaves the others. */
  afterRender = () => {
    // Cancel pending previews even when the next page has no deck editor.
    soundPreview.pause();
    for (const mount of [mountEditor, mountIntroEditor, mountManaEditor]) {
      try {
        mount();
      } catch (error) {
        console.error(`The ${mount.name} panel could not be drawn`, error);
      }
    }
  };
  /* The first view is usually drawn before this returns. */
  refresh().then(afterRender);
  /* Results recorded from the table show up as unpublished without a reload. */
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) call("/api/public/roster").then((result) => { publish = result.publish; showPublishState(); }).catch(() => {});
  });
})();
