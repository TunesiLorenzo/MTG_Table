# MTG Table

Three front-ends served by one local Flask app:

| Page | What it is |
| --- | --- |
| `/leaderboard` | **Game history and leaderboard** — persistent results, player standings, and deck statistics |
| `/` | **Commander life tracker** — a broadcast display for a screen in the middle of the table |
| `/lights` | **Light controls** — three Tapo bulbs and the center-table LED strip, phone-friendly |

## Setup

1. Install Python 3.10 or newer on the Windows PC near the Bluetooth LED strip.
2. `python -m pip install -r requirements.txt`
3. Copy `tapo_credentials.example.json` to `tapo_credentials.json` and enter your
   Tapo account details, or set `TAPO_USERNAME` and `TAPO_PASSWORD`.
   *(Only needed for the lights page — the life tracker runs without it.)*
4. Turn on Bluetooth and keep the PC and phone on the same private Wi-Fi network.

## Run

```
python serve.py            # opens a browser on http://localhost:5001/
python serve.py --port 80  # or pick a port
python web.py              # same app on port 5001, no browser launch
```

From a phone on the same Wi-Fi, open **`http://rpgtable.local:5001/`** (add
`/lights` for the light controls). The server advertises itself over mDNS while
it runs, so the name works without knowing the PC's current IP;
`http://<PC-IP>:5001/` still works too. The `.local` suffix is required — a bare
`rpgtable` will not resolve. The name points at the PC, not at this app: the
port is what separates it from LightRPG on the same machine.

Port 5001, not 5000, because LightRPG serves its own page on 5000 from the same
PC. Windows lets a second program bind a port that is already taken instead of
refusing it, so a clash there shows up as the *other* app's page with no error
in either terminal.

**Stopping the server:** Ctrl+C in the terminal, or the *Shut down server*
button — in the table's hub panel, and at the bottom of the lights page. The
button is there for the usual case where the terminal has been closed and the
server is still running behind it, still holding the port and the `rpgtable.local`
name. It saves the table first and withdraws the mDNS advertisement on the way
out. Starting it again is `python web.py` on the PC, as always.

If Windows Firewall prompts, allow Python on private networks only, and make
sure UDP 5353 is allowed on private networks or the name will not be discovered.

`serve.py --hostname TABLE` publishes a different name, `--no-mdns` turns the
advertisement off.

---

# The leaderboard (`/leaderboard`)

Record one completed four-player game by choosing its date and entering each
player's name, deck, and finishing position from 1 to 4. Tied positions are
allowed, for example 1, 3, 3, 4. Current tracker
names are suggested automatically, and previously entered player and deck names
remain available as suggestions.

When the life tracker detects that only one player remains, it celebrates that
winner by playing `sound/Announcer/Base/Winner.mp3`, which contains its own drum
build. At six seconds, the full-screen name and background appear and the
winner's selected commander sound starts, with the selected player announcement
over it half a second later. Once the name has finished, the `sound/win.mp3`
fanfare and falling confetti follow. Every volume and timing in this sequence
can be changed on the lights page's **Sound & timing** tab; a volume above 100%
boosts a clip past its recorded level. The room lights follow along: the bulbs dim and the LED strip
flashes through the drum roll, the winner's own lighting takes the room as their
background appears, and once their name has been announced the room eases back
to the house lights. The result window follows. Its ranking is prefilled
from elimination order; confirm or adjust it, enter the four decks, and save
directly to the leaderboard. For alternate win conditions, open that player's
counter tray and choose **Declare Winner** to run the same victory sequence
without first eliminating the other players.

The hub's **Declare draw** button ends the game as a draw between every player
still alive (at least two are required). It plays
`sound/Announcer/Base/Draw.mp3`, starts `sound/Announcer/Base/boos.wav` when
that cue ends, and speaks each surviving player's configured announcement in
table order over the crowd. Press the highlighted button again during playback
to cancel. The result form prefills every survivor tied for first; saved draws
count as games but do not award wins on the leaderboard.

Older results can be added as **historical wins** with only a player name and
win count. They contribute to all-time wins and the player win chart, but not to
recorded games, win rate, top-two finishes, deck statistics, or average finish,
because those details are unknown.

