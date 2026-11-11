/* The leaderboard display: summary tiles, charts, standings, archive.
 *
 * Read-only apart from correcting or removing a game (the editor is
 * static/game-editor.js, shared with the entry page). Recording results lives on
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
  // The page reloads the games every 20 seconds: a game's stats left open
  // stay open through it.
  const open = new Set([...list.querySelectorAll(".game-stats[open]")].map((panel) => panel.closest("[data-game-id]").dataset.gameId));
  list.innerHTML = games.map((game) => {
    const results = [...game.players].sort((a, b) => a.rank - b.rank);
    const winner = results[0];
    const isDraw = game.outcome === "draw";
    const headline = isDraw
      ? `Draw: ${results.filter((result) => result.rank === 1).map((result) => result.name).join(" & ")}`
      : `${winner.name} won with ${winner.deck}`;
    return `<article class="game-card" data-game-id="${escapeHtml(game.id)}">
      <div class="game-head"><div><span class="game-date">${escapeHtml(formatDate(game.date))}</span><span class="game-winner">${escapeHtml(headline)}</span>${game.edited_at ? '<span class="game-edited" title="Corrected after it was recorded">edited</span>' : ""}</div><div class="game-actions"><button class="edit-game" type="button" data-edit-game="${escapeHtml(game.id)}">Edit</button><button class="delete-game" type="button" data-delete-game="${escapeHtml(game.id)}">Remove</button></div></div>
      <div class="game-results">${results.map((result) => `<div class="game-player${result.rank === 1 ? " is-winner" : ""}"><span class="place">#${result.rank}${result.rank === 1 ? (isDraw ? " · DRAW" : " · WINNER") : ""}</span><strong>${escapeHtml(result.name)}</strong><small title="${escapeHtml(result.deck)}">${escapeHtml(result.deck)}</small></div>`).join("")}</div>
      ${gameStatsPanel(game)}
    </article>`;
  }).join("");
  list.querySelectorAll("[data-game-id]").forEach((card) => {
    const panel = card.querySelector(".game-stats");
    if (panel && open.has(card.dataset.gameId)) panel.open = true;
  });
}

/* ------------------------------------------------------------ statistics --
   What the life tracker saved with each game: the awards, records and
   averages come from js/game-stats.js, shared with the tracker and the
   public site. A game recorded without them simply has none. */

/* Optional: should game-stats.js fail to load, the statistics are left out
   and the rest of the leaderboard still draws. */
const GS = window.GameStats || null;
const statIcon = (name) => GS.icon(name, "stat-icon");
const names = (list) => list.map((p) => escapeHtml(p.name)).join(" &amp; ");

