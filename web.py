"""Web entrypoint: the table life tracker and a separate light control page.

Two independent front-ends share one server:
  /        the Commander life tracker shown on the table screen
  /lights  the phone-friendly light controls (three bulbs + LED strip)

Light control follows LightRPG's structure: three positioned bulbs that can be
driven individually or as a linked group, plus the center-table LED strip.
Lighting effects are deliberately not implemented.
"""

import colorsys
import copy
import json
import os
import re
import threading
from concurrent.futures import TimeoutError as FutureTimeoutError
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from flask import Flask, jsonify, render_template, request, send_from_directory
from werkzeug.exceptions import HTTPException

import bledom_led
import bulb_control
import cues
import lighting
import mdns


BASE_DIR = Path(__file__).resolve().parent
app = Flask(__name__)

# The existing bulb remains the center bulb. The other two start unassigned and
# can be configured or discovered from the Devices panel in the web page. These
# are only the first-run values: whatever the room ends up mapped to is saved
# and restored, so a restart does not send anyone hunting for IPs again.
BULB_NAMES = {
    "top_left": "Top left",
    "center": "Center",
    "bottom_right": "Bottom right",
}
DEFAULT_BULB_IPS = {"top_left": "", "center": bulb_control.DEFAULT_IP, "bottom_right": ""}
bulbs = {key: bulb_control.TapoController(initial_ip=ip) for key, ip in DEFAULT_BULB_IPS.items()}
# Backwards-compatible name for code importing web.bulb.
bulb = bulbs["center"]
discovery_controller = bulb_control.TapoController(initial_ip="")
discovered_bulbs = {}
strip = bledom_led.BledomController()
device_lock = threading.Lock()

# ---------- PLAYER LIGHTING ----------
# The life tracker and the lights page run on different devices (table screen
# and phone), so the per-player colors live here rather than in either browser.
PLAYER_COUNT = 4
CONFIG_FILE = BASE_DIR / "table_config.json"

# Completed games live separately from the lighting configuration. Keeping the
# history in its own portable JSON file makes it easy to back up or move without
# bringing device addresses and room settings with it.
HISTORY_FILE = BASE_DIR / "game_history.json"
GAME_PLAYER_COUNT = 4
GAME_NAME_MAX = 40
GAME_DECK_MAX = 80
game_history = []
historical_wins = []
history_lock = threading.Lock()

# One saved light plan per person, so a table adapts to whoever turns up: each
# file is one player's entry out of the config, named after the profile, and is
# plain JSON you can copy between machines or edit by hand.
PROFILE_DIR = BASE_DIR / "profiles"
PROFILE_NAME_MAX = 40

# Optional player introductions and fixed table announcements are kept apart:
# only Players appears in the per-player picker, while Base holds shared cues.
ANNOUNCER_DIR = BASE_DIR / "sound" / "Announcer"
ANNOUNCER_PLAYER_DIR = ANNOUNCER_DIR / "Players"
ANNOUNCER_BASE_DIR = ANNOUNCER_DIR / "Base"
ANNOUNCER_WINNER_FILE = "Winner.mp3"
ANNOUNCER_EXTENSIONS = {".mp3", ".wav", ".ogg", ".m4a"}
CROWD_SOUND_PATTERN = re.compile(r"^crowd_\d+\.wav$", re.IGNORECASE)
# Recordings of a coin landing, for the coin toss. None are needed: without
# them the tracker makes the sound itself.
COIN_SOUND_PATTERN = re.compile(r"^coin_\d+\.(wav|mp3|ogg|m4a)$", re.IGNORECASE)
# Commander reveals have their own per-player clip. Put recordings in this
# folder and the Lights page discovers them without another code change.
COMMANDER_SOUND_DIR = BASE_DIR / "sound" / "Commander"
COMMANDER_FIRE_FILE = "Fire.mp3"

# Every light a player's turn can be routed to.
LIGHT_IDS = ["top_left", "center", "bottom_right", lighting.STRIP_ID]
LIGHT_LABELS = {
    "top_left": "Top left",
    "center": "Center",
    "bottom_right": "Bottom right",
    lighting.STRIP_ID: "Table LED",
}

# Defaults match the four seat colors used by the life tracker. Each player
# starts driving the three bulbs; the table LED is opt-in per player.
DEFAULT_PLAYERS = [
    {"name": "Player 1", "hue": 0, "saturation": 85, "brightness": 90},
    {"name": "Player 2", "hue": 210, "saturation": 85, "brightness": 90},
    {"name": "Player 3", "hue": 135, "saturation": 80, "brightness": 90},
    {"name": "Player 4", "hue": 45, "saturation": 85, "brightness": 90},
]
DEFAULT_TARGETS = ["top_left", "center", "bottom_right"]

# Numeric limits for one light's settings, shared by validation and the page.
LIGHT_RANGES = (("hue", 0, 360), ("saturation", 0, 100), ("brightness", 1, 100))
DISPLAY_BRIGHTNESS_MIN = 20
DISPLAY_BRIGHTNESS_MAX = 150


def default_light(base, light_id):
    """One light in a player's plan: its own color or white, and its own effect.

    Seeded from the player's base color, so a fresh table looks like the older
    one-color-per-player setup until a light is given something different. The
    white temperature is carried alongside the color rather than replacing it,
    so switching a light to white and back does not lose either setting.
    """
    return {
        "enabled": light_id in DEFAULT_TARGETS,
        "mode": lighting.MODE_COLOR,
        "hue": base["hue"],
        "saturation": base["saturation"],
        "brightness": base["brightness"],
        "temperature": lighting.WHITE_TEMP_DEFAULT,
        "effect": lighting.EFFECT_NONE,
        "effect_seconds": lighting.EFFECT_SECONDS_DEFAULT,
    }


def default_player(base):
    """A player: a base color used as the seed and swatch, plus a light plan."""
    return dict(base, announcer_sound="", commander_sound="", second_commander_sound="",
                commander_name="", second_commander_name="", two_commanders=False,
                background_brightness=100, commander_brightness=70,
                lights={light_id: default_light(base, light_id) for light_id in LIGHT_IDS})


table_state = {
    "players": [default_player(player) for player in DEFAULT_PLAYERS],
    "current_player": 0,
    "fade_enabled": True,
    "fade_seconds": 1.5,
    # How each game moment looks on the lights: the Moments tab, see cues.py.
    "cues": cues.default_settings(),
}
state_lock = threading.Lock()

# ---------- HOUSE LIGHTS ----------
# One switch for "we are not playing right now": plain working light on every
# bulb, the strip off, nothing animating. Turns keep being tracked underneath,
# so switching back hands the table straight to whoever is up by then. It is
# deliberately not saved — a restart comes back to the players' lighting.
HOUSE_TEMPERATURE = 3600
HOUSE_BRIGHTNESS = 100
house_lights = False
# Bumped by every switch of the house lights, so a slow fade to them that has
# since been overtaken does not finish on top of whatever came next.
house_generation = 0


def resolve_device(device_id):
    """Return a controller for a light id, or None when it is not usable yet."""
    if device_id == lighting.STRIP_ID:
        return strip if strip.is_ready() else None
    controller = bulbs.get(device_id)
    return controller if controller is not None and controller.current_ip else None


turn_lighting = lighting.TurnLighting(resolve_device, device_lock, app.logger)


