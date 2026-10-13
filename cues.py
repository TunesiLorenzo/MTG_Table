"""What the room lights do at each moment of the game.

The tracker says what happened — a hit, a heal, the entrance, the first-player
spin, a commander reveal or burn — and each function here turns it into a
lighting.Cue: what every light shows, when, and when it goes back to its
player's plan. How each moment looks is set on the lights page's Moments tab
(see MOMENTS) and saved in table_config.json.

Every look is built around how quickly each light really answers. The strip
changes within a few tens of milliseconds, so it carries anything that has to
be sharp. A Tapo bulb takes about a quarter of a second per change, so it only
gets what it can show in that time: a flash, a slow roulette, a dim. For a
moment known in advance, the painter also sends each change early by that
light's measured round trip (Cue.compensate), so it lands on the moment.
"""

import copy

import lighting
from lighting import DARK, Cue, Track, animated, dimmed, faded, plan_dimmed, solid

# These ids mirror the room laid out in web.py.
CENTER = "center"
CORNERS = ("top_left", "bottom_right")
BULBS = ("top_left", "center", "bottom_right")
STRIP = lighting.STRIP_ID
ALL_LIGHTS = BULBS + (STRIP,)

# Which cue a light follows when two want it: a hit never interrupts a show.
FLASH = 1
SHOW = 2

# A cue with no fixed end — lights down for the entrance, the room holding its
# breath over a commander — lets go on its own after this long if the tracker
# never says what comes next, so a closed tab cannot leave the room dark.
HOLD_SECONDS = 90.0
COMMANDER_HOLD_SECONDS = 30.0


# ------------------------------------------------------------------ settings --
# The Moments tab builds its controls from this list. A field is a color (hue,
# saturation, brightness), a white (temperature, brightness), a time in
# seconds, a percentage, an on/off toggle, or a set of lights. Every moment
# also has its own on/off switch, "enabled".

def _seconds(key, label, default, low, high):
    return {"key": key, "type": "seconds", "label": label, "default": default, "min": low, "max": high, "step": 0.05}


def _percent(key, label, default, low=0, high=100):
    return {"key": key, "type": "percent", "label": label, "default": default, "min": low, "max": high, "step": 1}


def _color(key, label, hue, saturation, brightness):
    return {"key": key, "type": "color", "label": label,
            "default": {"hue": hue, "saturation": saturation, "brightness": brightness}}


def _white(key, label, kelvin, brightness):
    return {"key": key, "type": "white", "label": label, "default": {"temperature": kelvin, "brightness": brightness}}


def _toggle(key, label, default):
    return {"key": key, "type": "toggle", "label": label, "default": default}


def _lights(key, label):
    return {"key": key, "type": "lights", "label": label, "default": list(ALL_LIGHTS)}


def _life(hue, hint, label):
    # The default colors are the screen's own tints (--damage-screen-tint and
    # --heal-screen-tint in css/style.css). The hold outlasts a held button's
    # wait before it starts repeating, so a hold never blinks between its first
    # press and the next.
    return {"label": label, "hint": hint, "fields": [
        _color("color", "Color", hue, 100, 100), _lights("lights", "Lights"),
        _seconds("fade_in", "Fade in", 0.0, 0.0, 2.0), _seconds("hold", "Hold", 0.45, 0.1, 3.0),
        _seconds("fade_out", "Fade out", 0.35, 0.0, 3.0)]}


