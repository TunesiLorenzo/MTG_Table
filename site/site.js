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
 *   #/deck/<name>      one deck's numbers and pictures, and its commander's sound
 */

const app = document.querySelector("#app");

let games = [];
let historicalWins = [];
let rosterReady = false;
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

/* ---------------------------------------------------------------- theme -- */

/* A deck's page takes its theme from its commander: the colour of the card
   itself (Scryfall's card_colors) when known, otherwise its colour identity.
   No colour is colourless, one is that colour, two is their guild, three is
   their shard or wedge, and four or five is gold. The roster's "theme"
   overrides it, chosen in the editor. A key lists its colours with the one
   that paints the page first: a shard's centre colour, a wedge's clan colour
   as on Khans of Tarkir. */
const THEMES = {
  w: "White", u: "Blue", b: "Black", r: "Red", g: "Green", c: "Colourless", gold: "Gold",
  wu: "Azorius", ub: "Dimir", br: "Rakdos", rg: "Gruul", gw: "Selesnya",
  wb: "Orzhov", ur: "Izzet", bg: "Golgari", rw: "Boros", gu: "Simic",
  wgu: "Bant", uwb: "Esper", bur: "Grixis", rbg: "Jund", grw: "Naya",
  wbg: "Abzan", urw: "Jeskai", bgu: "Sultai", rwb: "Mardu", gur: "Temur",
  eldrazi: "Eldrazi",
};

function themeFromColors(value) {
  if (typeof value !== "string" || !value) return "";
  const colors = [...value.toLowerCase()].filter((color) => "wubrg".includes(color));
  if (!colors.length) return "c";
  if (colors.length === 1) return colors[0];
  if (colors.length <= 3) return Object.keys(THEMES).find((key) => key.length === colors.length && colors.every((color) => key.includes(color)));
  return "gold";
}
/* An Eldrazi commander, by the type line Scryfall gives, brings the void. */
const isEldrazi = (name) => /\bEldrazi\b/i.test(deckInfo(name).type_line || "");
const autoTheme = (name) => (isEldrazi(name) ? "eldrazi" : themeFromColors(deckInfo(name).card_colors) || themeFromColors(deckInfo(name).colors));
const deckTheme = (name, override = deckInfo(name).theme) => (override in THEMES ? override : autoTheme(name));

/* Paints the page in a theme ("" for the page's own), and points the embers,
   the bursts and the sigil at the given colours (none for all five). */
function applyTheme(key, colors = []) {
  const root = document.documentElement;
  delete root.dataset.themeC;
  if (key in THEMES) {
    const [first, second, third] = key.length <= 3 ? [...key] : [key];
    root.dataset.themeA = first;
    root.dataset.themeB = second || first;
    if (third) root.dataset.themeC = third;
  } else {
    delete root.dataset.themeA;
    delete root.dataset.themeB;
  }
  paintSigil(colors);
  /* The void burns colourless, whatever the identity. */
  embers.setColors(key === "eldrazi" ? ["C"] : colors);
}

/* Points the colour wheel at the colours in play. Some lit: their nodes and
   symbols, and the links between two of them, beat together, the rest fade
   back, and the core burns in just those colours. A colourless deck lights
   none and its core goes grey. None given: all five take turns. */