The page derives all-time player standings, wins, win rate, top-two finishes,
average finish, strongest and most-played decks, performance charts, and a
chronological game archive. Deck charts show each deck's player. Removing an
incorrect game recalculates every statistic.

Results are written immediately and atomically to `game_history.json`, and the
shutdown button saves them again before the server stops. The file is tracked by
Git, so committing after a game-night creates an additional versioned backup.

## The public copy (GitHub Pages)

`site/` is a read-only version of the leaderboard for GitHub Pages: standings,
a page per player, and a page per deck with its art and card. It has no server
behind it, so results are still recorded here, on the table. Pushing a new
`game_history.json` to `main` republishes it through
`.github/workflows/pages.yml` (repository **Settings → Pages → Source: GitHub
Actions**).

`site/roster.json` ties names to pictures. Keys are player and deck names as
they are typed into a result, ignoring case; paths are relative to the
repository:

```json
{
  "players": { "Borgo": { "portrait": "Backgrounds/Players/VoltiBase/borgo.jfif", "background": "…" } },
  "decks": { "Urza": { "commander": "Urza, Lord High Artificer",
                       "art": "Backgrounds/Players/Urza.png",
                       "cards": ["Backgrounds/Commander/Urza.jpg"] } }
}
```

Every field is optional. A player without a `background` gets the art of their
most played deck, and a player without a `portrait` gets their initial. Only
pictures named here are published; the rest of `Backgrounds/`, the sounds, and
the other pages stay out of the site.

To see it before pushing (needs `pip install pillow`):

```
python build_site.py
python -m http.server 8000 --directory _site
```

---

# The life tracker (`/`)

Four quadrants, one per seat, each rotatable so every player reads their own
panel right-side-up on a screen lying flat in the middle of the table.

Press **F11** or the hub's *Fullscreen* button to go edge to edge.

| Action | How |
| --- | --- |
| Life ±1 or ±5 | Tap the compact `−5`, `−1`, `+1`, or `+5` control in a quadrant |
| Fast life change | Press and hold — the repeat accelerates |
| Rename a player | Click the name and type |
| Rotate a panel | The `↺` button in that quadrant (0° → 90° → 180° → 270°) |
| **Pass the turn** | The big `↻` button at the center |
| **Commander damage, poison, tax, seat setup** | Tap any counter chip to open that seat's tray |
| **Player art** | Drag an image file onto that player's panel |
| **Player entrance** | Turn it on in the hub, then tap the first player's wooden name cover to start the clockwise sequence |
| **House lights** | The lightbulb left of the turn button, or the hub menu |
| **Resend the lighting** | The `⟳` below the turn button, or *Resend lights* in the hub |
| Turn direction, starting life, reset, fullscreen | The hub beside the turn button |
| Close the hub or a tray | The `×` / *Done*, a tap anywhere outside it, or `Esc` |

A tap that dismisses an open panel only dismisses — it never also nudges the
control underneath it.

Rapid taps batch into one `-7` style pill beside the total, which bumps as the
batch grows and floats away once it settles, so the table can see what just
happened. The total itself punches in the colour of each change, and every
press ripples out from the button — red for loss, green for gain.

Life loss and commander damage briefly tint the whole display red; life gain
tints it green. The tint spreads from the seat it happened to, so the table
also sees *where*. A held button, or a quick burst of taps, keeps the tint up
for as long as it lasts instead of flashing it over and over. The colors are
the `--damage-screen-tint` and `--heal-screen-tint` variables in
`css/style.css`, and the duration is `SCREEN_TINT_MS` near the top of
`js/app.js`.

From a quarter of the starting life down — 10 in a 40-life Commander game — the
total turns amber and starts to pulse, with a glow beating behind it, and every
point lost after that quickens the beat. At an eighth (5) it turns red and each
beat lands harder. The marks are `LIFE_LOW_FRACTION` and
`LIFE_CRITICAL_FRACTION` in `js/app.js`, and the beat runs from
`LIFE_PULSE_SLOW_S` at the low mark to `LIFE_PULSE_FAST_S` at zero.