def load_table_state():
    """Restore saved player colors, tolerating a partial or older config file."""
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as config_file:
            saved = json.load(config_file)
    except FileNotFoundError:
        return
    except ValueError as error:
        # Starting from defaults here used to be silent, which reads as "the
        # table forgot everything" with nothing to go on. Keep the file.
        broken = CONFIG_FILE.with_name(CONFIG_FILE.name + ".broken")
        try:
            os.replace(CONFIG_FILE, broken)
        except OSError:
            broken = CONFIG_FILE
        app.logger.error("%s is not readable (%s). Kept it as %s and started from defaults.",
                         CONFIG_FILE.name, error, broken.name)
        return

    load_bulb_ips(saved.get("bulbs"))

    saved_players = saved.get("players") if isinstance(saved.get("players"), list) else []
    first_saved = saved_players[0] if saved_players and isinstance(saved_players[0], dict) else {}

    for index, player in enumerate(saved_players[:PLAYER_COUNT]):
        apply_saved_player(table_state["players"][index], player)

    if saved.get("current_player") in range(PLAYER_COUNT):
        table_state["current_player"] = saved["current_player"]

    # Older configs had one global "also drive the strip" flag; fold it into the
    # per-player light plans that replaced it.
    if saved.get("turn_sets_strip") and "targets" not in first_saved:
        for player in table_state["players"]:
            player["lights"][lighting.STRIP_ID]["enabled"] = True

    # The table LED pulse used to be one global switch. It is now an effect any
    # light can run, so carry it over onto every player's strip.
    if saved.get("pulse_enabled") and "lights" not in first_saved:
        seconds = saved.get("pulse_seconds", lighting.EFFECT_SECONDS_DEFAULT)
        if not isinstance(seconds, (int, float)):
            seconds = lighting.EFFECT_SECONDS_DEFAULT
        for player in table_state["players"]:
            strip_light = player["lights"][lighting.STRIP_ID]
            strip_light["effect"] = "pulse"
            strip_light["effect_seconds"] = lighting.clamp(
                float(seconds), lighting.EFFECT_SECONDS_MIN, lighting.EFFECT_SECONDS_MAX
            )

    table_state["cues"] = cues.merge_settings(saved.get("cues"))
    table_state["fade_enabled"] = bool(saved.get("fade_enabled", True))
    value = saved.get("fade_seconds")
    if isinstance(value, (int, float)) and lighting.FADE_SECONDS_MIN <= value <= lighting.FADE_SECONDS_MAX:
        table_state["fade_seconds"] = round(float(value), 2)


def load_bulb_ips(saved_bulbs):
    """Put the bulbs back where they were before the last shutdown.

    A position saved as empty was deliberately forgotten, so it stays empty
    rather than falling back to the built-in default IP. Duplicates are dropped:
    one physical bulb never sits in two positions.
    """
    if not isinstance(saved_bulbs, dict):
        return

    assigned = set()
    for bulb_id, controller in bulbs.items():
        if bulb_id not in saved_bulbs:
            continue
        ip = str(saved_bulbs[bulb_id] or "").strip()
        if ip and ip not in assigned:
            controller.set_ip(ip)
            assigned.add(ip)
        else:
            controller.clear_ip()


def apply_saved_player(target, saved):
    """Restore one player from saved data, field by field, ignoring the rest.

    Shared by the config file and the per-player profiles, so a profile is
    exactly one player's entry out of the config and can be hand-edited the
    same way.
    """
    if not isinstance(saved, dict):
        return
    if isinstance(saved.get("name"), str) and saved["name"].strip():
        target["name"] = saved["name"].strip()[:18]
    if "announcer_sound" in saved:
        # A deleted or renamed recording should make an old profile silent,
        # rather than handing an unchecked path to the browser.
        target["announcer_sound"] = validate_announcer_sound(saved.get("announcer_sound"))
    target["two_commanders"] = saved.get("two_commanders") is True
    target["second_commander_sound"] = validate_commander_sound(saved.get("second_commander_sound", ""))
    for key in ("commander_name", "second_commander_name"):
        value = saved.get(key)
        if isinstance(value, str):
            target[key] = value.strip()[:GAME_NAME_MAX]
    if "commander_sound" in saved:
        target["commander_sound"] = validate_commander_sound(saved.get("commander_sound"))
    for key in ("background_brightness", "commander_brightness"):
        value = saved.get(key)
        if (isinstance(value, (int, float)) and not isinstance(value, bool)
                and DISPLAY_BRIGHTNESS_MIN <= value <= DISPLAY_BRIGHTNESS_MAX):
            target[key] = int(round(value))
    for key, low, high in LIGHT_RANGES:
        value = saved.get(key)
        if isinstance(value, (int, float)) and low <= value <= high:
            target[key] = int(round(value))

    # A player used to have one color and a list of lights to send it to.
    # Rebuild the per-light plan around that, then let a saved plan win.
    legacy_targets = saved.get("targets")
    if isinstance(legacy_targets, list):
        for light_id, light in target["lights"].items():
            light["enabled"] = light_id in legacy_targets
    for light in target["lights"].values():
        light.update(hue=target["hue"], saturation=target["saturation"], brightness=target["brightness"])
    load_player_lights(target, saved.get("lights"))


def load_player_lights(target, saved_lights):
    """Merge a saved light plan field by field, ignoring anything unrecognised."""
    if not isinstance(saved_lights, dict):
        return
    for light_id, light in target["lights"].items():
        saved = saved_lights.get(light_id)
        if not isinstance(saved, dict):
            continue
        if isinstance(saved.get("enabled"), bool):
            light["enabled"] = saved["enabled"]
        for key, low, high in LIGHT_RANGES:
            value = saved.get(key)
            if isinstance(value, (int, float)) and low <= value <= high:
                light[key] = int(round(value))
        if saved.get("mode") in lighting.MODES:
            light["mode"] = saved["mode"]
        temperature = saved.get("temperature")
        if isinstance(temperature, (int, float)) and lighting.WHITE_TEMP_MIN <= temperature <= lighting.WHITE_TEMP_MAX:
            light["temperature"] = int(round(temperature))
        if saved.get("effect") in lighting.EFFECTS:
            light["effect"] = saved["effect"]
        seconds = saved.get("effect_seconds")
        if isinstance(seconds, (int, float)) and lighting.EFFECT_SECONDS_MIN <= seconds <= lighting.EFFECT_SECONDS_MAX:
            light["effect_seconds"] = round(float(seconds), 2)