function paintSigil(colors) {
  const sigil = document.querySelector(".sigil");
  if (!sigil) return;
  const letters = colors.map((color) => color.toLowerCase());
  const lit = new Set(letters.filter((color) => "wubrg".includes(color)));
  const focused = lit.size > 0 || letters.includes("c");
  sigil.classList.toggle("has-focus", focused);
  for (const part of sigil.querySelectorAll("[data-color]")) {
    part.classList.toggle("is-lit", lit.has(part.dataset.color));
    part.classList.toggle("is-dim", focused && !lit.has(part.dataset.color));
  }
  for (const link of sigil.querySelectorAll(".sigil-link")) {
    const both = lit.has(link.dataset.a) && lit.has(link.dataset.b);
    link.classList.toggle("is-lit", both);
    link.classList.toggle("is-dim", focused && !both);
  }
  const tints = [..."wubrg"].filter((color) => !focused || lit.has(color)).map((color) => `var(--sigil-${color})`);
  if (!tints.length) sigil.style.setProperty("--core", "radial-gradient(circle, var(--mana-c), transparent 70%)");
  else if (tints.length === 1) sigil.style.setProperty("--core", `radial-gradient(circle, ${tints[0]}, transparent 70%)`);
  else sigil.style.setProperty("--core", `conic-gradient(${[...tints, tints[0]].join(", ")})`);
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
/* Back goes up one level: a deck opened from a player's page returns to that
   player, and everything else to the leaderboard. Where a page was opened
   from is kept in its history entry; see the router. */
const routeOf = (hash) => String(hash || "").replace(/^#\/?/, "");
function backLink(kind) {
  const [from, ...rest] = routeOf(history.state?.from).split("/");
  let name = rest.join("/");
  try { name = decodeURIComponent(name); } catch (error) { /* as written */ }
  const player = kind === "deck" && from === "player" && stats.playerIndex.get(keyOf(name));
  return player
    ? `<a class="back-link" href="${playerHref(player.name)}">&larr; ${escapeHtml(player.name)}</a>`
    : '<a class="back-link" href="#/">&larr; Leaderboard</a>';
}

/* ---------------------------------------------------------------- views -- */

/* The standings' columns, each with the short heading a phone shows instead;
   the key under the table spells the short ones out. */
const STANDINGS_COLUMNS = [
  ["#", "#"], ["Player", "Player"], ["Recorded games", "GP"], ["Recorded wins", "W"], ["Historical wins", "HW"],
  ["Recorded win rate", "W%"], ["Top 2", "T2"], ["Avg. finish", "Avg"],
];
const standingsHead = () => STANDINGS_COLUMNS.map(([long, short]) => long === short
  ? `<th>${long}</th>`
  : `<th title="${long}"><span class="th-long">${long}</span><span class="th-short" aria-hidden="true">${short}</span></th>`).join("");

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
    <section class="card">
      ${heading("ALL-TIME TABLE", "Player standings", "Sorted by recorded wins, then historical wins")}
      <div class="table-wrap"><table>
        <thead><tr>${standingsHead()}</tr></thead>
        <tbody>${standings}</tbody>
      </table></div>
      <p class="table-key" aria-hidden="true">GP games · W wins · HW historical wins · W% win rate · T2 top-two finishes · Avg average finish</p>
    </section>
    ${tiles([
      ["GAMES RECORDED", games.length, games.length === 1 ? "match in the archive" : "matches in the archive"],
      ["MOST WINS", champion ? champion.name : "—", champion ? `${plural(champion.detailedWins, "recorded win")}${champion.historicalWins ? ` · ${champion.historicalWins} historical` : ""}` : "No results yet"],
      ["STRONGEST DECK", strongest ? strongest.name : "—", strongest ? `${players(strongest)} · ${plural(strongest.wins, "win")} · ${percent(strongest.wins, strongest.games)} rate` : "No results yet"],
      ["MOST PLAYED DECK", mostPlayed ? mostPlayed.name : "—", mostPlayed ? `${players(mostPlayed)} · ${plural(mostPlayed.games, "appearance")}` : "No results yet"],
    ])}
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
  const portrait = playerInfo(player.name).portrait;
  document.title = `${player.name} · MTG Leaderboard`;
  return `
    ${backLink("player")}
    <section class="hero${slides.length ? " has-art" : ""}"${styleAttr(manaVar(playerColors(player)))}>
      ${slides.length ? `<span class="hero-slides" aria-hidden="true">${slides.map((slide) => `<span class="hero-slide" data-label="${escapeHtml(slide.label)}"${styleAttr(artVar(slide.picture), focusVar(slide.focus))}></span>`).join("")}</span>` : ""}
      ${slides.length > 1 ? `<span class="hero-wipe" aria-hidden="true"></span><span class="hero-showing">${escapeHtml(slides[0].label)}</span>` : ""}
      <span class="hero-portrait">${portrait ? `<a class="zoomable" href="${escapeHtml(portrait.full)}" data-zoom="${escapeHtml(portrait.full)}" data-zoom-alt="${escapeHtml(player.name)}" aria-label="Enlarge ${escapeHtml(player.name)}'s photo">${avatar(player.name, "avatar-large")}</a>` : avatar(player.name, "avatar-large")}${loyalty(player.wins, "Total wins", "loyalty-large")}</span>
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
    ...(info.art ? [`<a class="deck-art" href="${escapeHtml(info.art.full)}" data-zoom="${escapeHtml(info.art.full)}"><img src="${escapeHtml(info.art.full)}" alt="${escapeHtml(deck.name)} art"></a>`] : []),
    ...(info.cards || []).map((card) => `<a class="deck-printing" href="${escapeHtml(card.full)}" data-zoom="${escapeHtml(card.full)}"><img src="${escapeHtml(card.full)}" alt="${escapeHtml(info.commander || deck.name)} card" loading="lazy"></a>`),
  ];
  document.title = `${deck.name} · MTG Leaderboard`;
  return `
    ${backLink("deck")}
    <section class="hero${info.art ? " has-art" : ""}"${styleAttr(artVar(info.art), focusVar(info.art_focus), manaVar(colors))}>
      ${info.sound ? soundButton(info.sound, info.volume) : ""}
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
  return `${backLink()}<div class="empty">${escapeHtml(message)}</div>`;
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

/* What the embers and bursts are made of; applyTheme() narrows it to a deck's
   colours. startEmbers() fills in setColors once it is running. */
/* Colourless bursts too, on every page. */
const embers = { colors: [], bursts: [...MANA_ORDER, "C"], setColors: () => {}, burst: () => {} };

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
    /* A frame's timestamp can fall just before begun, hence the floor. */
    const progress = Math.min(Math.max((now - begun) / 900, 0), 1);
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
  /* The intro handles the visible panels in order after the sigil lands.
     Sections below the fold keep their usual scroll-triggered entrances. */
  const intro = Boolean(document.querySelector(".grimoire"));
  const later = (element) => !intro || element.getBoundingClientRect().top >= window.innerHeight;
  const singles = [...app.querySelectorAll(".page-header, .hero, .card, .section-heading")].filter(later);
  const rows = [...app.querySelectorAll(".summary, .deck-card, .game-card, .deck-gallery > a")].filter(later);
  for (const element of singles) element.classList.add("reveal");
  for (const element of rows) {
    element.classList.add("reveal");
    const place = [...element.parentElement.children].indexOf(element);
    element.style.setProperty("--delay", `${(place % 8) * 70}ms`);
  }
  for (const chart of app.querySelectorAll(".bar-chart")) {
    chart.querySelectorAll(".bar-fill").forEach((bar, index) => { bar.style.transitionDelay = `${150 + index * 60}ms`; });
    if (later(chart)) revealObserver.observe(chart);
    else chart.classList.add("is-grown");
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
   the page and shying away from the pointer. Now and then a mana burst: one
   colour's symbol flares at a random spot with a shockwave and a spray of
   sparks, and its node on the sigil flares with it. Clicking the empty
   background sets one off there. One canvas, redrawn each frame; browsers
   stop the frames while the tab is hidden. Left out for reduced motion. */
function startEmbers() {
  const canvas = document.querySelector("#embers");
  if (!canvas || reducedMotion.matches) return;
  const context = canvas.getContext("2d");
  const root = getComputedStyle(document.documentElement);
  const manaColor = Object.fromEntries([...MANA_ORDER, "C"].map((color) => [color, root.getPropertyValue(`--mana-${color.toLowerCase()}`).trim()]));
  const allColors = [...MANA_ORDER.map((color) => manaColor[color]), "#e3bb7a", "#e3bb7a"];
  embers.colors = allColors;
  /* A deck's colours plus its theme's accent; none means all five again. */
  embers.setColors = (letters) => {
    /* A theme may recolour colourless, as the void does. */
    manaColor.C = getComputedStyle(document.documentElement).getPropertyValue("--mana-c").trim() || manaColor.C;
    const chosen = letters.map((color) => color.toUpperCase()).filter((color) => color in manaColor);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--bronze-light").trim() || "#e3bb7a";
    embers.colors = chosen.length ? [...chosen.map((color) => manaColor[color]), accent] : allColors;
    embers.bursts = chosen.length ? chosen : [...MANA_ORDER, "C"];
    for (const mote of motes) mote.color = embers.colors[Math.floor(Math.random() * embers.colors.length)];
  };
  const pointer = { x: -1e4, y: -1e4 };
  const sparks = [];
  const rings = [];
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
    color: embers.colors[Math.floor(Math.random() * embers.colors.length)],
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

  /* Only a burst someone set off makes a sound; the random ones are silent. */
  const burst = (x, y, color = embers.bursts[Math.floor(Math.random() * embers.bursts.length)], front = false, silent = false) => {
    const tint = manaColor[color];
    if (!silent) playManaSound(color);
    for (let index = 0; index < 42; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 70 + Math.random() * 260;
      sparks.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, age: 0, life: 0.7 + Math.random() * 0.9, radius: 0.8 + Math.random() * 1.8, color: tint });
    }
    rings.push({ x, y, age: 0, life: 1.1, size: 90 + Math.random() * 70, color: tint });
    const symbol = document.createElement("i");
    symbol.className = `ms ms-${color.toLowerCase()} mana-burst${front ? " is-front" : ""}`;
    symbol.setAttribute("aria-hidden", "true");
    symbol.style.cssText = `left:${x}px;top:${y}px;--mana:${tint}`;
    symbol.addEventListener("animationend", () => symbol.remove());
    document.body.append(symbol);
    /* The node flares, then rejoins the slow pulse around the wheel. */
    const node = document.querySelector(`.sigil-symbol[data-color="${color.toLowerCase()}"]`);
    replay(node, "is-flaring");
    clearTimeout(node?.flareTimer);
    if (node) node.flareTimer = setTimeout(() => node.classList.remove("is-flaring"), 1700);
  };
  embers.burst = burst;
  /* A burst every few seconds, somewhere on screen, while the tab is shown. */
  const scheduleBurst = () => setTimeout(() => {
    if (!document.hidden) burst(width * (0.06 + Math.random() * 0.88), height * (0.1 + Math.random() * 0.8), undefined, false, true);
    scheduleBurst();
  }, 2600 + Math.random() * 4200);
  scheduleBurst();
  /* Inspect the original target before navigation can replace the page. */
  document.addEventListener("click", (event) => {
    if (!isEmptyManaClick(event)) return;
    if (event.target === document.body || event.target === document.documentElement || event.target === app) {
      burst(event.clientX, event.clientY);
      return;
    }
    if (!app.contains(event.target)) return;
    burst(event.clientX, event.clientY, undefined, true);
  }, true);

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
    /* Burst sparks slow as they fly and lift a little as they fade. */
    for (let index = sparks.length - 1; index >= 0; index -= 1) {
      const spark = sparks[index];
      spark.age += seconds;
      if (spark.age >= spark.life) {
        sparks.splice(index, 1);
        continue;
      }
      const drag = Math.pow(0.12, seconds);
      spark.vx *= drag;
      spark.vy = spark.vy * drag - 18 * seconds;
      spark.x += spark.vx * seconds;
      spark.y += spark.vy * seconds;
      const alpha = 1 - spark.age / spark.life;
      context.fillStyle = spark.color;
      context.globalAlpha = alpha * 0.25;
      context.beginPath();
      context.arc(spark.x, spark.y, spark.radius * 4, 0, Math.PI * 2);
      context.fill();
      context.globalAlpha = alpha;
      context.beginPath();
      context.arc(spark.x, spark.y, spark.radius, 0, Math.PI * 2);
      context.fill();
    }
    for (let index = rings.length - 1; index >= 0; index -= 1) {
      const ring = rings[index];
      ring.age += seconds;
      if (ring.age >= ring.life) {
        rings.splice(index, 1);
        continue;
      }
      const progress = ring.age / ring.life;
      context.strokeStyle = ring.color;
      context.globalAlpha = (1 - progress) * 0.7;
      context.lineWidth = 0.6 + (1 - progress) * 2.4;
      context.beginPath();
      context.arc(ring.x, ring.y, ring.size * (1 - (1 - progress) ** 3), 0, Math.PI * 2);
      context.stroke();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------- settings -- */

const MANA_CLICK_EXCLUSIONS = "a, button, input, select, textarea, label, summary, audio, video, iframe, [role], [tabindex], [onclick], [contenteditable]:not([contenteditable='false']), [data-zoom], .editor-card, .settings, dialog, .lightbox, .grimoire";
function isEmptyManaClick(event) {
  return event.isTrusted && !event.button && event.detail > 0 && !event.defaultPrevented &&
    !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
    !event.target.closest(MANA_CLICK_EXCLUSIONS);
}
const SOUND_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="sound-cone" d="M4 9h4l5-4v14l-5-4H4z"/><path class="sound-waves" d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/><path class="sound-slash" d="M16 9l6 6M22 9l-6 6"/></svg>';
const MIN_VOLUME_DB = -60;
// Stored site levels remain linear percentages for existing published sites.
const dbToGain = (db) => db <= MIN_VOLUME_DB ? 0 : 10 ** (db / 20);
const percentToDb = (percent) => percent > 0 ? Math.max(MIN_VOLUME_DB, 20 * Math.log10(percent / 100)) : MIN_VOLUME_DB;
// Display the position as 0–100%, while the audio gain still follows the dB curve.
const volumeLabel = (db) => `${Math.round((db - MIN_VOLUME_DB) / -MIN_VOLUME_DB * 100)}%`;

/* Two volumes multiply into every sound here. The site's is set in the
   editor on /public and published as settings.json, so it is the same for
   everyone. The visitor's, from the speaker in the corner, runs from nothing to
   the site's level and is remembered by their browser. Each deck's own level,
   and the intro's, apply on top of both. */
const SITE_VOLUME_DEFAULT = 100;
let siteVolume = SITE_VOLUME_DEFAULT;
let visitorVolume = 0;
let visitorMuted = false;
try {
  const saved = localStorage.getItem("visitor-volume-db");
  const legacy = localStorage.getItem("visitor-volume");
  if (saved !== null && Number(saved) >= MIN_VOLUME_DB && Number(saved) <= 0) visitorVolume = Number(saved);
  else if (legacy !== null && Number(legacy) >= 0 && Number(legacy) <= 100) visitorVolume = percentToDb(Number(legacy));
  visitorMuted = localStorage.getItem("visitor-muted") === "1";
} catch (error) { /* full each visit */ }
const volumeShare = () => visitorMuted ? 0 : (siteVolume / 100) * dbToGain(visitorVolume);
loadJson("settings.json").then((saved) => {
  const volume = Number(saved.volume);
  if (saved.volume !== undefined && volume >= 0 && volume <= 100) siteVolume = volume;
  applySiteVolume();
}).catch(() => { /* none published: the default */ });

/* One labelled slider; the editor on /public adds the site's to the panel. */
const volumeRow = (label, value, attribute) => `<label class="settings-volume"><span>${label}</span>
  <input type="range" ${attribute} min="${MIN_VOLUME_DB}" max="0" step="1" value="${Math.round(value)}"><output>${volumeLabel(value)}</output></label>`;
function paintSlider(input) {
  input.style.setProperty("--fill", `${(Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100}%`);
  input.nextElementSibling.textContent = volumeLabel(Number(input.value));
  input.setAttribute("aria-valuetext", volumeLabel(Number(input.value)));
}

const settings = document.createElement("div");
settings.className = "settings";
settings.innerHTML = `<button type="button" class="settings-toggle" aria-expanded="false" aria-controls="settings-panel" title="Sound settings">
    ${SOUND_ICON}<span class="visually-hidden">Sound settings</span></button>
  <div class="settings-panel" id="settings-panel" hidden>
    <span class="eyebrow">SOUND</span>
    ${volumeRow("Volume", visitorVolume, "data-visitor-volume")}
    <button type="button" class="settings-mute" aria-pressed="false">Mute all sounds</button>
    <p>All sounds, including the intro. 100% is full volume.</p>
  </div>`;
document.body.append(settings);
const settingsToggle = settings.querySelector(".settings-toggle");
const settingsPanel = settings.querySelector(".settings-panel");
const volumeSlider = settings.querySelector("[data-visitor-volume]");
paintSlider(volumeSlider);
const muteToggle = settings.querySelector(".settings-mute");
function paintMute() {
  settingsToggle.dataset.muted = String(volumeShare() === 0);
  muteToggle.setAttribute("aria-pressed", String(visitorMuted));
  muteToggle.textContent = visitorMuted ? "Unmute all sounds" : "Mute all sounds";
}
paintMute();
muteToggle.addEventListener("click", () => {
  visitorMuted = !visitorMuted;
  try { localStorage.setItem("visitor-muted", visitorMuted ? "1" : "0"); } catch (error) { /* this visit only */ }
  applySiteVolume();
});

function openSettings(open) {
  settingsPanel.hidden = !open;
  settingsToggle.setAttribute("aria-expanded", String(open));
}
settingsToggle.addEventListener("click", () => openSettings(settingsPanel.hidden));
document.addEventListener("click", (event) => {
  if (!settingsPanel.hidden && !settings.contains(event.target)) openSettings(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !settingsPanel.hidden) {
    openSettings(false);
    settingsToggle.focus();
  }
});
/* Changes as it slides; a click on letting go is a sample of the new level. */
volumeSlider.addEventListener("input", () => {
  visitorVolume = Number(volumeSlider.value);
  paintSlider(volumeSlider);
  applySiteVolume();
});
volumeSlider.addEventListener("change", () => {
  try { localStorage.setItem("visitor-volume-db", String(visitorVolume)); } catch (error) { /* this visit only */ }
  thud();
});

/* One low-latency context and master gain for all short effects and the intro.
   Decode files ahead of taps; never queue an old click behind a download. */
const siteAudio = { context: null, master: null, buffers: new Map(), decoded: new Map(), voices: new Set(), noise: new Map() };
function audioContext() {
  if (!siteAudio.context) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    try {
      siteAudio.context = new Context({ latencyHint: "interactive" });
      siteAudio.master = siteAudio.context.createGain();
      siteAudio.master.gain.value = volumeShare();
      siteAudio.master.connect(siteAudio.context.destination);
    } catch (error) { return null; }
  }
  return siteAudio.context;
}
function applySiteVolume() {
  const context = siteAudio.context;
  if (context) {
    siteAudio.master.gain.cancelScheduledValues(context.currentTime);
    siteAudio.master.gain.setTargetAtTime(volumeShare(), context.currentTime, 0.005);
  }
  applyDeckVolume();
  paintMute();
  document.dispatchEvent(new Event("sitevolumechange"));
}
function unlockAudio() {
  siteAudio.activated = true;
  const context = audioContext();
  if (context && context.state !== "running") context.resume().catch(() => {});
}
for (const type of ["pointerdown", "keydown", "click"]) {
  document.addEventListener(type, unlockAudio, { capture: true, passive: true });
}
function audioBuffer(url) {
  const context = audioContext();
  if (!url || !context) return Promise.resolve(null);
  if (!siteAudio.buffers.has(url)) {
    siteAudio.buffers.set(url, fetch(url).then((response) => {
      if (!response.ok) throw new Error(`Could not load audio (${response.status})`);
      return response.arrayBuffer();
    }).then((data) => new Promise((resolve, reject) => context.decodeAudioData(data, resolve, reject)))
      .then((buffer) => { siteAudio.decoded.set(url, buffer); return buffer; })
      .catch(() => { siteAudio.buffers.delete(url); return null; }));
  }
  return siteAudio.buffers.get(url);
}
function playEffect(url, level, rate = 1) {
  const context = audioContext();
  const buffer = siteAudio.decoded.get(url);
  if (!buffer) { audioBuffer(url); return false; }
  if (!context || context.state !== "running" || volumeShare() === 0) return false;
  // Bound overlapping samples on phones, especially long custom mana clips.
  if (siteAudio.voices.size >= 8) {
    const oldest = siteAudio.voices.values().next().value;
    oldest.stop();
    siteAudio.voices.delete(oldest);
  }
  const source = context.createBufferSource();
  const gain = context.createGain();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  gain.gain.value = level;
  source.connect(gain).connect(siteAudio.master);
  siteAudio.voices.add(source);
  source.onended = () => { source.disconnect(); gain.disconnect(); siteAudio.voices.delete(source); };
  source.start();
  return true;
}

/* Commander clips can wait for decoding and Android's asynchronous resume.
   A request token prevents an old page/preview from starting after Stop. */
function createClipPlayer() {
  const events = new EventTarget();
  let url = "", request = 0, source = null, gain = null, level = 1;
  const player = {
    paused: true, loading: false, error: null,
    addEventListener: (...args) => events.addEventListener(...args),
    get src() { return url; },
    set src(value) {
      if (url === value) return;
      url = value;
      player.error = null;
      player.pause();
      if (url) audioBuffer(url);
    },
    get volume() { return level; },
    set volume(value) {
      level = Math.min(1, Math.max(0, value));
      if (gain) gain.gain.setTargetAtTime(level, audioContext().currentTime, 0.005);
    },
    pause() {
      request += 1;
      if (source) { source.onended = null; source.stop(); source.disconnect(); }
      gain?.disconnect();
      source = gain = null;
      player.paused = true;
      player.loading = false;
      events.dispatchEvent(new Event("pause"));
    },
    async play() {
      player.pause();
      const token = request;
      const context = audioContext();
      player.error = null;
      player.paused = false;
      player.loading = true;
      events.dispatchEvent(new Event("loading"));
      try {
        if (!context || !url) throw new Error("Audio is unavailable");
        // Invoke resume before the first await, inside the user's gesture.
        const awake = context.state === "running" ? Promise.resolve() : context.resume();
        const [buffer] = await Promise.all([audioBuffer(url), awake]);
        if (token !== request) return;
        if (!buffer) throw new Error("Could not load this sound. Tap to retry.");
        if (context.state !== "running") throw new Error("Tap to enable sound");
        gain = context.createGain();
        gain.gain.value = level;
        source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(gain).connect(siteAudio.master);
        source.onended = () => {
          if (token !== request) return;
          source.disconnect();
          gain.disconnect();
          source = gain = null;
          player.paused = true;
          events.dispatchEvent(new Event("ended"));
        };
        source.start();
        player.loading = false;
        events.dispatchEvent(new Event("play"));
      } catch (error) {
        if (token !== request) return;
        player.pause();
        player.error = error;
        events.dispatchEvent(new Event("error"));
        throw error;
      }
    },
  };
  return player;
}

/* ----------------------------------------------------------- deck sound -- */

/* A deck's page plays its commander's sound as it opens, the one the table
   plays when that commander is revealed. Browsers keep a page silent until
   the visitor has clicked something, so a deck opened straight from a link
   waits for its button. Turning the sound off is remembered. Each deck can
   set its own volume in percent; without one it plays at DECK_SOUND_VOLUME,
   which mirrors ROSTER_SOUND_VOLUME_DEFAULT in web.py. */
const DECK_SOUND_VOLUME = 80;
const deckSound = createClipPlayer();
/* This deck's own level, 0 to 1, before the site volume scales it. */
let deckVolume = DECK_SOUND_VOLUME / 100;
const applyDeckVolume = () => { deckSound.volume = deckVolume; };
let deckSoundRoute = null;
let soundMuted = false;
try { soundMuted = localStorage.getItem("deck-sound-muted") === "1"; } catch (error) { /* never remembered */ }

function soundButton(url, volume) {
  return `<button type="button" class="hero-sound" data-sound="${escapeHtml(url)}" data-volume="${Number(volume) || DECK_SOUND_VOLUME}">${SOUND_ICON}<span></span></button>`;
}

/* The button reads off, playing, or ready to play again. */
function paintSoundButton() {
  const button = app.querySelector(".hero-sound");
  if (!button) return;
  const state = soundMuted ? "off" : deckSound.error ? "error" : deckSound.loading ? "loading" : deckSound.paused ? "ready" : "playing";
  const labels = { off: "Sound off", ready: "Play sound", playing: "Stop sound", loading: "Loading sound…", error: "Retry sound" };
  button.dataset.state = state;
  button.querySelector("span").textContent = labels[state];
  button.title = deckSound.error?.message || (state === "off" ? "Turn deck sounds back on" : state === "loading" ? "Cancel loading" : state === "playing" ? "Stop, and keep deck pages quiet" : "Play the commander's sound");
}

function playDeckSound() {
  deckSound.play().catch(() => { /* The button shows the error and offers a retry. */ }).finally(paintSoundButton);
}

/* Start once on entering a deck; an editor redraw must not restart its clip. */
function startDeckSound() {
  const button = app.querySelector(".hero-sound");
  if (!button) {
    deckSound.pause();
    deckSoundRoute = null;
    return;
  }
  const routeKey = `${window.location.hash}|${button.dataset.sound}`;
  const changed = routeKey !== deckSoundRoute;
  if (changed) deckSound.pause();
  deckSound.src = button.dataset.sound;
  deckVolume = Math.min(Math.max(Number(button.dataset.volume) / 100, 0), 1);
  applyDeckVolume();
  /* Under the opening it waits: playGrimoire() starts it as the book goes. */
  if (document.querySelector(".grimoire")) {
    deckSound.pause();
    deckSoundRoute = null;
  } else {
    deckSoundRoute = routeKey;
    if (soundMuted || volumeShare() === 0) deckSound.pause();
    else if (changed && (siteAudio.activated || audioContext()?.state === "running")) playDeckSound();
  }
  paintSoundButton();
}

for (const event of ["loading", "play", "pause", "ended", "error"]) deckSound.addEventListener(event, paintSoundButton);

/* Warm every sound used by a deck after the intro, so a phone doesn't have to
   fetch and decode it at the moment the visitor opens that deck. */
let commanderAudioWarmup = false;
let rosterImageWarmup = false;
function warmCommanderAudio() {
  if (commanderAudioWarmup) return;
  if (!rosterReady) {
    setTimeout(warmCommanderAudio, 300);
    return;
  }
  commanderAudioWarmup = true;
  const urls = [...new Set([...roster.decks.values()].map((info) => info.sound).filter(Boolean))];
  // Keep network and decode work off the animation and limit mobile CPU spikes.
  let next = 0;
  const worker = async () => {
    while (next < urls.length) await audioBuffer(urls[next++]);
  };
  Promise.all([worker(), worker()]);
}
function warmRosterImages() {
  if (rosterImageWarmup || !rosterReady) return;
  rosterImageWarmup = true;
  const urls = new Set();
  const addPicture = (picture) => {
    if (typeof picture === "string") urls.add(picture);
    else if (picture && typeof picture === "object") {
      for (const size of ["thumb", "full"]) if (picture[size]) urls.add(picture[size]);
    }
  };
  for (const group of [roster.players, roster.decks]) {
    for (const entry of group.values()) {
      for (const key of ["portrait", "background", "art"]) addPicture(entry[key]);
      for (const picture of entry.cards || []) addPicture(picture);
    }
  }
  const images = [...urls];
  let next = 0;
  const loadOne = (url) => new Promise((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.fetchPriority = "low";
    const finish = () => {
      image.onload = image.onerror = null;
      resolve();
    };
    image.onload = finish;
    image.onerror = finish;
    image.src = url;
    if (image.complete) finish();
  });
  const worker = async () => {
    while (next < images.length) await loadOne(images[next++]);
  };
  Promise.all(Array.from({ length: Math.min(4, images.length) }, worker));
}
function scheduleSiteAssetWarmup() {
  const start = () => warmCommanderAudio();
  const images = () => warmRosterImages();
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(start, { timeout: 1200 });
    requestIdleCallback(images, { timeout: 1200 });
  } else setTimeout(() => { start(); images(); }, 250);
}

/* These still help if a deck opens before the background warmup reaches it. */
function prepareDeckSound(event) {
  const link = event.target.closest("a[href^='#/deck/']");
  if (!link) return;
  prepareDeckSoundLink(link);
}

function prepareDeckSoundLink(link) {
  try {
    const info = deckInfo(decodeURIComponent(link.getAttribute("href").slice("#/deck/".length)));
    if (info.sound) audioBuffer(info.sound);
  } catch (error) { /* Ignore malformed hand-written links. */ }
}
for (const event of ["pointerdown", "pointerover", "focusin"]) app.addEventListener(event, prepareDeckSound);

app.addEventListener("click", (event) => {
  if (!event.target.closest(".hero-sound")) return;
  const playing = !soundMuted && !deckSound.paused;
  soundMuted = playing;
  try { localStorage.setItem("deck-sound-muted", soundMuted ? "1" : "0"); } catch (error) { /* this visit only */ }
  if (playing) deckSound.pause();
  else playDeckSound();
  paintSoundButton();
});

/* ----------------------------------------------------------- mana sound -- */

/* A mana burst someone sets off, with a click or a touch, makes a small sound
   of its colour's own; the ones that come on their own stay silent. Which
   sound and how loud is chosen per colour in the editor on /public and published as
   mana_sounds.json: "" is the built-in sound below, "none" silence, anything
   else a file. Both volumes and the global mute apply. The editor changes manaSounds as you edit, so the
   bursts on its page already sound the way they will once saved. */
const MANA_SOUND_DEFAULT_VOLUME = 60;
const manaSounds = Object.fromEntries([...MANA_ORDER, "C"].map((color) => [color, { sound: "", volume: MANA_SOUND_DEFAULT_VOLUME }]));
loadJson("mana_sounds.json").then((saved) => {
  for (const color of Object.keys(manaSounds)) {
    const entry = saved[color];
    if (!entry) continue;
    if (typeof entry.sound === "string") manaSounds[color].sound = entry.sound;
    if (Number(entry.volume) >= 0 && Number(entry.volume) <= 100) manaSounds[color].volume = Number(entry.volume);
    if (entry.sound && entry.sound !== "none") audioBuffer(entry.sound);
  }
}).catch(() => { /* none published: every colour built in */ });

/* The built-in sounds, made here rather than loaded: White a bright bell,
   Blue a watery bloop, Black a low dark swell, Red a crackle of fire, Green a
   woody pluck, colourless a hollow metallic ping. */
function synthMana(color, level) {
  const manaAudio = audioContext();
  if (!manaAudio || manaAudio.state !== "running") return;
  const now = manaAudio.currentTime;
  const output = manaAudio.createGain();
  output.gain.value = level;
  output.connect(siteAudio.master);
  let active = 0;
  const track = (source, nodes) => {
    active += 1;
    source.onended = () => {
      for (const node of [source, ...nodes]) node.disconnect();
      if (--active === 0) output.disconnect();
    };
  };
  const tone = (type, from, to, start, length, peak, filter) => {
    const oscillator = manaAudio.createOscillator();
    const gain = manaAudio.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, now + start);
    if (to !== from) oscillator.frequency.exponentialRampToValueAtTime(to, now + start + length * 0.6);
    gain.gain.setValueAtTime(0.0001, now + start);
    gain.gain.exponentialRampToValueAtTime(peak, now + start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + length);
    let chain = oscillator.connect(gain);
    const nodes = [gain];
    if (filter) {
      const shaped = manaAudio.createBiquadFilter();
      shaped.type = "lowpass";
      shaped.frequency.value = filter;
      chain = chain.connect(shaped);
      nodes.push(shaped);
    }
    chain.connect(output);
    track(oscillator, nodes);
    oscillator.start(now + start);
    oscillator.stop(now + start + length + 0.05);
  };
  const noise = (length, type, frequency, peak, crackle = false) => {
    const key = `${length}:${crackle}`;
    if (!siteAudio.noise.has(key)) {
      const samples = Math.floor(manaAudio.sampleRate * length);
      const buffer = manaAudio.createBuffer(1, samples, manaAudio.sampleRate);
      const data = buffer.getChannelData(0);
      for (let index = 0; index < samples; index += 1) {
        const fade = (1 - index / samples) ** 2;
        data[index] = (Math.random() * 2 - 1) * fade * (crackle ? (Math.random() < 0.06 ? 1 : 0.15) : 1);
      }
      siteAudio.noise.set(key, buffer);
    }
    const source = manaAudio.createBufferSource();
    const shaped = manaAudio.createBiquadFilter();
    const gain = manaAudio.createGain();
    source.buffer = siteAudio.noise.get(key);
    shaped.type = type;
    shaped.frequency.value = frequency;
    gain.gain.value = peak;
    source.connect(shaped).connect(gain).connect(output);
    track(source, [shaped, gain]);
    source.start(now);
  };
  if (color === "W") {
    tone("sine", 1046.5, 1046.5, 0, 0.9, 0.5);
    tone("sine", 1568, 1568, 0.01, 0.7, 0.22);
    tone("sine", 2093, 2093, 0.02, 0.4, 0.08);
  } else if (color === "U") {
    tone("sine", 320, 760, 0, 0.3, 0.6);
    tone("sine", 430, 980, 0.09, 0.24, 0.3);
  } else if (color === "B") {
    tone("sine", 82, 64, 0, 0.95, 0.8, 500);
    tone("triangle", 123, 96, 0.02, 0.8, 0.35, 380);
  } else if (color === "R") {
    noise(0.38, "bandpass", 1800, 1.1, true);
    tone("sine", 110, 45, 0, 0.25, 0.7);
  } else if (color === "G") {
    tone("triangle", 196, 180, 0, 0.5, 0.6);
    tone("sine", 294, 280, 0.005, 0.4, 0.3);
    noise(0.03, "lowpass", 2000, 0.35);
  } else {
    tone("sine", 1320, 1320, 0, 0.75, 0.3);
    tone("sine", 1840, 1840, 0, 0.6, 0.2);
    tone("sine", 2760, 2760, 0, 0.4, 0.1);
    tone("sine", 220, 210, 0, 0.6, 0.25);
  }
}