With *Reduce motion* switched on in the operating system, all of this still
shows but nothing moves, and the full-screen tint is left out.

### Sound

Every counter press makes a noise, so the table hears what it sees:

| Sound | When |
| --- | --- |
| `heal.mp3` | Life goes up |
| `thud.mp3` | Life goes down, or commander damage goes up |
| `poison.mp3` | Poison goes up |
| `turn.mp3` | The turn passes to a different player |
| `win.mp3` | Full-screen winner celebration (add this file to `sound/`) |
| `click.mp3` | Everything else — undoing a counter, commander tax |

The files live in `sound/`; drop in replacements under the same names to change
them. Per-sound volume is the `SOUNDS` table at the top of `js/app.js`.

### Coin toss

The coin button above the turn button throws a coin onto the table from the
seat of whoever's turn it is. The toss is simulated, not played back: the throw
is random and the bounces, the roll round its rim and the side it stops on all
follow from it. Tap the landed coin to flip again, which keeps a count of heads
and tails until the coin is put away; tap anywhere else to put it away.

The coin is struck in the colour of the player throwing it. Its two faces are
the greyscale relief maps `static/coin_heads.png` (the planeswalker side) and
`static/coin_tails.png` (the lettered side); replace them with any square
greyscale images to change the design, light for raised metal and dark for
recesses.

The toss is adjusted on the lights page's **Settings** tab: how high it is
thrown, how fast it flips, how much it bounces, the size of the coin, how long
the result stays up (or until it is tapped away), the volume, and whether a
landing shows its ring, jolt and sparks. *Call heads or tails before each flip*
makes every flip ask first and then say whether the call won. Changes reach the
table screen within a few seconds.

The coin's sounds are generated by the page. To use recordings for the knocks
on the table instead, add files named `coin_NUMBER` (`.wav`, `.mp3`, `.ogg` or
`.m4a`, for example `coin_1.wav`) to `sound/`: each should be one short coin
hit, and one is picked at random for every knock.

On the first touch or key press, the tracker starts a very quiet 25 Hz signal
and leaves it running. This keeps AUX amplifiers with automatic standby awake;
the first requested effect waits 180 ms for the audio path to wake before it
plays. `AUDIO_KEEPALIVE_GAIN` and `AUDIO_WAKE_MS` near the top of `js/app.js`
can be tuned for a particularly sensitive or slow amplifier.

### Counters

Each seat carries a row of chips, and tapping any of them opens that seat's tray
with `−`/`+` for every counter:

| Chip | Meaning |
| --- | --- |
| `♛` ×3 | Commander damage, one per opponent, in that opponent's seat colour |
| `☣` | Poison counters |
| `⬆` | Commander tax — each press is **+2**, shown as the extra cost to recast |

An empty counter shows just its icon, so the row only has numbers where there
is something to read. Commander damage and poison chips carry a meter along
their bottom edge showing how close that counter is to knocking the player out;
it turns amber at 15 commander damage or 7 poison, and the chip pulses red once
it is lethal. The tray draws the same meters. A partner commander's chip is
marked `#1` or `#2`.

A player is out at 0 life, at **21** commander damage from any single opponent,
or at **10** poison, and the panel is stamped **ELIMINATED** with the cause
underneath. The tray also has **Eliminate** and **Concede** for going out any
other way (a concession gets its own grey **CONCEDED** stamp); either fades the
panel right back and skips that seat in the rotation, and **Back in the game**
undoes it.

### Seat colour and art

The colour dot at the top of the tray, beside the player's name, sets a seat's
colour, which recolours that player's panel, their turn glow, and the `♛` chip
opponents see for them. **Drag an image file onto a
panel** to use it as that seat's background; it is downscaled and stored with the
rest of the table state, and *Clear art* removes it.

*Reset Game* clears seat colours and art along with the counters, for a clean
table between groups. Switching *Start* life resets the totals but keeps them,
so changing the format mid-setup does not wipe everyone's art.

### Player entrance