def write_json_file(path, payload):
    """Write JSON so an interrupted write cannot leave half a file behind.

    The config is rewritten on every turn change and every slider release, so a
    crash, a Ctrl+C or a power cut lands in the middle of one sooner or later.
    Writing in place truncates first, and a half-written file reads back as no
    file at all — which is the whole config quietly gone. Writing beside it and
    renaming means the old file survives right up until the new one is complete.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def load_game_history():
    """Restore completed games, leaving an unreadable file available to repair."""
    global game_history, historical_wins
    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as history_file:
            saved = json.load(history_file)
    except FileNotFoundError:
        return
    except (OSError, ValueError) as error:
        app.logger.error("Could not load %s (%s)", HISTORY_FILE.name, error)
        return

    games = saved.get("games") if isinstance(saved, dict) else None
    if isinstance(games, list):
        game_history = [game for game in games if isinstance(game, dict)]
    legacy_wins = saved.get("historical_wins") if isinstance(saved, dict) else None
    if isinstance(legacy_wins, list):
        historical_wins = [entry for entry in legacy_wins if isinstance(entry, dict)]


def save_game_history():
    write_json_file(HISTORY_FILE, {
        "version": 2,
        "games": game_history,
        "historical_wins": historical_wins,
    })


def clean_game_text(value, label, maximum):
    value = re.sub(r"\s+", " ", str(value or "")).strip()
    if not value:
        raise ValueError(f"{label} is required")
    if len(value) > maximum:
        raise ValueError(f"{label} must be at most {maximum} characters")
    return value


def game_from_payload(payload):
    """Validate one four-player result and return its persistent representation."""
    date = str(payload.get("date", "")).strip()
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError as error:
        raise ValueError("Date must use YYYY-MM-DD") from error

    outcome = str(payload.get("outcome", "win")).strip().casefold()
    if outcome not in {"win", "draw"}:
        raise ValueError("Game outcome must be win or draw")

    submitted = payload.get("players")
    if not isinstance(submitted, list) or len(submitted) != GAME_PLAYER_COUNT:
        raise ValueError("A game must contain exactly four players")

    players = []
    for entry in submitted:
        if not isinstance(entry, dict):
            raise ValueError("Every player result must be an object")
        name = clean_game_text(entry.get("name"), "Player name", GAME_NAME_MAX)
        deck = clean_game_text(entry.get("deck"), "Deck name", GAME_DECK_MAX)
        try:
            rank = int(entry.get("rank"))
        except (TypeError, ValueError) as error:
            raise ValueError("Every ranking must be a number from 1 to 4") from error
        players.append({"name": name, "deck": deck, "rank": rank})

    if any(entry["rank"] not in {1, 2, 3, 4} for entry in players):
        raise ValueError("Every ranking must be a number from 1 to 4")
    if not any(entry["rank"] == 1 for entry in players):
        raise ValueError("At least one player must be ranked first")
    if outcome == "draw" and sum(entry["rank"] == 1 for entry in players) < 2:
        raise ValueError("A draw must have at least two players tied for first")
    if len({entry["name"].casefold() for entry in players}) != GAME_PLAYER_COUNT:
        raise ValueError("Each player name must be different")

    return {
        "id": uuid4().hex,
        "date": date,
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "outcome": outcome,
        "players": players,
    }


def historical_wins_from_payload(payload):
    """Validate an aggregate win count from before detailed records existed."""
    name = clean_game_text(payload.get("name"), "Player name", GAME_NAME_MAX)
    try:
        wins = int(payload.get("wins"))
    except (TypeError, ValueError) as error:
        raise ValueError("Historical wins must be a whole number") from error
    if isinstance(payload.get("wins"), bool) or wins < 1 or wins > 100000:
        raise ValueError("Historical wins must be between 1 and 100000")
    return {"id": uuid4().hex, "name": name, "wins": wins}


def save_table_state():
    """Persist the player plans and where the bulbs currently live.

    The controllers own their IPs, so they are read back out here rather than
    mirrored into table_state where the two could drift apart.
    """
    saved = dict(table_state, bulbs={key: controller.current_ip for key, controller in bulbs.items()})
    try:
        write_json_file(CONFIG_FILE, saved)
    except OSError as error:
        app.logger.error("Could not write %s (%s); this change will not survive a restart",
                         CONFIG_FILE, error)


def profile_name(value):
    """A profile name reduced to something safe to use as a file name.

    Nothing here may reach outside the profiles folder, so this keeps letters,
    digits, spaces and dashes and drops the rest — including every separator.
    """
    cleaned = re.sub(r"[^A-Za-z0-9 _-]+", "", str(value or "")).strip()[:PROFILE_NAME_MAX]
    if not cleaned:
        raise ValueError("Give the profile a name using letters or numbers")
    return cleaned


def profile_path(name):
    return PROFILE_DIR / f"{profile_name(name)}.json"


def list_announcer_sounds():
    """Selectable recordings in sound/Announcer/Players."""
    try:
        files = [item for item in ANNOUNCER_PLAYER_DIR.iterdir()
                 if item.is_file() and item.suffix.casefold() in ANNOUNCER_EXTENSIONS]
    except OSError:
        return []
    return [{"file": item.name, "label": item.stem.replace("_", " ")}
            for item in sorted(files, key=lambda item: item.stem.casefold())]


def announcer_winner_sound():
    """The fixed victory lead-in, or blank when the recording is not there."""
    winner = ANNOUNCER_BASE_DIR / ANNOUNCER_WINNER_FILE
    return ANNOUNCER_WINNER_FILE if winner.is_file() else ""


def list_crowd_sounds():
    """Numbered crowd reactions available for randomized player entrances."""
    try:
        files = [item.name for item in (BASE_DIR / "sound").iterdir()
                 if item.is_file() and CROWD_SOUND_PATTERN.fullmatch(item.name)]
    except OSError:
        return []
    return sorted(files, key=lambda name: (int(name.rsplit("_", 1)[1].split(".", 1)[0]), name.casefold()))


def list_coin_sounds():
    """Numbered coin recordings the toss picks from at random for each knock."""
    try:
        files = [item.name for item in (BASE_DIR / "sound").iterdir()
                 if item.is_file() and COIN_SOUND_PATTERN.fullmatch(item.name)]
    except OSError:
        return []
    return sorted(files, key=str.casefold)


def validate_announcer_sound(value):
    """Return a catalogued announcer filename, or blank for the silent choice."""
    filename = str(value or "").strip()
    if not filename:
        return ""
    available = {item["file"] for item in list_announcer_sounds()}
    if filename not in available:
        raise ValueError("Choose an announcer sound from sound/Announcer/Players")
    return filename


def list_commander_sounds():
    """Selectable commander reveal recordings in sound/Commander."""
    try:
        files = [item for item in COMMANDER_SOUND_DIR.iterdir()
                 if item.is_file() and item.suffix.casefold() in ANNOUNCER_EXTENSIONS
                 and item.name.casefold() != COMMANDER_FIRE_FILE.casefold()]
    except OSError:
        return []
    return [{"file": item.name, "label": item.stem.replace("_", " ")}
            for item in sorted(files, key=lambda item: item.stem.casefold())]


def validate_commander_sound(value):
    filename = str(value or "").strip()
    if not filename:
        return ""
    available = {item["file"] for item in list_commander_sounds()}
    if filename not in available:
        raise ValueError("Choose a commander sound from sound/Commander")
    return filename


def list_profiles():
    """Every saved profile, newest first. The file name is the profile name."""
    try:
        files = sorted(PROFILE_DIR.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True)
    except OSError:
        return []
    return [{"name": item.stem, "saved": int(item.stat().st_mtime)} for item in files]


def player_index(value):
    try:
        index = int(value)
    except (TypeError, ValueError):
        raise ValueError("Unknown player")
    if not 0 <= index < PLAYER_COUNT:
        raise ValueError(f"Player must be between 1 and {PLAYER_COUNT}")
    return index


def player_targets(player):
    """The lights this player drives, in a stable order, for the compact view."""
    return [light_id for light_id in LIGHT_IDS if player["lights"][light_id]["enabled"]]


def player_plan(index):
    """What one player's turn looks like: a value and an effect per light."""
    player = table_state["players"][index]
    plan = {}
    for light_id in player_targets(player):
        light = player["lights"][light_id]
        plan[light_id] = {
            "color": lighting.light_value(light),
            "effect": light["effect"],
            "seconds": light["effect_seconds"],
        }
    return plan


def apply_player_lighting(index, fade=True, refresh_strip=False):
    """Hand every light this player drives its own color and effect.

    Returns the number of devices addressed. Zero is a normal outcome: the
    tracker fires this on every turn change even with no lights set up yet, and
    the house lights hold the room until they are switched back off.

    `refresh_strip` says the power-on has to go out again whatever we believe.
    The strip's caches assume every packet landed: a power-on is remembered the
    moment it is written, and an effect the chip is already running is not
    re-sent. Over BLE a write is not always taken, and when the lost one is the
    power-on, the strip sits dark through every later turn because nothing ever
    thinks to say it again. Turn changes and coming back from the house lights
    are rare and already re-send the whole room, so they pay the extra packets
    rather than trust the cache; the live preview paths, which fire on every
    drag of a slider, do not.
    """
    if house_lights:
        return 0
    # A cue driving the strip right now is proof enough that it is lit, and it
    # restarts the strip's effect itself as it lets go; a power-on sent under
    # it would only hold up its next frame.
    if refresh_strip and not turn_lighting.is_cued(lighting.STRIP_ID):
        strip.forget_state()
        turn_lighting.forget_effects(lighting.STRIP_ID)
    fade_seconds = table_state["fade_seconds"] if (fade and table_state["fade_enabled"]) else 0
    return turn_lighting.apply_plan(player_plan(index), fade_seconds)


def apply_house_lights():
    """Plain white on every bulb, the strip off, and nothing left animating.

    Returns the number of lights addressed and a note for anything that would
    not comply: the bulbs are already white by then, so a strip that does not
    answer is worth saying out loud rather than failing the whole switch.
    """
    value = house_value()
    plan = {bulb_id: {"color": value, "effect": lighting.EFFECT_NONE,
                      "seconds": lighting.EFFECT_SECONDS_DEFAULT}
            for bulb_id in BULB_NAMES}

    # Nothing plays over the house lights. A cue still running would light the
    # strip back up after it goes off, and hand the bulbs back to a player.
    turn_lighting.cancel_cues()
    # Forgetting the strip first stops the plan writing it a resting color on
    # the way past; it is about to be switched off instead.
    turn_lighting.forget_effects(lighting.STRIP_ID)
    applied = turn_lighting.apply_plan(plan, fade_seconds=0)

    notes = []
    if not strip.is_ready():
        notes.append("the LED strip is not connected")
    else:
        try:
            with device_lock:
                wait_for(strip.set_power(False))
            applied += 1
        except Exception as error:
            app.logger.warning("Could not switch the LED strip off: %s", error)
            notes.append("the LED strip did not answer")
    return applied, notes


def house_value():
    return lighting.light_value({
        "mode": lighting.MODE_WHITE,
        "brightness": HOUSE_BRIGHTNESS,
        "temperature": HOUSE_TEMPERATURE,
    })


def fade_to_house_lights(seconds):
    """Switch the house lights on, easing the room there over `seconds`.

    The bulbs ease to the house white and the strip to black under a cue, and
    the house lights proper go up at the end — unless something else has
    switched the lights since.
    """
    global house_lights, house_generation
    house_lights = True
    house_generation += 1
    if seconds <= 0:
        return apply_house_lights()
    generation = house_generation
    turn_lighting.play_cue(cues.house_fade(house_value(), seconds), take_room=True)

    def arrive():
        if house_lights and house_generation == generation:
            try:
                apply_house_lights()
            except Exception as error:
                app.logger.warning("Could not finish fading to the house lights: %s", error)

    threading.Timer(seconds, arrive).start()
    return 0, []


