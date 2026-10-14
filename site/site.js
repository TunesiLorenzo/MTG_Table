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
  const deckFor = (name) => {
    const key = keyOf(name);
    if (!decks.has(key)) decks.set(key, { name, games: 0, wins: 0, rankTotal: 0, finishes: [0, 0, 0, 0], players: new Map(), owners: new Set(), results: [] });
    return decks.get(key);
  };
  for (const game of games) {
    const isDraw = game.outcome === "draw";
    for (const result of game.players) {
      const deckKey = keyOf(result.deck);
      const player = playerFor(result.name);
      const deck = deckFor(result.deck);
      const won = !isDraw && result.rank === 1;
      if (!player.decks.has(deckKey)) player.decks.set(deckKey, { name: result.deck, games: 0, wins: 0, rankTotal: 0 });
      if (!deck.players.has(keyOf(result.name))) deck.players.set(keyOf(result.name), { name: result.name, games: 0, wins: 0, rankTotal: 0 });
      for (const entry of [player, deck, player.decks.get(deckKey), deck.players.get(keyOf(result.name))]) {
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
  /* Decks added by hand: any deck the roster describes, and each player's own
     list. One not played yet joins with no games, so it still has a page and
     still shows among its owner's decks. */
  for (const entry of roster.decks.values()) deckFor(entry.name);
  for (const entry of roster.players.values()) {
    if (!Array.isArray(entry.decks) || !entry.decks.length) continue;
    const player = playerFor(entry.name);
    for (const deckName of entry.decks) {
      const deck = deckFor(String(deckName));
      deck.owners.add(player.name);
      if (!player.decks.has(keyOf(deck.name))) player.decks.set(keyOf(deck.name), { name: deck.name, games: 0, wins: 0, rankTotal: 0 });
    }
  }
  const finish = (entry) => entry.games ? entry.rankTotal / entry.games : Number.POSITIVE_INFINITY;
  const rate = (entry) => entry.games ? entry.wins / entry.games : 0;
  /* Standings go by recorded wins; wins from before recording only break ties. */
  const playerList = [...players.values()].sort((a, b) => b.detailedWins - a.detailedWins || b.historicalWins - a.historicalWins || finish(a) - finish(b) || b.games - a.games || a.name.localeCompare(b.name));
  const deckList = [...decks.values()].sort((a, b) => b.wins - a.wins || rate(b) - rate(a) || finish(a) - finish(b) || b.games - a.games || a.name.localeCompare(b.name));
  return { players: playerList, decks: deckList, playerIndex: players, deckIndex: decks };
}

/* A player's decks or a deck's players, most played first. */
const byPlay = (entries) => [...entries.values()].sort((a, b) => b.games - a.games || b.wins - a.wins || a.name.localeCompare(b.name));

/* ------------------------------------------------------------- pictures -- */

const deckInfo = (name) => roster.decks.get(keyOf(name)) || {};
const playerInfo = (name) => roster.players.get(keyOf(name)) || {};

/* A player's banner: their own picture when one is set, otherwise the art of
   each of their decks in turn, most played first. */
function playerBanner(player) {
  const own = playerInfo(player.name).background;
  if (own) return [{ picture: own, focus: playerInfo(player.name).background_focus, label: "" }];
  const seen = new Set();
  return byPlay(player.decks)
    .map((deck) => ({ picture: deckInfo(deck.name).art, focus: deckInfo(deck.name).art_focus, label: deck.name }))
    .filter(({ picture }) => picture && !seen.has(picture.full) && seen.add(picture.full));
}

/* Who a deck belongs to: those who have played it, else those who own it. */
function deckPeople(deck) {
  const played = byPlay(deck.players).map((player) => player.name);
  return played.length ? played : [...deck.owners];
}
const deckCaption = (deck) => deck.games
  ? `Played by ${deckPeople(deck).join(", ")}`
  : `${deckPeople(deck).length ? `Owned by ${deckPeople(deck).join(", ")} · ` : ""}Not played yet`;
const playedDecks = (player) => [...player.decks.values()].filter((deck) => deck.games).length;

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
/* The point a picture is cropped around, chosen in the editor; the default is
   in site.css. Anything not shaped like "50% 25%" is ignored. */
const focusVar = (value) => /^\d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$/.test(value || "") ? `--focus:${value};` : "";

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
  return `<a class="deck-card${info.art ? " has-art" : ""}${colors.length ? " has-mana" : ""}" href="${deckHref(deck.name)}"${styleAttr(artVar(info.art, "thumb"), focusVar(info.art_focus), manaVar(colors))}>
    <span class="deck-card-body"><span class="deck-card-name"><strong>${escapeHtml(deck.name)}</strong>${pips(colors)}</span><small>${escapeHtml(caption)}</small>
    ${deck.games ? `<span class="deck-card-stats">${deck.wins}W · ${plural(deck.games, "game")} · ${percent(deck.wins, deck.games)}</span>` : '<span class="deck-card-stats is-new">NOT PLAYED YET</span>'}</span>
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
  if (!deck || !deck.games) return "";
  const info = deckInfo(deck.name);
  const colors = deckColors(deck.name);
  const card = (info.cards || [])[0];
  const picture = card
    ? `<img src="${escapeHtml(card.thumb)}" alt="${escapeHtml(info.commander || deck.name)}">`
    : info.art ? `<span class="zone-art"${styleAttr(artVar(info.art, "thumb"), focusVar(info.art_focus))}></span>` : "";
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
  const players = (deck) => byPlay(deck.players).map((player) => player.name).join(", ");
  const standings = stats.players.length
    ? stats.players.map((player, index) => `<tr class="rarity-${rarity(index + 1)}">
        <td>${rankGem(index + 1)}</td>
        <td><a class="player-cell" href="${playerHref(player.name)}">${avatar(player.name)}<span><strong>${escapeHtml(player.name)}${pips(playerColors(player))}</strong><small>${plural(playedDecks(player), "recorded deck")}</small></span></a></td>
        <td>${player.games || "—"}</td><td>${loyalty(player.detailedWins, "Recorded wins")}</td><td class="legacy-cell">${player.historicalWins || "—"}</td><td>${percent(player.detailedWins, player.games)}</td>
        <td>${player.games ? player.topTwos : "—"}</td><td>${average(player)}</td>
      </tr>`).join("")
    : '<tr><td colspan="8"><div class="empty">Standings appear after the first recorded game.</div></td></tr>';
  document.title = "MTG Leaderboard";
  return `
    <header class="page-header"><div><span class="eyebrow">COMMANDER NIGHT</span><h1>Leaderboard</h1></div></header>
    ${tiles([
      ["GAMES RECORDED", games.length, games.length === 1 ? "match in the archive" : "matches in the archive"],
      ["MOST WINS", champion ? champion.name : "—", champion ? `${plural(champion.detailedWins, "recorded win")}${champion.historicalWins ? ` · ${champion.historicalWins} historical` : ""}` : "No results yet"],
      ["STRONGEST DECK", strongest ? strongest.name : "—", strongest ? `${players(strongest)} · ${plural(strongest.wins, "win")} · ${percent(strongest.wins, strongest.games)} rate` : "No results yet"],
      ["MOST PLAYED DECK", mostPlayed ? mostPlayed.name : "—", mostPlayed ? `${players(mostPlayed)} · ${plural(mostPlayed.games, "appearance")}` : "No results yet"],
    ])}
    <section class="card">
      ${heading("ALL-TIME TABLE", "Player standings", "Sorted by recorded wins, then historical wins")}
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Player</th><th>Recorded games</th><th>Recorded wins</th><th>Historical wins</th><th>Recorded win rate</th><th>Top 2</th><th>Avg. finish</th></tr></thead>
        <tbody>${standings}</tbody>
      </table></div>
    </section>
    <section class="card">
      ${heading("ALL-TIME WINS", "Player win histogram")}
      ${stats.players.length ? bars([...stats.players].sort((a, b) => b.wins - a.wins).map((player) => [escapeHtml(player.name), player.name, player.wins, `${plural(player.wins, "win")}${player.historicalWins ? ` · ${player.historicalWins} historical` : ""}`, playerColors(player)])) : '<div class="empty">No results yet.</div>'}
      <p class="chart-note">Each bar wears the colours of that player's most played deck.</p>
    </section>
    ${colorPie()}
    <section>
      ${heading("DECK PERFORMANCE", "Decks", "Sorted by wins, then win rate")}
      ${stats.decks.length ? `<div class="deck-grid">${stats.decks.map((deck) => deckCard(deck, deckCaption(deck))).join("")}</div>` : '<div class="empty">Decks appear after the first recorded game.</div>'}
    </section>
    <section>
      ${heading("ARCHIVE", "Game history", plural(games.length, "game"))}
      ${gameCards(games, "No games recorded yet.")}
    </section>`;
}

function playerView(name) {
  const player = stats.playerIndex.get(keyOf(name));
  if (!player) return missingView(`No player called “${name}” has a recorded result.`);
  const slides = playerBanner(player);
  const position = stats.players.indexOf(player) + 1;
  const decks = byPlay(player.decks);
  document.title = `${player.name} · MTG Leaderboard`;
  return `
    ${backLink}
    <section class="hero${slides.length ? " has-art" : ""}"${styleAttr(manaVar(playerColors(player)))}>
      ${slides.length ? `<span class="hero-slides" aria-hidden="true">${slides.map((slide) => `<span class="hero-slide" data-label="${escapeHtml(slide.label)}"${styleAttr(artVar(slide.picture), focusVar(slide.focus))}></span>`).join("")}</span>` : ""}
      ${slides.length > 1 ? `<span class="hero-wipe" aria-hidden="true"></span><span class="hero-showing">${escapeHtml(slides[0].label)}</span>` : ""}
      <span class="hero-portrait">${avatar(player.name, "avatar-large")}${loyalty(player.wins, "Total wins", "loyalty-large")}</span>
      <div><span class="eyebrow">PLAYER · #${position} IN THE STANDINGS</span><h1>${escapeHtml(player.name)}</h1>
      <p>${plural(player.games, "recorded game")} with ${plural(playedDecks(player), "deck")}${player.historicalWins ? `, plus ${plural(player.historicalWins, "win")} from before games were recorded` : ""}.</p></div>
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
      ${decks.length ? `<div class="deck-grid">${decks.map((deck) => deckCard(deck, deckInfo(deck.name).commander || (deck.games ? `Avg. finish ${average(deck)}` : "New deck"))).join("")}</div>` : '<div class="empty">No deck has been recorded or added for this player yet.</div>'}
    </section>
    ${player.games ? `<section class="card">${heading("FINISHING POSITIONS", "Where the games ended")}${finishBars(player, playerColors(player))}</section>` : ""}
    <section>
      ${heading("ARCHIVE", `${player.name}'s games`, plural(player.games, "game"))}
      ${gameCards(player.results.map((entry) => entry.game), "No recorded games yet.")}
    </section>`;
}

function deckView(name) {
  const deck = stats.deckIndex.get(keyOf(name));
  if (!deck) return missingView(`No deck called “${name}” has been played or added.`);
  const info = deckInfo(deck.name);
  const players = byPlay(deck.players);
  const position = stats.decks.indexOf(deck) + 1;
  const colors = deckColors(deck.name);
  const pictures = [
    ...(info.art ? [`<a class="deck-art" href="${escapeHtml(info.art.full)}"><img src="${escapeHtml(info.art.full)}" alt="${escapeHtml(deck.name)} art"></a>`] : []),
    ...(info.cards || []).map((card) => `<a class="deck-printing" href="${escapeHtml(card.full)}"><img src="${escapeHtml(card.full)}" alt="${escapeHtml(info.commander || deck.name)} card" loading="lazy"></a>`),
  ];
  document.title = `${deck.name} · MTG Leaderboard`;
  return `
    ${backLink}
    <section class="hero${info.art ? " has-art" : ""}"${styleAttr(artVar(info.art), focusVar(info.art_focus), manaVar(colors))}>
      <div><span class="eyebrow">DECK · ${deck.games ? `#${position} BY WINS` : "NOT PLAYED YET"}</span><h1>${escapeHtml(deck.name)}</h1>${pips(colors)}
      <p>${info.commander ? `${escapeHtml(info.commander)} · ` : ""}${deck.games ? `Played by ${deckPeople(deck).map(playerLink).join(", ")}` : deck.owners.size ? `Owned by ${deckPeople(deck).map(playerLink).join(", ")}, not played yet` : "Not played yet"}.</p></div>
    </section>
    ${tiles([
      ["GAMES", deck.games, deck.games === 1 ? "recorded appearance" : "recorded appearances"],
      ["WINS", deck.wins, `${percent(deck.wins, deck.games)} win rate`],
      ["AVG. FINISH", average(deck), "1 is a win, 4 is last"],
      ["BEST PLAYER", players.length ? [...players].sort((a, b) => b.wins - a.wins || b.games - a.games)[0].name : "—", plural(players.length, "player")],
    ])}
    ${pictures.length ? `<section class="deck-gallery">${pictures.join("")}</section>` : ""}
    ${deck.games ? `<section class="card">${heading("FINISHING POSITIONS", "Where the games ended")}${finishBars(deck, colors)}</section>` : ""}
    ${players.length > 1 ? `<section class="card">${heading("PLAYED BY", "Who has played it")}${bars(players.map((player) => [playerLink(player.name), player.name, player.games, `${player.wins}W · ${plural(player.games, "game")}`, colors]))}</section>` : ""}
    <section>
      ${heading("ARCHIVE", `Games with ${deck.name}`, plural(deck.games, "game"))}
      ${gameCards(deck.results.map((entry) => entry.game), "No recorded games yet.")}
    </section>`;
}

function missingView(message) {
  document.title = "MTG Leaderboard";
  return `${backLink}<div class="empty">${escapeHtml(message)}</div>`;
}

/* ------------------------------------------------------------ slideshow -- */

/* The player banner moves between their decks. Each new picture is swiped in
   along a slanted edge with a band of light riding it, while the one before
   slides back and dims beneath; the picture on show settles from a slight
   zoom until the next swipe. Every redraw starts it afresh. With reduced
   motion the pictures cross-fade instead (see site.css). */
const SLIDE_SECONDS = 4.5;
let slideTimer = 0;

/* Restarts a CSS animation that is already applied by toggling its class. */
function replay(element, className) {
  if (!element) return;
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}

function startSlides() {
  clearInterval(slideTimer);
  const slides = [...app.querySelectorAll(".hero-slide")];
  if (!slides.length) return;
  const hero = slides[0].closest(".hero");
  const label = hero.querySelector(".hero-showing");
  const wipe = hero.querySelector(".hero-wipe");
  hero.style.setProperty("--slide-time", `${SLIDE_SECONDS}s`);
  /* The light band leans with the swipe's edge, which crosses 30% of the
     banner's width on the way down, so its angle depends on the banner. */
  const rect = hero.getBoundingClientRect();
  hero.style.setProperty("--wipe-skew", `${-Math.atan(0.3 * rect.width / Math.max(rect.height, 1))}rad`);
  let current = 0;
  /* Two frames, so the first picture fades in rather than appearing. */
  requestAnimationFrame(() => requestAnimationFrame(() => slides[0].classList.add("is-active")));
  if (slides.length < 2) return;
  slideTimer = setInterval(() => {
    const previous = slides[current];
    current = (current + 1) % slides.length;
    const next = slides[current];
    for (const slide of slides) slide.classList.remove("is-leaving");
    previous.classList.remove("is-active", "is-entering");
    previous.classList.add("is-leaving");
    next.classList.add("is-active");
    replay(next, "is-entering");
    replay(wipe, "is-sweeping");
    if (label) {
      label.textContent = next.dataset.label;
      replay(label, "is-changing");
    }
  }, SLIDE_SECONDS * 1000);
}

/* -------------------------------------------------------------- effects -- */

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
/* The CSS for entrances only applies under .motion, so with reduced motion,
   or before this runs, everything is simply there. */
if (!reducedMotion.matches) document.documentElement.classList.add("motion");

/* Panels, tiles and games rise into place as they scroll into view, a beat
   apart within a row; bars grow to length and headline numbers count up. */
let revealObserver = null;

function countUp(element) {
  const match = /^(\d+(?:\.\d+)?)(%?)$/.exec(element.textContent.trim());
  if (!match) return;
  const target = Number(match[1]);
  const decimals = (match[1].split(".")[1] || "").length;
  const begun = performance.now();
  const step = (now) => {
    const progress = Math.min((now - begun) / 900, 1);
    element.textContent = `${(target * (1 - (1 - progress) ** 3)).toFixed(decimals)}${match[2]}`;
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function show(element) {
  if (element.classList.contains("bar-chart")) {
    element.classList.add("is-grown");
    return;
  }
  element.classList.add("is-shown");
  if (element.matches(".summary")) countUp(element.querySelector("strong"));
  /* Once in place it hands its transform back to hover effects. */
  element.addEventListener("transitionend", () => element.classList.remove("reveal", "is-shown"), { once: true });
}

function revealOnScroll() {
  revealObserver?.disconnect();
  if (reducedMotion.matches || !("IntersectionObserver" in window)) return;
  revealObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      revealObserver.unobserve(entry.target);
      show(entry.target);
    }
  }, { rootMargin: "0px 0px -6% 0px" });
  const singles = app.querySelectorAll(".page-header, .hero, .card, .section-heading");
  const rows = app.querySelectorAll(".summary, .deck-card, .game-card, .deck-gallery > a");
  for (const element of singles) element.classList.add("reveal");
  for (const element of rows) {
    element.classList.add("reveal");
    const place = [...element.parentElement.children].indexOf(element);
    element.style.setProperty("--delay", `${(place % 8) * 70}ms`);
  }
  for (const chart of app.querySelectorAll(".bar-chart")) {
    chart.querySelectorAll(".bar-fill").forEach((bar, index) => { bar.style.transitionDelay = `${150 + index * 60}ms`; });
    revealObserver.observe(chart);
  }
  for (const element of [...singles, ...rows]) revealObserver.observe(element);
}

/* Deck tiles lean towards the pointer, with a light that follows it. */
if (finePointer.matches && !reducedMotion.matches) {
  app.addEventListener("pointermove", (event) => {
    const card = event.target.closest(".deck-card");
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    card.style.setProperty("--tilt-x", `${((0.5 - y) * 9).toFixed(2)}deg`);
    card.style.setProperty("--tilt-y", `${((x - 0.5) * 11).toFixed(2)}deg`);
    card.style.setProperty("--shine-x", `${(x * 100).toFixed(1)}%`);
    card.style.setProperty("--shine-y", `${(y * 100).toFixed(1)}%`);
  });
  app.addEventListener("pointerout", (event) => {
    const card = event.target.closest(".deck-card");
    if (!card || card.contains(event.relatedTarget)) return;
    for (const name of ["--tilt-x", "--tilt-y", "--shine-x", "--shine-y"]) card.style.removeProperty(name);
  });
}

/* Embers: motes of light in the five colours and bronze, drifting up behind
   the page and shying away from the pointer. One canvas, redrawn each frame;
   browsers stop the frames while the tab is hidden. Left out entirely for
   reduced motion. */
function startEmbers() {
  const canvas = document.querySelector("#embers");
  if (!canvas || reducedMotion.matches) return;
  const context = canvas.getContext("2d");
  const root = getComputedStyle(document.documentElement);
  const colors = ["--mana-w", "--mana-u", "--mana-b", "--mana-r", "--mana-g", "--bronze-light", "--bronze-light"]
    .map((name) => root.getPropertyValue(name).trim() || "#e3bb7a");
  const pointer = { x: -1e4, y: -1e4 };
  let width = 0;
  let height = 0;
  let motes = [];
  const spawn = (anywhere) => ({
    x: Math.random() * width,
    y: anywhere ? Math.random() * height : height + 12,
    radius: 0.6 + Math.random() ** 2 * 2.2,
    rise: 10 + Math.random() * 28,
    sway: 6 + Math.random() * 18,
    phase: Math.random() * Math.PI * 2,
    color: colors[Math.floor(Math.random() * colors.length)],
    glow: 0.35 + Math.random() * 0.5,
    pushX: 0,
    pushY: 0,
  });
  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    motes = Array.from({ length: Math.round(Math.min(70, width * height / 20000)) }, () => spawn(true));
  };
  let resizeTimer = 0;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 150); });
  window.addEventListener("pointermove", (event) => { pointer.x = event.clientX; pointer.y = event.clientY; });
  document.addEventListener("pointerleave", () => { pointer.x = pointer.y = -1e4; });
  resize();
  let last = performance.now();
  const frame = (now) => {
    const seconds = Math.min((now - last) / 1000, 0.1);
    last = now;
    context.clearRect(0, 0, width, height);
    context.globalCompositeOperation = "lighter";
    for (const mote of motes) {
      mote.phase += seconds;
      const dx = mote.x - pointer.x;
      const dy = mote.y - pointer.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 0 && distance < 140) {
        const force = (1 - distance / 140) * 90 * seconds;
        mote.pushX += dx / distance * force;
        mote.pushY += dy / distance * force;
      }
      const damping = Math.pow(0.05, seconds);
      mote.pushX *= damping;
      mote.pushY *= damping;
      mote.x += mote.pushX;
      mote.y += mote.pushY - mote.rise * seconds;
      if (mote.y < -20 || mote.x < -40 || mote.x > width + 40) Object.assign(mote, spawn(false));
      const x = mote.x + Math.sin(mote.phase * 0.6) * mote.sway;
      /* Brightest low on the screen, dissolving towards the top. */
      const fade = Math.max(0, Math.min(1, mote.y / (height * 0.3)));
      const alpha = mote.glow * (0.65 + 0.35 * Math.sin(mote.phase * 2.3)) * fade;
      context.fillStyle = mote.color;
      context.globalAlpha = alpha * 0.16;
      context.beginPath();
      context.arc(x, mote.y, mote.radius * 4.5, 0, Math.PI * 2);
      context.fill();
      context.globalAlpha = alpha;
      context.beginPath();
      context.arc(x, mote.y, mote.radius, 0, Math.PI * 2);
      context.fill();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/* --------------------------------------------------------------- router -- */

function route() {
  const [, kind, ...rest] = window.location.hash.replace(/^#/, "").split("/");
  let name = rest.join("/");
  try { name = decodeURIComponent(name); } catch (error) { /* a hand-typed % — use it as written */ }
  if (kind === "player" && name) app.innerHTML = playerView(name);
  else if (kind === "deck" && name) app.innerHTML = deckView(name);
  else app.innerHTML = homeView();
  startSlides();
  revealOnScroll();
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
      for (const [name, entry] of Object.entries(pictures[group] || {})) roster[group].set(keyOf(name), { ...entry, name });
    }
    stats = aggregate();
    route();
  } catch (error) {
    app.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

startEmbers();
start();