function playManaSound(color, setting = manaSounds[color]) {
  if (!setting || setting.sound === "none" || volumeShare() === 0) return;
  const level = setting.volume / 100;
  if (level <= 0) return;
  if (!setting.sound || !playEffect(setting.sound, level)) {
    synthMana(color, level);
  }
}

/* ------------------------------------------------------------- ui sound -- */

/* Every click through the site makes the life tracker's own button click
   (sound/click.mp3, copied beside this page); going back plays it a little
   slower and lower. The decoded sample is reused by the shared audio engine. */
const CLICK_VOLUME = 0.8;
audioBuffer("click.mp3");

function thud(back = false) {
  if (volumeShare() === 0) return;
  playEffect("click.mp3", CLICK_VOLUME, back ? 0.78 : 1);
}

/* Anything clickable clicks as it is pressed; a back link clicks deeper. The
   deck sound button stays quiet, as it plays a sound of its own. */
let lastThud = 0;
document.addEventListener("click", (event) => {
  const target = event.target.closest("a, button, select, summary, [role='button'], .editor-mana, .editor-upload, .grimoire");
  if (!target || target.disabled || target.closest(".hero-sound, .settings-mute")) return;
  lastThud = performance.now();
  thud(Boolean(target.closest(".back-link, .lightbox-close")));
}, true);
/* A page change nobody clicked for is the browser's back or forward. */
window.addEventListener("hashchange", () => {
  if (performance.now() - lastThud > 400) thud(true);
});