MOMENTS = [
    dict(id="damage", **_life(351, "Life going down, or commander damage going up. A held button keeps "
                                   "the color up.", "Life lost")),
    dict(id="heal", **_life(147, "Life going up.", "Life gained")),
    {"id": "commander_reveal", "label": "Commander reveal",
     "hint": "Dims the current player's own lighting while the card is in the air, and brings it back as it lands.",
     "fields": [_percent("dim", "Dim to", 25), _seconds("fade_in", "Fade down", 0.6, 0.0, 3.0),
                _seconds("fade_out", "Fade back up", 1.0, 0.0, 3.0)]},
    {"id": "commander_burn", "label": "Commander burn",
     "hint": "The bulbs flicker with the flame over a steady strip, settle to embers, and come back.",
     "fields": [_color("fire", "Fire", 24, 85, 100), _color("embers", "Embers", 30, 65, 55),
                _percent("dim", "Dim before the fire", 50), _seconds("flicker", "Flicker speed", 0.9, 0.4, 3.0),
                _seconds("fade", "Fade", 0.6, 0.0, 3.0), _seconds("fade_out", "Fade out", 1.0, 0.0, 3.0)]},
    {"id": "entrance", "label": "Player entrance",
     "hint": "Lights down with a glow over the table, then each player walks out to their own turn lighting.",
     "fields": [_white("glow", "Glow over the table", 2700, 28),
                _toggle("flash", "Strip flash as each plaque lands", True), _color("fight", "Fight! color", 0, 100, 100)]},
    {"id": "spin", "label": "First-player spin",
     "hint": "The strip follows the names, the bulbs cycle the players' colors, and all land on one flash.",
     "fields": [_percent("brightness", "Roulette brightness", 80, 1), _seconds("step", "Roulette step", 0.45, 0.3, 2.0),
                _white("ding", "Landing flash", 4000, 100), _seconds("ding_hold", "Landing flash hold", 0.4, 0.1, 2.0)]},
    {"id": "winner", "label": "Winner",
     "hint": "The bulbs dim and the strip flashes through the drum roll, the winner's own lighting takes the "
             "room as their background appears, and the room eases back to the house lights after their name.",
     "fields": [_white("dim", "Bulbs during the drum roll", 2700, 10), _color("flash", "Strip flash", 0, 0, 100),
                _seconds("flash_from", "Flashing starts at", 0.0, 0.0, 5.0),
                _seconds("flash_speed", "Flash speed", 0.25, 0.1, 1.0),
                _seconds("switch", "Into the winner's lighting", 0.5, 0.0, 3.0),
                _seconds("home_fade", "Back to the house lights", 6.0, 0.0, 10.0)]},
    # Not a light cue: the winner sequence's sound and timing, which the
    # tracker plays and the winner cue above keeps time with. It lives here to
    # share the editor, checks and saving, on a tab of its own ("tab") and
    # with no on/off switch or test ("settings_only").
    {"id": "winner_sound", "label": "Winner sequence", "tab": "sound", "settings_only": True,
     "hint": "The drum roll plays, the winner's background and commander sound land, their name is announced "
             "over the commander sound, and the fanfare follows once the name has finished.",
     "fields": [_seconds("reveal_at", "Background and commander sound at", 6.0, 1.0, 15.0),
                _percent("drum_volume", "Drum roll volume", 100),
                _percent("commander_volume", "Commander sound volume", 130, 0, 200),
                _seconds("announce_delay", "Name starts after the commander sound by", 0.5, 0.0, 10.0),
                _percent("announcer_volume", "Name volume", 100),
                _seconds("fanfare_gap", "Fanfare after the name by", 0.3, 0.0, 5.0),
                _percent("fanfare_volume", "Fanfare volume", 100),
                _seconds("celebration_hold", "Winner screen stays for", 5.6, 1.0, 20.0)]},
    # Not a light cue either: how the tracker's coin toss behaves, on the
    # Settings tab. The lights take no part in the toss.
    {"id": "coin", "label": "Coin toss", "tab": "settings", "settings_only": True,
     "hint": "The coin thrown by the button above the turn button. Changes apply from the next throw.",
     "fields": [_percent("height", "Throw height", 100, 50, 140),
                _percent("spin", "Flip speed", 100, 50, 170),
                _percent("bounce", "Bounciness", 45, 20, 65),
                _percent("size", "Coin size", 100, 60, 140),
                _seconds("hold", "Result stays for", 6.0, 1.0, 30.0),
                _toggle("stay", "Keep the result up until it is tapped away", False),
                _percent("volume", "Sound volume", 100),
                _toggle("effects", "Landing ring, table jolt and sparks", True),
                _toggle("call", "Call heads or tails before each flip", False)]},
]
_MOMENTS = {moment["id"]: moment for moment in MOMENTS}


def default_settings():
    return {moment["id"]: dict({"enabled": True},
                               **{field["key"]: copy.deepcopy(field["default"]) for field in moment["fields"]})
            for moment in MOMENTS}


def _part(value, key, low, high, label):
    part = value.get(key) if isinstance(value, dict) else None
    if isinstance(part, bool) or not isinstance(part, (int, float)) or not low <= part <= high:
        raise ValueError(f"{label} needs a {key} between {low} and {high}")
    return int(round(part))


