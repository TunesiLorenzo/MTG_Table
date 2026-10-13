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

buildResultRows();
$("#game-date").value = localDateValue();
render();
loadGames();
prefillCurrentPlayers();