/* ------------------------------------------------------------- glyphs -- */

/* The Eldrazi theme's alien script: each glyph a stem with rings, dots,
   bars, arcs and ticks hung on it, drawn at random once per visit. A wall of
   them, carved, goes into --glyph-wall for the background; a glowing line of
   them into --glyph-band, under a deck's name (see site.css). */
function alienGlyph(x, y, w, h) {
  const n = (value) => value.toFixed(1);
  const ring = (cx, cy, r) => `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(r * 2)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-r * 2)} 0`;
  const mid = x + w / 2;
  const lean = (Math.random() - 0.5) * w * 0.5;
  const parts = [`M${n(mid - lean / 2)} ${n(y)}L${n(mid + lean / 2)} ${n(y + h)}`];
  const at = (share) => [mid - lean / 2 + lean * share, y + h * share];
  for (const share of [0.15 + Math.random() * 0.2, 0.55 + Math.random() * 0.3]) {
    const [sx, sy] = at(share);
    const shape = Math.random();
    if (shape < 0.25) parts.push(ring(sx + (Math.random() < 0.5 ? -1 : 1) * w * 0.32, sy, w * 0.16));
    else if (shape < 0.45) parts.push(`M${n(sx - w * 0.45)} ${n(sy)}L${n(sx + w * 0.45)} ${n(sy)}`);
    else if (shape < 0.6) parts.push(`M${n(sx - w * 0.4)} ${n(sy - h * 0.12)}Q${n(sx)} ${n(sy + h * 0.2)} ${n(sx + w * 0.4)} ${n(sy - h * 0.12)}`);
    else if (shape < 0.78) parts.push(`M${n(sx)} ${n(sy)}L${n(sx + (Math.random() < 0.5 ? -1 : 1) * w * 0.45)} ${n(sy + h * 0.18)}`);
  }
  if (Math.random() < 0.55) parts.push(ring(...(Math.random() < 0.5 ? at(0) : at(1)), w * 0.13));
  return parts.join("");
}

function glyphLine(x, y, width, w, h) {
  let d = "";
  for (let along = x; along < x + width - w; along += w * 1.35) {
    d += alienGlyph(along, y, w, h);
    if (Math.random() < 0.16) along += w * 1.2;
  }
  return d;
}

const svgUrl = (markup) => `url("data:image/svg+xml,${encodeURIComponent(markup)}")`;

function inscribeGlyphs() {
  /* The wall: rows of script between carved rules, a dark stroke under a
     pale one so it reads as cut into stone. */
  let rows = "";
  for (let y = 18; y < 420; y += 52) rows += glyphLine(10, y, 440, 11, 22) + `M0 ${y + 36}H460`;
  const wall = `<svg xmlns="http://www.w3.org/2000/svg" width="460" height="420" fill="none" stroke-linecap="round">`
    + `<path d="${rows}" stroke="#000" stroke-opacity=".6" stroke-width="1.6" transform="translate(1 1.2)"/>`
    + `<path d="${rows}" stroke="#efe4cc" stroke-opacity=".075" stroke-width="1.2"/></svg>`;
  const band = glyphLine(2, 2, 400, 7, 12);
  const line = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="16" fill="none" stroke-linecap="round">`
    + `<path d="${band}" stroke="#d9a8ff" stroke-width="1.1"/></svg>`;
  document.documentElement.style.setProperty("--glyph-wall", svgUrl(wall));
  document.documentElement.style.setProperty("--glyph-band", svgUrl(line));
}

/* ----------------------------------------------------------------- zoom -- */

/* A deck's art and card, and a player's photo, open large over the page
   instead of on a page of their own, with the rest of the site dimmed
   behind. The cross, a click beside the picture, Escape or the phone's back
   button closes it. The links keep their href, so a middle click still opens
   the file itself. */
const lightbox = document.createElement("dialog");
lightbox.className = "lightbox";
lightbox.innerHTML = '<button type="button" class="lightbox-close" aria-label="Close">&times;</button><img alt="">';
document.body.append(lightbox);
const lightboxImage = lightbox.querySelector("img");

function zoom(url, alt) {
  lightboxImage.src = url;
  lightboxImage.alt = alt || "";
  lightbox.showModal();
  /* An entry of its own, so going back closes the picture, not the page. */
  history.pushState({ ...history.state, zoom: true }, "");
}

app.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-zoom]");
  if (!trigger || event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  zoom(trigger.dataset.zoom, trigger.dataset.zoomAlt || trigger.querySelector("img")?.alt);
});
lightbox.addEventListener("click", (event) => {
  if (event.target !== lightboxImage) lightbox.close();
});
/* However it closed, step off the picture's history entry. */
lightbox.addEventListener("close", () => {
  lightboxImage.removeAttribute("src");
  if (history.state?.zoom) history.back();
});
window.addEventListener("popstate", () => {
  if (lightbox.open && !history.state?.zoom) lightbox.close();
});

/* --------------------------------------------------------------- router -- */

function route() {
  const [, kind, ...rest] = window.location.hash.replace(/^#/, "").split("/");
  let name = rest.join("/");
  try { name = decodeURIComponent(name); } catch (error) { /* a hand-typed % — use it as written */ }
  if (kind === "player" && name) app.innerHTML = playerView(name);
  else if (kind === "deck" && name) app.innerHTML = deckView(name);
  else app.innerHTML = homeView();
  const deck = kind === "deck" && name && stats.deckIndex.get(keyOf(name));
  if (deck) applyTheme(deckTheme(deck.name), deckColors(deck.name));
  else applyTheme("");
  startSlides();
  startDeckSound();
  revealOnScroll();
  afterRender();
}

/* A page newly opened records the one it was opened from in its history
   entry. Back and forward return to entries that already have theirs. */
let currentHash = window.location.hash;
window.addEventListener("hashchange", () => {
  if (!history.state || !("from" in history.state)) history.replaceState({ ...history.state, from: currentHash }, "");
  currentHash = window.location.hash;
  route();
  window.scrollTo(0, 0);
});

/* Going back to the page this one was opened from steps back through the
   history rather than adding to it, so the browser's back button agrees. */
app.addEventListener("click", (event) => {
  const link = event.target.closest(".back-link");
  if (!link || event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  if (history.state && routeOf(link.getAttribute("href")) === routeOf(history.state.from)) {
    event.preventDefault();
    history.back();
  }
});

async function loadJson(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status})`);
  return response.json();
}

/* ------------------------------------------------------------- grimoire -- */

/* The opening. A chained grimoire waits for a tap to release its lock and
   wake the audio. Then it rattles with a thud and its cover lifts a crack,
   light leaking out, as if something inside wants out. A second tap (or
   Enter) throws it open: curled pages riffle past, each rustling, scrawled
   with nonsense, down to the last, where the colour wheel is drawn in ink.
   The wheel catches light and everything else dims; it comes alive as the
   wheel this page wears, with the opening sound starting on its glow. It
   glides to its corner, then the title and standings fade in, in that order.

   Its sounds and timings come from intro.json, set in the editor on /public;
   INTRO_DEFAULTS mirrors INTRO_NUMBERS in web.py. index.html holds only the
   empty, opaque .grimoire, so nothing flashes before this builds the book. */
const INTRO_DEFAULTS = {
  chain: "", sound: "", thud: "", page: "", volume: 80, repeat: "always", rattle: 90, rattle_every: 0.7,
  pages: 18, shuffle_seconds: 1.8, glow_seconds: 2.5, flight_seconds: 1.6, rotation_speed: 2,
};
const introSettings = loadJson("intro.json").then((saved) => ({ ...INTRO_DEFAULTS, ...saved })).catch(() => ({ ...INTRO_DEFAULTS }));
/* 1x is one turn in 240 seconds; the current 2x default is 120 seconds. */
function applyIntroRotationSpeed(value) {
  const number = Number(value);
  const speed = Number.isFinite(number) ? Math.max(0.5, Math.min(8, number)) : INTRO_DEFAULTS.rotation_speed;
  document.documentElement.style.setProperty("--sigil-spin-duration", `${240 / speed}s`);
}
introSettings.then((settings) => applyIntroRotationSpeed(settings.rotation_speed));
const RUNES = "ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ";
/* Resolved once start() has drawn the page, theme and all, which the
   wheel's flight to its corner needs. */
let markPageReady = () => {};
const pageReady = new Promise((resolve) => { markPageReady = resolve; });
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/* The intro's sounds go through one audio context, so a riffle of page turns
   can be timed to the pages and every sound obeys the volume, iPhones
   included. Browsers keep it silent until the visitor first taps or clicks:
   the first tap releases the chain and wakes audio before any rattles begin.
   The second tap opens the now-unbound book. */
const introAudio = { get context() { return siteAudio.context; }, noise: null, decoded: siteAudio.decoded };

function introContext() {
  return audioContext();
}

/* A sound file named in intro.json, fetched and decoded once. */
function introBuffer(url) {
  return audioBuffer(url);
}

function noiseBuffer(context) {
  if (!introAudio.noise) {
    introAudio.noise = context.createBuffer(1, Math.round(context.sampleRate * 0.4), context.sampleRate);
    const samples = introAudio.noise.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) samples[index] = Math.random() * 2 - 1;
  }
  return introAudio.noise;
}

/* A gain that swells to peak and dies away, wired to the speakers. */
function envelope(context, when, peak, attack, release) {
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), when + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + attack + release);
  gain.connect(siteAudio.master);
  return gain;
}