def _clean(field, value):
    """One field's value, checked against its type and range."""
    kind, label = field["type"], field["label"]
    if kind == "toggle":
        if not isinstance(value, bool):
            raise ValueError(f"{label} must be on or off")
        return value
    if kind in ("seconds", "percent"):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not field["min"] <= value <= field["max"]:
            raise ValueError(f"{label} must be between {field['min']} and {field['max']}")
        return round(float(value), 2) if kind == "seconds" else int(round(value))
    if kind == "lights":
        if not isinstance(value, list):
            raise ValueError(f"{label} must be a list of lights")
        return [light for light in ALL_LIGHTS if light in value]
    if kind == "color":
        return {"hue": _part(value, "hue", 0, 360, label), "saturation": _part(value, "saturation", 0, 100, label),
                "brightness": _part(value, "brightness", 1, 100, label)}
    return {"temperature": _part(value, "temperature", lighting.WHITE_TEMP_MIN, lighting.WHITE_TEMP_MAX, label),
            "brightness": _part(value, "brightness", 1, 100, label)}


def update_settings(settings, moment_id, patch):
    """Apply a partial change to one moment; returns the labels of what changed."""
    moment = _MOMENTS.get(moment_id)
    if moment is None:
        raise ValueError(f"Unknown moment: {moment_id}")
    look, changed = settings[moment_id], []
    if "enabled" in patch:
        if not isinstance(patch["enabled"], bool):
            raise ValueError("enabled must be true or false")
        look["enabled"] = patch["enabled"]
        changed.append("on" if patch["enabled"] else "off")
    for field in moment["fields"]:
        if field["key"] in patch:
            look[field["key"]] = _clean(field, patch[field["key"]])
            changed.append(field["label"].lower())
    return changed


def merge_settings(saved):
    """Saved settings over the defaults, field by field; anything invalid is dropped."""
    settings = default_settings()
    if isinstance(saved, dict):
        for moment in MOMENTS:
            entry = saved.get(moment["id"])
            for key, value in (entry.items() if isinstance(entry, dict) else ()):
                try:
                    update_settings(settings, moment["id"], {key: value})
                except ValueError:
                    pass
    return settings


def moment_label(moment_id):
    return _MOMENTS[moment_id]["label"]


# -------------------------------------------------------------------- values --

def color(hue, saturation, brightness):
    return (int(round(hue)) % 360, int(round(saturation)), max(1, int(round(brightness))), None)


def white(kelvin, brightness):
    hue, saturation = lighting.kelvin_to_hue_saturation(kelvin)
    return (hue, saturation, max(1, int(round(brightness))), int(kelvin))


def _as_color(setting, brightness=None):
    return color(setting["hue"], setting["saturation"], setting["brightness"] if brightness is None else brightness)


def _as_white(setting, brightness=None):
    return white(setting["temperature"], setting["brightness"] if brightness is None else brightness)


def _strip_white(brightness):
    # Full RGB: a color temperature, on a strip with no white channel, would
    # come out tinted.
    return color(0, 0, brightness)


def _eased(value, seconds):
    return faded(solid(value), seconds) if seconds > 0 else solid(value)


# ------------------------------------------------------------- hit and heal --
# The chosen lights take the color, hold it, and drift back to their plan.
# Every press renews it, so a held button keeps the color up.

def life_flash(gained, settings):
    look = settings["heal" if gained else "damage"]
    step = _eased(_as_color(look["color"]), look["fade_in"])
    return Cue({light: Track([(0.0, step)], look["fade_in"] + look["hold"], fade_out=look["fade_out"])
                for light in look["lights"]}, group="flash", priority=FLASH)


# ----------------------------------------------------------------- entrance --
# Lights down: the corners almost out, the strip dark, and the glow over the
# table gathering through the drum roll in four steps a second apart — slow
# enough for a bulb to show every one. Each plaque drop dips the room, and as
# it lands the strip flashes and that player's own turn lighting takes the
# room for their announcement: the look they designed is their walk-out.
REVEAL_FLASH_SECONDS = 0.15
# "Fight!": one hit on every light, then near darkness until the spin.
FIGHT_SECONDS = 0.6
FIGHT_AFTER_BRIGHTNESS = 3


