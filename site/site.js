/* The public leaderboard, as published to GitHub Pages by build_site.py.
 *
 * Read-only and server-less: it fetches game_history.json and roster.json from
 * beside itself and derives everything else here. Results are still recorded
 * through the local Flask app; this page changes when a new game_history.json
 * is pushed.
 *
 * One page, three views, chosen by the hash so that a link to a player or a
 * deck can be shared:
 *
 *   #/                 standings, decks, archive
 *   #/player/<name>    one player's numbers and decks
 *   #/deck/<name>      one deck's numbers and pictures
 */

const app = document.querySelector("#app");

let games = [];
let historicalWins = [];
/* Pictures and commander names, keyed the same way the statistics are. */
const roster = { players: new Map(), decks: new Map() };
let stats = { players: [], decks: [], playerIndex: new Map(), deckIndex: new Map() };

/* Called after every view is drawn. Nothing on the published site uses it; the
   local preview at /public replaces it to add its editor to the page. */
let afterRender = () => {};

const keyOf = (value) => String(value).trim().toLocaleLowerCase();

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function formatDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date);
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const percent = (wins, played) => played ? `${Math.round(wins / played * 100)}%` : "—";
const average = (entry) => entry.games ? (entry.rankTotal / entry.games).toFixed(2) : "—";
const playerHref = (name) => `#/player/${encodeURIComponent(name)}`;
const deckHref = (name) => `#/deck/${encodeURIComponent(name)}`;
const playerLink = (name) => `<a href="${playerHref(name)}">${escapeHtml(name)}</a>`;
const deckLink = (name) => `<a href="${deckHref(name)}">${escapeHtml(name)}</a>`;

/* ----------------------------------------------------------- statistics -- */

function aggregate() {
  const players = new Map();
  const decks = new Map();
  const playerFor = (name) => {
    const key = keyOf(name);
    if (!players.has(key)) players.set(key, { name, games: 0, detailedWins: 0, historicalWins: 0, wins: 0, topTwos: 0, rankTotal: 0, finishes: [0, 0, 0, 0], decks: new Map(), results: [] });
    return players.get(key);
  };
  for (const game of games) {
    const isDraw = game.outcome === "draw";
    for (const result of game.players) {
      const deckKey = keyOf(result.deck);
      if (!decks.has(deckKey)) decks.set(deckKey, { name: result.deck, games: 0, wins: 0, rankTotal: 0, finishes: [0, 0, 0, 0], pilots: new Map(), results: [] });
      const player = playerFor(result.name);
      const deck = decks.get(deckKey);
      const won = !isDraw && result.rank === 1;
      if (!player.decks.has(deckKey)) player.decks.set(deckKey, { name: result.deck, games: 0, wins: 0, rankTotal: 0 });
      if (!deck.pilots.has(keyOf(result.name))) deck.pilots.set(keyOf(result.name), { name: result.name, games: 0, wins: 0, rankTotal: 0 });
      for (const entry of [player, deck, player.decks.get(deckKey), deck.pilots.get(keyOf(result.name))]) {
        entry.games += 1; entry.rankTotal += result.rank;
        if (won) entry.wins += 1;
      }
      if (won) player.detailedWins += 1;
      if (result.rank <= 2) player.topTwos += 1;
      for (const entry of [player, deck]) {
        if (result.rank >= 1 && result.rank <= 4) entry.finishes[result.rank - 1] += 1;
        entry.results.push({ game, result });
      }
    }
  }
  /* Wins from before games were recorded one by one: a total, with no game,
     deck or finishing position behind it. */
  for (const legacy of historicalWins) {
    const player = playerFor(legacy.name);
    player.historicalWins += legacy.wins;
    player.wins += legacy.wins;
  }
  const finish = (entry) => entry.games ? entry.rankTotal / entry.games : Number.POSITIVE_INFINITY;
  const rate = (entry) => entry.games ? entry.wins / entry.games : 0;
  const playerList = [...players.values()].sort((a, b) => b.wins - a.wins || finish(a) - finish(b) || b.games - a.games || a.name.localeCompare(b.name));
  const deckList = [...decks.values()].sort((a, b) => b.wins - a.wins || rate(b) - rate(a) || finish(a) - finish(b) || b.games - a.games || a.name.localeCompare(b.name));
  return { players: playerList, decks: deckList, playerIndex: players, deckIndex: decks };
}

