/* Shared by the leaderboard display and its entry subpage.
 *
 * Everything here is about the data both pages need: the archive, the numbers
 * derived from it, and the toast. Nothing here touches an element that only one
 * of the two pages has — each page assigns its own `render`, which this file
 * calls after anything that changes the data. Loaded as a plain script before
 * the page's own, so its top-level bindings are in scope there. */

const $ = (selector) => document.querySelector(selector);
const statusBox = $("#status");

let games = [];
let historicalWins = [];

/* Replaced by whichever page loaded this. The default keeps the save and delete
   handlers below honest on a page that draws nothing. */
let render = () => {};

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function showStatus(message, kind = "") {
  statusBox.hidden = false;
  statusBox.textContent = message;
  statusBox.className = kind;
  window.clearTimeout(showStatus.timer);
  showStatus.timer = window.setTimeout(() => { statusBox.hidden = true; }, 3200);
}

function formatDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function aggregate() {
  const players = new Map();
  const decks = new Map();
  for (const game of games) {
    const isDraw = game.outcome === "draw";
    for (const result of game.players) {
      const playerKey = result.name.toLocaleLowerCase();
      const deckKey = result.deck.toLocaleLowerCase();
      if (!players.has(playerKey)) players.set(playerKey, { name: result.name, games: 0, detailedWins: 0, historicalWins: 0, wins: 0, topTwos: 0, rankTotal: 0, decks: new Set() });
      if (!decks.has(deckKey)) decks.set(deckKey, { name: result.deck, games: 0, wins: 0, rankTotal: 0, players: new Set() });
      const player = players.get(playerKey);
      const deck = decks.get(deckKey);
      player.games += 1; player.rankTotal += result.rank; player.decks.add(result.deck);
      deck.games += 1; deck.rankTotal += result.rank; deck.players.add(result.name);
      if (!isDraw && result.rank === 1) { player.detailedWins += 1; player.wins += 1; deck.wins += 1; }
      if (result.rank <= 2) player.topTwos += 1;
    }
  }
  for (const legacy of historicalWins) {
    const playerKey = legacy.name.toLocaleLowerCase();
    if (!players.has(playerKey)) players.set(playerKey, { name: legacy.name, games: 0, detailedWins: 0, historicalWins: 0, wins: 0, topTwos: 0, rankTotal: 0, decks: new Set() });
    const player = players.get(playerKey);
    player.historicalWins += legacy.wins;
    player.wins += legacy.wins;
  }
  const finish = (entry) => entry.games ? entry.rankTotal / entry.games : Number.POSITIVE_INFINITY;
  const rate = (entry) => entry.games ? entry.wins / entry.games : 0;
  /* Standings go by recorded wins; wins from before recording only break ties. */
  const playerList = [...players.values()].sort((a, b) => b.detailedWins - a.detailedWins || b.historicalWins - a.historicalWins || finish(a) - finish(b) || b.games - a.games || a.name.localeCompare(b.name));
  const deckList = [...decks.values()].sort((a, b) => b.wins - a.wins || rate(b) - rate(a) || finish(a) - finish(b) || b.games - a.games || a.name.localeCompare(b.name));
  return { players: playerList, decks: deckList };
}

async function loadGames() {
  try {
    const response = await fetch("/api/games", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || "Could not load game history");
    games = result.games;
    historicalWins = Array.isArray(result.historical_wins) ? result.historical_wins : [];
    render();
  } catch (error) {
    showStatus(error.message, "error");
  }
}

async function deleteGame(id) {
  const response = await fetch(`/api/games/${encodeURIComponent(id)}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.message || "Could not remove game");
  games = games.filter((item) => item.id !== id);
  render();
  return result.message;
}