function introChain(source, ...nodes) {
  let tail = source;
  for (const node of nodes) tail = tail.connect(node);
  source.addEventListener("ended", () => {
    for (const node of [source, ...nodes]) node.disconnect();
  }, { once: true });
}

/* What plays when no file is chosen: a heavy book's dull knock, and the
   swish of a page. */
const INTRO_SYNTH = {
  chain(context, when, level) {
    /* A short spill of uneven metal-on-metal clinks until a file is chosen. */
    return Array.from({ length: 10 }, (_, index) => {
      const clink = context.createOscillator();
      const at = when + index * 0.095 + Math.random() * 0.025;
      clink.type = "triangle";
      clink.frequency.setValueAtTime(1200 + Math.random() * 2300, at);
      introChain(clink, envelope(context, at, level * (0.15 - index * 0.009), 0.002, 0.09));
      clink.start(at);
      clink.stop(at + 0.12);
      return clink;
    });
  },
  thud(context, when, level) {
    const body = context.createOscillator();
    body.frequency.setValueAtTime(110, when);
    body.frequency.exponentialRampToValueAtTime(42, when + 0.16);
    introChain(body, envelope(context, when, level, 0.006, 0.3));
    body.start(when);
    body.stop(when + 0.34);
    /* A woody midrange impact stays audible on small phone speakers. */
    const tap = context.createOscillator();
    tap.type = "triangle";
    tap.frequency.setValueAtTime(460, when);
    tap.frequency.exponentialRampToValueAtTime(160, when + 0.08);
    introChain(tap, envelope(context, when, level * 0.35, 0.003, 0.12));
    tap.start(when);
    tap.stop(when + 0.14);
    const knock = context.createBufferSource();
    knock.buffer = noiseBuffer(context);
    const muffle = context.createBiquadFilter();
    muffle.type = "lowpass";
    muffle.frequency.value = 700;
    introChain(knock, muffle, envelope(context, when, level * 0.6, 0.003, 0.07));
    knock.start(when, Math.random() * 0.3, 0.09);
    return [body, tap, knock];
  },
  page(context, when, level) {
    const swish = context.createBufferSource();
    swish.buffer = noiseBuffer(context);
    swish.playbackRate.value = 0.8 + Math.random() * 0.5;
    const paper = context.createBiquadFilter();
    paper.type = "bandpass";
    paper.frequency.value = 1800 + Math.random() * 1600;
    paper.Q.value = 0.8;
    const length = 0.14 + Math.random() * 0.08;
    introChain(swish, paper, envelope(context, when, level * 0.55, 0.035, length));
    swish.start(when, Math.random() * 0.15, length + 0.06);
    return [swish];
  },
};

/* Plays an intro sound (chain, glow, thud or page turn), delay seconds
   from now, at the intro's volume under the site's and the visitor's. */
function introSound(kind, settings, delay = 0, level = 1, signal = null) {
  const context = introAudio.context;
  if (signal?.aborted || !context || context.state !== "running" || volumeShare() === 0) return;
  const volume = Math.min(Math.max(settings.volume / 100, 0), 1) * level;
  if (volume <= 0) return;
  const when = context.currentTime + delay;
  /* Short effects must land on time even if a mobile connection is still
     downloading their files. Use the built-in effect until decoding finishes. */
  const ready = introAudio.decoded.get(settings[kind]);
  const bufferReady = (ready || INTRO_SYNTH[kind]) ? Promise.resolve(ready) : introBuffer(settings[kind]);
  bufferReady.then((buffer) => {
    if (signal?.aborted || volumeShare() === 0) return;
    const start = Math.max(when, context.currentTime);
    if (buffer) {
      const source = context.createBufferSource();
      source.buffer = buffer;
      const gain = context.createGain();
      gain.gain.value = volume;
      if (kind === "chain") {
        gain.gain.setValueAtTime(volume, start);
        gain.gain.setValueAtTime(volume, start + 2.1);
        gain.gain.linearRampToValueAtTime(0, start + 2.5);
      }
      introChain(source, gain);
      gain.connect(siteAudio.master);
      source.start(start);
      if (kind === "chain") source.stop(start + Math.min(buffer.duration, 2.5));
      if (signal) {
        const stop = () => { source.stop(); };
        signal.addEventListener("abort", stop, { once: true });
        source.onended = () => { signal.removeEventListener("abort", stop); source.disconnect(); gain.disconnect(); };
      }
    } else if (INTRO_SYNTH[kind]) {
      for (const source of INTRO_SYNTH[kind](context, start, volume)) {
        if (!signal) continue;
        const stop = () => source.stop();
        signal.addEventListener("abort", stop, { once: true });
        source.onended = () => { signal.removeEventListener("abort", stop); source.disconnect(); };
      }
    }
  });
}

/* A line of cursive that is not quite any language: humps, cups, loops above
   and below the line, and gaps between "words", drifting a little. */
function scribble(x, y, width) {
  const n = (value) => value.toFixed(1);
  /* Repeated letterforms give the hand a consistent ductus. Each word has
     its own baseline and pen angle, with finer joins, dots and crossbars. */
  const letters = [
    "c -1 -4 3 -6 3 -3 c 0 3 -4 4 -3 1 m 3 -1 q -1 3 2 1",
    "c 3 -2 5 -11 2 -9 c -2 1 -2 12 2 7 q 3 -3 2 1",
    "c 4 -3 1 -5 0 -3 c -2 3 0 5 4 1",
    "q 2 -6 3 -3 q -3 9 -4 7 q -2 -2 4 -5 l 2 -1",
    "l 1 -4 q -2 7 2 3 m -1 -6 l .2 -.5 m 1 6 l 2 -1",
    "q 3 -7 3 -3 l -1 3 q 3 -7 4 -4 l -1 4 q 2 0 3 -2",
    "c 1 -2 0 -5 2 -4 q 2 1 3 0 m -4 3 q 1 3 4 0",
    "q 4 -12 3 -9 l -3 8 q 0 3 4 0 m -4 -4 l 5 -1 m -1 5 l 1 -1",
    "c 4 -5 1 -6 0 -3 c -1 2 4 1 3 3 q -2 2 -4 0 m 4 0 l 2 -1",
  ];
  let d = "";
  let along = x;
  while (along < x + width - 10) {
    const count = 2 + Math.floor(Math.random() * 7);
    const baseline = y + (Math.random() - 0.5) * 1.2;
    for (let letter = 0; letter < count && along < x + width - 10; letter += 1) {
      const form = Math.floor(Math.random() * letters.length);
      d += ` M${n(along)} ${n(baseline)} ${letters[form]}`;
      along += form === 5 ? 8 : 4 + Math.random() * 1.2;
    }
    along += 4 + Math.random() * 4;
  }
  return d;
}

/* A circle drawn by hand: a slightly uneven ring that overshoots its start. */
function wobblyCircle(cx, cy, r) {
  const points = 28;
  const start = Math.random() * Math.PI * 2;
  let d = "";
  for (let index = 0; index <= points + 2; index += 1) {
    const angle = start + index / points * Math.PI * 2;
    const radius = r * (1 + (Math.random() - 0.5) * 0.035);
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    d += `${index ? " L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

/* A straight line drawn by hand: it bows a little. */
function inkLine([x1, y1], [x2, y2]) {
  const bow = (Math.random() - 0.5) * 2.4;
  const length = Math.hypot(x2 - x1, y2 - y1);
  const midX = (x1 + x2) / 2 - ((y2 - y1) / length) * bow;
  const midY = (y1 + y2) / 2 + ((x2 - x1) / length) * bow;
  return `M${x1} ${y1} Q${midX.toFixed(1)} ${midY.toFixed(1)} ${x2} ${y2}`;
}

function pentagram(cx, cy, r) {
  const tips = [0, 2, 4, 1, 3, 0].map((step) => {
    const angle = -Math.PI / 2 + step * Math.PI * 2 / 5;
    return `${(cx + Math.cos(angle) * r).toFixed(1)} ${(cy + Math.sin(angle) * r).toFixed(1)}`;
  });
  return `M${tips.join(" L")}`;
}

/* Sketchbook studies alternate with magical diagrams. Construction lines,
   hatching and uneven marginal notes make each page a worked manuscript. */
function manuscriptStudy(variant) {
  if (variant === 0) {
    const rings = [58, 48, 33].map((radius) => `<path d="${wobblyCircle(119, 147, radius)}"/>`).join("");
    const spokes = Array.from({ length: 12 }, (_, index) => {
      const angle = index * Math.PI / 6;
      return `<path class="study-construction" d="M${(119 + 34 * Math.cos(angle)).toFixed(1)} ${(147 + 34 * Math.sin(angle)).toFixed(1)} L${(119 + 63 * Math.cos(angle)).toFixed(1)} ${(147 + 63 * Math.sin(angle)).toFixed(1)}"/>`;
    }).join("");
    return `<g class="study-ink">${rings}${spokes}<path d="${pentagram(119, 147, 43)}"/>
      <path class="study-construction" d="M49 147 H189 M119 77 V217 M66 94 L172 200 M66 200 L172 94"/>
      <path class="study-red" d="M119 62 l4 10 -4 10 -4 -10 Z M119 212 l4 10 -4 10 -4 -10 Z"/>
      <circle cx="119" cy="147" r="6"/><circle cx="119" cy="147" r="2"/></g>`;
  }
  if (variant === 1) {
    const leaves = Array.from({ length: 9 }, (_, index) => {
      const y = 90 + index * 16;
      const side = index % 2 ? 1 : -1;
      const x = 114 + (index - 4) * 1.6;
      const tip = x + side * (36 + index % 3 * 8);
      return `<path d="M${x} ${y} Q${x + side * 13} ${y - 22} ${tip} ${y - 13} Q${x + side * 34} ${y + 4} ${x} ${y} M${x} ${y} Q${x + side * 27} ${y - 10} ${tip} ${y - 13}"/>`;
    }).join("");
    const roots = Array.from({ length: 8 }, (_, index) => `<path class="study-construction" d="M113 234 Q${77 + index * 9} 252 ${52 + index * 17} ${270 + index % 3 * 5}"/>`).join("");
    return `<g class="study-ink"><path d="M115 230 C97 188 127 149 111 84 Q108 69 117 55"/>${leaves}${roots}
      <path d="M117 56 C91 53 91 30 112 37 C120 23 137 29 136 43 C150 48 141 64 123 61 Z"/>
      <path class="study-construction" d="M108 46 Q118 53 132 45 M114 39 Q120 52 119 58"/>
      <path class="study-red" d="M149 53 Q180 40 190 59 M141 143 Q178 133 193 147"/></g>`;
  }
  if (variant === 2) {
    const ribs = Array.from({ length: 10 }, (_, index) => {
      const x = 52 + index * 13;
      const upper = 117 - Math.sin(index / 9 * Math.PI) * 39;
      return `<path class="study-construction" d="M119 168 L${x} ${upper.toFixed(1)} M${x} ${upper.toFixed(1)} L${x + 4} ${(upper + 18).toFixed(1)}"/>`;
    }).join("");
    return `<g class="study-ink"><path d="M27 124 Q73 57 119 106 Q171 48 213 129 Q171 122 119 168 Q66 118 27 124 Z"/>
      ${ribs}<path d="M119 106 L119 222 L142 251 L119 235 L96 251 L119 222 M103 144 Q119 136 135 144"/>
      <path d="${wobblyCircle(119, 181, 25)}"/><path d="${wobblyCircle(119, 181, 17)}"/>
      <path class="study-construction" d="M28 150 H211 M28 158 H211 M119 73 V276"/>
      <path class="study-red" d="M35 64 Q119 35 203 66 M42 70 l-8 -7 M195 70 l8 -7"/></g>`;
  }
  const facets = [
    "M118 71 L150 118 L136 204 L116 235 L91 204 L80 118 Z",
    "M80 118 L118 71 L150 118 L116 142 Z M80 118 L91 204 L116 142 L136 204 L150 118",
    "M91 204 L116 235 L136 204 M116 142 L118 71",
  ].map((d, index) => `<path class="${index ? "study-construction" : ""}" d="${d}"/>`).join("");
  const rays = Array.from({ length: 14 }, (_, index) => {
    const a = index * Math.PI / 7;
    const cx = 116 + Math.cos(a) * 82;
    const cy = 150 + Math.sin(a) * 95;
    return `<path class="study-construction" d="M${cx.toFixed(1)} ${cy.toFixed(1)} l${(Math.cos(a) * 10).toFixed(1)} ${(Math.sin(a) * 10).toFixed(1)}"/>`;
  }).join("");
  return `<g class="study-ink">${facets}${rays}<path class="study-construction" d="${wobblyCircle(116, 151, 74)}"/>
    <path class="study-red" d="M48 149 Q116 60 187 148 M51 156 Q116 245 185 156"/></g>`;
}

function gibberish(variant = Math.floor(Math.random() * 4)) {
  const between = (low, high) => low + Math.random() * (high - low);
  const runes = (count) => Array.from({ length: count }, () => RUNES[Math.floor(Math.random() * RUNES.length)]).join("");
  const parts = [
    '<path class="ink-rule" d="M23 24 L23 308 M27 24 L211 24 M27 313 L213 313"/>',
    `<text class="ink-folio" x="194" y="320">${Math.floor(between(12, 180))}</text>`,
    manuscriptStudy(variant),
  ];
  const line = (x, y, width, pale = false) => {
    const tilt = between(-4.8, 3.6).toFixed(1);
    const weight = between(pale ? 0.3 : 0.55, pale ? 0.68 : 1.24).toFixed(2);
    const opacity = between(pale ? 0.28 : 0.54, pale ? 0.6 : 0.94).toFixed(2);
    const carbon = Math.random() < 0.16 ? "stroke:#1e1712;" : "";
    parts.push(`<path d="${scribble(x, y, width)}" transform="rotate(${tilt} ${x} ${y})" style="stroke-width:${weight};opacity:${opacity};${carbon}"/>`);
    // A worn pencil occasionally retraces a phrase, leaving a soft graphite ghost.
    if (Math.random() < 0.1) parts.push(`<path d="${scribble(x + 1, y + 1.2, width * between(0.3, 0.65))}" style="stroke-width:1.7;opacity:.13"/>`);
  };
  parts.push(`<path class="ink-bold ink-red" d="${scribble(29, 36, between(112, 180))}"/>`);
  // The central drawing stays readable, but the entire sheet carries irregular
  // writing: broad headings, cramped marginalia, corrections and faded notes.
  for (let y = 47; y < 83; y += between(7, 11)) line(between(27, 42), y, between(110, 181));
  let leftY = between(87, 93);
  let rightY = between(86, 93);
  while (leftY < 247 || rightY < 247) {
    if (leftY < 247) {
      const x = between(27, 40);
      line(x, leftY, between(33, variant === 1 ? 62 : 51), Math.random() < 0.28);
      leftY += between(6.3, 11.8);
    }
    if (rightY < 247) {
      const x = between(162, 177);
      line(x, rightY, between(27, 209 - x), Math.random() < 0.3);
      rightY += between(6.2, 12.5);
    }
  }
  for (let y = between(250, 254); y < 307; y += between(6.5, 10.5)) {
    const x = between(27, 49);
    line(x, y, between(79, 209 - x), Math.random() < 0.18);
  }
  // Ink spills into the drawing like an annotated sketchbook, at a softer hand.
  for (let index = 0; index < 6; index += 1) {
    const x = between(63, 143);
    const y = between(96, 238);
    line(x, y, between(30, 67), true);
  }
  for (let index = 0; index < 4; index += 1) {
    const x = index % 2 ? between(164, 189) : between(28, 54);
    const y = between(101, 239);
    parts.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" style="font-size:${between(5.5, 9).toFixed(1)}px;opacity:${between(0.4, 0.83).toFixed(2)}" transform="rotate(${between(-14, 11).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})">${runes(2 + Math.floor(between(0, 4)))}</text>`);
  }
  // Compass ticks, alchemical seals and exploratory hatching vary by page.
  const sealX = variant % 2 ? 195 : 42;
  const sealY = variant === 2 ? 218 : 117;
  parts.push(`<g class="study-construction" opacity=".7"><path d="${wobblyCircle(sealX, sealY, 13)} ${pentagram(sealX, sealY, 9)}"/>`);
  for (let index = 0; index < 11; index += 1) {
    const yy = 105 + index * between(6, 9);
    const xx = variant === 1 ? 67 + index * 1.4 : variant === 2 ? 45 + index * 4.8 : 88 + index * 5;
    parts.push(`<path d="M${xx.toFixed(1)} ${yy.toFixed(1)} l${between(8, 22).toFixed(1)} ${between(-5, -1).toFixed(1)}"/>`);
  }
  parts.push('</g>');
  if (variant === 0 || variant === 3) {
    parts.push(`<path class="study-red" stroke-width=".55" opacity=".7" d="${wobblyCircle(119, 147, variant === 0 ? 67 : 87)}"/>`);
    parts.push(`<text x="75" y="244" style="font-size:8px;opacity:.78">${runes(11)}</text>`);
  }
  return parts.join("");
}