/* A player's or pilot's sub-entries, most played first. */
const byPlay = (entries) => [...entries.values()].sort((a, b) => b.games - a.games || b.wins - a.wins || a.name.localeCompare(b.name));

/* ------------------------------------------------------------- pictures -- */

const deckInfo = (name) => roster.decks.get(keyOf(name)) || {};
const playerInfo = (name) => roster.players.get(keyOf(name)) || {};

/* A player with no background of their own borrows the art of the deck they
   have played most. */
function playerBackdrop(player) {
  const own = playerInfo(player.name).background;
  if (own) return own;
  for (const deck of byPlay(player.decks)) {
    if (deckInfo(deck.name).art) return deckInfo(deck.name).art;
  }
  return null;
}

function avatar(name, extraClass = "") {
  const portrait = playerInfo(name).portrait;
  return portrait
    ? `<img class="avatar ${extraClass}" src="${escapeHtml(portrait.thumb)}" alt="" loading="lazy">`
    : `<span class="avatar avatar-blank ${extraClass}" aria-hidden="true">${escapeHtml(name.trim().charAt(0).toLocaleUpperCase())}</span>`;
}

/* Style declarations are built separately so one element can take several. */
const styleAttr = (...declarations) => {
  const text = declarations.filter(Boolean).join("");
  return text ? ` style="${text}"` : "";
};
const artVar = (picture, size = "full") => picture ? `--art:url('${escapeHtml(picture[size])}');` : "";
const artStyle = (picture, size = "full") => styleAttr(artVar(picture, size));

/* ----------------------------------------------------------------- mana -- */

const MANA_ORDER = ["W", "U", "B", "R", "G"];
const MANA_NAMES = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green", C: "Colourless" };

/* A deck's colour identity as letters: none when it has not been set, ["C"]
   when the deck is colourless. */
function deckColors(name) {
  const value = deckInfo(name).colors;
  return typeof value === "string" ? [...value.toUpperCase()].filter((color) => color in MANA_NAMES) : [];
}

/* A player wears the colours of the most played deck that has them. */
function playerColors(player) {
  for (const deck of byPlay(player.decks)) {
    const colors = deckColors(deck.name);
    if (colors.length) return colors;
  }
  return [];
}

/* Mana symbols from the Mana font, named for screen readers. */
function pips(colors) {
  if (!colors.length) return "";
  const label = colors.map((color) => MANA_NAMES[color]).join(", ");
  return `<span class="pips" title="${label}" role="img" aria-label="${label}">${colors.map((color) => `<i class="ms ms-${color.toLowerCase()} ms-cost ms-shadow"></i>`).join("")}</span>`;
}

/* The deck's colours as gradient stops in --mana, for borders and bars. */
function manaVar(colors) {
  if (!colors.length) return "";
  const stops = colors.map((color) => `var(--mana-${color.toLowerCase()})`);
  return `--mana:${(stops.length === 1 ? [stops[0], stops[0]] : stops).join(",")};`;
}

/* A place in the standings, read the way a set symbol reads its rarity. */
const RARITY_NAMES = { mythic: "Mythic rare", rare: "Rare", uncommon: "Uncommon", common: "Common" };
function rarity(position) {
  if (position === 1) return "mythic";
  if (position <= 3) return "rare";
  if (position <= 6) return "uncommon";
  return "common";
}
const rankGem = (position) => `<span class="rank-gem rarity-${rarity(position)}" title="${RARITY_NAMES[rarity(position)]} · #${position}">${position}</span>`;

/* A count in a planeswalker's loyalty shield. */
const loyalty = (value, title, extraClass = "") => `<span class="loyalty ${extraClass}" title="${escapeHtml(title)}">${escapeHtml(value)}</span>`;

const CROWN = '<svg class="log-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17h18l-1.4-9.5-4.8 4.2L12 4.5l-2.8 7.2-4.8-4.2z" fill="currentColor"/><rect x="3" y="18.5" width="18" height="2.2" rx="1.1" fill="currentColor"/></svg>';
const BROKEN_SIGIL = '<svg class="log-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.4 2.6a9.6 9.6 0 0 0 0 18.8M13.6 2.6a9.6 9.6 0 0 1 0 18.8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12.6 1.5 10.8 7l2.6 3.4-2.4 4.2 2.2 3.3-1.2 4.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

/* --------------------------------------------------------------- pieces -- */

