/**
 * MTG Table — game inbox on Google Drive.
 *
 * The phone tracker POSTs each finished game here; this script appends it to
 * one JSON file in the Drive of whoever deployed it. Nobody else needs a
 * Google account or edit rights: the script is the only thing that writes.
 *
 *   POST  <web app url>         body: one game submission (see drive/README.md)
 *                               → {"ok":true,"id":"…"} or {"ok":false,"error":"…"}
 *   GET   <web app url>         → the whole inbox file
 *   GET   <web app url>?id=…    → {"ok":true,"saved":true|false}
 *
 * It only ever appends. A submission whose game id is already in the file is
 * acknowledged and not added again, so a phone may safely resend.
 *
 * Setup: drive/README.md. Paste this whole file into a new Apps Script
 * project, run `setup` once, then Deploy → New deployment → Web app.
 */

var INBOX_NAME = 'mtg_games.json';
var INBOX_FORMAT = 'mtg-table-inbox';
var SUBMISSION_FORMAT = 'mtg-table-game';
var VERSION = 1;

// Limits match web.py's game_from_payload, so anything accepted here imports.
var PLAYER_COUNT = 4;
var NAME_MAX = 40;
var DECK_MAX = 80;
// One game with stats, final table and a long turn-by-turn record is well
// under this; anything bigger is not a game from the tracker.
var BODY_MAX = 256 * 1024;
var NEW_DECKS_MAX = PLAYER_COUNT * 2;
var LOCK_WAIT_MS = 30 * 1000;


/* ---------- web app ---------- */

function doPost(e) {
  var raw = (e && e.postData && e.postData.contents) || '';
  if (!raw) return reply({ ok: false, error: 'Empty request' });
  if (raw.length > BODY_MAX) return reply({ ok: false, error: 'Submission is too large' });

  var body;
  try {
    body = JSON.parse(raw);
  } catch (error) {
    return reply({ ok: false, error: 'Not valid JSON' });
  }

  var problem = submissionProblem(body);
  if (problem) return reply({ ok: false, error: problem });

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_WAIT_MS);
  } catch (error) {
    return reply({ ok: false, error: 'Inbox is busy, try again' });
  }
  try {
    var file = inboxFile();
    var inbox = readInbox(file);
    var id = body.game.id;
    var already = inbox.submissions.some(function (entry) { return entry && entry.id === id; });
    if (already) return reply({ ok: true, id: id, duplicate: true });

    inbox.submissions.push(inboxEntry(body));
    inbox.updated_at = new Date().toISOString();
    file.setContent(JSON.stringify(inbox, null, 1));
    return reply({ ok: true, id: id, count: inbox.submissions.length });
  } catch (error) {
    return reply({ ok: false, error: String(error && error.message || error) });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  try {
    var inbox = readInbox(inboxFile());
    var id = e && e.parameter && e.parameter.id;
    if (id) {
      var saved = inbox.submissions.some(function (entry) { return entry && entry.id === id; });
      return reply({ ok: true, id: id, saved: saved });
    }
    return reply(inbox);
  } catch (error) {
    return reply({ ok: false, error: String(error && error.message || error) });
  }
}


/* ---------- the inbox file ---------- */

/* The file's id is remembered after the first run, so renaming or moving the
   file in Drive is fine. Deleting it starts a fresh, empty inbox. */
function inboxFile() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('INBOX_FILE_ID');
  if (id) {
    try {
      var existing = DriveApp.getFileById(id);
      if (!existing.isTrashed()) return existing;
    } catch (error) {
      // Gone: fall through and make a new one.
    }
  }
  var file = DriveApp.createFile(INBOX_NAME, JSON.stringify(emptyInbox(), null, 1), 'application/json');
  props.setProperty('INBOX_FILE_ID', file.getId());
  return file;
}

function emptyInbox() {
  return {
    format: INBOX_FORMAT,
    version: VERSION,
    created_at: new Date().toISOString(),
    updated_at: null,
    submissions: []
  };
}

/* A file that no longer parses is never overwritten: the error stops the
   save, and Drive's version history (File → Manage versions) still has it. */
function readInbox(file) {
  var text = file.getBlob().getDataAsString('UTF-8');
  if (!text.trim()) return emptyInbox();
  var inbox = JSON.parse(text);
  if (!inbox || inbox.format !== INBOX_FORMAT || !Array.isArray(inbox.submissions)) {
    throw new Error(INBOX_NAME + ' is not an MTG Table inbox — fix or delete it in Drive');
  }
  return inbox;
}

