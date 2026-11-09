# Game inbox on Google Drive

The phone tracker sends each finished game to a small Google Apps Script,
[`inbox.gs`](inbox.gs), which appends it to **`mtg_games.json`** in your Drive.
Friends need no Google account and no access to the file: the script runs as
you and is the only thing that writes to it. It only ever appends, and a game
it already has is not added twice, so a phone can safely resend.

The script never touches the leaderboard. The table's server does: while
`web.py` (or `serve.py`) runs, it reads the inbox every five minutes, and
whenever `/leaderboard/entry` opens. It imports new games and corrections into
`game_history.json`, then commits that file alone and pushes it, which
republishes the public site. A game with the same result as one typed in by
hand is left for you to add from the entry page's **Import games** card
(**Review inbox**). New decks join the roster locally and reach the site with
the next **Publish**. Set `MTG_DRIVE_SYNC=0` to turn this off, or
`MTG_INBOX_URL` to read another deployment. Otherwise the URL comes from
`js/game-inbox.js`.

**Anything valid in the inbox goes live by itself**, so delete test entries
from `mtg_games.json` before the server next runs.

## Setup (once, about 10 minutes)

1. Go to <https://script.google.com> → **New project**. Name it *MTG Table inbox*.
2. Delete the sample code, paste the whole of `inbox.gs`, and save (Ctrl+S).
3. In the function menu next to **Run**, pick **`setup`** and press **Run**.
   Google asks for permission to see and manage your Drive files — allow it
   (on the "Google hasn't verified this app" screen: *Advanced → Go to MTG
   Table inbox*; it is your own script). The log shows the link to the new
   `mtg_games.json` in My Drive. You can move or rename the file.
4. Optional check: run **`testSubmit`**. The log should show `"ok":true`
   then `"duplicate":true`, and the file gains one test game. Delete that entry
   from the file afterwards (or delete the file; a fresh one is made on the
   next save).
5. **Deploy → New deployment** → gear icon → **Web app**:
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**
   
   Press **Deploy** and copy the **Web app URL** (ends in `/exec`). That URL
   goes into the phone tracker's settings.

**Changing the script later:** paste the new code, then **Deploy → Manage
deployments** → pencil → *Version: New version* → **Deploy**. This keeps the
same URL; a *New deployment* would make a different one.

**Who can see what:** anyone with the URL can add a valid game, and can read
the inbox (`GET` returns the whole file) — the same names and results the
public site shows. Nobody can edit or delete entries through it. If junk ever
arrives, skip it on import; a passcode can be added later.

## Endpoints

| Request | Answer |
| --- | --- |
| `POST <url>` with a submission as the body | `{"ok":true,"id":"…","count":12}` · `{"ok":true,"id":"…","duplicate":true}` · `{"ok":false,"error":"…"}` |
| `GET <url>` | The whole inbox file |
| `GET <url>?id=<game id>` | `{"ok":true,"id":"…","saved":true}` |

Send the body as plain text (no `Content-Type: application/json` header), so
the browser makes a simple request with no CORS preflight, which Apps Script
cannot answer. The answer comes back through a redirect that `fetch` follows.

## Submission format (`mtg-table-game`, version 1)

What the phone sends, and also what its **Download game** button saves, so a
downloaded file and an inbox entry import the same way.