const inkSheet = () => `<svg class="grimoire-ink" viewBox="0 0 240 330">${gibberish()}</svg>`;

/* The last page: annotations above, below and beside the colour wheel,
   which is drawn in ink on the page's own sigil's plan (see .sigil in
   index.html: a 200-unit square, nodes on these points, each symbol at the
   same share of the width), so it can hand over to that one exactly. */
const SIGIL_POINTS = [[100, 40], [157.1, 81.5], [135.3, 148.5], [64.7, 148.5], [42.9, 81.5]];

function lastPage() {
  const between = (low, high) => low + Math.random() * (high - low);
  const lines = [`<path class="ink-bold ink-red" d="${scribble(28, 36, between(70, 130))}"/>`];
  for (const y of [46, 55, 63, 72, 257, 266, 275, 284, 293, 302, 311]) {
    const x = between(27, 42);
    lines.push(`<path d="${scribble(x, y, between(110, 209 - x))}" style="stroke-width:${between(.38, 1.18).toFixed(2)};opacity:${between(.45, .92).toFixed(2)}"/>`);
  }
  for (let y = 96; y < 244; y += between(8, 13)) {
    const x = between(27, 35);
    lines.push(`<path d="${scribble(x, y, between(28, 42))}" style="stroke-width:${between(.3, .82).toFixed(2)};opacity:.62"/>`);
    lines.push(`<path d="${scribble(between(178, 184), y + between(-3, 3), between(25, 31))}" style="stroke-width:${between(.3, .82).toFixed(2)};opacity:.62"/>`);
  }
  const wheel = [wobblyCircle(100, 100, 94), wobblyCircle(100, 100, 84)].map((d) => `<path d="${d}"/>`);
  wheel.push(`<path class="ink-dashes" d="${wobblyCircle(100, 100, 89)}"/>`);
  SIGIL_POINTS.forEach((point, index) => {
    wheel.push(`<path d="${inkLine(point, SIGIL_POINTS[(index + 1) % 5])}"/>`, `<path class="ink-faint" d="${inkLine(point, SIGIL_POINTS[(index + 2) % 5])}"/>`);
  });
  for (const [x, y] of SIGIL_POINTS) wheel.push(`<path class="ink-node" d="${wobblyCircle(x, y, 20)}"/>`, `<path class="ink-faint" d="${wobblyCircle(x, y, 15.5)}"/>`);
  const symbols = MANA_ORDER.map((color, index) => {
    const [x, y] = SIGIL_POINTS[index];
    return `<i class="ms ms-${color.toLowerCase()} grimoire-pentacle-mana" style="left:${x / 2}%;top:${y / 2}%"></i>`;
  }).join("");
  return `<svg class="grimoire-ink" viewBox="0 0 240 330">${lines.join("")}</svg>
    <div class="grimoire-pentacle"><svg class="grimoire-ink" viewBox="0 0 200 200">${wheel.join("")}</svg>${symbols}</div>`;
}

/* Worn oxblood leather with bronze corners and a clasp, and on it the
   planeswalker's spark in a tooled ring, the five colours glowing round it. */
function grimoireCover() {
  const mana = MANA_ORDER.map((color, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / 5;
    const letter = color.toLowerCase();
    return `<i class="ms ms-${letter} grimoire-mana" style="left:${(50 + Math.cos(angle) * 40).toFixed(2)}%;top:${(50 + Math.sin(angle) * 40).toFixed(2)}%;--mana:var(--mana-${letter});--order:${index}"></i>`;
  }).join("");
  const corners = ["tl", "tr", "bl", "br"].map((corner) => `<span class="grimoire-corner" data-corner="${corner}"></span>`).join("");
  return `<div class="grimoire-cover">
      <div class="grimoire-cover-front">${corners}
        <div class="grimoire-emblem"><span class="grimoire-ring"></span><i class="ms ms-planeswalker grimoire-logo"></i>${mana}</div>
        <span class="grimoire-title">Commander Night</span>
        <span class="grimoire-clasp"></span>
      </div>
      <div class="grimoire-cover-back"></div>
    </div>`;
}

function grimoireChains() {
  const strand = (name, coverPath, escapePath) => `<g class="chain-strand" data-strand="${name}"><path class="chain-track" d="${coverPath} ${escapePath}"/><path class="chain-corner-track" d="${coverPath}"/>
    ${Array.from({ length: 29 }, (_, index) => `<g class="chain-piece" data-link="${index}"><ellipse class="chain-link-shadow" rx="10" ry="6" cy="2"/><ellipse class="chain-link-metal" rx="10" ry="6"/><path class="chain-link-light" d="M-7 -3 Q0 -7 7 -3"/><path class="chain-link-wear" d="M-4 5 l3 -.8 M3 4.9 l2 -1"/></g>`).join("")}</g>`;
  return `<svg class="grimoire-chains" viewBox="0 0 240 330" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="grimoire-chain-metal" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#e0bd79"/><stop offset=".16" stop-color="#9b7743"/><stop offset=".42" stop-color="#473523"/><stop offset=".69" stop-color="#261d18"/><stop offset=".86" stop-color="#806039"/><stop offset="1" stop-color="#342519"/></linearGradient>
      <linearGradient id="grimoire-lock-metal" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#d7ae69"/><stop offset=".2" stop-color="#745431"/><stop offset=".48" stop-color="#392719"/><stop offset=".74" stop-color="#8a6537"/><stop offset="1" stop-color="#251911"/></linearGradient>
      <pattern id="grimoire-lock-patina" width="7" height="7" patternUnits="userSpaceOnUse"><circle cx="1" cy="2" r=".7" fill="#140d08" opacity=".65"/><circle cx="5.5" cy="5" r=".45" fill="#dfbf7b" opacity=".45"/><path d="M3 1 l1.6 .5" stroke="#1c120a" stroke-width=".5" opacity=".6"/></pattern>
    </defs>
    ${strand("upper", "M0 0 C36 54 82 120 120 165 C162 213 208 266 237.6 306.9", "C319 407 411 498 490 604")}
    ${strand("lower", "M0 330 C38 276 82 210 120 165 C162 115 208 58 240 13.2", "C319 -88 414 -174 490 -268")}
    <g class="chain-lock"><path class="lock-shackle" d="M107 158 V145 C107 128 133 128 133 145 V158"/>
      <path class="lock-body" d="M101 153 Q120 149 138 151 L141 184 Q120 198 99 184 Z"/>
      <path class="lock-patina" d="M101 153 Q120 149 138 151 L141 184 Q120 198 99 184 Z"/>
      <path class="lock-panel" d="M106 158 Q120 155 135 157 L137 181 Q120 190 103 181 Z"/>
      <path class="lock-scar" d="M104 158 Q121 155 135 158 M102 180 Q121 189 138 180 M108 164 l8 -2 M128 177 l6 -1 M109 179 l4 1"/>
      <circle class="lock-rivet" cx="106" cy="159" r="1.35"/><circle class="lock-rivet" cx="135" cy="158" r="1.35"/>
      <path class="lock-keyhole" d="M123 173 a4 4 0 1 0 -6 0 l-2 9 h10 Z"/>
    </g></svg>`;
}