def player_payload(index):
    """One player as the pages see it: base color, light plan, derived targets."""
    player = table_state["players"][index]
    return dict(player, targets=player_targets(player))


def players_payload():
    return [player_payload(index) for index in range(PLAYER_COUNT)]


def number(payload, name, minimum, maximum, *, integer=True):
    if name not in payload:
        raise ValueError(f"Missing {name}")
    value = float(payload[name])
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return int(round(value)) if integer else value


def wait_for(future, timeout=35):
    try:
        return future.result(timeout=timeout)
    except FutureTimeoutError as exc:
        raise RuntimeError("The device did not respond in time") from exc


def wait_for_all(futures):
    for future in futures:
        wait_for(future)


def ok(message, **extra):
    return jsonify({"ok": True, "message": message, **extra})


def get_bulb(bulb_id):
    if bulb_id not in bulbs:
        raise ValueError("Unknown bulb")
    return bulbs[bulb_id]


def target_bulbs(target, *, default="center"):
    target = target or default
    if isinstance(target, list):
        if not target:
            raise ValueError("Select at least one bulb")
        unique_targets = list(dict.fromkeys(target))
        selected = []
        for bulb_id in unique_targets:
            controller = get_bulb(bulb_id)
            if not controller.current_ip:
                raise ValueError(f"Configure or find the {BULB_NAMES[bulb_id].lower()} bulb first")
            selected.append((bulb_id, controller))
        return selected
    if target in {"all", "all_bulbs"}:
        configured = [(key, controller) for key, controller in bulbs.items() if controller.current_ip]
        if not configured:
            raise ValueError("Configure or find at least one bulb first")
        return configured
    controller = get_bulb(target)
    if not controller.current_ip:
        raise ValueError(f"Configure or find the {BULB_NAMES[target].lower()} bulb first")
    return [(target, controller)]


def requested_bulbs(payload, *, default="center"):
    """Resolve a linked frontend group or a legacy single target."""
    if "targets" in payload:
        if not isinstance(payload["targets"], list):
            raise ValueError("targets must be a list of bulb ids")
        return target_bulbs(payload["targets"], default=default)
    return target_bulbs(payload.get("target"), default=default)


@app.after_request
def no_stale_copies(response):
    """Keep the API and the pages out of browser caches.

    Every response used to go out with no cache headers at all, which leaves a
    browser free to reuse an old copy — and the lights page builds its whole
    display from /api/status, so a phone holding a stale one shows a table that
    stopped existing hours ago, and looks for all the world like the settings
    were never saved. Everything here is local and cheap: nothing is worth
    caching. Static files keep the revalidation Flask already gives them.
    """
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    else:
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


@app.errorhandler(Exception)
def handle_error(error):
    # Device errors become a 400 the pages can display. Routing errors keep
    # their own status, so a missing asset stays a 404 instead of a bad request.
    if isinstance(error, HTTPException):
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "message": error.description}), error.code
        return error
    app.logger.exception("MTG table request failed")
    return jsonify({"ok": False, "message": str(error) or "Unexpected error"}), 400


# -----------------------------
# PAGES
# -----------------------------
@app.get("/")
def index():
    """The life tracker is a plain static page, not a template."""
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/css/<path:filename>")
def css_asset(filename):
    return send_from_directory(BASE_DIR / "css", filename)


@app.get("/js/<path:filename>")
def js_asset(filename):
    return send_from_directory(BASE_DIR / "js", filename)


@app.get("/sound/<path:filename>")
def sound_asset(filename):
    return send_from_directory(BASE_DIR / "sound", filename)


@app.get("/Backgrounds/<path:filename>")
def background_asset(filename):
    return send_from_directory(BASE_DIR / "Backgrounds", filename)


@app.get("/lights")
def lights():
    return render_template(
        "lights.html",
        bulbs={key: {"name": BULB_NAMES[key], "ip": controller.current_ip} for key, controller in bulbs.items()},
    )


@app.get("/leaderboard")
def leaderboard():
    return render_template("leaderboard.html")


@app.get("/leaderboard/entry")
def leaderboard_entry():
    """Recording results, on its own page and never rotated.

    The leaderboard itself sits tilted on the table screen so it can be read
    from a seat; typing into a page turned on its side is another matter, so
    entry lives here and stays upright whatever the display is doing.
    """
    return render_template("entry.html")


# -----------------------------
# GAME HISTORY AND LEADERBOARD
# -----------------------------
@app.get("/api/games")
def get_games():
    with history_lock:
        games = copy.deepcopy(game_history)
        legacy_wins = copy.deepcopy(historical_wins)
    games.sort(key=lambda game: (game.get("date", ""), game.get("created_at", "")), reverse=True)
    legacy_wins.sort(key=lambda entry: (-int(entry.get("wins", 0)), str(entry.get("name", "")).casefold()))
    return jsonify({"ok": True, "games": games, "historical_wins": legacy_wins})


@app.post("/api/games")
def add_game():
    game = game_from_payload(request.get_json(force=True, silent=True) or {})
    with history_lock:
        game_history.append(game)
        try:
            save_game_history()
        except Exception:
            game_history.pop()
            raise
    return ok("Game added to the leaderboard", game=game), 201


@app.delete("/api/games/<game_id>")
def delete_game(game_id):
    with history_lock:
        index = next((index for index, game in enumerate(game_history)
                      if game.get("id") == game_id), None)
        if index is None:
            raise ValueError("Game not found")
        removed = game_history.pop(index)
        try:
            save_game_history()
        except Exception:
            game_history.insert(index, removed)
            raise
    return ok("Game removed from the leaderboard")


@app.post("/api/historical-wins")
def set_historical_wins():
    """Add or replace one player's aggregate wins from incomplete old records."""
    entry = historical_wins_from_payload(request.get_json(force=True, silent=True) or {})
    with history_lock:
        index = next((index for index, saved in enumerate(historical_wins)
                      if str(saved.get("name", "")).casefold() == entry["name"].casefold()), None)
        replaced = historical_wins[index] if index is not None else None
        if index is None:
            historical_wins.append(entry)
        else:
            entry["id"] = replaced.get("id") or entry["id"]
            historical_wins[index] = entry
        try:
            save_game_history()
        except Exception:
            if index is None:
                historical_wins.pop()
            else:
                historical_wins[index] = replaced
            raise
    action = "updated" if replaced is not None else "added"
    return ok(f"Historical wins {action} for {entry['name']}", historical_wins=entry)


@app.delete("/api/historical-wins/<entry_id>")
def delete_historical_wins(entry_id):
    with history_lock:
        index = next((index for index, entry in enumerate(historical_wins)
                      if entry.get("id") == entry_id), None)
        if index is None:
            raise ValueError("Historical win entry not found")
        removed = historical_wins.pop(index)
        try:
            save_game_history()
        except Exception:
            historical_wins.insert(index, removed)
            raise
    return ok("Historical wins removed")


# -----------------------------
# DEVICE SETUP
# -----------------------------
@app.get("/api/status")
def status():
    return jsonify({
        "ok": True,
        "bulb_ip": bulb.current_ip,
        "bulbs": {
            key: {"name": BULB_NAMES[key], "ip": controller.current_ip, "configured": bool(controller.current_ip)}
            for key, controller in bulbs.items()
        },
        "strip_connected": strip.is_ready(),
        "players": players_payload(),
        "current_player": table_state["current_player"],
        "lights": [{"id": key, "label": LIGHT_LABELS[key], "ready": resolve_device(key) is not None}
                   for key in LIGHT_IDS],
        "fade_enabled": table_state["fade_enabled"],
        "fade_seconds": table_state["fade_seconds"],
        # The page builds its effect menus from this rather than hard-coding them.
        "effects": [{"id": effect, "label": lighting.EFFECT_LABELS[effect]} for effect in lighting.EFFECTS],
        "effect_seconds_min": lighting.EFFECT_SECONDS_MIN,
        "effect_seconds_max": lighting.EFFECT_SECONDS_MAX,
        "white_temp_min": lighting.WHITE_TEMP_MIN,
        "white_temp_max": lighting.WHITE_TEMP_MAX,
        "house_lights": house_lights,
        "house_temperature": HOUSE_TEMPERATURE,
        "profiles": list_profiles(),
        "announcer_sounds": list_announcer_sounds(),
        "announcer_winner": announcer_winner_sound(),
        "crowd_sounds": list_crowd_sounds(),
        "coin_sounds": list_coin_sounds(),
        "commander_sounds": list_commander_sounds(),
        "effects_running": turn_lighting.effects_running,
        # Each light's usual round trip, as measured on every write.
        "light_latency_ms": turn_lighting.latency_ms,
        # The Moments tab builds its controls from these.
        "moments": cues.MOMENTS,
        "moment_settings": table_state["cues"],
    })