```json
{
  "format": "mtg-table-game",
  "version": 1,
  "source": { "app": "phone-tracker", "app_version": "2026-11-09" },

  "game": {
    "id": "3f9c2a0d5b7e4c1fa8d6e2b4c9071e3a",
    "date": "2026-11-08",
    "created_at": "2026-11-08T23:40:55+01:00",
    "outcome": "win",
    "duration_seconds": 5412,
    "starting_life": 40,
    "players": [
      { "name": "Borgo", "deck": "Urza", "rank": 1,
        "stats": { "turns": 11, "play_seconds": 1380, "longest_turn_seconds": 240,
                   "damage_dealt": 64, "commander_damage_dealt": 21, "poison_dealt": 0,
                   "biggest_hit": 14, "life_gained": 9, "damage_taken": 22,
                   "lowest_life": 18, "eliminations": 2, "eliminated_by": null } },
      { "name": "Ny",    "deck": "Niv-Mizzet", "rank": 2, "stats": {} },
      { "name": "Coach", "deck": "Zhulodok",   "rank": 3, "stats": {} },
      { "name": "Dani",  "deck": "Ghave",      "rank": 4, "stats": {} }
    ]
  },

  "table": {
    "direction": "cw",
    "first_player": "Ny",
    "ended_by": "elimination",
    "elimination_order": ["Dani", "Coach", "Ny"],
    "monarch": "Borgo",
    "initiative": null,
    "daytime": null,
    "seats": [
      { "seat": 0, "name": "Borgo", "deck": "Urza", "deck_source": "preset",
        "commander_names": ["Urza, Lord High Artificer", ""], "color": "#7a5cff",
        "life": 12, "poison": 0, "energy": 0, "experience": 0,
        "commander_damage_taken": { "Ny": [6, 0], "Coach": [0, 0], "Dani": [0, 0] },
        "tax": 4, "second_tax": 0, "emblems": [], "blessing": false,
        "out": false, "out_cause": null }
    ]
  },

  "timeline": [
    { "t": 0,    "type": "start", "first_player": "Ny" },
    { "t": 312,  "type": "turn", "turn": 1, "player": "Ny", "seconds": 312,
      "life": [40, 40, 38, 40], "poison": [0, 0, 0, 0] },
    { "t": 2900, "type": "out",  "player": "Dani", "cause": "commander", "by": "Borgo" },
    { "t": 5412, "type": "end",  "outcome": "win", "winners": ["Borgo"] }
  ],

  "new_decks": [
    { "name": "Ghave", "commander": "Ghave, Guru of Spores", "scryfall_id": "…",
      "color_identity": ["W", "B", "G"],
      "art_url": "https://cards.scryfall.io/art_crop/…",
      "card_url": "https://cards.scryfall.io/normal/…",
      "color": "#5fae4e" }
  ]
}
```

| Block | What it is | Checked by the script |
| --- | --- | --- |
| `game` | **Exactly an entry of `game_history.json`**, so importing is a copy. `id` is made on the phone (32 hex) and kept on import, which is what stops a game being counted twice. | Strictly: id, date, outcome, four players with different names, ranks 1–4, someone first, a draw has a tie for first |
| `table` | The tracker's final state: seats in seat order (0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right), everything on each panel, who went out and how. `deck_source` is `preset` (a configured deck) or `blank`. `commander_damage_taken` is per opponent, `[first commander, partner]`. `out_cause`: `life`, `commander`, `poison`, `removed`, `conceded` or `null`. `first_player` is whoever played the first counted turn (a turn under 5 seconds is a slipped pass and is not counted). | Must be an object |
| `timeline` | Events in game time, `t` in seconds from the start, clock stops excluded. A `turn` event is written at the end of each counted turn: whose it was, how long it took (`seconds`), and everyone's life and poison in seat order. An `out` event names who went out, the cause, and who did it (`by`, `null` for a concession or going out on your own turn). Events in the same second can come in either order. | Must be a list |
| `new_decks` | Blank decks set up from Scryfall during this game, so the import can add them to the roster. Configured decks are only named in `game`. | At most 8, each with a name |

Names inside `table` and `timeline` are player names as in `game.players`.

**Corrections.** The inbox never overwrites, so a result that is changed after
it was sent, saved or downloaded (a deck renamed, a rank moved) goes out with a
**new** `game.id` and `"replaces": "<old id>"` in `source`. On import, the
newest entry wins and the one it replaces is dropped. Sending the same result
again keeps its id and is ignored. The table's local leaderboard does the same:
a correction takes the place of the game it replaces.

## The inbox file (`mtg-table-inbox`, version 1)

```json
{
  "format": "mtg-table-inbox",
  "version": 1,
  "created_at": "2026-11-08T21:02:11.000Z",
  "updated_at": "2026-11-08T22:41:02.000Z",
  "submissions": [
    { "id": "3f9c…", "received_at": "2026-11-08T22:41:02.000Z",
      "source": {}, "game": {}, "table": {}, "timeline": [], "new_decks": [] }
  ]
}
```

Each entry is the submission without `format`/`version`, plus `received_at`
(server time, UTC). Entries are never changed or removed by the script. If
the file stops being valid JSON (say, after a hand edit), the script refuses
to save rather than overwrite it; fix it or restore it from Drive's *Manage
versions*.