Turn **Player entrance** on in the center hub after names, colours, and art are
ready. Every quadrant becomes a wood-and-leather name plaque and the center
controls disappear. Tap whichever player should enter first. The table plays
`sound/drumroll.wav` with `sound/Announcer/Base/Intro.mp3`, waits four seconds,
then drops that plaque. Once a plaque is fully open, that player's selected
announcement and center-screen artwork play together. A randomly assigned
`sound/crowd_NUMBER.wav` reaction starts one second before that announcement
ends, at 35% volume. The next plaque begins dropping early enough for its
announcement to start one second before the cheer ends. Crowd clips are shuffled
for every entrance sequence and are never reused between players; if fewer than
four are available, the remaining players are silent. After the final cheer,
`sound/Announcer/Base/Fight.mp3` plays and the animated random first-player
selection follows immediately. Revealed panels remain visible after a refresh.
Use **Cover players again** in the hub to re-arm every plaque; starting a new
game also puts the covers back while entrance mode is enabled.

### Turn tracking

The active player's quadrant is framed in their color: corner brackets lock on
and a sweep of light crosses the panel as the turn arrives, the edge glows
gently while it lasts, and their art brightens while everyone else's steps
back. Beside their name a **Your turn** badge counts how long the turn has been
going. The clock restarts on every pass, keeps counting through a refresh,
and can be switched off with *Turn clock* in the hub.

The center button is filled with the active player's color, and its glyph
shows the direction of play — `↻` clockwise or `↺` counterclockwise, set under
*Order* in the hub — spinning that way each time the turn passes. Around it,
the **turn compass** has one arc per seat, pointing at that seat's quadrant. A
lit comet travels round it to whoever is up. The next player's arc is a little
brighter than the rest, and an eliminated player's is dotted.

The turn passes around the **physical table** (top-left → top-right →
bottom-right → bottom-left), not across the grid, and **eliminated players are
skipped**. Turning *Lights follow turn* on in the hub makes every configured bulb
take the new player's color on each turn change — see *Player colors* below.

### House lights

**House lights** in the hub is the switch for "we are not playing right now":
every bulb goes to plain **3600K white at full brightness**, the **LED strip goes
off**, and any effect stops. Press it again and the table goes straight back to
whoever's turn it is by then.

*(Switching the strip off means writing it black. These controllers disagree
about the power command — one common form is a byte shorter than every command
this strip does obey, and gets dropped — but a colour write always lands, so
"off" is black and "on" restores the last colour it was showing. Same for the
strip's own on/off buttons on the lights page. A strip that did take the
power-off will store a colour and stay dark, so anything that wants light again
powers it back on first.)*

### Resend lights

**Resend lights**, under the house-lights switch, puts the current state back on
every light — the player whose turn it is, or the house lights if those are on.

It is for when one light has drifted out of step: a bulb missed a command, the
strip's Bluetooth link dropped, someone used the Tapo app. Everything the server
caches to avoid needless traffic — what each bulb was last told, what the strip
is running, what the painter last drew — is exactly what would suppress the fix,
so it is all cleared first and the whole state goes out fresh. A strip whose link
has dropped is reconnected on the way, which can take a few seconds.

Turns keep being tracked while it is on — passing the turn, renaming a player,
editing a light plan all still work, they just do not touch the room until the
house lights go back off. The switch lives on the server, so it holds for
whoever is looking and the button shows the real state when the tracker loads.
It is deliberately not saved: restarting comes back to the players' lighting.

**Keyboard** (for an operator off to the side) — one column of keys per seat,
gain above loss:

```
Seat 1: Q / A     Seat 2: W / S     Seat 3: E / D     Seat 4: R / F
Space = next player     Backspace = previous player
```

Life totals, names, rotations, and starting life persist to `localStorage`,
so a refresh or a screen sleep will not lose the game.

### Game moments on the lights

With *Lights follow turn* on, the room reacts to the game as well as the turn:

| Moment | Lights |
| --- | --- |
| Life lost, commander damage | Every light, strip included, turns red at once and drifts back |
| Life gained | The same in green |

A held button keeps the colour up for as long as it is held instead of flashing
over and over.

The shows run whatever that setting:

| Moment | Lights |
| --- | --- |
| Player entrance | Lights down with a warm glow gathering over the table. Each plaque drop dips the room, then that player's own turn lighting takes it for their announcement. *Fight!* is a red hit, then darkness |
| First-player pick | The strip follows the spinning names while the bulbs cycle the players' colours, and everything lands on a white flash timed to the final click, then the chosen player's lighting |
| Commander reveal | The current player's own lighting dims while the card is in the air — colours and effects unchanged, the strip's own effect still running — and comes back up as the card lands home |
| Commander burn | The bulbs flicker orange with the flame over a steady strip, ease to a warm amber, then back — bright enough to keep reading the table |
| Winner | The bulbs dim to a low warm white while the strip flashes through the drum roll, the winner's own turn lighting takes the room as their background appears, and after their name everything eases to the house lights |

The entrance, the first-player pick and the winner take the whole room, so they
switch the house lights off (the winner hands the room back to them at the end);
nothing else plays under the house lights. Every moment ends on
whatever the lights should show by then, so a turn passed during one lands on
the new player. A light set by hand on the Lights tab is left alone until a turn
drives it again.

Every moment is set on the lights page's **Moments** tab: switch it on or off by
tapping its name, change its colours, which lights it uses, its hold and its
fades, and press **Test** to play it on the room right away. The settings are
saved in `table_config.json` with the rest of the table.

The tracker only reports what happened; `cues.py` decides what each light does.
The server times every write, and for moments known in advance it sends each
change early by that light's usual round trip so it lands on time. Each light's
measured round trip is in `/api/status` as `light_latency_ms`.

### Layout notes

The default seating assumes two players per long side: the top two quadrants are
rotated 180°, the bottom two 0°. If players sit on all four sides, rotate the left
quadrant to 90° and the right to 270° with `↺`. Rotated panels swap their width
and height so they still fill the quadrant exactly.

---

# The lights (`/lights`)

Structure imported from the **LightRPG** project: three bulbs placed in a room
diagram (top left, center, bottom right) plus the center-table LED strip.

The page has two tabs, and remembers which one you left it on:

| Tab | What it does |
| --- | --- |
| **Lights** | Drive the room by hand right now — pick a light, set a color, white, or power |
| **Players & effects** | Set what each player's turn does to each light |

## Lights tab

- **Tap a fixture** to select it. Controls then act on that light.
- **Tap a chain badge** to add or remove a bulb from the *linked group*. Selecting
  any linked bulb drives the whole group at once; unlinked bulbs stay independent.
- **Sync the LED strip** applies the same color to the strip alongside the bulbs.
  (White temperature is a bulb-only capability and never reaches the strip.)
- **Device setup** discovers bulbs, blinks each one so you can identify it, and
  assigns it to a room position. IPs can also be typed in directly.

Where the bulbs live is **saved and restored on the next start**, so the room
stays mapped across restarts and reboots. The one thing that clears it is
**Discover and assign all bulbs**, which is a fresh mapping by definition: it
drops all three positions before scanning, so nothing narrows the scan and no
bulb that has since changed IP leaves a dead address behind. *Set*, *Forget* and
per-bulb *Find* all keep the rest of the mapping as it was.

## Players & effects tab

Every player has a **light plan**: all four lights — the three bulbs and the
table LED — each with **its own colour or white, brightness, and effect**.
Passing the turn hands all four over at once.

### Light plans

One card per player, one row per light:

| Control | What it does |
| --- | --- |
| The light's **name button** | On or off for this player. Off leaves that light alone on their turn |
| The **colour square** | That light's hue and saturation, for this player only |
| **Picked** | Copies the colour picked on the *Lights* tab onto this one light |
| **Brightness** | That light's own level |
| **White** | Runs this light as white instead of a colour, for this player |
| The **warmth slider** | The white temperature, 2500K to 6500K. Dimmed on a colour light |
| The **effect menu** | What that light does while the turn lasts (see below) |
| The **speed slider** | The effect's period, 0.4s to 20s. Dimmed for a solid light |

### White

Any light in any player's plan can be white instead of a colour — one player
reads by warm light while the next turns the table blue, or a single bulb stays
white all game as the one you can actually see cards under.