# -----------------------------
# PLAYER COLORS AND TURN ORDER
# -----------------------------
@app.get("/api/table")
def get_table_state():
    return jsonify({"ok": True, **table_state, "players": players_payload(),
                    "announcer_sounds": list_announcer_sounds(),
                    "announcer_winner": announcer_winner_sound(),
                    "crowd_sounds": list_crowd_sounds(),
                    "coin_sounds": list_coin_sounds(),
                    "commander_sounds": list_commander_sounds()})


@app.post("/api/players/<index>/color")
def set_player_color(index):
    """Set a player's base color.

    `spread` also pushes it onto every one of that player's lights, which is
    what the compact "use picked color" control means; without it only the base
    color moves and any per-light colors are left alone.
    """
    payload = request.get_json(force=True)
    index = player_index(index)
    hue = number(payload, "hue", 0, 360)
    saturation = number(payload, "saturation", 0, 100)
    brightness = number(payload, "brightness", 1, 100)
    spread = bool(payload.get("spread", True))

    with state_lock:
        player = table_state["players"][index]
        player.update(hue=hue, saturation=saturation, brightness=brightness)
        if spread:
            # One color for the whole player, so a light left on white goes back
            # to color rather than quietly ignoring the new one.
            for light in player["lights"].values():
                light.update(mode=lighting.MODE_COLOR, hue=hue, saturation=saturation, brightness=brightness)
        save_table_state()

    name = player["name"]
    if payload.get("preview") and index == table_state["current_player"]:
        # Recoloring the player whose turn it is should show up straight away.
        apply_player_lighting(index)
    return ok(
        f"Saved the {name} color" + (" on every light" if spread else ""),
        player=player_payload(index),
    )


@app.post("/api/players/<index>/announcer")
def set_player_announcer(index):
    """Choose the recording played when this player's cover is removed."""
    payload = request.get_json(force=True, silent=True) or {}
    index = player_index(index)
    sound = validate_announcer_sound(payload.get("sound"))

    with state_lock:
        player = table_state["players"][index]
        player["announcer_sound"] = sound
        save_table_state()

    return ok(f"{player['name']} announcer: {sound or 'none'}",
              player=player_payload(index))


@app.post("/api/players/<index>/commander-sound")
def set_player_commander_sound(index):
    """Choose the recording played as this player's commander is revealed."""
    payload = request.get_json(force=True, silent=True) or {}
    index = player_index(index)
    sound = validate_commander_sound(payload.get("sound"))

    with state_lock:
        player = table_state["players"][index]
        player["second_commander_sound" if payload.get("slot") == 2 else "commander_sound"] = sound
        save_table_state()

    return ok(f"{player['name']} commander sound: {sound or 'none'}",
              player=player_payload(index))


@app.post("/api/players/<index>/two-commanders")
def set_two_commanders(index):
    payload = request.get_json(force=True, silent=True) or {}
    index = player_index(index)
    with state_lock:
        table_state["players"][index]["two_commanders"] = payload.get("enabled") is True
        save_table_state()
    return ok("Commander settings saved", player=player_payload(index))


@app.post("/api/players/<index>/commander-names")
def set_commander_names(index):
    """Set the labels used for this player's separate commander damage."""
    payload = request.get_json(force=True, silent=True) or {}
    index = player_index(index)
    with state_lock:
        player = table_state["players"][index]
        for key in ("commander_name", "second_commander_name"):
            if key in payload:
                player[key] = str(payload[key] or "").strip()[:GAME_NAME_MAX]
        save_table_state()
    return ok("Commander names saved", player=player_payload(index))


@app.post("/api/players/<index>/display")
def set_player_display(index):
    """Adjust that player's artwork on the table display, independently of lights."""
    payload = request.get_json(force=True, silent=True) or {}
    index = player_index(index)
    notes = []

    with state_lock:
        player = table_state["players"][index]
        for key, label in (("background_brightness", "background"),
                           ("commander_brightness", "commander")):
            if key not in payload:
                continue
            player[key] = number(payload, key, DISPLAY_BRIGHTNESS_MIN, DISPLAY_BRIGHTNESS_MAX)
            notes.append(f"{label} {player[key]}%")
        save_table_state()

    return ok(f"{player['name']} display: {', '.join(notes) if notes else 'no change'}",
              player=player_payload(index))


@app.post("/api/players/<index>/lights/<light_id>")
def set_player_light(index, light_id):
    """Change one light in one player's plan: color, effect, or whether it runs."""
    payload = request.get_json(force=True)
    index = player_index(index)
    if light_id not in LIGHT_IDS:
        raise ValueError(f"Unknown light: {light_id}")

    with state_lock:
        player = table_state["players"][index]
        light = player["lights"][light_id]
        notes = update_light(light, payload)
        save_table_state()

    applied = 0
    # Editing the player whose turn it is should show on the lights as you go.
    if payload.get("preview", True) and index == table_state["current_player"]:
        applied = apply_player_lighting(index, fade=False)

    label = LIGHT_LABELS[light_id]
    return ok(
        f"{player['name']} · {label}: {', '.join(notes) if notes else 'no change'}",
        player=player_payload(index),
        lights_applied=applied,
    )


def update_light(light, payload):
    """Apply a partial light update in place, validating every field it names."""
    notes = []
    if "enabled" in payload:
        light["enabled"] = bool(payload["enabled"])
        notes.append("on" if light["enabled"] else "off")

    if "temperature" in payload:
        light["temperature"] = number(payload, "temperature", lighting.WHITE_TEMP_MIN, lighting.WHITE_TEMP_MAX)

    # Picking a color means color, and reaching for the warmth slider means
    # white, so neither costs a second tap on the mode button.
    if "mode" in payload:
        if payload["mode"] not in lighting.MODES:
            raise ValueError(f"Unknown light mode: {payload['mode']}")
        light["mode"] = payload["mode"]
    elif "hue" in payload or "saturation" in payload:
        light["mode"] = lighting.MODE_COLOR
    elif "temperature" in payload:
        light["mode"] = lighting.MODE_WHITE

    recolored = False
    for key, low, high in LIGHT_RANGES:
        if key in payload:
            light[key] = number(payload, key, low, high)
            recolored = True
    if recolored or "mode" in payload or "temperature" in payload:
        notes.append(f"{light['temperature']}K white" if light["mode"] == lighting.MODE_WHITE
                     else f"H:{light['hue']} S:{light['saturation']}")
        notes.append(f"B:{light['brightness']}%")

    if "effect" in payload:
        effect = str(payload["effect"])
        if effect not in lighting.EFFECTS:
            raise ValueError(f"Unknown effect: {effect}")
        light["effect"] = effect
        notes.append(lighting.EFFECT_LABELS[effect])
    if "effect_seconds" in payload:
        light["effect_seconds"] = number(
            payload, "effect_seconds", lighting.EFFECT_SECONDS_MIN, lighting.EFFECT_SECONDS_MAX, integer=False
        )
        notes.append(f"{light['effect_seconds']:.1f}s")
    return notes


@app.post("/api/players/<index>/preview")
def preview_player_color(index):
    index = player_index(index)
    if house_lights:
        raise ValueError("The house lights are on. Switch them off to show a player's lighting.")
    applied = apply_player_lighting(index)
    name = table_state["players"][index]["name"]
    if not applied:
        raise ValueError(
            "None of that player's lights are ready. Assign a bulb or connect the "
            "strip, and check the player's light selection."
        )
    return ok(f"Showing {name}'s lighting on {applied} light{'s' if applied != 1 else ''}")


@app.post("/api/players/<index>/targets")
def set_player_targets(index):
    payload = request.get_json(force=True)
    index = player_index(index)
    targets = payload.get("targets")
    if not isinstance(targets, list):
        raise ValueError("targets must be a list of light ids")

    unknown = [item for item in targets if item not in LIGHT_IDS]
    if unknown:
        raise ValueError(f"Unknown light: {unknown[0]}")

    with state_lock:
        player = table_state["players"][index]
        for light_id, light in player["lights"].items():
            light["enabled"] = light_id in targets
        save_table_state()

    chosen = [LIGHT_LABELS[item] for item in player_targets(player)]
    return ok(
        f"{player['name']}: {', '.join(chosen)}" if chosen else f"{player['name']} drives no lights",
        player=player_payload(index),
    )