function placeChainLinks(chains, advance = 0) {
  const geometry = chains._geometry ||= [...chains.querySelectorAll(".chain-strand")].map((strand) => {
    const track = strand.querySelector(".chain-track");
    const cornerTrack = strand.querySelector(".chain-corner-track");
    const cornerLength = cornerTrack.getTotalLength();
    const cornerPoint = cornerTrack.getPointAtLength(cornerLength);
    const length = track.getTotalLength();
    const samples = Array.from({ length: Math.ceil(length / 4) + 1 }, (_, index) =>
      track.getPointAtLength(Math.min(length, index * 4)));
    return { length, cornerLength, cornerPoint, samples, links: [...strand.querySelectorAll(".chain-piece")] };
  });
  for (const { length, cornerLength, cornerPoint, samples, links } of geometry) {
    const pointAt = (distance) => {
      if (Math.abs(distance - cornerLength) < .001) return cornerPoint;
      const position = Math.max(0, Math.min(samples.length - 1.001, distance / 4));
      const index = Math.floor(position);
      const mix = position - index;
      return { x: samples[index].x * (1 - mix) + samples[index + 1].x * mix,
        y: samples[index].y * (1 - mix) + samples[index + 1].y * mix };
    };
    const spacing = cornerLength / (links.length - 1);
    for (const [index, link] of links.entries()) {
      const distance = Math.min(length - 1, index * spacing + advance);
      const point = pointAt(distance);
      const next = pointAt(Math.min(length, distance + 2));
      const angle = Math.atan2(next.y - point.y, next.x - point.x) * 180 / Math.PI;
      link.setAttribute("transform", `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)}) rotate(${angle.toFixed(1)})`);
      link.style.opacity = distance >= length - 2 ? "0" : "1";
    }
  }
}

async function unlockGrimoire(parts, settings, signal) {
  signal.throwIfAborted();
  parts.hint.textContent = "The chain is slipping away…";
  introSound("chain", settings, 0, 1, signal);
  const animations = [parts.chains.querySelector(".lock-shackle").animate([
    { transform: "translateY(0) rotate(0deg)" },
    { transform: "translateY(-12px) rotate(-20deg)" },
  ], { duration: 260, fill: "forwards", easing: "ease-out" })];
  animations.push(parts.chains.querySelector(".chain-lock").animate([
    { transform: "none", opacity: 1 },
    { transform: "translate(36px, 210px) rotate(28deg)", opacity: 0 },
  ], { duration: 850, delay: 260, fill: "forwards", easing: "ease-in" }));
  const cancel = () => animations.forEach((animation) => animation.cancel());
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await new Promise((resolve, reject) => {
      const started = performance.now();
      let frame = 0;
      const stop = () => { cancelAnimationFrame(frame); reject(new DOMException("Intro skipped", "AbortError")); };
      signal.addEventListener("abort", stop, { once: true });
      const draw = (now) => {
        if (signal.aborted) return stop();
        const progress = Math.min(1, (now - started) / 2300);
        const eased = 1 - (1 - progress) ** 2.3;
        placeChainLinks(parts.chains, 610 * eased);
        if (progress < 1) frame = requestAnimationFrame(draw);
        else { signal.removeEventListener("abort", stop); resolve(); }
      };
      frame = requestAnimationFrame(draw);
    });
    signal.throwIfAborted();
    parts.chains.remove();
    parts.hint.textContent = `${finePointer.matches ? "Click" : "Tap"} the grimoire to open it`;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/* The book shut and chained. The leaves are added only when it opens. */
function buildGrimoire(overlay) {
  overlay.innerHTML = `
    <div class="grimoire-zoom"><div class="grimoire-fit"><div class="grimoire-book" aria-hidden="true">
      <div class="grimoire-block"><div class="grimoire-last-sheet" style="--paper-tear:${tornPaper()}">${lastPage()}</div><span class="grimoire-leak"></span></div>
      ${grimoireCover()}
      ${grimoireChains()}
    </div></div></div>
    <div class="grimoire-dim"></div>
    <p class="grimoire-hint" aria-live="polite">${finePointer.matches ? "Click" : "Tap"} to unlock the chain</p>
    <button type="button" class="grimoire-skip">Skip intro</button>`;
  const part = (name) => overlay.querySelector(`.grimoire-${name}`);
  placeChainLinks(part("chains"));
  return { overlay, zoom: part("zoom"), fit: part("fit"), book: part("book"), cover: part("cover"), leak: part("leak"), pentacle: part("pentacle"), dim: part("dim"), chains: part("chains"), hint: part("hint") };
}

/* Now and then the shut book shakes with a thud and its cover lifts a crack,
   light leaking out: harder with a stronger rattle, sooner with a shorter
   pause. Returns what stops it. */
function rattle(parts, settings) {
  const controller = new AbortController();
  let timer = 0;
  let running = [];
  const swing = (amount) => ((Math.random() * 2 - 1) * amount).toFixed(2);
  const shake = () => {
    const strength = settings().rattle / 100;
    let duration = 0;
    if (strength > 0) {
      const count = 5 + Math.floor(Math.random() * 5);
      const frames = [{ transform: "none" }];
      for (let index = 0; index < count; index += 1) {
        const fade = 1 - index / count / 2;
        frames.push({ transform: `translate(${swing(12 * strength * fade)}px, ${swing(8 * strength * fade)}px) rotate(${swing(3.5 * strength * fade)}deg)` });
      }
      frames.push({ transform: "none" });
      duration = 180 + count * 45;
      const lift = -(5 + Math.random() * 19 * strength);
      running = [
        parts.book.animate(frames, { duration }),
        parts.cover.animate([{ transform: "translateZ(16px) rotateY(0deg)" }, { transform: `translateZ(16px) rotateY(${lift.toFixed(1)}deg)`, offset: 0.3 }, { transform: "translateZ(16px) rotateY(0deg)" }], { duration, easing: "ease-out" }),
        parts.leak.animate([{ opacity: 0 }, { opacity: Math.min(1, 0.35 + strength), offset: 0.3 }, { opacity: 0 }], { duration: duration + 250, easing: "ease-out" }),
      ];
      /* A knock as it jumps, and a softer one as the cover drops back. */
      introSound("thud", settings(), 0, 0.5 + 0.5 * strength, controller.signal);
      introSound("thud", settings(), duration * 0.7 / 1000, 0.35 + 0.4 * strength, controller.signal);
    }
    timer = setTimeout(shake, duration + settings().rattle_every * 1000 * (0.5 + Math.random() * 0.7));
  };
  timer = setTimeout(shake, 160);
  return () => {
    controller.abort();
    clearTimeout(timer);
    for (const animation of running) animation.cancel();
  };
}

/* A copy of the page's sigil, laid over the ink wheel on the last page at
   the same size, that glides to where the real one sits. The copy keeps the
   page's own placing (.grimoire's perspective makes the overlay what fixed
   things are placed in, and it covers the window), so where it lands is
   exactly where the real one is; measured with its spin stopped, it is moved
   from the ink wheel by a transform about that spot. At landing, the real
   sigil takes the moving copy's phase so its angle cannot jump. */
function flyingSigil(overlay, sigil, from) {
  const element = document.createElement("div");
  element.className = "grimoire-flight";
  const copy = sigil.cloneNode(true);
  /* The copy's url(#…) references still find the originals. */
  for (const node of [copy, ...copy.querySelectorAll("[id]")]) node.removeAttribute("id");
  copy.style.removeProperty("visibility");
  copy.style.animation = "none";
  element.append(copy);
  overlay.append(element);
  const target = copy.getBoundingClientRect();
  copy.style.removeProperty("animation");
  if (!target.width || !from.width) {
    element.remove();
    return null;
  }
  const centreX = target.left + target.width / 2;
  const centreY = target.top + target.height / 2;
  const start = `translate(${(from.left + from.width / 2 - centreX).toFixed(1)}px, ${(from.top + from.height / 2 - centreY).toFixed(1)}px) scale(${(from.width / target.width).toFixed(4)})`;
  Object.assign(element.style, { transformOrigin: `${centreX.toFixed(1)}px ${centreY.toFixed(1)}px`, transform: start });
  return {
    element,
    startGlow() {
      element.classList.add("is-spinning");
    },
    sync() {
      const moving = copy.getAnimations({ subtree: true });
      sigil.getAnimations({ subtree: true }).forEach((animation, index) => {
        if (moving[index] && moving[index].animationName === animation.animationName) animation.currentTime = moving[index].currentTime;
      });
    },
    land(duration) {
      return element.animate([
        { transform: start, filter: "brightness(1.8) drop-shadow(0 0 22px #ffcf7aaa)" },
        { transform: "none", filter: "brightness(1) drop-shadow(0 0 0 #ffcf7a00)" },
      ], { duration, easing: "cubic-bezier(.55, 0, .25, 1)", fill: "forwards" }).finished;
    },
  };
}

async function revealIntroPage(signal) {
  const children = [...app.children];
  const reveal = (element, duration) => element.animate(
    [{ opacity: 0 }, { opacity: 1 }], { duration, easing: "ease-out", fill: "both" });
  const animations = [];
  const cancel = () => animations.forEach((animation) => animation.cancel());
  signal.addEventListener("abort", cancel, { once: true });
  try {
    /* Finish the title before starting the table. Remaining sections follow. */
    for (const element of children.slice(0, 2)) {
      signal.throwIfAborted();
      const animation = reveal(element, 650);
      animations.push(animation);
      await animation.finished;
    }
    signal.throwIfAborted();
    const rest = children.slice(2).map((element) => reveal(element, 500));
    animations.push(...rest);
    await Promise.all(rest.map((animation) => animation.finished));
  } finally {
    app.classList.remove("intro-pending");
    cancel();
    signal.removeEventListener("abort", cancel);
  }
}

/* One torn silhouette per physical sheet, shared by all of its strips. */
function tornPaper() {
  const points = ["0% 0%"];
  for (let x = 8; x <= 96; x += 8) points.push(`${x}% ${(Math.random() * 1.3).toFixed(2)}%`);
  points.push("99% 2%");
  const rip = 20 + Math.floor(Math.random() * 55);
  for (let y = 5; y < 98; y += 3) {
    const bite = Math.abs(y - rip) < 3 ? 2 + Math.random() * 2 : Math.random() * 1.1;
    points.push(`${(100 - bite).toFixed(2)}% ${y}%`);
  }
  points.push("98% 98%", "97% 97%");
  for (let x = 88; x > 0; x -= 8) points.push(`${x}% ${(99 + Math.random()).toFixed(2)}%`);
  points.push("0% 100%");
  return `polygon(${points.join(",")})`;
}

const introInkArt = [];
function wornInk(index = 0) {
  const variant = index % 4;
  if (introInkArt[variant]) return `<img class="grimoire-ink" alt="" src="${introInkArt[variant]}">`;
  const spots = Array.from({ length: 12 }, () => `<ellipse class="ink-stain" cx="${25 + Math.random() * 200}" cy="${15 + Math.random() * 300}" rx="${1 + Math.random() * 6}" ry="${1 + Math.random() * 4}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 330">
    <style>path,circle,ellipse{fill:none;stroke:#352213;stroke-width:.7;stroke-linecap:round;stroke-linejoin:round}.ink-stain{fill:#64401c;stroke:none}.ink-red,.study-red{stroke:#7c1d0e}.ink-bold{stroke-width:1.15}.ink-rule{stroke:#87452e;opacity:.3}.study-construction{stroke-width:.43;opacity:.55}.study-ink{stroke-width:.85}.study-notes{stroke-width:.58;opacity:.8}text{fill:#352213;font:italic 8px Georgia,serif}</style>
    <g fill="#64401c" opacity=".17">${spots}</g>
    <path d="M207 0 Q218 137 195 330 M0 249 Q119 232 240 251" style="stroke:#58371b;stroke-width:2;opacity:.12"/>
    <g opacity=".8">${gibberish(variant)}</g></svg>`;
  introInkArt[variant] = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  return `<img class="grimoire-ink" alt="" src="${introInkArt[variant]}">`;
}

/* Integrate the tangents across the paper. Every strip begins exactly at
   the previous strip's end; the outer edge follows the spine with a curl. */
function pageCurve(width, progress, segments = 8) {
  let x = 0;
  let z = 0;
  return Array.from({ length: segments }, (_, index) => {
    const angle = -180 * progress + 55 * Math.sin(Math.PI * progress) * Math.sin((index + 0.5) / segments * Math.PI / 2);
    const transform = `translate3d(${x.toFixed(3)}px, 0, ${z.toFixed(3)}px) rotateY(${angle.toFixed(3)}deg)`;
    x += Math.cos(angle * Math.PI / 180) * width / segments;
    z -= Math.sin(angle * Math.PI / 180) * width / segments;
    return transform;
  });
}

function bendingLeaf(width, index, count, gap, frames) {
  const leaf = document.createElement("div");
  leaf.className = "grimoire-leaf";
  leaf.style.transform = `translateZ(${(count - index) * gap}px)`;
  const tear = tornPaper();
  leaf.style.setProperty("--paper-tear", tear);
  leaf.style.setProperty("--paper-tear-back", tear.replace(/([\d.]+)% ([\d.]+)%/g, (_, x, y) => `${100 - Number(x)}% ${y}%`));
  const front = wornInk(index);
  const back = wornInk(index + 2);
  const segments = frames[0].length;
  const stripWidth = width / segments;
  leaf.innerHTML = Array.from({ length: segments }, (_, part) => `
    <div class="leaf-strip" style="width:${stripWidth}px;transform:${frames[0][part]}">
      <div class="leaf-surface"><div class="leaf-face leaf-sheet" style="width:${width}px;left:${-part * stripWidth}px">${front}</div></div>
      <div class="leaf-surface leaf-strip-back"><div class="leaf-face leaf-sheet" style="width:${width}px;left:${-(segments - 1 - part) * stripWidth}px">${back}</div></div>
    </div>`).join("");
  return {
    element: leaf,
    async turn(duration, delay, signal) {
      const timing = { duration, delay, easing: "linear", fill: "both" };
      const animations = [...leaf.querySelectorAll(".leaf-strip")].map((strip, part) => strip.animate(
        frames.map((frame) => ({ transform: frame[part] })), timing));
      animations.push(leaf.animate([
        { transform: `translateZ(${(count - index) * gap}px)` },
        { transform: `translateZ(${(index + 1) * gap}px)` },
      ], timing));
      const cancel = () => animations.forEach((animation) => animation.cancel());
      signal.addEventListener("abort", cancel, { once: true });
      try {
        signal.throwIfAborted();
        await Promise.all(animations.map((animation) => animation.finished));
        signal.throwIfAborted();
        /* Once flat, release the temporary strip layers and retain one sheet. */
        leaf.innerHTML = `<div class="leaf-face">${front}</div><div class="leaf-face leaf-back">${back}</div>`;
        leaf.style.transform = `translateZ(${(index + 1) * gap}px) rotateY(-180deg)`;
      } finally {
        cancel();
        signal.removeEventListener("abort", cancel);
      }
    },
  };
}

function prepareGrimoirePages(parts, settings) {
  if (parts.preparedPages) return parts.preparedPages;
  const width = parts.book.offsetWidth;
  const small = window.matchMedia?.("(max-width: 700px)").matches;
  /* Closely spaced pages read as a blur on phones. Each curved sheet here is
     a small bundle; the selected page count still controls the book's depth. */
  const count = Math.min(Math.max(4, Math.ceil(settings.pages / 2)), small ? 6 : 9);
  const gap = 0.7;
  const segments = small ? 5 : 6;
  const frames = Array.from({ length: 17 }, (_, frame) => {
    const t = frame / 16;
    return pageCurve(width, t * t * (3 - 2 * t), segments);
  });
  const leaves = Array.from({ length: count }, (_, index) => bendingLeaf(width, index, count, gap, frames));
  parts.cover.before(...leaves.map((leaf) => leaf.element));
  parts.preparedPages = { leaves, count, gap };
  return parts.preparedPages;
}

function decodeIntroTextures() {
  if (typeof Image === "undefined") return Promise.resolve();
  return Promise.all(["grimoire-leather.webp", "grimoire-paper.webp", ...introInkArt].map((src) => {
    const image = new Image();
    image.src = src;
    return image.decode?.().catch(() => {}) || Promise.resolve();
  }));
}

async function openGrimoire(parts, settings, signal) {
  const { overlay, zoom, fit, book, cover, pentacle, dim } = parts;
  const width = book.offsetWidth;
  const height = book.offsetHeight;
  const viewWidth = document.documentElement.clientWidth;
  const viewHeight = window.innerHeight;
  const { leaves, count, gap } = prepareGrimoirePages(parts, settings);

  /* The cover swings over to the left, landing with a thud, while the book
     slides right and, where the window is narrow, shrinks until both pages fit. */
  overlay.classList.add("is-open");
  const fitScale = Math.min(1, (viewWidth * 0.96) / (width * 2), (viewHeight * 0.92) / height);
  fit.animate([{ transform: "none" }, { transform: `scale(${fitScale}) translateX(50%)` }], { duration: 900, easing: "cubic-bezier(.55, 0, .25, 1)", fill: "forwards" });
  cover.animate([
    { transform: `translateZ(16px) rotateY(0deg)` },
    { transform: "translateZ(-0.5px) rotateY(-180deg)" },
  ], { duration: 850, easing: "cubic-bezier(.5, 0, .3, 1)", fill: "forwards" });
  await wait(380);
  signal.throwIfAborted();
  /* Scheduled from here, once the tap has woken the sound. */
  introSound("thud", settings, 0.42, 0.9, signal);

  /* The pages riffle over, one after another, all within shuffle_seconds,
     each rustling as it passes upright. */
  const shuffle = settings.shuffle_seconds * 1000;
  const flip = Math.min(760, shuffle * 0.6);
  const step = count > 1 ? (shuffle - flip) / (count - 1) : 0;
  const flips = leaves.map((leaf, index) => {
    introSound("page", settings, (index * step + flip * 0.45) / 1000, 0.7 + Math.random() * 0.3, signal);
    return leaf.turn(flip, index * step, signal);
  });
  await Promise.all(flips);
  await pageReady;
  await wait(300);
  signal.throwIfAborted();

  /* Glow and rotate over the last page for the configured glow time. Keep
     that same rotation running when the flight begins afterward. */
  const sigil = document.querySelector("body > .sigil");
  const glow = settings.glow_seconds * 1000;
  const travel = settings.flight_seconds * 1000;
  pentacle.classList.add("is-lit");
  introSound("sound", settings, 0, 1, signal);
  const flight = sigil && flyingSigil(overlay, sigil, pentacle.getBoundingClientRect());
  if (flight) {
    sigil.style.visibility = "hidden";
    flight.startGlow();
    flight.element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: Math.min(600, glow * 0.6), easing: "ease-out", fill: "both" });
    pentacle.animate([{ opacity: 1 }, { opacity: 0 }], { duration: Math.min(600, glow * 0.6), delay: 120, easing: "ease-in", fill: "forwards" });
  }
  dim.animate([{ opacity: 0 }, { opacity: 0.82 }], { duration: Math.min(900, glow * 0.7), easing: "ease-in-out", fill: "forwards" });
  await wait(glow);
  signal.throwIfAborted();

  /* The sigil keeps rotating as it travels; the book fades underneath it. */
  const fade = { duration: travel, easing: "ease-in-out", fill: "forwards" };
  overlay.style.setProperty("--landing", `${travel}ms`);
  overlay.classList.add("is-landing");
  zoom.animate([{ opacity: 1 }, { opacity: 0 }], fade);
  dim.animate([{ opacity: 0.82 }, { opacity: 0 }], fade);
  if (flight) await flight.land(travel);
  else await wait(travel);
  signal.throwIfAborted();
  if (flight) {
    flight.sync();
    sigil.style.removeProperty("visibility");
    await flight.element.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" }).finished;
  }
  signal.throwIfAborted();
  await revealIntroPage(signal);
}

