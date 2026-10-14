/* The leaderboard display: summary tiles, charts, standings, archive.
 *
 * Read-only apart from removing a game. Recording results lives on
 * /leaderboard/entry, which stays upright while this page sits tilted on the
 * table screen. Shares its data with that page through leaderboard-core.js,
 * which must be loaded first. */

function renderSummary(stats) {
  const champion = stats.players[0];
  const strongest = stats.decks[0];
  const mostPlayed = [...stats.decks].sort((a, b) => b.games - a.games || b.wins - a.wins)[0];
  const cards = [
    ["GAMES RECORDED", games.length, games.length === 1 ? "match in the archive" : "matches in the archive"],
    ["MOST WINS", champion ? champion.name : "—", champion ? `${champion.detailedWins} recorded win${champion.detailedWins === 1 ? "" : "s"}${champion.historicalWins ? ` · ${champion.historicalWins} historical` : ""}` : "No results yet"],
    ["STRONGEST DECK", strongest ? strongest.name : "—", strongest ? `${[...strongest.players].sort().join(", ")} · ${strongest.wins} wins · ${Math.round(strongest.wins / strongest.games * 100)}% rate` : "No results yet"],
    ["MOST PLAYED DECK", mostPlayed ? mostPlayed.name : "—", mostPlayed ? `${[...mostPlayed.players].sort().join(", ")} · ${mostPlayed.games} appearance${mostPlayed.games === 1 ? "" : "s"}` : "No results yet"],
  ];
  $("#summary-grid").innerHTML = cards.map(([label, value, detail]) => `<article class="summary"><span class="eyebrow">${escapeHtml(label)}</span><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></article>`).join("");
}

function renderChart(target, entries, kind) {
  const container = $(target);
  container.classList.toggle("deck-bars", kind === "deck");
  if (!entries.length) {
    container.innerHTML = '<div class="empty">Add the first game to start this chart.</div>';
    return;
  }
  const shown = entries.slice(0, 7);
  const maximum = Math.max(...shown.map((entry) => entry.wins), 1);
  container.innerHTML = shown.map((entry) => {
    const winRate = entry.games ? Math.round((entry.detailedWins ?? entry.wins) / entry.games * 100) : null;
    const width = entry.wins ? Math.max(8, entry.wins / maximum * 100) : 3;
    const detail = kind === "player"
      ? `${entry.wins} win${entry.wins === 1 ? "" : "s"}${entry.historicalWins ? ` · ${entry.historicalWins} historical` : ""}`
      : `${entry.wins}W${winRate === null ? "" : ` · ${winRate}%`}`;
    const players = kind === "deck" ? [...entry.players].sort().join(", ") : "";
    const label = kind === "deck"
      ? `<span class="bar-label deck-label" title="${escapeHtml(`${entry.name} — ${players}`)}"><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(players)}</small></span>`
      : `<span class="bar-label" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>`;
    return `<div class="bar-item">${label}<span class="bar-track"><span class="bar-fill" style="--width:${width}%"></span></span><span class="bar-value">${detail}</span></div>`;
  }).join("");
}

function renderStandings(players) {
  const body = $("#standings-body");
  if (!players.length) {
    body.innerHTML = '<tr><td colspan="8"><div class="empty">Standings appear after the first recorded game.</div></td></tr>';
    return;
  }
  body.innerHTML = players.map((player, index) => `<tr>
    <td>${index + 1}</td>
    <td class="player-cell"><strong>${escapeHtml(player.name)}</strong><small>${player.decks.size} recorded deck${player.decks.size === 1 ? "" : "s"}</small></td>
    <td>${player.games || "—"}</td><td>${player.detailedWins}</td><td class="legacy-cell">${player.historicalWins || "—"}</td><td>${player.games ? `${Math.round(player.detailedWins / player.games * 100)}%` : "—"}</td>
    <td>${player.games ? player.topTwos : "—"}</td><td>${player.games ? (player.rankTotal / player.games).toFixed(2) : "—"}</td>
  </tr>`).join("");
}

function renderHistory() {
  $("#history-count").textContent = `${games.length} game${games.length === 1 ? "" : "s"}`;
  const list = $("#history-list");
  if (!games.length) {
    list.innerHTML = '<div class="empty">No games recorded yet. Record the first result from the entry page.</div>';
    return;
  }
  list.innerHTML = games.map((game) => {
    const results = [...game.players].sort((a, b) => a.rank - b.rank);
    const winner = results[0];
    const isDraw = game.outcome === "draw";
    const headline = isDraw
      ? `Draw: ${results.filter((result) => result.rank === 1).map((result) => result.name).join(" & ")}`
      : `${winner.name} won with ${winner.deck}`;
    return `<article class="game-card" data-game-id="${escapeHtml(game.id)}">
      <div class="game-head"><div><span class="game-date">${escapeHtml(formatDate(game.date))}</span><span class="game-winner">${escapeHtml(headline)}</span></div><button class="delete-game" type="button" data-delete-game="${escapeHtml(game.id)}">Remove</button></div>
      <div class="game-results">${results.map((result) => `<div class="game-player${result.rank === 1 ? " is-winner" : ""}"><span class="place">#${result.rank}${result.rank === 1 ? (isDraw ? " · DRAW" : " · WINNER") : ""}</span><strong>${escapeHtml(result.name)}</strong><small title="${escapeHtml(result.deck)}">${escapeHtml(result.deck)}</small></div>`).join("")}</div>
    </article>`;
  }).join("");
}

render = function () {
  const stats = aggregate();
  renderSummary(stats);
  // The chart is all-time wins, so it keeps its own order by the total.
  renderChart("#player-chart", [...stats.players].sort((a, b) => b.wins - a.wins), "player");
  renderChart("#deck-chart", stats.decks, "deck");
  renderStandings(stats.players);
  renderHistory();
};

$("#history-list").addEventListener("click", async (event) => {
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

/* Page rotation cycles 0 -> 90 -> 180 -> 270 so the leaderboard can face any
   side of the table. The initial value is applied by the inline script in
   leaderboard.html; this only advances and remembers it. The entry page has no
   rotation frame at all, so it is unaffected by whatever is set here. */
const ROTATION_STORAGE_KEY = "mtg-leaderboard-rotation";

$("#rotate-page").addEventListener("click", () => {
  const rotation = (Number(document.documentElement.dataset.rot || 0) + 90) % 360;
  document.documentElement.dataset.rot = rotation;
  document.documentElement.style.setProperty("--page-rot", `${rotation}deg`);
  localStorage.setItem(ROTATION_STORAGE_KEY, String(rotation));
  $("#rotate-stage").scrollTop = 0;
});

render();
loadGames();

/* The display is left open on the table all evening while results are entered
   from a phone, so it picks up changes on its own rather than waiting to be
   reloaded. */
window.setInterval(loadGames, 20000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadGames();
});