@app.get("/api/profiles")
def get_profiles():
    return jsonify({"ok": True, "profiles": list_profiles(), "folder": PROFILE_DIR.name})


@app.post("/api/players/<index>/profile")
def save_player_profile(index):
    """Write one player's whole light plan out to profiles/<name>.json."""
    payload = request.get_json(force=True, silent=True) or {}
    index = player_index(index)

    with state_lock:
        player = table_state["players"][index]
        name = profile_name(payload.get("profile") or player["name"])
        profile = copy.deepcopy(player)
        profile["saved_at"] = datetime.now().isoformat(timespec="seconds")

    try:
        write_json_file(profile_path(name), profile)
    except OSError as error:
        raise RuntimeError(f"Could not write the profile: {error}") from error

    return ok(f"Saved {name} to {PROFILE_DIR.name}/{name}.json", profile=name, profiles=list_profiles())


@app.post("/api/players/<index>/profile/load")
def load_player_profile(index):
    """Put a saved profile onto a player, lights, name and all."""
    payload = request.get_json(force=True, silent=True) or {}
    index = player_index(index)
    name = profile_name(payload.get("profile"))

    try:
        with open(profile_path(name), "r", encoding="utf-8") as profile_file:
            saved = json.load(profile_file)
    except FileNotFoundError as error:
        raise ValueError(f"No profile called {name}") from error
    except ValueError as error:
        raise ValueError(f"{name}.json is not readable: {error}") from error

    with state_lock:
        apply_saved_player(table_state["players"][index], saved)
        save_table_state()

    applied = 0
    if index == table_state["current_player"]:
        applied = apply_player_lighting(index, fade=False)
    return ok(
        f"Loaded {name} onto player {index + 1}",
        player=player_payload(index),
        players=players_payload(),
        lights_applied=applied,
    )


@app.post("/api/players/names")
def set_player_names():
    """The life tracker owns player names and pushes them here when edited."""
    payload = request.get_json(force=True)
    names = payload.get("names")
    if not isinstance(names, list):
        raise ValueError("names must be a list")

    with state_lock:
        for index, name in enumerate(names[:PLAYER_COUNT]):
            if isinstance(name, str) and name.strip():
                table_state["players"][index]["name"] = name.strip()[:18]
        save_table_state()
    return ok("Player names updated", players=players_payload())


@app.post("/api/turn")
def set_turn():
    payload = request.get_json(force=True)
    index = player_index(payload.get("player"))

    with state_lock:
        table_state["current_player"] = index
        save_table_state()

    applied = apply_player_lighting(index, refresh_strip=True) if payload.get("apply_lights", True) else 0
    name = table_state["players"][index]["name"]
    return ok(
        f"{name}'s turn" + (f" ({applied} light{'s' if applied != 1 else ''})" if applied else ""),
        current_player=index,
        lights_applied=applied,
    )


@app.post("/api/lights/house")
def set_house_lights():
    """Switch the table between plain working light and the players' lighting.

    Sent with no body it toggles, which is what the tracker's one button does;
    `on` forces a side for anything that wants to be sure which way it went.
    """
    global house_lights, house_generation
    payload = request.get_json(force=True, silent=True) or {}
    enabled = payload.get("on")
    if not isinstance(enabled, bool):
        enabled = not house_lights

    was_on = house_lights
    house_lights = enabled
    house_generation += 1
    try:
        if enabled:
            applied, notes = apply_house_lights()
            return ok(
                f"House lights on: {HOUSE_TEMPERATURE}K at {HOUSE_BRIGHTNESS}%"
                + (f" on {applied} light{'s' if applied != 1 else ''}" if applied else "")
                + ("; " + ", ".join(notes) if notes else ""),
                house_lights=True,
                lights_applied=applied,
            )

        index = table_state["current_player"]
        # A slow fade to the house lights may still be holding the room.
        turn_lighting.release("house")
        # The strip was switched off on the way in, so the power-on it is owed
        # must not be skipped over by a cache that thinks it is still lit.
        applied = apply_player_lighting(index, fade=False, refresh_strip=True)
        return ok(
            f"House lights off: back to {table_state['players'][index]['name']}'s lighting",
            house_lights=False,
            lights_applied=applied,
        )
    except Exception:
        # Nothing was switched, so the button must not be left saying it was.
        house_lights = was_on
        raise


@app.post("/api/lights/resend")
def resend_lights():
    """Send the room's current lighting again, whatever it is.

    For when a light has drifted out of step: a bulb missed a command, the strip
    dropped its Bluetooth link, someone used the Tapo app. Everything this server
    caches to avoid needless traffic — what each bulb was last told, what the
    strip is running, what the painter last drew — is exactly what would suppress
    the fix, so it is all cleared first and the whole state goes out fresh.
    """
    # A cue in the middle of a moment is not "the current state": drop it.
    turn_lighting.cancel_cues()
    for controller in bulbs.values():
        controller.forget_state()
    strip.forget_state()
    turn_lighting.forget_effects(*LIGHT_IDS)

    notes = []
    if not strip.is_ready() and strip.device is not None:
        # A dropped link is invisible until something tries to use it, and while
        # it is down the strip is left out of every plan.
        try:
            with device_lock:
                wait_for(strip.reconnect(), timeout=30)
        except Exception as error:
            app.logger.warning("Could not reconnect the LED strip: %s", error)
            notes.append("the LED strip did not reconnect")

    if house_lights:
        applied, house_notes = apply_house_lights()
        notes += house_notes
        what = "house lights"
    else:
        index = table_state["current_player"]
        applied = apply_player_lighting(index, fade=False)
        what = f"{table_state['players'][index]['name']}'s lighting"

    return ok(
        f"Sent {what} again to {applied} light{'s' if applied != 1 else ''}"
        + ("; " + ", ".join(notes) if notes else ""),
        lights_applied=applied,
        house_lights=house_lights,
    )


# ---------- GAME MOMENTS ----------
# The entrance and the first-player spin start the game, so they take the whole
# room, even from the house lights (the spin always did), and lay a plan out
# underneath: whatever the show hands the lights back to is somebody's turn.
# The winner's show ends the game the same way, handing the room to the house
# lights once the winner has been announced.
ROOM_CUES = {"entrance_start", "entrance_player", "entrance_fight", "spin", "winner"}
# Which Moments-tab setting each cue from the tracker belongs to.
CUE_MOMENTS = {"damage": "damage", "heal": "heal", "entrance_start": "entrance", "entrance_player": "entrance",
               "entrance_fight": "entrance", "spin": "spin", "commander_reveal": "commander_reveal",
               "commander_burn": "commander_burn", "winner": "winner", "winner_home": "winner"}


