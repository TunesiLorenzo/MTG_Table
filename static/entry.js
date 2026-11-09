/* The entry subpage: record a game, add historical wins.
 *
 * Everything that types lives here so the leaderboard display can stay tilted.
 * Shares its data with that page through leaderboard-core.js, loaded first. */

const resultRows = $("#result-rows");
const gameForm = $("#game-form");
const historicalForm = $("#historical-form");

function buildResultRows() {
  resultRows.innerHTML = [1, 2, 3, 4].map((rank, index) => `
    <div class="result-row">
      <select class="rank-select" name="rank-${index}" aria-label="Player ${index + 1} ranking" required>
        ${[1, 2, 3, 4].map((value) => `<option value="${value}"${value === rank ? " selected" : ""}>#${value}</option>`).join("")}
      </select>
      <input class="player-input" name="player-${index}" list="player-suggestions" maxlength="40" placeholder="Player name" aria-label="Player ${index + 1} name" required>
      <input class="deck-input" name="deck-${index}" list="deck-suggestions" maxlength="80" placeholder="Deck name" aria-label="Player ${index + 1} deck" required>
    </div>`).join("");
}

function localDateValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function renderHistoricalWins() {
  const list = $("#historical-list");
  if (!historicalWins.length) {
    list.innerHTML = '<span class="muted">No historical totals added yet.</span>';
    return;
  }
  list.innerHTML = [...historicalWins]
    .sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name))
    .map((entry) => `<span class="historical-entry"><span>${escapeHtml(entry.name)} · <strong>${entry.wins} win${entry.wins === 1 ? "" : "s"}</strong></span><button class="delete-historical" type="button" data-delete-historical="${escapeHtml(entry.id)}" aria-label="Remove historical wins for ${escapeHtml(entry.name)}">Remove</button></span>`)
    .join("");
}

/* A short archive so a mistyped result can be undone here, rather than by
   reaching over to a display that is turned on its side. */
function renderRecent() {
  const list = $("#recent-list");
  const shown = games.slice(0, 8);
  $("#recent-count").textContent = `${games.length} game${games.length === 1 ? "" : "s"} recorded`;
  if (!shown.length) {
    list.innerHTML = '<div class="empty">No games recorded yet.</div>';
    return;
  }
  list.innerHTML = shown.map((game) => {
    const results = [...game.players].sort((a, b) => a.rank - b.rank);
    const winner = results[0];
    const summary = game.outcome === "draw"
      ? `Draw: ${results.filter((result) => result.rank === 1).map((result) => result.name).join(" & ")}`
      : `${winner.name} · ${winner.deck}`;
    return `<div class="recent-row">
      <span class="recent-date">${escapeHtml(formatDate(game.date))}</span>
      <span class="recent-winner">${escapeHtml(summary)}</span>
      <button class="delete-game" type="button" data-delete-game="${escapeHtml(game.id)}">Remove</button>
    </div>`;
  }).join("");
}

render = function () {
  const stats = aggregate();
  renderHistoricalWins();
  renderRecent();
  const playerNames = [...new Set(stats.players.map((player) => player.name))].sort();
  const deckNames = [...new Set(stats.decks.map((deck) => deck.name))].sort();
  $("#player-suggestions").innerHTML = playerNames.map((name) => `<option value="${escapeHtml(name)}">`).join("");
  $("#deck-suggestions").innerHTML = deckNames.map((name) => `<option value="${escapeHtml(name)}">`).join("");
};

async function prefillCurrentPlayers() {
  try {
    const response = await fetch("/api/table", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok || !result.ok || !Array.isArray(result.players)) return;
    document.querySelectorAll(".player-input").forEach((input, index) => {
      if (result.players[index] && !input.value) input.value = result.players[index].name;
    });
  } catch (_) { /* Entry remains fully usable without tracker names. */ }
}

gameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = gameForm.querySelector("button[type='submit']");
  const players = [...document.querySelectorAll(".result-row")].map((row) => ({
    rank: Number(row.querySelector(".rank-select").value),
    name: row.querySelector(".player-input").value,
    deck: row.querySelector(".deck-input").value,
  }));
  button.disabled = true;
  button.textContent = "Saving result…";
  try {
    const response = await fetch("/api/games", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date: $("#game-date").value, players }) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "Could not save game");
    games.unshift(result.game);
    games.sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));
    // A saved game clears the decks but keeps the players: the same four sit
    // there all evening, and the next result is usually the next game.
    resultRows.querySelectorAll(".deck-input").forEach((input) => { input.value = ""; });
    render();
    showStatus(result.message, "success");
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Save game result";
  }
});

historicalForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = historicalForm.querySelector("button[type='submit']");
  const name = $("#historical-player").value;
  const wins = Number($("#historical-count").value);
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const response = await fetch("/api/historical-wins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, wins }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "Could not save historical wins");
    historicalWins = historicalWins.filter((entry) =>
      entry.id !== result.historical_wins.id &&
      entry.name.toLocaleLowerCase() !== result.historical_wins.name.toLocaleLowerCase());
    historicalWins.push(result.historical_wins);
    historicalForm.reset();
    render();
    showStatus(result.message, "success");
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Save historical wins";
  }
});

$("#historical-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-historical]");
  if (!button) return;
  const entry = historicalWins.find((item) => item.id === button.dataset.deleteHistorical);
  if (!entry || !window.confirm(`Remove ${entry.wins} historical win${entry.wins === 1 ? "" : "s"} for ${entry.name}?`)) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/historical-wins/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "Could not remove historical wins");
    historicalWins = historicalWins.filter((item) => item.id !== entry.id);
    render();
    showStatus(result.message, "success");
  } catch (error) {
    button.disabled = false;
    showStatus(error.message, "error");
  }
});

$("#recent-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-game]");
  if (!button) return;
  const game = games.find((item) => item.id === button.dataset.deleteGame);
  if (!game || !window.confirm(`Remove the game from ${formatDate(game.date)}? This changes all leaderboard statistics.`)) return;
  button.disabled = true;
  try {
    showStatus(await deleteGame(game.id), "success");
  } catch (error) {
    button.disabled = false;
    showStatus(error.message, "error");
  }
});

/* Importing the phone tracker's games: the server sorts each one into new,
   a correction, already imported and so on (plan_game_import in web.py);
   this shows that plan and sends back the ids that are ticked. */
const importInput = $("#import-file");
const importPreview = $("#import-preview");
const IMPORTABLE = ["new", "correction", "match"];
const IMPORT_LABELS = {
  new: "New",
  correction: "Correction",
  match: "Recorded by hand?",
  imported: "Already imported",
  superseded: "Replaced by a later correction",
  repeat: "Repeated in the file",
  invalid: "Not a valid game",
};
let importItems = null;
let importPlan = null;

function importPlayers(game) {
  return [...game.players].sort((a, b) => a.rank - b.rank)
    .map((player) => `<span class="import-player"><b>#${player.rank}</b> ${escapeHtml(player.name)} <span class="muted">${escapeHtml(player.deck)}</span></span>`)
    .join("");
}

function importNote(entry) {
  if (entry.status === "correction") {
    const old = games.find((game) => game.id === entry.replaces);
    return `Replaces the saved game from ${escapeHtml(formatDate(old ? old.date : entry.date))}`;
  }
  if (entry.status === "match") return "Same date, players, decks and ranks as a game already saved, so it is left unticked";
  if (entry.status === "invalid") return escapeHtml(entry.message || "");
  return "";
}

function importRow(entry, selectable) {
  const note = importNote(entry);
  const body = `
    <span class="recent-date">${escapeHtml(entry.date ? formatDate(entry.date) : "No date")}</span>
    <span class="import-players">${entry.game ? importPlayers(entry.game) : ""}${note ? `<span class="import-note">${note}</span>` : ""}</span>
    <span class="import-badge import-${entry.status}">${IMPORT_LABELS[entry.status] || entry.status}</span>`;
  return selectable
    ? `<label class="import-row"><input type="checkbox" data-import-id="${escapeHtml(entry.id)}"${entry.status === "match" ? "" : " checked"}>${body}</label>`
    : `<div class="import-row is-skipped"><span></span>${body}</div>`;
}

function renderImportPreview() {
  const entries = importPlan.entries;
  const ready = entries.filter((entry) => IMPORTABLE.includes(entry.status));
  const skipped = entries.filter((entry) => !IMPORTABLE.includes(entry.status));
  const imported = skipped.filter((entry) => entry.status === "imported").length;
  const total = `${entries.length} game${entries.length === 1 ? "" : "s"} in the file`;
  const decks = importPlan.new_decks;
  importPreview.hidden = false;
  importPreview.innerHTML = `
    <p class="import-heading"><strong>${total}</strong> · ${ready.length} to import · ${imported} already imported${skipped.length > imported ? ` · ${skipped.length - imported} skipped` : ""}</p>
    ${ready.length
      ? `<div class="import-list">${ready.map((entry) => importRow(entry, true)).join("")}</div>`
      : '<div class="empty import-empty">Nothing new to import: every game in the file is already on the leaderboard.</div>'}
    ${decks.length && ready.length ? `<label class="import-decks"><input type="checkbox" id="import-add-decks" checked>
      Also add ${decks.length === 1 ? "a new deck" : `${decks.length} new decks`} to the roster: ${decks.map((deck) => escapeHtml(deck.name)).join(", ")}</label>` : ""}
    ${skipped.length ? `<details class="import-skipped"><summary>Show the ${skipped.length} left out</summary>
      <div class="import-list">${skipped.map((entry) => importRow(entry, false)).join("")}</div></details>` : ""}
    ${ready.length ? '<button type="button" class="submit-button" id="import-submit"></button>' : ""}`;
  updateImportButton();
}

function chosenImports() {
  return [...importPreview.querySelectorAll("[data-import-id]:checked")].map((box) => box.dataset.importId);
}

function updateImportButton() {
  const button = $("#import-submit");
  if (!button) return;
  const count = chosenImports().length;
  button.disabled = !count;
  button.textContent = count ? `Import ${count} game${count === 1 ? "" : "s"}` : "Tick a game to import";
}

async function previewImport() {
  const response = await fetch("/api/games/import", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: importItems }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.message || "Could not read the file");
  importPlan = result;
  renderImportPreview();
}