Colour and white are both remembered per light, so switching between them never
costs you the other setting. Picking a colour switches that light back to colour
on its own, and dragging the warmth slider switches it to white, so neither
needs the **White** button first; the button is there for switching back and
forth without touching either value. **Use picked** puts one colour on every one
of that player's lights, white ones included.

The bulbs use their real white channel, which looks far better than the same
temperature mixed out of RGB. The strip has no white channel, so it gets the
closest RGB match. A white light fades to another white along the temperature
dial; between a colour and a white, the fade travels through colour and lands on
true white on the last frame.

Changes save as you let go, and if you are editing the player whose turn it is,
you see it on the lights immediately. A light that is switched on but not
connected yet stays dim, and the card for whoever is up is outlined.

### Effects

| Effect | What it looks like |
| --- | --- |
| **Solid** | Holds the colour |
| **Pulse** | Swings brightness down to 20% and back |
| **Breathe** | The same, but only down to 60% — for a light you still read by |
| **Swap sides** | The two facing bulbs hold, then trade colours, then trade back |
| **Flicker** | Candle-like wobble around the set brightness |
| **Blink** | Hard alternation between the colour and its dimmest |

**Swap sides** is a trade between the **top left and bottom right** bulbs. Each
holds its colour for half the period, changes straight over to the other's, and
changes back — **no crossfade through the colours in between**, so a red and a
blue never both sit on magenta on the way past. Both ends read the same clock, so
they change together and are never showing the same colour. The speed slider is
the full there-and-back, so 20s means ten seconds on each colour. If the two
bulbs have different saved speeds, a paired swap uses their average as one shared
period; a one-sided swap continues to use that light's own speed.

Set it on both bulbs for the full trade; set it on one and that one alternates
while the other holds. The **centre bulb and the table LED have nobody to trade
with, so the effect leaves them alone** — they keep their colour. The colour a
light trades for is whatever its partner is actually showing, even if the current
player does not drive that partner.

On a white light there is no hue to move, so the brightness effects work while
the warmth holds.

An effect belongs to a player's turn. When the turn passes, lights the next
player does not drive stop animating and rest on the colour they were showing.
All lights animated from the server share one painter thread. Each light gets
its next frame as soon as it has answered the last one, and never has more than
one write on its way, so a slow bulb gets fewer frames rather than stale ones,
and never holds up the strip.

**The strip animates itself.** Its effects are the ELK-BLEDOM chip's own
built-ins, selected once (with redundant BLE packets for reliability) and then
left alone — the
same approach LightRPG uses. Driving it from here instead means a frame every
fifth of a second across a BLE link that answers late and unevenly, and that
unevenness is exactly what a flicker makes visible: the effect is smooth
arithmetic, but the frames carrying it are not, so it reads as jitter rather
than as a candle. Handing the effect to the chip also stops the slowest device
in the room from setting the frame rate for the bulbs.

The trade is that the chip only knows seven colours, so a strip effect runs in
the nearest one — red, yellow, green, cyan, blue, magenta, or white — rather
than the player's exact colour. *Pulse* and *Breathe* become the chip's
crossfade, *Flicker* and *Blink* its blink. A **solid** strip is unaffected and
still shows the exact colour.

### Profiles — one file per person

Each player card has **Save as…** and a **Load** menu. *Save as…* writes that
player's whole plan — name, base colour, and all four lights with their colours,
whites, effects and speeds — to `profiles/<name>.json`. *Load* puts a saved
profile onto **any seat**, so when someone different turns up you drop their
profile into whichever chair they took.

They are plain JSON, one player's entry out of `table_config.json`, so you can
copy them between machines, back them up, edit them in a text editor, or delete
one by deleting the file. Saving under a name that already exists overwrites it.
Loading also sets the player's name — though the tracker owns names, so renaming
that seat on the tracker (or reloading the tracker page) wins afterwards.

### Player colors

The *Player colors* card is the shortcut for the common case: pick a colour on
the *Lights* tab, then press **Use picked** on a player's row to give them and
**every light they drive** that one colour. **Show** puts a player's whole plan
on the lights right away. The chips under each row toggle the same lights as the
plan rows above.

Player names come from the life tracker — rename someone there and it appears
here.