function tiles(cards) {
  return `<section class="summary-grid">${cards.map(([label, value, detail]) => `<article class="summary"><span class="eyebrow">${escapeHtml(label)}</span><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></article>`).join("")}</section>`;
}

/* rows: [label html, title text, value, detail text, colours]. A row with
   colours fills in them; one without keeps the default bronze. */
function bars(rows, kind = "") {
  const maximum = Math.max(...rows.map((row) => row[2]), 1);
  return `<div class="bar-chart ${kind}">${rows.map(([label, title, value, detail, colors = []]) => {
    const width = value ? Math.max(8, value / maximum * 100) : 3;
    return `<div class="bar-item" title="${escapeHtml(`${title}: ${detail}`)}"><span class="bar-label">${label}</span><span class="bar-track"><span class="bar-fill${colors.length ? " has-mana" : ""}" style="--width:${width}%;${manaVar(colors)}"></span></span><span class="bar-value">${escapeHtml(detail)}</span></div>`;
  }).join("")}</div>`;
}

function finishBars(entry, colors) {
  return bars(["1st", "2nd", "3rd", "4th"].map((label, index) => [label, label, entry.finishes[index], plural(entry.finishes[index], "game"), colors]));
}

/* Hovering a deck that has commander cards swaps its art for them. */
function deckCard(deck, caption) {
  const info = deckInfo(deck.name);
  const colors = deckColors(deck.name);
  const cards = (info.cards || []).slice(0, 2);
  return `<a class="deck-card${info.art ? " has-art" : ""}${colors.length ? " has-mana" : ""}" href="${deckHref(deck.name)}"${styleAttr(artVar(info.art, "thumb"), manaVar(colors))}>
    <span class="deck-card-body"><span class="deck-card-name"><strong>${escapeHtml(deck.name)}</strong>${pips(colors)}</span><small>${escapeHtml(caption)}</small>
    <span class="deck-card-stats">${deck.wins}W · ${plural(deck.games, "game")} · ${percent(deck.wins, deck.games)}</span></span>
    ${cards.length ? `<span class="deck-card-reveal" aria-hidden="true">${cards.map((card) => `<img src="${escapeHtml(card.thumb)}" alt="" loading="lazy">`).join("")}</span>` : ""}
  </a>`;
}

/* Every recorded appearance, counted once for each colour its deck plays. */
function colorStats() {
  const rows = new Map([...MANA_ORDER, "C"].map((color) => [color, { color, games: 0, wins: 0 }]));
  let unknown = 0;
  for (const game of games) {
    for (const result of game.players) {
      const colors = deckColors(result.deck);
      if (!colors.length) unknown += 1;
      for (const color of colors) {
        rows.get(color).games += 1;
        if (game.outcome !== "draw" && result.rank === 1) rows.get(color).wins += 1;
      }
    }
  }
  return { rows: [...rows.values()].filter((row) => row.color !== "C" || row.games), unknown };
}

/* Win rate per colour on one 0–100% scale, with an even share marked: in a
   four-player game a colour that wins one game in four is pulling its weight. */
function colorPie() {
  const { rows, unknown } = colorStats();
  if (!rows.some((row) => row.games)) return "";
  const note = unknown ? `${plural(unknown, "appearance")} by decks with no colours set are left out` : "A deck counts for every colour it plays";
  return `<section class="card">
    ${heading("COLOUR PIE", "Which colours win", note)}
    <div class="bar-chart color-pie">${rows.map((row) => {
      const detail = row.games ? `${percent(row.wins, row.games)} · ${plural(row.wins, "win")} in ${plural(row.games, "game")}` : "Not played yet";
      const width = row.games ? Math.max(2, row.wins / row.games * 100) : 0;
      return `<div class="bar-item" title="${MANA_NAMES[row.color]}: ${escapeHtml(detail)}"><span class="bar-label">${pips([row.color])}${MANA_NAMES[row.color]}</span><span class="bar-track"><span class="bar-fill has-mana" style="--width:${width}%;${manaVar([row.color])}"></span></span><span class="bar-value">${escapeHtml(detail)}</span></div>`;
    }).join("")}</div>
    <p class="chart-note"><span class="even-share-key" aria-hidden="true"></span>Even share: one win in four games</p>
  </section>`;
}

