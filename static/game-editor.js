/* Correcting a saved game, and publishing the results to the public site.
 *
 * Shared by the leaderboard and its entry page. Loaded after
 * leaderboard-core.js, whose `games`, `render`, `showStatus` and helpers it
 * uses. Any element with data-edit-game="<id>" opens the editor for that game;
 * an element with data-publish-results becomes the Publish button, shown only
 * while the site is missing results.
 *
 * The editor lays each player out as a column, so the four sit side by side
 * like the stats table under the game. Everything the tracker saved can be
 * corrected: date, result, decks, and every statistic. A game keeps its id
 * when edited, so the Drive inbox never brings back the uncorrected copy. */

const GameEditor = (() => {
  /* The tracker's statistics, in the order the stats table shows them.
     `clock` fields are seconds, typed as m:ss. */
  const STAT_FIELDS = [
    { key: "play_seconds", label: "Play time", clock: true },
    { key: "turns", label: "Turns" },
    { key: "longest_turn_seconds", label: "Longest turn", clock: true },
    { key: "damage_dealt", label: "Damage dealt" },
    { key: "commander_damage_dealt", label: "Commander damage" },
    { key: "biggest_hit", label: "Biggest hit" },
    { key: "poison_dealt", label: "Poison given" },
    { key: "life_gained", label: "Life gained" },
    { key: "damage_taken", label: "Damage taken" },
    { key: "lowest_life", label: "Lowest life", negative: true },
    { key: "eliminations", label: "Eliminations" },
  ];

  let dialog = null;
  let editing = null;

  function clockText(seconds) {
    if (!Number.isFinite(seconds)) return "";
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor(s % 3600 / 60);
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  /* "12:30" or "1:02:30" is a clock; a bare number is minutes. Blank is
     nothing; anything else is NaN, which the form marks as wrong. */
  function parseClock(text) {
    const value = text.trim();
    if (!value) return null;
    if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 60);
    const match = value.match(/^(?:(\d+):)?(\d{1,3}):(\d{1,2})$/);
    if (!match || Number(match[3]) > 59) return NaN;
    return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }

  function parseCount(text, negative) {
    const value = text.trim();
    if (!value) return null;
    if (!(negative ? /^-?\d+$/ : /^\d+$/).test(value)) return NaN;
    return Number(value);
  }

  function build() {
    dialog = document.createElement("dialog");
    dialog.id = "game-editor";
    dialog.className = "game-editor";
    dialog.setAttribute("aria-labelledby", "game-editor-title");
    dialog.innerHTML = `<form method="dialog" novalidate>
      <header class="editor-head">
        <div><span class="eyebrow">CORRECT A GAME</span><h2 id="game-editor-title">Edit game</h2></div>
        <button type="button" class="editor-close" data-editor-cancel aria-label="Close without saving">&times;</button>
      </header>
      <div class="editor-meta">
        <label>Date<input type="date" name="date" required></label>
        <label>Result<select name="outcome"><option value="win">Win</option><option value="draw">Draw</option></select></label>
        <label>Game length<input name="duration" inputmode="numeric" placeholder="m:ss" autocomplete="off"></label>
        <label>Starting life<input name="starting_life" inputmode="numeric" placeholder="40" autocomplete="off"></label>
      </div>
      <div class="table-wrap editor-table-wrap"><table class="editor-table"><tbody></tbody></table></div>
      <p class="editor-note">Times are m:ss (a plain number is minutes). Leave a stat blank if it is unknown.</p>
      <p class="editor-error" role="alert" hidden></p>
      <footer class="editor-actions">
        <button type="button" class="is-quiet" data-editor-cancel>Cancel</button>
        <button type="submit" class="is-quiet" value="save">Save</button>
        <button type="submit" value="publish">Save &amp; publish</button>
      </footer>
      <datalist id="game-editor-names"></datalist>
    </form>`;
    document.body.append(dialog);
    const form = dialog.querySelector("form");
    dialog.querySelectorAll("[data-editor-cancel]").forEach((button) => button.addEventListener("click", () => dialog.close()));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      save(event.submitter && event.submitter.value === "publish");
    });
    // A corrected field stops being marked wrong as soon as it is touched.
    form.addEventListener("input", (event) => event.target.classList.remove("is-invalid"));
    // Player names feed the "Out to" suggestions as they change.
    form.addEventListener("change", (event) => {
      if (event.target.matches("[data-field='name']")) fillNameSuggestions();
    });
  }

  function fillNameSuggestions() {
    const names = [...dialog.querySelectorAll("[data-field='name']")].map((input) => input.value.trim()).filter(Boolean);
    dialog.querySelector("#game-editor-names").innerHTML = names.map((name) => `<option value="${escapeHtml(name)}">`).join("");
  }

  function cell(index, field, value, attributes = "") {
    return `<td><input data-player="${index}" data-field="${field}" value="${escapeHtml(value ?? "")}" autocomplete="off" ${attributes}></td>`;
  }

  function open(game) {
    if (!dialog) build();
    editing = game;
    const form = dialog.querySelector("form");
    form.elements.date.value = game.date;
    form.elements.outcome.value = game.outcome === "draw" ? "draw" : "win";
    form.elements.duration.value = clockText(game.duration_seconds);
    form.elements.starting_life.value = game.starting_life ?? "";
    dialog.querySelector("#game-editor-title").textContent = `Game of ${formatDate(game.date)}`;
    const players = game.players;
    const stat = (player, key) => player.stats ? player.stats[key] : undefined;
    const rows = [
      `<tr class="editor-names"><th scope="row">Player</th>${players.map((p, i) => cell(i, "name", p.name, 'maxlength="40" required')).join("")}</tr>`,
      `<tr><th scope="row">Deck</th>${players.map((p, i) => cell(i, "deck", p.deck, 'maxlength="80" required list="deck-suggestions"')).join("")}</tr>`,
      `<tr><th scope="row">Finish</th>${players.map((p, i) => `<td><select data-player="${i}" data-field="rank">${[1, 2, 3, 4].map((rank) => `<option value="${rank}"${rank === p.rank ? " selected" : ""}>#${rank}</option>`).join("")}</select></td>`).join("")}</tr>`,
      `<tr class="editor-section"><th colspan="${players.length + 1}">Statistics</th></tr>`,
      ...STAT_FIELDS.map((field) => `<tr><th scope="row">${escapeHtml(field.label)}</th>${players.map((p, i) => {
        const value = stat(p, field.key);
        return cell(i, field.key, field.clock ? clockText(value) : value,
          `inputmode="${field.negative ? "text" : "numeric"}"${field.clock ? ' placeholder="m:ss"' : ""}`);
      }).join("")}</tr>`),
      `<tr><th scope="row">Out to</th>${players.map((p, i) => cell(i, "eliminated_by", stat(p, "eliminated_by"), 'maxlength="40" list="game-editor-names" placeholder="—"')).join("")}</tr>`,
    ];
    dialog.querySelector(".editor-table tbody").innerHTML = rows.join("");
    fillNameSuggestions();
    showError("");
    dialog.showModal();
  }

  function showError(message) {
    const box = dialog.querySelector(".editor-error");
    box.hidden = !message;
    box.textContent = message;
  }

  /* The edited game as the server wants it, or null with the wrong fields
     marked. Stats a player never had stay absent unless typed in. */
  function collect() {
    const form = dialog.querySelector("form");
    const wrong = [];
    const mark = (input) => { input.classList.add("is-invalid"); wrong.push(input); };
    const payload = { date: form.elements.date.value, outcome: form.elements.outcome.value };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) mark(form.elements.date);
    const duration = parseClock(form.elements.duration.value);
    if (Number.isNaN(duration)) mark(form.elements.duration);
    else if (duration) payload.duration_seconds = duration;
    const life = parseCount(form.elements.starting_life.value, false);
    if (Number.isNaN(life) || life === 0 || life > 1000) mark(form.elements.starting_life);
    else if (life !== null) payload.starting_life = life;

    payload.players = editing.players.map((_, index) => {
      const input = (field) => dialog.querySelector(`[data-player="${index}"][data-field="${field}"]`);
      const player = { name: input("name").value.trim(), deck: input("deck").value.trim(), rank: Number(input("rank").value) };
      if (!player.name) mark(input("name"));
      if (!player.deck) mark(input("deck"));
      const stats = {};
      for (const field of STAT_FIELDS) {
        const box = input(field.key);
        const value = field.clock ? parseClock(box.value) : parseCount(box.value, field.negative);
        if (Number.isNaN(value)) mark(box);
        else if (value !== null) stats[field.key] = value;
      }
      const by = input("eliminated_by").value.trim();
      if (by) stats.eliminated_by = by;
      if (Object.keys(stats).length) player.stats = stats;
      return player;
    });
    if (wrong.length) {
      wrong[0].focus();
      showError("Fix the marked fields: times are m:ss, the rest whole numbers.");
      return null;
    }
    return payload;
  }

  async function save(publishAfter) {
    const payload = collect();
    if (!payload) return;
    const buttons = dialog.querySelectorAll("button");
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const response = await fetch(`/api/games/${encodeURIComponent(editing.id)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || "Could not save the game");
      games = games.map((game) => game.id === result.game.id ? result.game : game);
      render();
      dialog.close();
      showStatus(result.message, "success");
      if (publishAfter) await publish();
      else refreshPublish();
    } catch (error) {
      showError(error.message);
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  /* ------------------------------------------------------------ publish -- */
  const publishButtons = () => document.querySelectorAll("[data-publish-results]");

  /* Always in view where git is available, so it is clear whether the site
     has the latest results: "Publish results" while it does not, a quiet
     "Site up to date" once it does. */
  function showPublish(state) {
    publishButtons().forEach((button) => {
      const pending = Boolean(state && (state.changed || state.unpushed));
      button.hidden = !state;
      button.disabled = !pending;
      button.classList.toggle("is-published", !pending);
      button.textContent = pending ? button.dataset.pendingLabel : "✓ Site up to date";
      button.title = pending ? "Commit the results and push them to the public site" : "The public site has every result";
    });
  }
  publishButtons().forEach((button) => { button.dataset.pendingLabel = button.textContent; });

  async function refreshPublish() {
    if (!publishButtons().length) return;
    try {
      const response = await fetch("/api/games/publish", { cache: "no-store" });
      const result = await response.json();
      showPublish(result.ok ? result.publish : null);
    } catch {
      showPublish(null);
    }
  }

  async function publish() {
    publishButtons().forEach((button) => { button.disabled = true; button.textContent = "Publishing…"; });
    showStatus("Publishing the results…");
    try {
      const response = await fetch("/api/games/publish", { method: "POST" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || "Could not publish");
      showStatus(result.message, "success");
      showPublish(result.publish);
    } catch (error) {
      showStatus(`Saved, but not published: ${error.message}`, "error");
      refreshPublish();
    }
  }

  document.addEventListener("click", (event) => {
    const edit = event.target.closest("[data-edit-game]");
    if (edit) {
      const game = games.find((item) => item.id === edit.dataset.editGame);
      if (game) open(game);
      return;
    }
    if (event.target.closest("[data-publish-results]")) publish();
  });

  refreshPublish();
  // Other changes (a removed game, a Drive import) can need publishing too.
  window.setInterval(refreshPublish, 30000);

  return { open, publish, refreshPublish };
})();