importInput.addEventListener("change", async () => {
  const files = [...importInput.files];
  importPreview.hidden = true;
  importItems = null;
  if (!files.length) return;
  try {
    importItems = await Promise.all(files.map(async (file) => {
      try {
        return JSON.parse(await file.text());
      } catch (_) {
        throw new Error(`${file.name} is not a valid JSON file`);
      }
    }));
    await previewImport();
  } catch (error) {
    showStatus(error.message, "error");
  }
});

importPreview.addEventListener("change", (event) => {
  if (event.target.matches("[data-import-id]")) updateImportButton();
});

importPreview.addEventListener("click", async (event) => {
  const button = event.target.closest("#import-submit");
  if (!button) return;
  const ids = chosenImports();
  if (!ids.length) return;
  const addDecks = $("#import-add-decks");
  button.disabled = true;
  button.textContent = "Importing…";
  try {
    const response = await fetch("/api/games/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: importItems, import: ids, add_decks: addDecks ? addDecks.checked : false }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "Could not import the games");
    await loadGames();
    // Previewed again, the games just added now show as already imported.
    await previewImport();
    showStatus(result.message, "success");
  } catch (error) {
    showStatus(error.message, "error");
    updateImportButton();
  }
});

/* The Drive inbox: the server imports and publishes what is new in it every
   few minutes (sync_drive_inbox in web.py), and once more as this page opens.
   Review inbox loads it into the preview above, to pick games by hand. */
const driveStatus = $("#drive-sync-status");
const driveHint = $("#drive-sync-hint");
const driveButton = $("#drive-sync-button");
const driveReviewButton = $("#drive-review-button");

function clockTime(iso) {
  const when = iso ? new Date(iso) : null;
  if (!when || Number.isNaN(when.getTime())) return "";
  const today = when.toDateString() === new Date().toDateString();
  return when.toLocaleString([], today ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function renderDriveSync(sync, problem = "") {
  const lines = [];
  if (!sync || !sync.enabled) {
    lines.push("Automatic import from the Drive inbox is off (MTG_DRIVE_SYNC=0).");
    driveHint.textContent = "From the Drive inbox (mtg_games.json) or a downloaded game";
  } else {
    const checked = clockTime(sync.checked_at);
    const error = problem || sync.error;
    lines.push(error
      ? `<span class="is-warning">Could not check the Drive inbox: ${escapeHtml(error)}</span>`
      : checked ? `Drive inbox checked at <strong>${checked}</strong>` : "Drive inbox not checked yet");
    if (sync.last_import) lines.push(`Last import ${clockTime(sync.last_import.at)}: ${escapeHtml(sync.last_import.message)}`);
    if (sync.publish_error) lines.push(`<span class="is-warning">Not on the public site yet: ${escapeHtml(sync.publish_error)}. Tried again on the next check.</span>`);
    else if (sync.published_at) lines.push(`Published to the site at ${clockTime(sync.published_at)}`);
    if (sync.waiting) lines.push(`<span class="is-warning">${sync.waiting} game${sync.waiting === 1 ? " has" : "s have"} the same result as one typed in by hand, so ${sync.waiting === 1 ? "it was" : "they were"} left out. Review the inbox to add ${sync.waiting === 1 ? "it" : "them"} anyway.</span>`);
    driveHint.textContent = error ? "Drive inbox: could not check" : checked ? `Drive inbox imported automatically · checked ${checked}` : "Drive inbox imported automatically";
  }
  driveStatus.innerHTML = lines.map((line) => `<span>${line}</span>`).join("");
}

async function checkDriveInbox() {
  driveButton.disabled = true;
  driveButton.textContent = "Checking…";
  try {
    const response = await fetch("/api/games/drive-sync", { method: "POST" });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      const status = await fetch("/api/games/drive-sync").then((answer) => answer.json()).catch(() => null);
      renderDriveSync(status && status.sync, result.message || "Unexpected error");
      return;
    }
    renderDriveSync(result.sync);
    if (result.imported) {
      await loadGames();
      if (importItems) await previewImport();
      showStatus(result.message, result.sync.publish_error ? "error" : "success");
    }
  } catch (error) {
    renderDriveSync(null, error.message);
  } finally {
    driveButton.disabled = false;
    driveButton.textContent = "Check now";
  }
}

driveButton.addEventListener("click", checkDriveInbox);
driveReviewButton.addEventListener("click", async () => {
  driveReviewButton.disabled = true;
  driveReviewButton.textContent = "Loading…";
  try {
    const response = await fetch("/api/games/drive-inbox");
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "Could not load the Drive inbox");
    importInput.value = "";
    importItems = [result.inbox];
    await previewImport();
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    driveReviewButton.disabled = false;
    driveReviewButton.textContent = "Review inbox";
  }
});

buildResultRows();
$("#game-date").value = localDateValue();
render();
loadGames();
prefillCurrentPlayers();
checkDriveInbox();