def cue_seconds(payload, name, low, high, default):
    """An optional time in a cue request, held to a range that makes sense."""
    value = payload.get(name, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        value = default
    return lighting.clamp(float(value), low, high)


def spin_ticks(payload):
    """The spin as [(seconds, seat)] in time order, ending on the chosen seat."""
    raw = payload.get("ticks")
    if not isinstance(raw, list) or not 1 <= len(raw) <= 64:
        raise ValueError("A spin needs between 1 and 64 ticks")
    ticks = []
    for tick in raw:
        if not isinstance(tick, dict):
            raise ValueError("Every spin tick needs a time and a seat")
        ticks.append((cue_seconds(tick, "at", 0.0, 15.0, 0.0), player_index(tick.get("seat"))))
    return sorted(ticks, key=lambda tick: tick[0])


def build_cue(kind, payload):
    """The cue for one moment of the game, from what the tracker sent."""
    settings = table_state["cues"]
    if kind in ("damage", "heal"):
        return cues.life_flash(kind == "heal", settings)
    if kind == "entrance_start":
        return cues.entrance_start(settings)
    if kind == "entrance_player":
        return cues.entrance_player(cue_seconds(payload, "reveal_in", 0.0, 5.0, 0.9), settings)
    if kind == "entrance_fight":
        return cues.entrance_fight(settings)
    if kind == "spin":
        colors = [(player["hue"], player["saturation"]) for player in table_state["players"]]
        return cues.spin(spin_ticks(payload), colors, settings)
    if kind == "commander_reveal":
        return cues.commander_reveal(settings)
    if kind == "commander_burn":
        end = cue_seconds(payload, "end", 1.0, 15.0, 6.2)
        fire_at = cue_seconds(payload, "fire_at", 0.0, end, 1.1)
        return cues.commander_burn(fire_at, cue_seconds(payload, "fire_seconds", 0.0, end - fire_at, 4.5), end,
                                   settings)
    if kind == "winner":
        return cues.winner(cue_seconds(payload, "reveal_in", 0.0, 15.0, 6.0), settings)
    raise ValueError(f"Unknown cue: {kind}")


@app.post("/api/cue")
def play_game_cue():
    """Play a moment of the game on the lights, answering at once.

    The tracker only says what happened; cues.py decides what each light does
    about it, and the painter plays it in its own time, handing every light
    back to its plan as the cue ends. A hit, a heal or a commander plays
    nothing under the house lights. `release` ends a cue that
    has no fixed end, optionally `in` a few seconds and with `restore` putting
    the current player's lighting back underneath.
    """
    global house_lights
    payload = request.get_json(force=True, silent=True) or {}
    kind = str(payload.get("kind", ""))

    if kind == "release":
        group = str(payload.get("group", ""))
        turn_lighting.release(group, cue_seconds(payload, "in", 0.0, 30.0, 0.0))
        if payload.get("restore") is True and not house_lights:
            apply_player_lighting(table_state["current_player"], fade=False)
        return ok(f"Released the {group} lighting", house_lights=house_lights)

    moment = CUE_MOMENTS.get(kind)
    if moment is None:
        raise ValueError(f"Unknown cue: {kind}")
    enabled = table_state["cues"][moment]["enabled"]
    if moment == "winner" and (kind == "winner_home" or not enabled):
        # A won game always ends on the house lights: slowly after the show,
        # at once with the show switched off.
        fade_to_house_lights(table_state["cues"]["winner"]["home_fade"] if enabled else 0.0)
        return ok("Back to the house lights", lights=[], house_lights=True)
    if not enabled:
        return ok(f"{cues.moment_label(moment)} lighting is switched off", lights=[], house_lights=house_lights)

    cue = build_cue(kind, payload)
    if kind in ROOM_CUES:
        seat = (player_index(payload.get("seat")) if kind in ("entrance_player", "winner")
                else table_state["current_player"])
        taken = play_room_cue(cue, seat)
    elif house_lights:
        return ok("House lights are on, so the lights stay as they are", lights=[], house_lights=True)
    else:
        taken = play_moment_cue(cue, lay_out=payload.get("follow") is True)

    return ok(f"Playing {kind} on {len(taken)} light{'s' if len(taken) != 1 else ''}",
              lights=taken, house_lights=house_lights)


def play_room_cue(cue, seat):
    """Play a show that starts the game: it takes the whole room, even from the
    house lights, with `seat`'s plan laid out underneath so none of it shows
    until the show lets go."""
    global house_lights, house_generation
    turn_lighting.release("house")
    taken = turn_lighting.play_cue(cue, take_room=True)
    was_house = house_lights
    house_lights = False
    house_generation += 1
    apply_player_lighting(seat, fade=False, refresh_strip=was_house)
    return taken


def play_moment_cue(cue, lay_out=True):
    """Play a cue over the current plan.

    If nothing has been put on the lights since the server started there is no
    plan for the cue to hand them back to, so with `lay_out` the current
    player's goes up now, underneath it.
    """
    taken = turn_lighting.play_cue(cue)
    if lay_out and not turn_lighting.has_laid_out:
        apply_player_lighting(table_state["current_player"], fade=False)
    return taken


@app.post("/api/moments/<moment_id>")
def set_moment(moment_id):
    """Change how one game moment looks, from the lights page's Moments tab."""
    payload = request.get_json(force=True, silent=True) or {}
    with state_lock:
        changed = cues.update_settings(table_state["cues"], moment_id, payload)
        save_table_state()
    return ok(f"{cues.moment_label(moment_id)}: {', '.join(changed) if changed else 'no change'}",
              settings=table_state["cues"][moment_id])


@app.post("/api/moments/<moment_id>/test")
def test_moment(moment_id):
    """Play one moment on the room now, as set, whether or not it is switched on."""
    settings = table_state["cues"]
    current = table_state["current_player"]
    if moment_id in ("entrance", "spin", "winner"):
        if moment_id == "winner":
            # A shorter drum roll, the current player as the winner, and the
            # house lights a few seconds after the reveal.
            taken = play_room_cue(cues.winner(4.0, settings), current)
            generation = house_generation

            def home():
                if house_generation == generation:
                    fade_to_house_lights(settings["winner"]["home_fade"])

            threading.Timer(7.0, home).start()
        elif moment_id == "spin":
            colors = [(each["hue"], each["saturation"]) for each in table_state["players"]]
            taken = play_room_cue(cues.spin(cues.demo_spin_ticks([0, 1, 3, 2], current), colors, settings), current)
        else:
            # Lights down for a few seconds, then the current player walks out.
            taken = play_room_cue(cues.entrance_start(settings), current)
            threading.Timer(3.0, play_room_cue, args=(cues.entrance_player(0.9, settings), current)).start()
    else:
        if house_lights:
            raise ValueError("The house lights are on. Switch them off to try a moment.")
        if moment_id in ("damage", "heal"):
            taken = play_moment_cue(cues.life_flash(moment_id == "heal", settings))
        elif moment_id == "commander_reveal":
            taken = play_moment_cue(cues.commander_reveal(settings))
            turn_lighting.release("commander", 3.5)
        elif moment_id == "commander_burn":
            taken = play_moment_cue(cues.commander_burn(1.1, 4.5, 6.2, settings))
        else:
            raise ValueError(f"Unknown moment: {moment_id}")
    return ok(f"Trying {cues.moment_label(moment_id).lower()} on {len(taken)} "
              f"light{'s' if len(taken) != 1 else ''}", house_lights=house_lights)


@app.post("/api/table/settings")
def update_table_settings():
    payload = request.get_json(force=True)
    notes = []

    with state_lock:
        if "fade_enabled" in payload:
            table_state["fade_enabled"] = bool(payload["fade_enabled"])
            notes.append("Colors will fade between players" if table_state["fade_enabled"]
                         else "Colors will change instantly")
        if "fade_seconds" in payload:
            table_state["fade_seconds"] = number(
                payload, "fade_seconds", lighting.FADE_SECONDS_MIN, lighting.FADE_SECONDS_MAX, integer=False
            )
            notes.append(f"Fade over {table_state['fade_seconds']:.1f}s")
        save_table_state()

    return ok("; ".join(notes) or "No change", **{**table_state, "players": players_payload()})


@app.post("/api/bulbs/<bulb_id>/ip")
def set_named_bulb_ip(bulb_id):
    payload = request.get_json(force=True)
    controller = get_bulb(bulb_id)
    ip = str(payload.get("ip", "")).strip()
    if any(key != bulb_id and other.current_ip == ip for key, other in bulbs.items()):
        raise ValueError("That IP is already assigned to another bulb")
    controller.set_ip(ip)
    with state_lock:
        save_table_state()
    return ok(f"{BULB_NAMES[bulb_id]} bulb IP set to {controller.current_ip}", ip=controller.current_ip)


@app.post("/api/bulbs/<bulb_id>/disconnect")
def disconnect_named_bulb(bulb_id):
    controller = get_bulb(bulb_id)
    old_ip = controller.current_ip
    controller.clear_ip()
    with state_lock:
        save_table_state()
    if old_ip:
        return ok(f"Forgot {BULB_NAMES[bulb_id].lower()} bulb at {old_ip}", ip="")
    return ok(f"{BULB_NAMES[bulb_id]} bulb was already disconnected", ip="")


@app.post("/api/bulbs/<bulb_id>/find")
def find_named_bulb(bulb_id):
    controller = get_bulb(bulb_id)
    excluded = {
        other.current_ip for key, other in bulbs.items()
        if key != bulb_id and other.current_ip
    }
    with device_lock:
        ip = wait_for(controller.find_bulb(excluded), timeout=45)
    with state_lock:
        save_table_state()
    return ok(f"Found {BULB_NAMES[bulb_id].lower()} bulb at {ip}", ip=ip)


@app.post("/api/bulbs/discover")
def discover_bulbs():
    """Start the room mapping over.

    Discovery walks every bulb it finds and has you place each one, so the old
    assignment is dropped once a scan succeeds: a bulb that has since taken a
    different IP cannot leave a stale address sitting in a position. Every
    other route keeps its assignment.

    The scan never reads the current assignment, so nothing is gained by
    clearing it beforehand — and clearing it early leaves every assigned bulb
    briefly unassigned while the background lighting effects keep running.
    That empty window used to make each animated bulb's own reconnect logic
    kick off a second, unsynchronized network scan for the same physical
    bulbs the discovery scan was already probing, so the two starved each
    other of the bulb's single local-API session. Clearing only after a
    successful scan keeps every assignment intact — and therefore reachable
    by the effect loop — for the whole scan.
    """
    global discovered_bulbs
    with device_lock:
        candidates = wait_for(discovery_controller.discover_all(), timeout=90)

    with state_lock:
        for controller in bulbs.values():
            controller.clear_ip()
        save_table_state()
    discovered_bulbs = {item["ip"]: item for item in candidates}
    return ok(
        f"Found {len(candidates)} compatible Tapo bulb{'s' if len(candidates) != 1 else ''}"
        " — previous positions cleared, assign each one below",
        bulbs=candidates,
    )


@app.post("/api/bulbs/identify")
def identify_discovered_bulb():
    payload = request.get_json(force=True)
    ip = str(payload.get("ip", "")).strip()
    if ip not in discovered_bulbs:
        raise ValueError("Run bulb discovery again before identifying this device")
    with device_lock:
        wait_for(discovery_controller.identify(ip), timeout=15)
    return ok(f"Identification blink completed for {ip}")


@app.post("/api/bulbs/assign")
def assign_discovered_bulb():
    payload = request.get_json(force=True)
    bulb_id = str(payload.get("bulb_id", ""))
    ip = str(payload.get("ip", "")).strip()
    controller = get_bulb(bulb_id)
    if ip not in discovered_bulbs:
        raise ValueError("Run bulb discovery again before assigning this device")

    # Moving a discovered bulb to a different room position must not leave the
    # same physical IP registered in two slots.
    for other_id, other in bulbs.items():
        if other_id != bulb_id and other.current_ip == ip:
            other.clear_ip()
    controller.set_ip(ip)
    with state_lock:
        save_table_state()
    return ok(f"Assigned {ip} to the {BULB_NAMES[bulb_id].lower()} bulb", ip=ip, bulb_id=bulb_id)


@app.post("/api/strip/connect")
def connect_strip():
    with device_lock:
        label = wait_for(strip.scan_and_connect())
    # A fresh connection is not running whatever effect it was last given.
    turn_lighting.forget_effects(lighting.STRIP_ID)
    if house_lights:
        # It connected into a room that is meant to be plain white.
        with device_lock:
            wait_for(strip.set_power(False))
    else:
        # The strip was unreachable until now, so it was skipped by the last turn
        # change. Give it the current player's color and effect straight away.
        apply_player_lighting(table_state["current_player"], fade=False)
    return ok(f"LED strip connected: {label}", label=label)


# -----------------------------
# LIGHT CONTROL
# -----------------------------
@app.post("/api/color")
def apply_color():
    payload = request.get_json(force=True)
    hue = number(payload, "hue", 0, 360)
    saturation = number(payload, "saturation", 0, 100)
    brightness = number(payload, "brightness", 1, 100)
    target = payload.get("target", "both")

    # Preserve legacy target meanings. New calls use a bulb id, all_bulbs,
    # strip, or all (all three bulbs plus the strip).
    if "targets" in payload:
        bulb_target, include_strip = payload["targets"], bool(payload.get("include_strip"))
    elif target == "bulb":
        bulb_target, include_strip = "center", False
    elif target == "both":
        bulb_target, include_strip = "center", True
    elif target == "strip":
        bulb_target, include_strip = None, True
    elif target == "all":
        bulb_target, include_strip = "all_bulbs", True
    elif target in bulbs or target == "all_bulbs":
        bulb_target, include_strip = target, False
    else:
        raise ValueError("Unknown color target")

    red, green, blue = colorsys.hsv_to_rgb(hue / 360, saturation / 100, 1)
    selected = target_bulbs(bulb_target) if bulb_target else []
    touched = [bulb_id for bulb_id, _ in selected] + ([lighting.STRIP_ID] if include_strip else [])
    # A hand on a light wins over any cue on it — from before this write lands,
    # or the cue's next frame could paint straight over it.
    turn_lighting.taken_by_hand(*touched)
    futures = []
    with device_lock:
        # force: pressing Apply means put this on the bulb, even if we believe
        # it is already showing it.
        futures.extend(controller.apply_hsv(hue, saturation, brightness, force=True)
                       for _, controller in selected)
        if include_strip:
            futures.append(strip.apply_color(int(red * 255), int(green * 255), int(blue * 255), brightness))
        wait_for_all(futures)
    # These lights are no longer showing what the last turn put on them — and a
    # solid color takes the strip out of any built-in effect it was running.
    turn_lighting.forget_effects(*touched)
    return ok("Color applied")


@app.post("/api/bulb/white")
def apply_white():
    payload = request.get_json(force=True)
    temperature = number(payload, "temperature", 2500, 6500)
    brightness = number(payload, "brightness", 1, 100)
    targets = requested_bulbs(payload)
    turn_lighting.taken_by_hand(*[bulb_id for bulb_id, _ in targets])
    with device_lock:
        wait_for_all([controller.apply_white(temperature, brightness, force=True) for _, controller in targets])
    turn_lighting.forget_effects(*[bulb_id for bulb_id, _ in targets])
    return ok(f"White applied: {temperature}K at {brightness}%")


@app.post("/api/bulb/power")
def set_bulb_power():
    payload = request.get_json(force=True)
    enabled = payload.get("on")
    if not isinstance(enabled, bool):
        raise ValueError("on must be true or false")
    targets = requested_bulbs(payload, default="all_bulbs")
    turn_lighting.taken_by_hand(*[bulb_id for bulb_id, _ in targets])
    with device_lock:
        wait_for_all([controller.set_power(enabled) for _, controller in targets])
    return ok(f"{'Turned on' if enabled else 'Turned off'} {len(targets)} bulb{'s' if len(targets) != 1 else ''}")


@app.post("/api/strip/power")
def set_strip_power():
    payload = request.get_json(force=True)
    enabled = payload.get("on")
    if not isinstance(enabled, bool):
        raise ValueError("on must be true or false")
    turn_lighting.taken_by_hand(lighting.STRIP_ID)
    with device_lock:
        wait_for(strip.set_power(enabled))
    turn_lighting.forget_effects(lighting.STRIP_ID)
    return ok(f"LED strip turned {'on' if enabled else 'off'}")


@app.post("/api/power")
def set_power():
    """Legacy combined power route kept for older clients."""
    payload = request.get_json(force=True)
    enabled = payload.get("on")
    target = payload.get("target")
    if not isinstance(enabled, bool):
        raise ValueError("on must be true or false")
    if target not in {"bulb", "strip", "both"}:
        raise ValueError("Unknown power target")
    turn_lighting.taken_by_hand(*(["center"] if target in {"bulb", "both"} else []),
                                *([lighting.STRIP_ID] if target in {"strip", "both"} else []))
    with device_lock:
        futures = []
        if target in {"bulb", "both"}:
            futures.extend(controller.set_power(enabled) for _, controller in target_bulbs("center"))
        if target in {"strip", "both"}:
            futures.append(strip.set_power(enabled))
        wait_for_all(futures)
    if target in {"strip", "both"}:
        turn_lighting.forget_effects(lighting.STRIP_ID)
    return ok(f"Turned {target} {'on' if enabled else 'off'}")


@app.post("/api/shutdown")
def shutdown_server():
    """Stop the server from either page.

    The table PC often has no terminal left to Ctrl+C: the window gets closed
    and the server carries on in the background, holding the port and the
    rpgtable.local name. This is the way out of that without the Task Manager.

    The reply goes out first and the process ends a moment later, so the page
    can say what happened rather than reporting a dead connection.
    """
    try:
        save_table_state()
        with history_lock:
            save_game_history()
    except Exception:
        app.logger.exception("Could not save the table before shutting down")

    def stop():
        # os._exit skips atexit handlers, so withdraw the mDNS name by hand -
        # leaving it advertised would point phones at a port nobody answers.
        mdns.unregister()
        os._exit(0)

    threading.Timer(0.5, stop).start()
    return ok("Server stopping. This page will go offline until you start it again.")


load_table_state()
load_game_history()


if __name__ == "__main__":
    print("MTG table display:  http://127.0.0.1:5001/")
    print("Light controls:     http://127.0.0.1:5001/lights")
    print("On your phone, use http://rpgtable.local:5001 while on the same Wi-Fi")
    mdns.register(5001)
    try:
        app.run(host="0.0.0.0", port=5001, threaded=True)
    finally:
        mdns.unregister()