/* Plays the opening, or with preview (from the editor on /public) plays it
   again with settings not saved yet. Resolves once the page shows. */
function playGrimoire(preview = null) {
  let overlay = document.querySelector(".grimoire");
  if (preview) {
    overlay?.remove();
    overlay = document.createElement("div");
    overlay.className = "grimoire";
    document.body.prepend(overlay);
    document.documentElement.classList.remove("no-grimoire");
    /* The editor's click counts as the tap that lets sound play. */
    introContext()?.resume();
  }
  if (!overlay || document.documentElement.classList.contains("no-grimoire")) {
    overlay?.remove();
    scheduleSiteAssetWarmup();
    return Promise.resolve();
  }
  const parts = buildGrimoire(overlay);
  const controller = new AbortController();
  app.classList.add("intro-pending");
  app.inert = true;
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  let settings = { ...INTRO_DEFAULTS, ...preview };
  const prepared = (preview ? Promise.resolve(settings) : introSettings).then((saved) => {
    settings = saved;
    applyIntroRotationSpeed(saved.rotation_speed);
    if (!preview) {
      try {
        if (saved.repeat === "visit") sessionStorage.setItem("grimoire-opened", "1");
        else sessionStorage.removeItem("grimoire-opened");
      } catch (error) { /* plays every time */ }
    }
    /* Fetched now, so the tap does not wait for them. */
    for (const kind of ["chain", "sound", "thud", "page"]) introBuffer(saved[kind]);
    return saved;
  });
  const pagesReady = prepared.then((saved) => new Promise((resolve) => {
    const build = () => { prepareGrimoirePages(parts, saved); resolve(decodeIntroTextures()); };
    if (typeof requestIdleCallback === "function") requestIdleCallback(build, { timeout: 350 });
    else setTimeout(build, 0);
  }));
  let stopRattle = () => {};

  return new Promise((resolve) => {
    let stage = "locked";
    const end = (skip = true) => {
      if (stage === "done") return;
      stage = "done";
      if (skip) controller.abort();
      stopRattle();
      app.classList.remove("intro-pending");
      app.inert = false;
      window.removeEventListener("keydown", onKey);
      document.querySelector("body > .sigil")?.style.removeProperty("visibility");
      overlay.classList.add("is-leaving");
      setTimeout(() => {
        overlay.remove();
        for (const animation of overlay.getAnimations({ subtree: true })) animation.cancel();
        startDeckSound();
        scheduleSiteAssetWarmup();
      }, 450);
      resolve();
    };
    /* First tap wakes sound and drops the chain. Only a later tap opens the
       rattling book. Double taps while unlocking must not bypass this stage. */
    const open = () => {
      if (stage === "unlocking" || stage === "done") return;
      if (stage === "locked") {
        stage = "unlocking";
        parts.hint.textContent = "Unlocking…";
        const context = introContext();
        const awake = context ? context.resume().catch(() => {}) : Promise.resolve();
        Promise.all([awake, prepared]).then(async () => {
          controller.signal.throwIfAborted();
          await unlockGrimoire(parts, settings, controller.signal);
          controller.signal.throwIfAborted();
          stage = "shut";
          stopRattle = rattle(parts, () => settings);
        }).catch(() => end());
        return;
      }
      if (stage !== "shut") {
        end();
        return;
      }
      stage = "opening";
      stopRattle();
      /* resume() must run directly in the trusted tap/keyboard event. Wait
         for activation before scheduling effects, with a silent fallback. */
      const context = introContext();
      const awake = context ? context.resume().catch(() => {}) : Promise.resolve();
      Promise.all([awake, pagesReady])
        .then(() => {
          controller.signal.throwIfAborted();
          return openGrimoire(parts, settings, controller.signal);
        }).then(() => end(false), () => end());
    };
    function onKey(event) {
      if (event.key === "Escape") end();
      else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    }
    overlay.addEventListener("click", (event) => (event.target.closest(".grimoire-skip") ? end() : open()));
    /* The page underneath stays put while the book is up. */
    overlay.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });
    window.addEventListener("keydown", onKey);
  });
}

playGrimoire();

async function start() {
  try {
    const [history, pictures] = await Promise.all([loadJson("game_history.json"), loadJson("roster.json")]);
    games = Array.isArray(history.games) ? history.games : [];
    historicalWins = Array.isArray(history.historical_wins) ? history.historical_wins : [];
    for (const group of ["players", "decks"]) {
      roster[group].clear();
      for (const [name, entry] of Object.entries(pictures[group] || {})) roster[group].set(keyOf(name), { ...entry, name });
    }
    rosterReady = true;
    stats = aggregate();
    route();
    if (!document.querySelector(".grimoire")) scheduleSiteAssetWarmup();
  } catch (error) {
    rosterReady = true;
    app.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
  markPageReady();
}

inscribeGlyphs();
startEmbers();
start();