### Commander cards

Each seat has a small face-down card in its bottom-right corner, sized
(`--commander-card-width` in `css/style.css`) to stay clear of the `+1`/`+5`
buttons above it. Drop a card image directly onto it (dropping elsewhere on the
seat still changes the player background). The first tap lifts the card toward the middle of the table, then
starts its selected sound and begins flipping shortly after the movement starts.
Once centered, it waits for the complete sound and flip before returning
face-up. Tapping a revealed commander
lifts it again, plays the shared `sound/Commander/Fire.mp3`, burns it away in the
middle, and restores the small card face-down without a return flight. Commander
art is stored in that table browser and stays loaded between games.

Optional reveal sounds go in `sound/Commander` (`.mp3`, `.wav`, `.ogg`, or
`.m4a`). Choose one per player with **Commander sound** on the Lights page, next
to the entrance-sound menu. `Fire.mp3` is reserved for the shared burn effect and
does not appear in this menu. That choice is also included in saved profiles.

*(These are the lights for a player's turn. The seat colour on the tracker is set
separately, in that seat's tray.)*

### Speed

How fast the table turns over is mostly round trips to the bulbs, so a light is
told only what actually changed, in **one request**: a turn change is a single
call per bulb, and a frame of an effect that only moves brightness is a smaller
one. Re-sending a colour a bulb is already showing costs nothing at all — except
from the *Apply* buttons on the Lights tab, which always reach the device.

What is left is the **fade time** you set below and one frame of latency. If turn
changes still feel slow, shorten the fade or switch it off; a light with an
effect on it starts moving immediately either way.

### Fade

**Fade between player colors** crossfades the solid lights from the outgoing
player's colours to the incoming one, over the time you set. Off means they snap.
Hue takes the short way round the colour wheel, and a new turn always wins — a
fast sequence of turn changes ends on the newest player's lighting. Lights
running an effect are not faded; they pick the new colour up on their next frame.

Plans, names, the current player, and the bulb IPs live on the server (saved to
`table_config.json`), because the tracker and this page run on different devices.
The file is written beside itself and renamed into place, so an interrupted
write — a Ctrl+C, a crash, a power cut — cannot leave a half-file that reads
back as no settings at all; and a file that is unreadable for any other reason
is kept as `table_config.json.broken` and logged, rather than silently replaced
with defaults.

Nothing here is cached by the browser: the API answers `no-store` and the pages
revalidate. The lights page draws its whole display from one `/api/status` call,
so a phone reusing an old copy of it would show a table that stopped existing
hours ago — settings you had definitely saved, apparently gone.
A turn change with no bulbs configured is a harmless no-op. An older
`table_config.json` is migrated on load: one colour per player becomes that
colour on all of their lights, the old global table-LED pulse becomes a pulse
effect on every player's strip, and a file with no bulb IPs in it simply starts
from the built-in defaults.

## Files

```
index.html          life tracker markup + seat template
css/style.css       life tracker styles (layout, rotation, broadcast theme)
js/app.js           life tracker state, persistence, interaction, sound
sound/              click, heal, thud, poison, turn, and the user-supplied win

templates/lights.html   light control page, both tabs
static/lights.css       light control styles
static/lights.js        tabs, room selector, colour wheel, white pad, light plans
templates/leaderboard.html  result entry, charts, standings, and game archive
static/leaderboard.css      responsive leaderboard styles
static/leaderboard.js       statistics, charts, history rendering, and API calls

site/               the public, read-only leaderboard and its roster of pictures
build_site.py       assembles site/, the results and the roster's pictures into _site/

web.py              Flask app: all three pages, game API, device API, player light plans
lighting.py         turn crossfades, white, the per-light effect painter, and cues
cues.py             what each game moment looks like on the lights
serve.py            runs web.py and opens a browser
table_config.json   saved light plans, names, and bulb IPs (created on use)
game_history.json   completed game results (created on first saved game)
profiles/           one saved light plan per person (created on first save)
bulb_control.py     Tapo bulb driver: discovery, identify, setters
bledom_led.py       ELK-BLEDOM strip driver: connect, solid color, power, effects
```