/* One game's awards and every player's numbers, folded away under the result. */
function gameStatsPanel(game) {
  const summary = GS && GS.gameSummary(game);
  if (!summary) return "";
  const tops = GS.leaders(summary.players);
  const facts = [
    summary.durationSeconds ? `${GS.clock(summary.durationSeconds)} game` : "",
    GS.plural(summary.turns, "turn", "turns"),
    GS.plural(summary.eliminations, "elimination", "eliminations"),
  ].filter(Boolean).join(" · ");
  const awards = summary.awards.length
    ? `<ul class="award-list">${summary.awards.map((entry) => `<li title="${escapeHtml(entry.award.note)}">${statIcon(entry.award.icon)}<span><b>${escapeHtml(entry.award.title)}</b><strong>${names(entry.winners)}</strong><small>${escapeHtml(entry.value)}</small></span></li>`).join("")}</ul>`
    : "";
  const rows = summary.players.map((p) => `<tr>
    <td>${p.rank}</td>
    <td class="stats-player"><strong>${escapeHtml(p.name)}</strong>${p.eliminatedBy ? `<small>out to ${escapeHtml(p.eliminatedBy)}</small>` : ""}</td>
    ${GS.COLUMNS.map((column) => p.hasStats
      ? `<td${tops[column.key] !== undefined && p[column.key] === tops[column.key] ? ' class="is-lead"' : ""}>${GS.cell(column, p[column.key])}</td>`
      : "<td>—</td>").join("")}
  </tr>`).join("");
  return `<details class="game-stats">
    <summary><span>Game stats</span><small>${escapeHtml(facts)}</small></summary>
    ${awards}
    <div class="table-wrap"><table class="stats-table">
      <thead><tr><th>#</th><th>Player</th>${GS.COLUMNS.map((column) => `<th title="${escapeHtml(column.label)}">${escapeHtml(column.short)}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </details>`;
}

function renderRecords() {
  const records = GS ? GS.records(games) : [];
  $("#records-grid").innerHTML = records.length
    ? records.map((record) => `<article class="record">${statIcon(record.icon)}<span class="eyebrow">${escapeHtml(record.title)}</span>
        <strong>${record.holders.length ? record.holders.map(escapeHtml).join(" &amp; ") : escapeHtml(record.value)}</strong>
        <small>${escapeHtml([record.holders.length ? record.value : "", record.detail, record.date ? formatDate(record.date) : ""].filter(Boolean).join(" · "))}</small></article>`).join("")
    : '<div class="empty">Records appear once a game is saved from the life tracker with its statistics.</div>';
}

function renderPlayerStats() {
  const totals = GS ? GS.playerTotals(games) : [];
  const box = $("#player-stats");
  if (!totals.length) {
    box.innerHTML = '<div class="empty">Averages appear once a game is saved from the life tracker with its statistics.</div>';
    return;
  }
  const columns = [
    ["Tracked games", (t) => t.games],
    ["Avg turn", (t) => t.avgTurnSeconds, "high", true],
    ["Longest turn", (t) => t.longestTurnSeconds, "high", true],
    ["Time / game", (t) => t.perGame.playSeconds, "high", true],
    ["Damage / game", (t) => t.perGame.damageDealt, "high"],
    ["Cmdr / game", (t) => t.perGame.commanderDealt, "high"],
    ["Life gained / game", (t) => t.perGame.lifeGained, "high"],
    ["Taken / game", (t) => t.perGame.damageTaken],
    ["Eliminations", (t) => t.eliminations, "high"],
    ["Biggest hit", (t) => t.biggestHit, "high"],
  ];
  const tops = columns.map(([, value, lead]) => lead ? Math.max(...totals.map(value)) : null);
  box.innerHTML = `<table class="stats-table player-stats-table">
    <thead><tr><th>Player</th>${columns.map(([label]) => `<th>${escapeHtml(label)}</th>`).join("")}<th>Awards</th></tr></thead>
    <tbody>${totals.map((t) => `<tr>
      <td class="stats-player"><strong>${escapeHtml(t.name)}</strong></td>
      ${columns.map(([, value, , isClock], index) => {
        const raw = value(t);
        const shown = isClock ? GS.clock(raw) : String(GS.perGame(raw));
        return `<td${tops[index] && raw === tops[index] ? ' class="is-lead"' : ""}>${shown}</td>`;
      }).join("")}
      <td class="award-cell">${t.awards.length ? t.awards.slice(0, 3).map((entry) => `<span title="${escapeHtml(entry.award.note)}">${statIcon(entry.award.icon)}${escapeHtml(entry.award.title)}${entry.count > 1 ? ` ×${entry.count}` : ""}</span>`).join("") + (t.awards.length > 3 ? `<small>+${t.awards.length - 3} more</small>` : "") : "—"}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

render = function () {
  const stats = aggregate();
  renderSummary(stats);
  // The chart is all-time wins, so it keeps its own order by the total.
  renderChart("#player-chart", [...stats.players].sort((a, b) => b.wins - a.wins), "player");
  renderChart("#deck-chart", stats.decks, "deck");
  renderStandings(stats.players);
  renderRecords();
  renderPlayerStats();
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