/* Exactly what the phone sent, minus the envelope fields, plus when it arrived. */
function inboxEntry(body) {
  return {
    id: body.game.id,
    received_at: new Date().toISOString(),
    source: isObject(body.source) ? body.source : {},
    game: body.game,
    table: isObject(body.table) ? body.table : null,
    timeline: Array.isArray(body.timeline) ? body.timeline : [],
    new_decks: Array.isArray(body.new_decks) ? body.new_decks : []
  };
}


/* ---------- checks ---------- */

/* Only the result itself is checked strictly — it is what reaches the
   leaderboard. Stats, the final table and the timeline are kept as sent. */
function submissionProblem(body) {
  if (!isObject(body)) return 'Submission must be an object';
  if (body.format !== SUBMISSION_FORMAT) return 'Not an MTG Table game';
  if (body.version !== VERSION) return 'Unsupported version ' + body.version;

  var game = body.game;
  if (!isObject(game)) return 'Missing game';
  if (typeof game.id !== 'string' || !/^[0-9a-f]{32}$/.test(game.id)) return 'Game id must be 32 hex characters';
  if (typeof game.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(game.date)) return 'Date must use YYYY-MM-DD';
  if (game.outcome !== 'win' && game.outcome !== 'draw') return 'Outcome must be win or draw';

  var players = game.players;
  if (!Array.isArray(players) || players.length !== PLAYER_COUNT) return 'A game must have exactly four players';
  var names = {};
  for (var i = 0; i < players.length; i++) {
    var player = players[i];
    if (!isObject(player)) return 'Every player must be an object';
    if (!isText(player.name, NAME_MAX)) return 'Player name must be 1–' + NAME_MAX + ' characters';
    if (!isText(player.deck, DECK_MAX)) return 'Deck name must be 1–' + DECK_MAX + ' characters';
    if ([1, 2, 3, 4].indexOf(player.rank) === -1) return 'Every rank must be 1 to 4';
    if (player.stats !== undefined && player.stats !== null && !isObject(player.stats)) return 'Stats must be an object';
    var key = player.name.trim().toLowerCase();
    if (names[key]) return 'Each player name must be different';
    names[key] = true;
  }
  var winners = players.filter(function (player) { return player.rank === 1; }).length;
  if (!winners) return 'Someone must be ranked first';
  if (game.outcome === 'draw' && winners < 2) return 'A draw needs at least two players tied for first';

  if (body.table !== undefined && body.table !== null && !isObject(body.table)) return 'Table must be an object';
  if (body.timeline !== undefined && !Array.isArray(body.timeline)) return 'Timeline must be a list';
  if (body.new_decks !== undefined) {
    if (!Array.isArray(body.new_decks) || body.new_decks.length > NEW_DECKS_MAX) return 'Too many new decks';
    for (var d = 0; d < body.new_decks.length; d++) {
      if (!isObject(body.new_decks[d]) || !isText(body.new_decks[d].name, DECK_MAX)) return 'Every new deck needs a name';
    }
  }
  return null;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function reply(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}


/* ---------- run these from the editor ---------- */

/* Run once before deploying: Google asks you to allow Drive access, and the
   inbox file appears in My Drive. The log shows its link. */
function setup() {
  var file = inboxFile();
  Logger.log('Inbox ready: ' + file.getName() + ' — ' + file.getUrl());
}

/* Sends a made-up game through the same path as the phone, twice, to show it
   is saved once. Delete the test entry from the file afterwards, or delete
   the file to start empty. */
function testSubmit() {
  var id = Utilities.getUuid().replace(/-/g, '');
  var sample = {
    format: SUBMISSION_FORMAT,
    version: VERSION,
    source: { app: 'apps-script-test' },
    game: {
      id: id,
      date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      outcome: 'win',
      players: [
        { name: 'Test A', deck: 'Deck A', rank: 1 },
        { name: 'Test B', deck: 'Deck B', rank: 2 },
        { name: 'Test C', deck: 'Deck C', rank: 3 },
        { name: 'Test D', deck: 'Deck D', rank: 4 }
      ]
    }
  };
  var event = { postData: { contents: JSON.stringify(sample) } };
  Logger.log(doPost(event).getContent());
  Logger.log(doPost(event).getContent());
}