/* The most played deck, laid out in its zone with the commander card. */
function commanderZone(player) {
  const deck = byPlay(player.decks)[0];
  if (!deck) return "";
  const info = deckInfo(deck.name);
  const colors = deckColors(deck.name);
  const card = (info.cards || [])[0];
  const picture = card
    ? `<img src="${escapeHtml(card.thumb)}" alt="${escapeHtml(info.commander || deck.name)}">`
    : info.art ? `<span class="zone-art"${artStyle(info.art, "thumb")}></span>` : "";
  return `<section class="card commander-zone"${styleAttr(manaVar(colors))}>
    ${picture ? `<a class="zone-slot" href="${deckHref(deck.name)}">${picture}</a>` : ""}
    <div class="zone-body"><span class="eyebrow">COMMANDER ZONE · MOST PLAYED</span>
      <h2>${escapeHtml(info.commander || deck.name)}</h2>${pips(colors)}
      <p>${deckLink(deck.name)}, cast in ${deck.games} of ${plural(player.games, "recorded game")}.</p>
      <div class="zone-stats">${loyalty(deck.wins, "Wins with it")}<span>${plural(deck.wins, "win")} · ${percent(deck.wins, deck.games)} win rate · avg. finish ${average(deck)}</span></div>
    </div>
  </section>`;
}