def _lights_down(look, end):
    corner = _as_white(look["glow"], 1)
    tracks = {light: Track([(0.0, solid(corner))], end) for light in CORNERS}
    tracks[STRIP] = Track([(0.0, DARK)], end)
    return tracks


def entrance_start(settings):
    look = settings["entrance"]
    glow = look["glow"]
    ramp = [(float(step), solid(_as_white(glow, glow["brightness"] * (step + 1) / 4))) for step in range(4)]
    tracks = _lights_down(look, HOLD_SECONDS)
    tracks[CENTER] = Track(ramp, HOLD_SECONDS)
    return Cue(tracks, group="show", priority=SHOW)


def entrance_player(reveal_in, settings):
    """The room dips while a plaque drops, and hands over as it lands `reveal_in` later.

    What it hands over to is the entering player's plan, which web.py lays out
    underneath this cue.
    """
    look = settings["entrance"]
    tracks = _lights_down(look, reveal_in)
    tracks[CENTER] = Track([(0.0, solid(_as_white(look["glow"])))], reveal_in)
    if look["flash"]:
        tracks[STRIP] = Track([(0.0, DARK), (reveal_in, solid(_strip_white(100)))],
                              reveal_in + REVEAL_FLASH_SECONDS)
    return Cue(tracks, group="show", priority=SHOW, compensate=True)


def entrance_fight(settings):
    fight = settings["entrance"]["fight"]
    hit, after = _as_color(fight), _as_color(fight, FIGHT_AFTER_BRIGHTNESS)
    tracks = {light: Track([(0.0, solid(hit)), (FIGHT_SECONDS, solid(after))], HOLD_SECONDS) for light in BULBS}
    tracks[STRIP] = Track([(0.0, solid(hit)), (FIGHT_SECONDS, DARK)], HOLD_SECONDS)
    return Cue(tracks, group="show", priority=SHOW)


# --------------------------------------------------------------------- spin --
# The strip follows the ticks, though never faster than every
# SPIN_STRIP_STEP_MIN: the quickest ticks are closer together than a room
# light should flash. The bulbs cannot follow any tick — even the slowest are
# about one round trip apart — so they cycle the players' colors instead,
# which reads the same at that speed. Everything lands on one flash, sent early
# enough to arrive on the final click, and then opens on the chosen player.
SPIN_STRIP_STEP_MIN = 0.2
# The roulette stops this long before the landing and holds its last colors: a
# bulb still busy with a roulette change when the flash is due lands late.
SPIN_DING_CLEARANCE = 0.6


def spin(ticks, colors, settings):
    """`ticks` is [(seconds, seat)] in time order, ending on the chosen seat, and
    `colors` gives each seat's player as (hue, saturation)."""
    look = settings["spin"]
    landing, brightness = ticks[-1][0], look["brightness"]
    steps, last = [], None
    for at, seat in ticks[:-1]:
        if last is None or at - last >= SPIN_STRIP_STEP_MIN:
            steps.append((at, solid(color(*colors[seat], brightness))))
            last = at
    steps.append((landing, solid(_strip_white(look["ding"]["brightness"]))))
    tracks = {STRIP: Track(steps, landing + look["ding_hold"])}

    seats = sorted({seat for _, seat in ticks})
    for offset, light in enumerate(BULBS):
        steps, slot = [], 0
        while slot * look["step"] < landing - SPIN_DING_CLEARANCE:
            hue, saturation = colors[seats[(slot + offset) % len(seats)]]
            steps.append((slot * look["step"], solid(color(hue, saturation, brightness))))
            slot += 1
        steps.append((landing, solid(_as_white(look["ding"]))))
        tracks[light] = Track(steps, landing + look["ding_hold"])
    return Cue(tracks, group="show", priority=SHOW, compensate=True)


def demo_spin_ticks(seats, winner, count=22, slowest=0.26, fastest=0.055):
    """A spin paced like the tracker's, for trying the look from the lights page."""
    ticks, at = [], 0.0
    for step in range(count):
        if step:
            progress, span = step / count, slowest - fastest
            at += (slowest - span * progress / 0.5 if progress < 0.5
                   else fastest + span * ((progress - 0.5) / 0.5) ** 2)
        ticks.append((at, seats[step % len(seats)]))
    ticks[-1] = (at, winner)
    return ticks


