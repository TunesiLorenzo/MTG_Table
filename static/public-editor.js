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
      ${field === "cards" ? '<button type="button" class="editor-remove" data-remove-card title="Remove this card">&times;</button>' : ""}</div></div>`;
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
           ${pictureField("art", "Art", entry.art || "", "No art")}
           <div class="editor-cards">${(entry.cards || []).map((card) => pictureField("cards", "Card", card, "No card")).join("")}</div>
           <button type="button" class="editor-add" data-add-card>+ Add a commander card</button>`
        : `${pictureField("portrait", "Portrait", entry.portrait || "", "Initial only")}
           ${pictureField("background", "Background", entry.background || "", "Art of the most played deck")}`}
      <div class="editor-actions"><button type="submit">Save</button><span class="editor-status" role="status"></span></div>`;

    form.addEventListener("change", (event) => {
      if (!event.target.matches(".editor-picture select")) return;
      const preview = event.target.parentElement.querySelector("img");
      preview.hidden = !event.target.value;
      if (event.target.value) preview.src = `/${encodeURI(event.target.value)}`;
    });
    form.addEventListener("click", (event) => {
      if (event.target.closest("[data-add-card]")) form.querySelector(".editor-cards").insertAdjacentHTML("beforeend", pictureField("cards", "Card", "", "No card"));
      const remove = event.target.closest("[data-remove-card]");
      if (remove) remove.closest(".editor-field").remove();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const picked = (field) => [...form.querySelectorAll(`[data-picture="${field}"] select`)].map((select) => select.value).filter(Boolean);
      const edited = group === "decks"
        ? { commander: form.elements.commander.value, art: picked("art")[0] || "", cards: picked("cards") }
        : { portrait: picked("portrait")[0] || "", background: picked("background")[0] || "" };
      const status = form.querySelector(".editor-status");
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
  }

  async function refresh() {
    try {
      const result = await call("/api/public/roster");
      source = result.roster;
      pictures = result.pictures;
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