function gameCards(list, emptyText) {
  if (!list.length) return `<div class="empty">${escapeHtml(emptyText)}</div>`;
  const ordered = [...list].sort((a, b) => b.date.localeCompare(a.date) || String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return `<div class="history-list">${ordered.map((game) => {
    const results = [...game.players].sort((a, b) => a.rank - b.rank);
    const isDraw = game.outcome === "draw";
    const headline = isDraw
      ? `${results.filter((result) => result.rank === 1).map((result) => result.name).join(" & ")} shared the table`
      : `${results[0].name} claimed the table with ${results[0].deck}`;
    /* The edge down the left wears the winning deck's colours. */
    return `<article class="game-card${isDraw ? " is-draw" : ""}"${styleAttr(isDraw ? "" : manaVar(deckColors(results[0].deck)))}>
      <div class="game-head"><span class="game-date">${escapeHtml(formatDate(game.date))}</span><span class="game-winner">${escapeHtml(headline)}</span></div>
      <div class="game-results">${results.map((result) => {
        const top = result.rank === 1;
        const place = top ? (isDraw ? `${BROKEN_SIGIL}DRAW` : `${CROWN}VICTORY`) : `#${result.rank}`;
        return `<div class="game-player${top ? (isDraw ? " is-tied" : " is-winner") : ""}"><span class="place">${place}</span><strong>${playerLink(result.name)}</strong><small>${deckLink(result.deck)}${pips(deckColors(result.deck))}</small></div>`;
      }).join("")}</div>
    </article>`;
  }).join("")}</div>`;
}

const heading = (eyebrow, title, note = "") => `<div class="section-heading"><div><span class="eyebrow">${escapeHtml(eyebrow)}</span><h2>${escapeHtml(title)}</h2></div>${note ? `<span class="muted">${escapeHtml(note)}</span>` : ""}</div>`;
const backLink = '<a class="back-link" href="#/">&larr; Leaderboard</a>';

/* ---------------------------------------------------------------- views -- */

function homeView() {
  const champion = stats.players[0];
  const strongest = stats.decks[0];
  const mostPlayed = [...stats.decks].sort((a, b) => b.games - a.games || b.wins - a.wins)[0];
  const pilots = (deck) => byPlay(deck.pilots).map((pilot) => pilot.name).join(", ");
  const standings = stats.players.length
    ? stats.players.map((player, index) => `<tr class="rarity-${rarity(index + 1)}">
        <td>${rankGem(index + 1)}</td>
        <td><a class="player-cell" href="${playerHref(player.name)}">${avatar(player.name)}<span><strong>${escapeHtml(player.name)}${pips(playerColors(player))}</strong><small>${plural(player.decks.size, "recorded deck")}${player.historicalWins ? ` · <span class="legacy-note">${plural(player.historicalWins, "historical win")}</span>` : ""}</small></span></a></td>
        <td>${player.games || "—"}</td><td>${loyalty(player.wins, player.historicalWins ? `${player.detailedWins} recorded · ${player.historicalWins} historical` : "Total wins")}</td><td>${percent(player.detailedWins, player.games)}</td>
        <td>${player.games ? player.topTwos : "—"}</td><td>${average(player)}</td>
      </tr>`).join("")
    : '<tr><td colspan="7"><div class="empty">Standings appear after the first recorded game.</div></td></tr>';
  document.title = "MTG Leaderboard";
  return `
    <header class="page-header"><div><span class="eyebrow">COMMANDER NIGHT</span><h1>Leaderboard</h1></div></header>
    ${tiles([
      ["GAMES RECORDED", games.length, games.length === 1 ? "match in the archive" : "matches in the archive"],
      ["MOST WINS", champion ? champion.name : "—", champion ? `${plural(champion.wins, "total win")}${champion.historicalWins ? ` · ${champion.historicalWins} historical` : ""}` : "No results yet"],
      ["STRONGEST DECK", strongest ? strongest.name : "—", strongest ? `${pilots(strongest)} · ${plural(strongest.wins, "win")} · ${percent(strongest.wins, strongest.games)} rate` : "No results yet"],
      ["MOST PLAYED DECK", mostPlayed ? mostPlayed.name : "—", mostPlayed ? `${pilots(mostPlayed)} · ${plural(mostPlayed.games, "appearance")}` : "No results yet"],
    ])}
    <section class="card">
      ${heading("ALL-TIME TABLE", "Player standings", "Sorted by wins, then average finish")}
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Player</th><th>Recorded games</th><th>Total wins</th><th>Recorded win rate</th><th>Top 2</th><th>Avg. finish</th></tr></thead>
        <tbody>${standings}</tbody>
      </table></div>
    </section>
    <section class="card">
      ${heading("ALL-TIME WINS", "Player win histogram")}
      ${stats.players.length ? bars(stats.players.map((player) => [escapeHtml(player.name), player.name, player.wins, `${plural(player.wins, "win")}${player.historicalWins ? ` · ${player.historicalWins} historical` : ""}`, playerColors(player)])) : '<div class="empty">No results yet.</div>'}
      <p class="chart-note">Each bar wears the colours of that player's most played deck.</p>
    </section>
    ${colorPie()}
    <section>
      ${heading("DECK PERFORMANCE", "Decks", "Sorted by wins, then win rate")}
      ${stats.decks.length ? `<div class="deck-grid">${stats.decks.map((deck) => deckCard(deck, pilots(deck))).join("")}</div>` : '<div class="empty">Decks appear after the first recorded game.</div>'}
    </section>
    <section>
      ${heading("ARCHIVE", "Game history", plural(games.length, "game"))}
      ${gameCards(games, "No games recorded yet.")}
    </section>`;
}

function playerView(name) {
  const player = stats.playerIndex.get(keyOf(name));
  if (!player) return missingView(`No player called “${name}” has a recorded result.`);
  const backdrop = playerBackdrop(player);
  const position = stats.players.indexOf(player) + 1;
  const decks = byPlay(player.decks);
  document.title = `${player.name} · MTG Leaderboard`;
  return `
    ${backLink}
    <section class="hero${backdrop ? " has-art" : ""}"${styleAttr(artVar(backdrop), manaVar(playerColors(player)))}>
      <span class="hero-portrait">${avatar(player.name, "avatar-large")}${loyalty(player.wins, "Total wins", "loyalty-large")}</span>
      <div><span class="eyebrow">PLAYER · #${position} IN THE STANDINGS</span><h1>${escapeHtml(player.name)}</h1>
      <p>${plural(player.games, "recorded game")} with ${plural(decks.length, "deck")}${player.historicalWins ? `, plus ${plural(player.historicalWins, "win")} from before games were recorded` : ""}.</p></div>
    </section>
    ${tiles([
      ["TOTAL WINS", player.wins, player.historicalWins ? `${player.detailedWins} recorded · ${player.historicalWins} historical` : "all from recorded games"],
      ["WIN RATE", percent(player.detailedWins, player.games), player.games ? `${player.detailedWins} of ${plural(player.games, "recorded game")}` : "No recorded games"],
      ["TOP 2", player.games ? player.topTwos : "—", player.games ? `${percent(player.topTwos, player.games)} of recorded games` : "No recorded games"],
      ["AVG. FINISH", average(player), "1 is a win, 4 is last"],
    ])}
    ${commanderZone(player)}
    <section>
      ${heading("DECKS", `${player.name}'s decks`, "Most played first")}
      ${decks.length ? `<div class="deck-grid">${decks.map((deck) => deckCard(deck, deckInfo(deck.name).commander || `Avg. finish ${average(deck)}`)).join("")}</div>` : '<div class="empty">No deck has been recorded for this player yet.</div>'}
    </section>
    ${player.games ? `<section class="card">${heading("FINISHING POSITIONS", "Where the games ended")}${finishBars(player, playerColors(player))}</section>` : ""}
    <section>
      ${heading("ARCHIVE", `${player.name}'s games`, plural(player.games, "game"))}
      ${gameCards(player.results.map((entry) => entry.game), "No recorded games yet.")}
    </section>`;
}

function deckView(name) {
  const deck = stats.deckIndex.get(keyOf(name));
  if (!deck) return missingView(`No deck called “${name}” has a recorded result.`);
  const info = deckInfo(deck.name);
  const pilots = byPlay(deck.pilots);
  const position = stats.decks.indexOf(deck) + 1;
  const colors = deckColors(deck.name);
  const pictures = [
    ...(info.art ? [`<a class="deck-art" href="${escapeHtml(info.art.full)}"><img src="${escapeHtml(info.art.full)}" alt="${escapeHtml(deck.name)} art"></a>`] : []),
    ...(info.cards || []).map((card) => `<a class="deck-printing" href="${escapeHtml(card.full)}"><img src="${escapeHtml(card.full)}" alt="${escapeHtml(info.commander || deck.name)} card" loading="lazy"></a>`),
  ];
  document.title = `${deck.name} · MTG Leaderboard`;
  return `
    ${backLink}
    <section class="hero${info.art ? " has-art" : ""}"${styleAttr(artVar(info.art), manaVar(colors))}>
      <div><span class="eyebrow">DECK · #${position} BY WINS</span><h1>${escapeHtml(deck.name)}</h1>${pips(colors)}
      <p>${info.commander ? `${escapeHtml(info.commander)} · ` : ""}Piloted by ${pilots.map((pilot) => playerLink(pilot.name)).join(", ")}.</p></div>
    </section>
    ${tiles([
      ["GAMES", deck.games, deck.games === 1 ? "recorded appearance" : "recorded appearances"],
      ["WINS", deck.wins, `${percent(deck.wins, deck.games)} win rate`],
      ["AVG. FINISH", average(deck), "1 is a win, 4 is last"],
      ["BEST PILOT", pilots.length ? [...pilots].sort((a, b) => b.wins - a.wins || b.games - a.games)[0].name : "—", plural(pilots.length, "pilot")],
    ])}
    ${pictures.length ? `<section class="deck-gallery">${pictures.join("")}</section>` : ""}
    <section class="card">${heading("FINISHING POSITIONS", "Where the games ended")}${finishBars(deck, colors)}</section>
    ${pilots.length > 1 ? `<section class="card">${heading("PILOTS", "Who has played it")}${bars(pilots.map((pilot) => [playerLink(pilot.name), pilot.name, pilot.games, `${pilot.wins}W · ${plural(pilot.games, "game")}`, colors]))}</section>` : ""}
    <section>
      ${heading("ARCHIVE", `Games with ${deck.name}`, plural(deck.games, "game"))}
      ${gameCards(deck.results.map((entry) => entry.game), "No recorded games yet.")}
    </section>`;
}

function missingView(message) {
  document.title = "MTG Leaderboard";
  return `${backLink}<div class="empty">${escapeHtml(message)}</div>`;
}

/* --------------------------------------------------------------- router -- */

function route() {
  const [, kind, ...rest] = window.location.hash.replace(/^#/, "").split("/");
  let name = rest.join("/");
  try { name = decodeURIComponent(name); } catch (error) { /* a hand-typed % — use it as written */ }
  if (kind === "player" && name) app.innerHTML = playerView(name);
  else if (kind === "deck" && name) app.innerHTML = deckView(name);
  else app.innerHTML = homeView();
  afterRender();
}

window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status})`);
  return response.json();
}

async function start() {
  try {
    const [history, pictures] = await Promise.all([loadJson("game_history.json"), loadJson("roster.json")]);
    games = Array.isArray(history.games) ? history.games : [];
    historicalWins = Array.isArray(history.historical_wins) ? history.historical_wins : [];
    for (const group of ["players", "decks"]) {
      roster[group].clear();
      for (const [name, entry] of Object.entries(pictures[group] || {})) roster[group].set(keyOf(name), entry);
    }
    stats = aggregate();
    route();
  } catch (error) {
    app.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

start();