# ------------------------------------------------------------------- winner --
# The drum roll: the bulbs ease down to a low white while the strip — the only
# light quick enough — flashes. As the winner's background appears the flashing
# stops dead and the winner's own lighting, which web.py lays out underneath,
# takes the room, the bulbs easing in so they are there on the reveal. After
# their name the room eases to the house lights (house_fade).
WINNER_DIM_SECONDS = 1.0


def winner(reveal_in, settings):
    look = settings["winner"]
    dim = _eased(_as_white(look["dim"]), WINNER_DIM_SECONDS)
    # Bulbs start easing out early by as long as the easing takes.
    tracks = {bulb: Track([(0.0, dim)], max(0.0, reveal_in - look["switch"]), fade_out=look["switch"])
              for bulb in BULBS}
    half, at, lit = look["flash_speed"] / 2, look["flash_from"], True
    steps = [(0.0, DARK)] if at > 0 else []
    while at < reveal_in:
        steps.append((at, solid(_as_color(look["flash"])) if lit else DARK))
        at, lit = at + half, not lit
    tracks[STRIP] = Track(steps, reveal_in)
    return Cue(tracks, group="winner", priority=SHOW, compensate=True)


def house_fade(value, seconds):
    """Every bulb easing to the house white `value` and the strip to black, held
    until web.py puts the house lights up for real at the end."""
    tracks = {bulb: Track([(0.0, _eased(value, seconds))], HOLD_SECONDS) for bulb in BULBS}
    tracks[STRIP] = Track([(0.0, faded(DARK, seconds) if seconds > 0 else DARK)], HOLD_SECONDS)
    return Cue(tracks, group="house", priority=SHOW)


# ---------------------------------------------------------------- commander --
# A reveal only dims the current player's own lighting while the card is in
# the air — every light keeps its color and effect, just lower, and a strip
# running its own effect is dimmed on the chip rather than stopped — and eases
# it back up as the card lands home (the tracker times that release).

def commander_reveal(settings):
    look = settings["commander_reveal"]
    step = plan_dimmed(look["dim"] / 100, look["fade_in"])
    return Cue({light: Track([(0.0, step)], COMMANDER_HOLD_SECONDS, fade_out=look["fade_out"])
                for light in ALL_LIGHTS}, group="commander", priority=SHOW, compensate=True)


# A burn: the room eases down as the card reaches the middle and catches fire
# with the flame on screen — the bulbs flicker, the one over the table
# hottest, the strip glowing steady under them — then eases to embers three
# quarters of the way through the flame, and back to the plan by the end.
EMBERS_AT = 0.75
BURN_SIDE_SHARE = 0.8


def commander_burn(fire_at, fire_seconds, end, settings):
    look = settings["commander_burn"]
    fire, embers, fade = look["fire"], look["embers"], look["fade"]
    # Let go early enough to be back on the plan when the burn ends.
    let_go = max(fire_at, end - look["fade_out"])
    embers_at = min(let_go, fire_at + EMBERS_AT * fire_seconds)
    start = (0.0, faded(dimmed(look["dim"] / 100), fade))
    to_embers = (embers_at, _eased(_as_color(embers), fade))
    flame = animated("flicker", _as_color(fire), look["flicker"])
    tracks = {CENTER: Track([start, (fire_at, flame), to_embers], let_go, fade_out=look["fade_out"])}
    side_fire = _as_color(fire, fire["brightness"] * BURN_SIDE_SHARE)
    for index, corner in enumerate(CORNERS, start=1):
        # Each corner on a clock and pace of its own, so the bulbs do not
        # flicker as one.
        side_flame = animated("flicker", side_fire, look["flicker"] + 0.2 * index, 0.37 * index)
        tracks[corner] = Track([start, (fire_at, side_flame), to_embers], let_go, fade_out=look["fade_out"])
    tracks[STRIP] = Track([start, (fire_at, _eased(_as_color(fire), fade)),
                           (embers_at, _eased(_as_color(embers, embers["brightness"] * BURN_SIDE_SHARE), fade))],
                          let_go, fade_out=look["fade_out"])
    return Cue(tracks, group="commander", priority=SHOW, compensate=True)
