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
import io
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
from concurrent.futures import TimeoutError as FutureTimeoutError
from datetime import datetime
from pathlib import Path
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlencode
from uuid import uuid4

from flask import Flask, Response, abort, jsonify, redirect, render_template, request, send_file, send_from_directory
from werkzeug.exceptions import HTTPException

import bledom_led
import build_site
import bulb_control
import cues
import lighting
import mdns
import screen_mirror


BASE_DIR = Path(__file__).resolve().parent
# Where the server was started from, so a restart runs the same command line
# from the same place.
STARTUP_DIR = os.getcwd()
# Set on the copy a restart starts; see wait_for_previous_server().
RESTART_ENV = "MTG_TABLE_RESTARTED"
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

# The public leaderboard in site/ is what GitHub Pages shows. /public serves the
# same page from here against the live results, with an editor for its roster
# (which picture and commander belong to which player and deck) and a button
# that commits and pushes, which is what republishes the real one.
SITE_DIR = BASE_DIR / "site"
ROSTER_FILE = SITE_DIR / "roster.json"
ROSTER_GROUPS = ("players", "decks")
ROSTER_PICTURE_DIR = BASE_DIR / "Backgrounds"
ROSTER_PICTURE_EXTENSIONS = {".jpg", ".jpeg", ".jfif", ".png", ".webp"}
ROSTER_COMMANDER_MAX = 120
# A player's decks added by hand, played yet or not.
ROSTER_DECKS_MAX = 40
# Pictures sent from the editor land here, inside the folder it picks from.
ROSTER_UPLOAD_DIR = ROSTER_PICTURE_DIR / "Uploads"
ROSTER_UPLOAD_MAX = 20 * 1024 * 1024
# A deck's sound is one of the commander recordings the table plays, so a
# sound uploaded from the editor lands in sound/Commander beside them.
ROSTER_SOUND_UPLOAD_MAX = 10 * 1024 * 1024
# How loud a deck's page plays its sound, in percent. The default is left out
# of the roster; mirrors DECK_SOUND_VOLUME in site/site.js.
ROSTER_SOUND_VOLUME_DEFAULT = 80
# A deck's colour identity is stored as some of WUBRG in that order, or C for
# colourless. Scryfall supplies it from the commander's name.
MANA_COLORS = "WUBRG"
# A deck page's theme, chosen by hand in place of the one its commander's
# colours give it. Mirrors THEMES in site/site.js.
DECK_THEMES = {"w", "u", "b", "r", "g", "c", "gold", "wu", "ub", "br", "rg", "gw", "wb", "ur", "bg", "rw", "gu",
               "wgu", "uwb", "bur", "rbg", "grw", "wbg", "urw", "bgu", "rwb", "gur", "eldrazi"}
SCRYFALL_NAMED_URL = "https://api.scryfall.com/cards/named"
# The public site's opening: its sound, from its own folder, and its timings,
# set from the editor on /public and published as site/intro.json.
INTRO_FILE = SITE_DIR / "intro.json"
# The sound each mana burst on the public site makes, one per colour and one
# for colourless: "" is the site's own built-in sound, "none" is silence, and
# anything else a file in sound/Mana. Volume is a percentage.
MANA_SOUNDS_FILE = SITE_DIR / "mana_sounds.json"
MANA_SOUND_DIR = BASE_DIR / "sound" / "Mana"
MANA_SOUND_KEYS = ("W", "U", "B", "R", "G", "C")
MANA_SOUND_VOLUME_DEFAULT = 60
INTRO_SOUND_DIR = BASE_DIR / "sound" / "Intro"
# "always" plays it on every load, "visit" once per browser tab.
INTRO_REPEATS = ("always", "visit")
# Its sounds, each a file in sound/Intro: "chain" on unlocking, "sound" as the
# pentacle glows, "thud" as the book knocks about and "page" as each page turns.
# Without a file the chain, thud and page turn are made by the site itself.
INTRO_SOUNDS = ("chain", "sound", "thud", "page")
# Each number as (lowest, highest, default). Mirrors INTRO_DEFAULTS in site/site.js.
INTRO_NUMBERS = {"volume": (1, 100, 80), "rattle": (0, 100, 90), "rattle_every": (0.4, 8, 0.7),
                 "pages": (4, 40, 18), "shuffle_seconds": (0.5, 6, 1.8), "glow_seconds": (1, 8, 2.5),
                 "flight_seconds": (0.6, 5, 1.6), "rotation_speed": (0.5, 8, 2)}
INTRO_WHOLE_NUMBERS = {"volume", "rattle", "pages"}
# The public site's overall volume in percent, set from the editor on /public
# and published as site/settings.json. Every sound on the site is scaled by it,
# and a visitor's own slider only goes up to it. Mirrors SITE_VOLUME_DEFAULT
# in site/site.js.
SITE_SETTINGS_FILE = SITE_DIR / "settings.json"
SITE_VOLUME_DEFAULT = 100
# Everything the public site is built from, and so everything a publish
# commits: the files it shows, and the build script and workflow that make it.
# Other code and the rest of the working tree are left for a normal commit.
PUBLISH_PATHS = ("game_history.json", "site", "Backgrounds", "sound/Commander", "sound/Intro", "sound/Mana",
                 "build_site.py", ".github/workflows/pages.yml", *build_site.SHARED_PAGE_FILES.values())
PUBLISH_BRANCH = "main"
roster_lock = threading.Lock()
publish_lock = threading.Lock()

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
# An elimination is announced as a random line from Base/Death ("Down goes
# another one!") and then the player's own clip from Players/Death, matched to
# the seat's name. Either folder can be empty; the other still plays.
ANNOUNCER_DEATH_INTRO_DIR = ANNOUNCER_BASE_DIR / "Death"
ANNOUNCER_DEATH_PLAYER_DIR = ANNOUNCER_PLAYER_DIR / "Death"
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
# A dark picture can be boosted to three times its brightness. The lights
# page offers the commander card only up to 150%; the background goes the
# whole way.
DISPLAY_BRIGHTNESS_MAX = 300
# How far a seat's background can be zoomed into, past filling the panel.
BACKGROUND_ZOOM_MIN = 1.0
BACKGROUND_ZOOM_MAX = 3.0
# A seat's pictures on the table display: the panel background and each
# commander's card, as paths from the repository root into Backgrounds.
PLAYER_PICTURE_KEYS = ("background_image", "commander_image", "second_commander_image")
# Each commander card's animation on the table display (js/commander-fx.js
# draws them; its effect ids must match these). "focus" is the point the
# effect centres on and "glow" an optional second one — glowing eyes, or the
# mouth a breath leaves from — both as "x% y%" on the card picture. "area"
# keeps the effect to the art window or lets it cover the whole card.
COMMANDER_FX_EFFECTS = (
    ("foil", "Foil shimmer"),
    ("breath", "Bellows breath"),
    ("dragon", "Dragon breath"),
    ("arcane", "Arcane flow"),
    ("embers", "Heat haze & embers"),
    ("storm", "Storm"),
    ("shadow", "Shadow creep"),
    ("wind", "Wind sway"),
    ("radiance", "Radiance"),
    ("caustics", "Caustics"),
    ("glint", "Artifact glint"),
    ("eyes", "Glowing eyes"),
    ("roar", "Roar"),
    ("quake", "Quake"),
    ("heartbeat", "Heartbeat"),
    ("frost", "Frost"),
    ("snow", "Snowfall"),
    ("toxic", "Toxic"),
    ("void", "Void rift"),
    ("inferno", "Inferno"),
    ("ghost", "Ghost"),
    ("blood", "Blood drain"),
    ("vines", "Overgrowth"),
    ("time", "Time ripple"),
    ("rain", "Rain"),
    ("mana", "Mana orbit"),
    ("cosmic", "Cosmic"),
    ("treasure", "Treasure"),
    ("clockwork", "Clockwork & sparks"),
    ("none", "No animation"),
)
COMMANDER_FX_LABELS = dict(COMMANDER_FX_EFFECTS)
COMMANDER_FX_AREAS = ("art", "card")
COMMANDER_FX_KEYS = ("commander_fx", "second_commander_fx")


def default_commander_fx():
    return {"effect": "foil", "focus": "", "glow": "", "area": "art"}


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
    """A player: a base color used as the seed and swatch, plus a light plan.

    The deck and its pictures make a saved profile a whole deck preset: the
    pictures are paths into Backgrounds, the same ones the leaderboard roster
    names, and the table display shows them on the seat.
    """
    return dict(base, announcer_sound="", commander_sound="", second_commander_sound="",
                commander_name="", second_commander_name="", two_commanders=False,
                background_brightness=100, commander_brightness=70,
                deck="", background_focus="", background_zoom=1.0, **{key: "" for key in PLAYER_PICTURE_KEYS},
                **{key: default_commander_fx() for key in COMMANDER_FX_KEYS},
                lights={light_id: default_light(base, light_id) for light_id in LIGHT_IDS})


table_state = {
    "players": [default_player(player) for player in DEFAULT_PLAYERS],
    "current_player": 0,
    "fade_enabled": True,
    "fade_seconds": 1.5,
    # How each game moment looks on the lights: the Moments tab, see cues.py.
    "cues": cues.default_settings(),
    # A new game's seats being claimed from phones: see the JOIN section.
    "lobby": {"active": False, "keys": [""] * PLAYER_COUNT, "claimed": [False] * PLAYER_COUNT, "revision": 0},
    # The screen remote's code: see the SCREEN REMOTE section.
    "mirror_key": "",
}
state_lock = threading.Lock()

# A fresh token per seat each time a preset or roster deck is loaded onto it,
# so the table display re-dresses the seat even when the same deck is loaded
# again after its art was cleared there. Not saved: a restart starts blank,
# and a blank token never re-dresses anything.
preset_loads = [""] * PLAYER_COUNT


def mark_preset_load(index):
    preset_loads[index] = f"{time.time_ns():x}"

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
# The life tracker owns the seat names, but the lights page can rename a seat
# too. Each rename from there bumps this, and the tracker takes the server's
# names whenever it sees it move; the tracker's own pushes leave it alone.
names_revision = 0


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

    # Seats still being claimed when the server stopped stay claimable with
    # the codes already on the table.
    lobby = saved.get("lobby") if isinstance(saved.get("lobby"), dict) else {}
    keys, claimed = lobby.get("keys"), lobby.get("claimed")
    if (isinstance(keys, list) and len(keys) == PLAYER_COUNT and all(isinstance(key, str) for key in keys)
            and isinstance(claimed, list) and len(claimed) == PLAYER_COUNT):
        table_state["lobby"] = {"active": lobby.get("active") is True, "keys": keys,
                                "claimed": [seat is True for seat in claimed], "revision": time.time_ns() // 1_000_000}

    if isinstance(saved.get("mirror_key"), str) and re.fullmatch(r"[A-Za-z0-9_-]{8,40}", saved["mirror_key"]):
        table_state["mirror_key"] = saved["mirror_key"]

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


def known_or_blank(validate, value):
    """A saved file name if it still exists, or "" when it has gone since.

    A deleted or renamed file should make an old profile or roster entry
    quiet or bare, rather than refuse to load or hand an unchecked path to
    the browser.
    """
    try:
        return validate(value)
    except ValueError:
        return ""


def apply_deck_details(target, saved):
    """Restore the deck half of a player: its name, its pictures and the crop."""
    if isinstance(saved.get("deck"), str):
        target["deck"] = re.sub(r"\s+", " ", saved["deck"]).strip()[:GAME_DECK_MAX]
    for key in PLAYER_PICTURE_KEYS:
        if key in saved:
            target[key] = known_or_blank(validate_picture, saved.get(key))
    if "background_focus" in saved:
        target["background_focus"] = known_or_blank(clean_focus, saved.get("background_focus"))
    # The zoom belongs to the picture it was set for: a new picture without
    # one of its own starts unzoomed.
    if "background_zoom" in saved:
        target["background_zoom"] = known_or_blank(clean_zoom, saved.get("background_zoom")) or 1.0
    elif "background_image" in saved:
        target["background_zoom"] = 1.0


def apply_saved_player(target, saved, *, keep_name=False):
    """Restore one player from saved data, field by field, ignoring the rest.

    Shared by the config file and the per-player profiles, so a profile is
    exactly one player's entry out of the config and can be hand-edited the
    same way. `keep_name` leaves the seat's name alone, which is what a
    profile wants: the life tracker owns who is sitting where.
    """
    if not isinstance(saved, dict):
        return
    if not keep_name and isinstance(saved.get("name"), str) and saved["name"].strip():
        target["name"] = saved["name"].strip()[:18]
    if "announcer_sound" in saved:
        target["announcer_sound"] = known_or_blank(validate_announcer_sound, saved.get("announcer_sound"))
    target["two_commanders"] = saved.get("two_commanders") is True
    target["second_commander_sound"] = known_or_blank(validate_commander_sound, saved.get("second_commander_sound", ""))
    for key in ("commander_name", "second_commander_name"):
        value = saved.get(key)
        if isinstance(value, str):
            target[key] = value.strip()[:GAME_NAME_MAX]
    if "commander_sound" in saved:
        target["commander_sound"] = known_or_blank(validate_commander_sound, saved.get("commander_sound"))
    apply_deck_details(target, saved)
    # A profile from before animations, or without one for this card, starts
    # from the default rather than keeping the previous deck's.
    for key in COMMANDER_FX_KEYS:
        target[key] = default_commander_fx()
        apply_commander_fx(target[key], saved.get(key))
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


def apply_commander_fx(target, saved, *, strict=False):
    """Merge a commander animation field by field.

    Loading a file skips anything unrecognised; a change from the lights page
    (`strict`) is refused instead, so a bad request says what was wrong.
    """
    if not isinstance(saved, dict):
        if strict:
            raise ValueError("A commander animation is a set of fields")
        return

    def effect(value):
        if value not in COMMANDER_FX_LABELS:
            raise ValueError(f"Unknown animation: {value}")
        return value

    def area(value):
        if value not in COMMANDER_FX_AREAS:
            raise ValueError("The animation covers the art or the whole card")
        return value

    def point(value):
        try:
            return clean_focus(value)
        except ValueError:
            raise ValueError("A point on the card is two percentages, like 50% 33%") from None

    for key, check in (("effect", effect), ("focus", point), ("glow", point), ("area", area)):
        if key not in saved:
            continue
        try:
            target[key] = check(saved[key])
        except ValueError:
            if strict:
                raise


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


GAME_STAT_FIELDS = (
    "turns", "play_seconds", "longest_turn_seconds", "damage_dealt", "commander_damage_dealt",
    "poison_dealt", "biggest_hit", "life_gained", "damage_taken", "eliminations",
)
GAME_STAT_MAX = 10_000_000
GAME_ID_PATTERN = re.compile(r"[0-9a-f]{32}")


def clean_game_stats(value):
    """The tracker's per-player statistics for one game, or None without any.

    Optional and forgiving: a result is worth keeping even when its statistics
    are not, so a field that is missing or nonsensical is simply left out."""
    if not isinstance(value, dict):
        return None
    stats = {}
    for field in GAME_STAT_FIELDS:
        number = value.get(field)
        if isinstance(number, (int, float)) and not isinstance(number, bool) and 0 <= number <= GAME_STAT_MAX:
            stats[field] = int(round(number))
    lowest = value.get("lowest_life")
    if isinstance(lowest, (int, float)) and not isinstance(lowest, bool) and abs(lowest) <= GAME_STAT_MAX:
        stats["lowest_life"] = int(round(lowest))
    by = value.get("eliminated_by")
    if isinstance(by, str) and by.strip():
        stats["eliminated_by"] = re.sub(r"\s+", " ", by).strip()[:GAME_NAME_MAX]
    return stats or None


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
        player = {"name": name, "deck": deck, "rank": rank}
        stats = clean_game_stats(entry.get("stats"))
        if stats:
            player["stats"] = stats
        players.append(player)

    if any(entry["rank"] not in {1, 2, 3, 4} for entry in players):
        raise ValueError("Every ranking must be a number from 1 to 4")
    if not any(entry["rank"] == 1 for entry in players):
        raise ValueError("At least one player must be ranked first")
    if outcome == "draw" and sum(entry["rank"] == 1 for entry in players) < 2:
        raise ValueError("A draw must have at least two players tied for first")
    if len({entry["name"].casefold() for entry in players}) != GAME_PLAYER_COUNT:
        raise ValueError("Each player name must be different")

    # The tracker names its game, so the same game saved here and sent to the
    # Drive inbox (drive/inbox.gs) is recognised as one when it is imported.
    given_id = payload.get("id")
    game_id = given_id if isinstance(given_id, str) and GAME_ID_PATTERN.fullmatch(given_id) else uuid4().hex
    game = {
        "id": game_id,
        "date": date,
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "outcome": outcome,
        "players": players,
    }
    duration = payload.get("duration_seconds")
    if isinstance(duration, (int, float)) and not isinstance(duration, bool) and 0 < duration <= GAME_STAT_MAX:
        game["duration_seconds"] = int(round(duration))
    # The starting life, which the Close Call award measures low life against.
    life = payload.get("starting_life")
    if isinstance(life, int) and not isinstance(life, bool) and 1 <= life <= 1000:
        game["starting_life"] = life
    return game


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


def list_sound_files(folder):
    """Every playable recording directly inside `folder`, by name."""
    try:
        files = [item.name for item in folder.iterdir()
                 if item.is_file() and item.suffix.casefold() in ANNOUNCER_EXTENSIONS]
    except OSError:
        return []
    return sorted(files, key=str.casefold)


def announcer_death_sounds():
    """The elimination intros and the per-player elimination clips."""
    return {"intros": list_sound_files(ANNOUNCER_DEATH_INTRO_DIR),
            "players": list_sound_files(ANNOUNCER_DEATH_PLAYER_DIR)}


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


def list_intro_sounds():
    """Selectable sounds for the public site's opening, in sound/Intro."""
    try:
        files = [item for item in INTRO_SOUND_DIR.iterdir()
                 if item.is_file() and item.suffix.casefold() in ANNOUNCER_EXTENSIONS]
    except OSError:
        return []
    return [{"file": item.name, "label": item.stem.replace("_", " ")}
            for item in sorted(files, key=lambda item: item.stem.casefold())]


def list_mana_sounds():
    """Selectable sounds for the public site's mana bursts, in sound/Mana."""
    try:
        files = [item for item in MANA_SOUND_DIR.iterdir()
                 if item.is_file() and item.suffix.casefold() in ANNOUNCER_EXTENSIONS]
    except OSError:
        return []
    return [{"file": item.name, "label": item.stem.replace("_", " ")}
            for item in sorted(files, key=lambda item: item.stem.casefold())]


def clean_mana_sounds(payload, strict=True):
    """Every colour's burst sound and volume; a missing or, when not strict,
    unusable one takes the built-in sound at the default volume."""
    available = {item["file"] for item in list_mana_sounds()}
    cleaned = {}
    for key in MANA_SOUND_KEYS:
        entry = payload.get(key) if isinstance(payload.get(key), dict) else {}
        sound = str(entry.get("sound") or "").strip()
        if sound and sound != "none" and sound not in available:
            if strict:
                raise ValueError(f"Choose a mana sound from sound/Mana, not {sound}")
            sound = ""
        volume = entry.get("volume", MANA_SOUND_VOLUME_DEFAULT)
        if not isinstance(volume, (int, float)) or isinstance(volume, bool) or not 0 <= volume <= 100:
            if strict:
                raise ValueError("A mana sound's volume is a percentage from 0 to 100")
            volume = MANA_SOUND_VOLUME_DEFAULT
        cleaned[key] = {"sound": sound, "volume": round(volume)}
    return cleaned


def load_mana_sounds():
    try:
        saved = json.loads(MANA_SOUNDS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        saved = {}
    return clean_mana_sounds(saved if isinstance(saved, dict) else {}, strict=False)


def clean_intro(payload, strict=True):
    """The intro's settings, every one present; a missing one takes its default.

    Saving is strict. Reading the saved file is not: a value out of range there,
    or a sound since deleted, quietly becomes the default.
    """
    def refuse(message, fallback):
        if strict:
            raise ValueError(message)
        return fallback

    intro = {}
    available = {item["file"] for item in list_intro_sounds()}
    for key in INTRO_SOUNDS:
        sound = str(payload.get(key) or "").strip()
        if sound and sound not in available:
            sound = refuse("Choose the intro's sounds from sound/Intro", "")
        intro[key] = sound
    repeat = payload.get("repeat") or "always"
    intro["repeat"] = repeat if repeat in INTRO_REPEATS else refuse("Choose when the intro plays", "always")
    for key, (lowest, highest, default) in INTRO_NUMBERS.items():
        value = payload.get(key)
        try:
            number = default if value in (None, "") else float(value)
        except (TypeError, ValueError):
            number = None
        # NaN fails this comparison too.
        if number is None or not lowest <= number <= highest:
            number = refuse(f"Intro {key.replace('_', ' ')} must be between {lowest} and {highest}", default)
        intro[key] = round(number) if key in INTRO_WHOLE_NUMBERS else round(number, 1)
    return intro


def load_intro():
    try:
        saved = json.loads(INTRO_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        saved = {}
    return clean_intro(saved if isinstance(saved, dict) else {}, strict=False)


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


# Each profile's deck, read once per version of its file: the status poll lists
# the profiles every few seconds.
profile_deck_cache = {}


def profile_deck(path, modified):
    cached = profile_deck_cache.get(path)
    if cached and cached[0] == modified:
        return cached[1]
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
        deck = saved.get("deck") if isinstance(saved, dict) and isinstance(saved.get("deck"), str) else ""
    except (OSError, ValueError):
        deck = ""
    profile_deck_cache[path] = (modified, deck)
    return deck


def list_profiles():
    """Every saved profile, newest first. The file name is the profile name.

    `deck` is the leaderboard deck it is the preset for: the one it names, or
    else the one its file is named after, like NivMizzet for Niv-Mizzet.
    """
    try:
        files = sorted(((item, item.stat().st_mtime) for item in PROFILE_DIR.glob("*.json")),
                       key=lambda pair: pair[1], reverse=True)
    except OSError:
        return []
    decks = {deck_key(name): name for name in load_roster()["decks"]}
    profiles = []
    for item, modified in files:
        deck = profile_deck(item, modified) or decks.get(deck_key(item.stem), "")
        profiles.append({"name": item.stem, "saved": int(modified), "deck": deck})
    return profiles


def list_roster_decks(profiles):
    """The leaderboard's decks, each with the profile that is its preset, if any."""
    presets = {}
    for profile in profiles:
        presets.setdefault(deck_key(profile["deck"]), profile["name"])
    return [{"name": name, "profile": presets.get(deck_key(name), "")}
            for name in sorted(load_roster()["decks"], key=str.casefold)]


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
    return dict(player, targets=player_targets(player), preset_load=preset_loads[index])


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
    payload = request.get_json(force=True, silent=True) or {}
    game = game_from_payload(payload)
    replaces = payload.get("replaces")
    with history_lock:
        # Saving the same game again (a second press, a resend) adds nothing.
        existing = next((saved for saved in game_history if saved.get("id") == game["id"]), None)
        if existing is not None:
            return ok("Game is already on the leaderboard", game=existing, duplicate=True)
        before = list(game_history)
        # A corrected result names the one it replaces, which it takes the place of.
        index = next((i for i, saved in enumerate(game_history)
                      if isinstance(replaces, str) and saved.get("id") == replaces), None)
        if index is None:
            game_history.append(game)
        else:
            game_history[index] = game
        try:
            save_game_history()
        except Exception:
            game_history[:] = before
            raise
    message = "Game result corrected" if index is not None else "Game added to the leaderboard"
    return ok(message, game=game), 201


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


def edited_game(original, payload):
    """A saved game with the corrections from the leaderboard's editor.

    Checked like any new result. It keeps its id, so the Drive inbox still
    knows the game and never imports the uncorrected copy over it, and when
    it was first recorded; `edited_at` says it was corrected since."""
    game = game_from_payload({**payload, "id": original["id"]})
    game["created_at"] = original.get("created_at") or game["created_at"]
    game["edited_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    return game


@app.put("/api/games/<game_id>")
def edit_game(game_id):
    payload = request.get_json(force=True, silent=True) or {}
    with history_lock:
        index = next((index for index, game in enumerate(game_history)
                      if game.get("id") == game_id), None)
        if index is None:
            raise ValueError("Game not found")
        original = game_history[index]
        game = edited_game(original, payload)
        game_history[index] = game
        try:
            save_game_history()
        except Exception:
            game_history[index] = original
            raise
    return ok("Game corrected", game=game)


def history_publish_state():
    """Whether the results have anything GitHub does not: a changed
    game_history.json or commits not pushed yet."""
    changed = bool(run_git("status", "--porcelain", "--", HISTORY_FILE.name))
    try:
        unpushed = int(run_git("rev-list", "--count", "@{upstream}..HEAD"))
    except (RuntimeError, ValueError):
        unpushed = 0
    return {"changed": changed, "unpushed": unpushed}


@app.get("/api/games/publish")
def games_publish_status():
    try:
        state = history_publish_state()
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        # No git here: the leaderboard simply offers no Publish button.
        return ok("Publishing is not available", publish=None, error=str(error))
    return ok("Publish status", publish=state)


@app.post("/api/games/publish")
def publish_games():
    """Push the results alone to the public site, as the Drive import does."""
    if not any(history_publish_state().values()):
        return ok("Nothing to publish: the site already has these results", publish=history_publish_state())
    publish_game_history(f"Correct game results ({datetime.now():%Y-%m-%d})")
    return ok("Pushed. The public site updates in a minute or two", publish=history_publish_state())


def import_submissions(payload):
    """Every game submission in an imported file, in file order.

    Accepts what the phone tracker produces: the Drive inbox
    (`mtg-table-inbox`), one downloaded game (`mtg-table-game`), a bare
    leaderboard game, or a list of any of these (several files at once).
    """
    if isinstance(payload, list):
        return [submission for item in payload for submission in import_submissions(item)]
    if not isinstance(payload, dict):
        raise ValueError("This file does not contain any games")
    if payload.get("format") == "mtg-table-inbox" or isinstance(payload.get("submissions"), list):
        return [item if isinstance(item, dict) else {} for item in payload.get("submissions") or []]
    if isinstance(payload.get("game"), dict):
        return [payload]
    if isinstance(payload.get("players"), list):
        return [{"game": payload}]
    raise ValueError("This file does not contain any games")


def imported_created_at(*values):
    """The first of the given timestamps that parses, in local time, or now."""
    for value in values:
        if isinstance(value, str) and value.strip():
            try:
                return datetime.fromisoformat(value.strip().replace("Z", "+00:00")).astimezone().isoformat(timespec="seconds")
            except ValueError:
                continue
    return datetime.now().astimezone().isoformat(timespec="seconds")


def game_signature(game):
    """What makes two records the same result: the date and who finished where with what."""
    return (game.get("date"), frozenset((str(player.get("name", "")).casefold(), str(player.get("deck", "")).casefold(),
                                         player.get("rank")) for player in game.get("players") or []
                                        if isinstance(player, dict)))


IMPORTABLE_STATUSES = {"new", "correction", "match"}


def plan_game_import(submissions, history, deck_known=lambda name: False):
    """Sort imported submissions into what to add and what to skip.

    Each entry gets a status:
      new         not on the leaderboard yet
      correction  replaces a game already on the leaderboard (`replaces`)
      match       a different id, but the same date, players, decks and ranks
                  as a saved game: most likely typed in by hand, so off by default
      imported    its id is already on the leaderboard
      superseded  a later correction in the same file replaces it
      repeat      the same id earlier in the file
      invalid     not a valid result (`message` says why)
    New decks named by an importable game and missing from the roster are
    listed in `new_decks`.
    """
    history_ids = {game.get("id") for game in history}
    history_signatures = {game_signature(game): game for game in history}
    entries, seen = [], set()
    for index, submission in enumerate(submissions):
        source = submission.get("source") if isinstance(submission.get("source"), dict) else {}
        raw = submission.get("game") if isinstance(submission.get("game"), dict) else {}
        entry = {"index": index, "status": "new"}
        try:
            if not isinstance(raw.get("id"), str) or not GAME_ID_PATTERN.fullmatch(raw["id"]):
                raise ValueError("The game has no id from the tracker")
            game = game_from_payload(raw)
        except ValueError as error:
            entry.update(status="invalid", message=str(error),
                         date=str(raw.get("date") or ""), id=str(raw.get("id") or ""))
            entries.append(entry)
            continue
        game["created_at"] = imported_created_at(raw.get("created_at"), submission.get("received_at"))
        replaces = source.get("replaces")
        entry.update(id=game["id"], date=game["date"], game=game,
                     replaces=replaces if isinstance(replaces, str) and GAME_ID_PATTERN.fullmatch(replaces) else None)
        decks = [deck for deck in submission.get("new_decks") or [] if isinstance(deck, dict)]
        entry["decks"] = decks
        if game["id"] in seen:
            entry["status"] = "repeat"
        seen.add(game["id"])
        entries.append(entry)

    replaced = {entry["replaces"]: entry["id"] for entry in entries if entry.get("replaces")}
    for entry in entries:
        if entry["status"] != "new":
            continue
        if entry["id"] in history_ids:
            entry["status"] = "imported"
        elif entry["id"] in replaced and replaced[entry["id"]] != entry["id"]:
            entry["status"] = "superseded"
        elif entry["replaces"] in history_ids:
            entry["status"] = "correction"
        elif game_signature(entry["game"]) in history_signatures:
            entry["status"] = "match"
            entry["match_id"] = history_signatures[game_signature(entry["game"])].get("id")

    new_decks, named = [], set()
    for entry in entries:
        if entry["status"] not in IMPORTABLE_STATUSES:
            continue
        played = {player["deck"].casefold() for player in entry["game"]["players"]}
        for deck in entry.pop("decks", []):
            name = re.sub(r"\s+", " ", str(deck.get("name") or "")).strip()[:GAME_DECK_MAX]
            if name and name.casefold() in played and name.casefold() not in named and not deck_known(name):
                named.add(name.casefold())
                new_decks.append({"name": name, "game": entry["id"],
                                  "commander": re.sub(r"\s+", " ", str(deck.get("commander") or "")).strip()[:ROSTER_COMMANDER_MAX],
                                  "colors": "".join(c for c in deck.get("color_identity") or [] if isinstance(c, str))})
    for entry in entries:
        entry.pop("decks", None)
    return {"entries": entries, "new_decks": new_decks}


@app.post("/api/games/import")
def import_games():
    """Preview, then import, games from the phone tracker's files.

    `items` is the parsed file (or a list of them). Without `import` this only
    previews; with `import`, a list of game ids, it adds those of them that are
    still importable, re-checked here against the saved history.
    """
    payload = request.get_json(force=True, silent=True) or {}
    submissions = import_submissions(payload.get("items"))
    if not submissions:
        raise ValueError("This file does not contain any games")
    chosen = payload.get("import")
    if not isinstance(chosen, list):
        with history_lock:
            plan = plan_game_import(submissions, game_history, roster_deck_known)
        for entry in plan["entries"]:
            entry.pop("index", None)
        return ok("Preview ready", **plan)
    chosen = {value for value in chosen if isinstance(value, str)}
    result = apply_game_import(submissions, lambda entry: entry["id"] in chosen, payload.get("add_decks", True))
    if not result["picked"]:
        raise ValueError("Those games are already on the leaderboard" if chosen else "Choose at least one game to import")
    return ok(import_message(result), imported=[entry["id"] for entry in result["picked"]], decks=result["decks"]), 201


def roster_deck_known(name):
    return bool(roster_deck(name)[0])


def apply_game_import(submissions, choose, add_decks=True):
    """Add the importable games that `choose(entry)` picks from the import
    plan, and the new decks they name to the roster.

    The plan is made again here, under the history lock, so a game imported
    meanwhile (by the Drive sync, or another page) is not added twice.
    """
    with history_lock:
        plan = plan_game_import(submissions, game_history, roster_deck_known)
        picked = [entry for entry in plan["entries"] if entry["status"] in IMPORTABLE_STATUSES and choose(entry)]
        result = {"plan": plan, "picked": picked, "corrected": 0, "decks": [], "failed_decks": []}
        if not picked:
            return result
        before = list(game_history)
        corrected = 0
        for entry in picked:
            index = next((i for i, saved in enumerate(game_history)
                          if entry["status"] == "correction" and saved.get("id") == entry["replaces"]), None)
            if index is None:
                game_history.append(entry["game"])
            else:
                game_history[index] = entry["game"]
                corrected += 1
        try:
            save_game_history()
        except Exception:
            game_history[:] = before
            raise

    result["corrected"] = corrected

    # The decks come after the games are safe: a deck that cannot be saved
    # costs its roster entry, never the results.
    if add_decks:
        picked_ids = {entry["id"] for entry in picked}
        for deck in plan["new_decks"]:
            if deck["game"] not in picked_ids or roster_deck_known(deck["name"]):
                continue
            try:
                save_roster_entry("decks", deck["name"], {"commander": deck["commander"], "colors": deck["colors"]})
                result["decks"].append(deck["name"])
            except (OSError, ValueError) as error:
                app.logger.warning("Could not add deck %s to the roster (%s)", deck["name"], error)
                result["failed_decks"].append(deck["name"])
    return result


def import_message(result):
    count, corrected = len(result["picked"]), result["corrected"]
    added_decks, failed_decks = result["decks"], result["failed_decks"]
    message = f"Imported {count} game{'s' if count != 1 else ''}"
    if corrected:
        message += f" ({corrected} correction{'s' if corrected != 1 else ''})"
    if added_decks:
        message += f", added {len(added_decks)} deck{'s' if len(added_decks) != 1 else ''} to the roster"
    if failed_decks:
        message += f"; could not add {', '.join(failed_decks)} to the roster"
    return message


# -----------------------------
# DRIVE INBOX SYNC
# -----------------------------
# While the server runs, games the phone tracker sent to the Drive inbox
# (drive/inbox.gs) are imported by themselves and pushed to the public site:
# every few minutes, and whenever the entry page opens. Set MTG_DRIVE_SYNC=0
# to turn it off; MTG_INBOX_URL points it at another deployment.
DRIVE_SYNC_SECONDS = 5 * 60
DRIVE_SYNC_FIRST_DELAY = 15
# New games and corrections go in by themselves. A game with the same result
# as one typed in by hand ("match") would most likely be counted twice, so it
# waits on the import card for someone to decide.
DRIVE_AUTO_STATUSES = {"new", "correction"}
drive_sync_lock = threading.Lock()
drive_sync_state = {
    "url": "", "checked_at": None, "error": None, "waiting": 0,
    "last_import": None, "published_at": None, "publish_error": None, "publish_pending": False,
}


def drive_sync_enabled():
    return os.environ.get("MTG_DRIVE_SYNC", "1").strip() != "0"


def drive_inbox_url():
    """The inbox the phone tracker sends to: the URL in js/game-inbox.js, so
    the two cannot drift apart, unless MTG_INBOX_URL says otherwise."""
    url = os.environ.get("MTG_INBOX_URL", "").strip()
    if url:
        return url
    try:
        script = (BASE_DIR / "js" / "game-inbox.js").read_text(encoding="utf-8")
    except OSError:
        return ""
    match = re.search(r"https://script\.google\.com/macros/s/[\w-]+/exec", script)
    return match.group(0) if match else ""


def fetch_drive_inbox(url):
    # Apps Script answers through a redirect, which urllib follows.
    lookup = urllib.request.Request(url, headers={"User-Agent": "MTGTable/1.0", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(lookup, timeout=45) as response:
            inbox = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"The Drive inbox answered {error.code}") from error
    except (urllib.error.URLError, OSError) as error:
        raise RuntimeError(f"Could not reach the Drive inbox: {getattr(error, 'reason', error)}") from error
    except ValueError as error:
        raise RuntimeError("The Drive inbox did not answer with JSON") from error
    if isinstance(inbox, dict) and inbox.get("ok") is False:
        raise RuntimeError(f"The Drive inbox says: {inbox.get('error') or 'unknown error'}")
    if not isinstance(inbox, dict) or inbox.get("format") != "mtg-table-inbox":
        raise RuntimeError("The Drive inbox answered with something that is not an MTG Table inbox")
    return inbox


def publish_game_history(message=None):
    """Commit game_history.json alone and push it.

    Only the results go out by themselves. Roster edits, pictures and sounds
    can stop the site building, so they wait for the Publish button, which
    checks the build first. A deck the import added still shows on the site
    from its games; its roster details follow with the next Publish.
    """
    with publish_lock:
        branch = run_git("rev-parse", "--abbrev-ref", "HEAD")
        if branch != PUBLISH_BRANCH:
            raise RuntimeError(f"The site is published from {PUBLISH_BRANCH}, but this checkout is on {branch}")
        if run_git("status", "--porcelain", "--", HISTORY_FILE.name):
            run_git("add", "--", HISTORY_FILE.name)
            # With paths, git commits only those: anything else staged stays staged.
            run_git("commit", "-m", message or f"Add games from the Drive inbox ({datetime.now():%Y-%m-%d})",
                    "--", HISTORY_FILE.name)
        if publish_state()["unpushed"]:
            run_git("push", timeout=180)


def drive_sync_snapshot():
    # Not under drive_sync_lock: a check can hold it for a minute or more, and
    # a status read should not wait on it.
    return {**copy.deepcopy(drive_sync_state), "enabled": drive_sync_enabled()}


def sync_drive_inbox():
    """Fetch the Drive inbox, import what is new, and publish it.

    A push that fails (offline, no credentials) is tried again on the next
    check, whether or not that check brings anything new.
    """
    url = drive_inbox_url()
    if not url:
        raise RuntimeError("No Drive inbox URL: set it in js/game-inbox.js or MTG_INBOX_URL")
    with drive_sync_lock:
        state = drive_sync_state
        state["url"] = url
        try:
            submissions = import_submissions(fetch_drive_inbox(url))
            result = apply_game_import(submissions, lambda entry: entry["status"] in DRIVE_AUTO_STATUSES)
            state["error"] = None
        except Exception as error:
            state["error"] = str(error) or "Unexpected error"
            raise
        finally:
            state["checked_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
        state["waiting"] = sum(entry["status"] == "match" for entry in result["plan"]["entries"])
        if result["picked"]:
            state["last_import"] = {"at": state["checked_at"], "count": len(result["picked"]),
                                    "message": import_message(result),
                                    "ids": [entry["id"] for entry in result["picked"]]}
            app.logger.info("Drive inbox: %s", state["last_import"]["message"])
        if result["picked"] or state["publish_pending"]:
            try:
                publish_game_history()
                state.update(published_at=state["checked_at"], publish_error=None, publish_pending=False)
            except Exception as error:
                state.update(publish_error=str(error) or "Unexpected error", publish_pending=True)
                app.logger.warning("Drive inbox: imported, but could not publish (%s)", error)
        return {"imported": len(result["picked"]), "message": import_message(result) if result["picked"] else ""}


def start_drive_sync():
    """Check the Drive inbox in the background while the server runs."""
    if not drive_sync_enabled() or not drive_inbox_url():
        return

    def loop():
        time.sleep(DRIVE_SYNC_FIRST_DELAY)
        while True:
            try:
                sync_drive_inbox()
            except Exception as error:
                app.logger.warning("Drive inbox check failed: %s", error)
            time.sleep(DRIVE_SYNC_SECONDS)

    threading.Thread(target=loop, name="drive-sync", daemon=True).start()


@app.get("/api/games/drive-sync")
def drive_sync_status():
    return ok("Drive inbox status", sync=drive_sync_snapshot())


@app.get("/api/games/drive-inbox")
def drive_inbox_contents():
    """The Drive inbox itself, for the import card to preview like a file."""
    url = drive_inbox_url()
    if not url:
        raise RuntimeError("No Drive inbox URL: set it in js/game-inbox.js or MTG_INBOX_URL")
    return ok("Drive inbox loaded", inbox=fetch_drive_inbox(url))


@app.post("/api/games/drive-sync")
def drive_sync_now():
    """Check the Drive inbox now: the entry page asks as it opens."""
    if not drive_sync_enabled():
        raise ValueError("Checking the Drive inbox is turned off (MTG_DRIVE_SYNC=0)")
    outcome = sync_drive_inbox()
    sync = drive_sync_snapshot()
    if not outcome["imported"]:
        message = "Drive inbox checked: nothing new"
    elif sync["publish_error"]:
        message = f"{outcome['message']}, but could not publish: {sync['publish_error']}"
    else:
        message = f"{outcome['message']} and published to the site"
    return ok(message, sync=sync, imported=outcome["imported"])


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
# PUBLIC LEADERBOARD PREVIEW
# -----------------------------
def load_roster():
    try:
        roster = json.loads(ROSTER_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        roster = {}
    return {group: dict(roster.get(group) or {}) for group in ROSTER_GROUPS}


def list_roster_pictures():
    """Every picture a roster entry may name, as a path from the repository root."""
    return sorted(path.relative_to(BASE_DIR).as_posix()
                  for path in ROSTER_PICTURE_DIR.rglob("*")
                  if path.is_file() and path.suffix.lower() in ROSTER_PICTURE_EXTENSIONS)


def validate_picture(value):
    """A picture path a seat or roster entry may name, or "" for none."""
    path = str(value or "").strip()
    if path and path not in set(list_roster_pictures()):
        raise ValueError(f"No such picture: {path}")
    return path


def deck_key(name):
    """How a deck name is matched to a profile: "NivMizzet" is "Niv-Mizzet"."""
    return re.sub(r"[^0-9a-z]+", "", str(name or "").casefold())


def roster_deck(name):
    """A leaderboard deck as (its name in the roster, its entry), or ("", {})."""
    wanted = deck_key(name)
    if not wanted:
        return "", {}
    decks = load_roster()["decks"]
    # An exact match first, so two decks that only differ in punctuation stay apart.
    for key in (key for key in decks if key.casefold() == str(name).strip().casefold()):
        return key, decks[key]
    return next(((key, entry) for key, entry in decks.items() if deck_key(key) == wanted), ("", {}))


def short_commander_name(name):
    """A commander as the damage tracker labels it: "Arcades", not "Arcades, the Strategist"."""
    return name.split(",")[0].strip()[:GAME_NAME_MAX]


def deck_details_from_roster(name, entry):
    """What a leaderboard deck brings to a seat, in the shape a profile stores it.

    A deck with two card pictures is a pair of partners written "A & B". The
    lights, the entrance sound and the seat's name are not the deck's to set.
    """
    cards = [card for card in entry.get("cards") or [] if isinstance(card, str)]
    commander = str(entry.get("commander") or "")
    partners = [part.strip() for part in commander.split("&") if part.strip()]
    two = len(cards) > 1
    if not two or len(partners) != 2:
        partners = [commander, ""]
    return {
        "deck": name,
        "two_commanders": two,
        "commander_name": short_commander_name(partners[0]),
        "second_commander_name": short_commander_name(partners[1]) if two else "",
        "commander_sound": entry.get("sound") or "",
        # The roster has one sound per deck, so a partner pair shares it.
        "second_commander_sound": "",
        "background_image": entry.get("art") or "",
        "background_focus": entry.get("art_focus") or "",
        "commander_image": cards[0] if cards else "",
        "second_commander_image": cards[1] if two else "",
    }


def roster_entry_from_payload(group, payload):
    """Validate one player's or deck's roster entry. Empty fields are left out."""
    pictures = set(list_roster_pictures())

    def picture(value):
        value = str(value or "").strip()
        if value and value not in pictures:
            raise ValueError(f"No such picture: {value}")
        return value

    entry = {}
    if group == "decks":
        commander = re.sub(r"\s+", " ", str(payload.get("commander") or "")).strip()
        if len(commander) > ROSTER_COMMANDER_MAX:
            raise ValueError(f"Commander must be at most {ROSTER_COMMANDER_MAX} characters")
        entry["commander"] = commander
        entry["colors"] = clean_colors(payload.get("colors"))
        entry["card_colors"] = clean_colors(payload.get("card_colors"))
        # The commander's type line, as Scryfall prints it; an Eldrazi's
        # brings the Eldrazi theme.
        entry["type_line"] = re.sub(r"\s+", " ", str(payload.get("type_line") or "")).strip()[:200]
        theme = str(payload.get("theme") or "").strip().lower()
        if theme and theme not in DECK_THEMES:
            raise ValueError("Unknown theme")
        entry["theme"] = theme
        entry["art"] = picture(payload.get("art"))
        entry["art_focus"] = clean_focus(payload.get("art_focus")) if entry["art"] else ""
        cards = payload.get("cards")
        entry["cards"] = [card for card in map(picture, cards if isinstance(cards, list) else []) if card]
        entry["sound"] = validate_commander_sound(payload.get("sound"))
        if entry["sound"]:
            entry["volume"] = clean_sound_volume(payload.get("volume"))
        # No longer played: the deck keeps its page, art and sound, and the
        # site marks it with a banner.
        entry["discontinued"] = payload.get("discontinued") is True
        entry["card_fx"] = clean_card_fx(payload.get("card_fx"), len(entry["cards"]))
    else:
        entry["portrait"] = picture(payload.get("portrait"))
        entry["background"] = picture(payload.get("background"))
        entry["background_focus"] = clean_focus(payload.get("background_focus")) if entry["background"] else ""
        decks = payload.get("decks")
        entry["decks"] = []
        for deck in decks if isinstance(decks, list) else []:
            deck = clean_game_text(deck, "Deck name", GAME_DECK_MAX)
            if deck.casefold() not in {saved.casefold() for saved in entry["decks"]}:
                entry["decks"].append(deck)
        if len(entry["decks"]) > ROSTER_DECKS_MAX:
            raise ValueError(f"A player can have at most {ROSTER_DECKS_MAX} decks added by hand")
    return {key: value for key, value in entry.items() if value}


def clean_sound_volume(value):
    """A deck sound's volume as a whole percent from 1 to 100, or 0 for the default."""
    if value in (None, ""):
        return 0
    try:
        volume = round(float(value))
    except (TypeError, ValueError, OverflowError):
        raise ValueError("Volume must be a number") from None
    if not 1 <= volume <= 100:
        raise ValueError("Volume must be between 1% and 100%")
    return 0 if volume == ROSTER_SOUND_VOLUME_DEFAULT else volume


def clean_focus(value):
    """The point a cropped picture is centred on, as "x% y%", or "" for the default."""
    if not value:
        return ""
    match = re.fullmatch(r"\s*(\d{1,3}(?:\.\d+)?)%\s+(\d{1,3}(?:\.\d+)?)%\s*", str(value))
    if not match or any(float(number) > 100 for number in match.groups()):
        raise ValueError("A crop is two percentages, like 50% 25%")
    return f"{float(match[1]):g}% {float(match[2]):g}%"


def clean_zoom(value):
    """How far a background is zoomed past filling its panel: 1 is not at all."""
    try:
        zoom = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError("Zoom must be a number") from error
    if not BACKGROUND_ZOOM_MIN <= zoom <= BACKGROUND_ZOOM_MAX:
        raise ValueError(f"Zoom must be between {BACKGROUND_ZOOM_MIN:g} and {BACKGROUND_ZOOM_MAX:g}")
    return round(zoom, 3)


def clean_colors(value):
    """A colour identity as some of WUBRG in that order, C, or "" when unknown."""
    letters = set(re.sub(r"[^A-Za-z]", "", str(value or "")).upper())
    if letters - set(MANA_COLORS + "C"):
        raise ValueError("Colours are W, U, B, R and G, or C for colourless")
    if "C" in letters:
        if len(letters) > 1:
            raise ValueError("A colourless deck has no other colours")
        return "C"
    return "".join(color for color in MANA_COLORS if color in letters)


def scryfall_card(name):
    """One card from Scryfall by approximate name, or None when it has no match."""
    lookup = urllib.request.Request(f"{SCRYFALL_NAMED_URL}?{urlencode({'fuzzy': name})}",
                                    headers={"User-Agent": "MTGTable/1.0", "Accept": "application/json"})
    # Scryfall asks for a short pause between requests.
    time.sleep(0.1)
    try:
        with urllib.request.urlopen(lookup, timeout=10) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise RuntimeError(f"Scryfall answered {error.code}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Could not reach Scryfall: {error.reason}") from error


def lookup_color_identity(commander):
    """The colour identity of a commander, or of partners written "A & B".

    The whole name is tried first, since some single cards have an & in theirs.
    """
    commander = re.sub(r"\s+", " ", str(commander or "")).strip()
    if not commander:
        raise ValueError("Enter the commander first")
    names = [commander]
    cards = [scryfall_card(commander)]
    if cards[0] is None and "&" in commander:
        names = [part.strip() for part in commander.split("&") if part.strip()]
        cards = [scryfall_card(name) for name in names]
    missing = [name for name, card in zip(names, cards) if card is None]
    if missing:
        raise ValueError(f"Scryfall has no card called {', '.join(missing)}")
    letters = set().union(*(card.get("color_identity") or [] for card in cards))
    # The card's own colours, its frame: a double-faced card keeps them on its front.
    printed = set().union(*((card.get("colors") if "colors" in card else (card.get("card_faces") or [{}])[0].get("colors")) or []
                            for card in cards))
    return {"colors": "".join(color for color in MANA_COLORS if color in letters) or "C",
            "card_colors": "".join(color for color in MANA_COLORS if color in printed) or "C",
            "type_line": " // ".join(card.get("type_line") or (card.get("card_faces") or [{}])[0].get("type_line", "") for card in cards),
            "cards": [card.get("name", "") for card in cards]}


def run_git(*arguments, timeout=60):
    # Never wait on a credential prompt nobody can see: fail and say so instead.
    result = subprocess.run(["git", *arguments], cwd=BASE_DIR, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=timeout,
                            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip() or f"git {arguments[0]} failed")
    # Only the line ends: git status marks a file with its leading columns.
    return result.stdout.strip("\n")


def publish_state():
    """What a publish would send: changed public files, and commits not yet pushed."""
    listing = run_git("status", "--porcelain", "--", *PUBLISH_PATHS)
    changed = [line[3:] for line in listing.splitlines()]
    try:
        unpushed = int(run_git("rev-list", "--count", "@{upstream}..HEAD"))
    except (RuntimeError, ValueError):
        unpushed = 0
    return {"changed": changed, "unpushed": unpushed}


@app.get("/public")
def public_site_redirect():
    # The page finds its files beside itself, which needs the trailing slash.
    return redirect("/public/")


@app.get("/public/")
def public_site():
    """site/index.html as published, plus the editor that only exists here."""
    page = (SITE_DIR / "index.html").read_text(encoding="utf-8")
    page = page.replace("</head>", '  <link rel="stylesheet" href="/static/public-editor.css">\n</head>')
    return page.replace("</body>", '  <script src="/static/public-editor.js"></script>\n</body>')


@app.get("/public/game_history.json")
def public_site_history():
    with history_lock:
        return jsonify({"games": copy.deepcopy(game_history), "historical_wins": copy.deepcopy(historical_wins)})


@app.get("/public/roster.json")
def public_site_roster():
    """The roster in the shape build_site.py publishes it, minus the resizing."""
    def served(source):
        url = "/" + quote(source)
        return {"full": url, "thumb": url}

    roster = load_roster()
    for group in ROSTER_GROUPS:
        for entry in roster[group].values():
            for key in build_site.IMAGE_KEYS:
                if entry.get(key):
                    entry[key] = served(entry[key])
            for key in build_site.IMAGE_LIST_KEYS:
                if entry.get(key):
                    entry[key] = [served(source) for source in entry[key]]
    for entry in roster["decks"].values():
        if entry.get("sound"):
            entry["sound"] = "/sound/Commander/" + quote(entry["sound"])
    return jsonify(roster)


@app.get("/public/mana_sounds.json")
def public_site_mana_sounds():
    """The mana burst sounds in the shape build_site.py publishes them."""
    sounds = load_mana_sounds()
    for entry in sounds.values():
        if entry["sound"] and entry["sound"] != "none":
            entry["sound"] = "/sound/Mana/" + quote(entry["sound"])
    return jsonify(sounds)


@app.get("/public/intro.json")
def public_site_intro():
    """The intro's settings in the shape build_site.py publishes them."""
    intro = load_intro()
    for key in INTRO_SOUNDS:
        if intro[key]:
            intro[key] = "/sound/Intro/" + quote(intro[key])
    return jsonify(intro)


@app.get("/public/<path:filename>")
def public_site_asset(filename):
    # Files the site shares with the table, like the card animations, live
    # outside site/ and are copied in by build_site.py.
    shared = build_site.SHARED_PAGE_FILES.get(filename)
    if shared:
        return send_from_directory(BASE_DIR / Path(shared).parent, Path(shared).name)
    return send_from_directory(SITE_DIR, filename)


@app.get("/api/public/roster")
def get_public_roster():
    return jsonify({"ok": True, "roster": load_roster(), "pictures": list_roster_pictures(),
                    "sounds": list_commander_sounds(), "intro": load_intro(), "intro_sounds": list_intro_sounds(),
                    "intro_numbers": INTRO_NUMBERS, "settings": load_site_settings(),
                    "mana_sounds": load_mana_sounds(), "mana_sound_files": list_mana_sounds(), "publish": publish_state()})


@app.post("/api/public/mana-sounds")
def set_public_mana_sounds():
    """The sound and volume of each colour's mana burst on the public site."""
    payload = request.get_json(force=True, silent=True) or {}
    sounds = clean_mana_sounds(payload.get("sounds") or {})
    with roster_lock:
        write_json_file(MANA_SOUNDS_FILE, sounds)
    return ok("Saved the mana sounds", sounds=sounds, publish=publish_state())


@app.post("/api/public/intro")
def set_public_intro():
    payload = request.get_json(force=True, silent=True) or {}
    submitted = payload.get("intro") or {}
    # Older open editor tabs may predate these controls. Preserve saved values
    # instead of silently resetting them when an old tab saves another field.
    if isinstance(submitted, dict) and ("chain" not in submitted or "rotation_speed" not in submitted):
        saved = load_intro()
        submitted = {**{"chain": saved["chain"], "rotation_speed": saved["rotation_speed"]}, **submitted}
    intro = clean_intro(submitted)
    with roster_lock:
        write_json_file(INTRO_FILE, intro)
    return ok("Saved the intro", intro=intro, publish=publish_state())


def load_site_settings():
    try:
        saved = json.loads(SITE_SETTINGS_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        saved = {}
    volume = saved.get("volume") if isinstance(saved, dict) else None
    valid = isinstance(volume, (int, float)) and not isinstance(volume, bool) and 0 <= volume <= 100
    # Keep quiet dB slider values instead of rounding them down to silence.
    return {"volume": round(volume, 4) if valid else SITE_VOLUME_DEFAULT}


@app.post("/api/public/settings")
def set_public_site_settings():
    """The site's overall volume, which every visitor's slider tops out at."""
    payload = request.get_json(force=True, silent=True) or {}
    volume = payload.get("volume")
    if not isinstance(volume, (int, float)) or isinstance(volume, bool) or not 0 <= volume <= 100:
        raise ValueError("The site volume is a percentage from 0 to 100")
    settings = {"volume": round(volume, 4)}
    with roster_lock:
        write_json_file(SITE_SETTINGS_FILE, settings)
    return ok(f"Site volume set to {settings['volume']}%", settings=settings, publish=publish_state())


@app.post("/api/public/pictures")
def upload_roster_picture():
    """Save a picture sent from the roster editor into Backgrounds/Uploads.

    It is only stored here; nothing uses it until a roster entry names it, and
    it reaches the public site with the next publish, like every picture.
    """
    # The lights page sends a seat's background to Players and its card to
    # Commander, the folders its menus list; the roster editor uses Uploads.
    folder = {"players": ROSTER_PICTURE_DIR / "Players",
              "commander": ROSTER_PICTURE_DIR / "Commander"}.get(request.form.get("folder"), ROSTER_UPLOAD_DIR)
    upload = request.files.get("picture")
    if not upload or not upload.filename:
        raise ValueError("Choose a picture to upload")
    suffix = Path(upload.filename).suffix.lower()
    if suffix not in ROSTER_PICTURE_EXTENSIONS:
        raise ValueError("Pictures must be JPG, PNG, WebP or JFIF")
    data = upload.read(ROSTER_UPLOAD_MAX + 1)
    if len(data) > ROSTER_UPLOAD_MAX:
        raise ValueError(f"Pictures must be at most {ROSTER_UPLOAD_MAX // (1024 * 1024)} MB")
    # Pillow is only needed to build the site, so a check is done when it is there.
    try:
        from PIL import Image
    except ImportError:
        Image = None
    if Image:
        try:
            with Image.open(io.BytesIO(data)) as image:
                image.verify()
        except Exception as error:
            raise ValueError("That file is not a picture Pillow can read") from error
    stem = re.sub(r"[^A-Za-z0-9]+", "-", Path(upload.filename).stem).strip("-")[:60] or "picture"
    with roster_lock:
        folder.mkdir(parents=True, exist_ok=True)
        target, copy_number = folder / f"{stem}{suffix}", 2
        while target.exists():
            target, copy_number = folder / f"{stem}-{copy_number}{suffix}", copy_number + 1
        target.write_bytes(data)
    path = target.relative_to(BASE_DIR).as_posix()
    return ok(f"Uploaded {path}", path=path, pictures=list_roster_pictures(), publish=publish_state())


@app.post("/api/public/sounds")
def upload_roster_sound():
    """Save a sound sent from the roster editor into sound/Commander, or into
    sound/Intro or sound/Mana when the form says folder=intro or folder=mana.

    The table's commander picker lists a commander sound straight away. Like a
    picture, a sound reaches the public site once a deck or the intro names it
    and the site is published.
    """
    folder, listing = {"intro": (INTRO_SOUND_DIR, list_intro_sounds),
                       "mana": (MANA_SOUND_DIR, list_mana_sounds)}.get(request.form.get("folder"),
                                                                       (COMMANDER_SOUND_DIR, list_commander_sounds))
    upload = request.files.get("sound")
    if not upload or not upload.filename:
        raise ValueError("Choose a sound to upload")
    suffix = Path(upload.filename).suffix.lower()
    if suffix not in ANNOUNCER_EXTENSIONS:
        raise ValueError("Sounds must be MP3, WAV, OGG or M4A")
    data = upload.read(ROSTER_SOUND_UPLOAD_MAX + 1)
    if len(data) > ROSTER_SOUND_UPLOAD_MAX:
        raise ValueError(f"Sounds must be at most {ROSTER_SOUND_UPLOAD_MAX // (1024 * 1024)} MB")
    stem = re.sub(r"[^A-Za-z0-9]+", "_", Path(upload.filename).stem).strip("_")[:60] or "sound"
    with roster_lock:
        folder.mkdir(parents=True, exist_ok=True)
        target, copy_number = folder / f"{stem}{suffix}", 2
        while target.exists():
            target, copy_number = folder / f"{stem}_{copy_number}{suffix}", copy_number + 1
        target.write_bytes(data)
    return ok(f"Uploaded {target.name}", file=target.name, sounds=listing(), publish=publish_state())


@app.get("/api/public/color-identity")
def get_color_identity():
    """A commander's colour identity from Scryfall, for the roster editor."""
    found = lookup_color_identity(request.args.get("commander", ""))
    return ok(f"{' & '.join(found['cards'])}: {found['colors']}", **found)


@app.post("/api/public/roster")
def set_public_roster_entry():
    """Replace one player's or deck's entry. An empty one removes it."""
    payload = request.get_json(force=True, silent=True) or {}
    group = payload.get("group")
    if group not in ROSTER_GROUPS:
        raise ValueError("Unknown roster group")
    name = clean_game_text(payload.get("name"), "Name", GAME_DECK_MAX)
    roster = save_roster_entry(group, name, payload.get("entry") or {})
    return ok(f"Saved {name}", roster=roster, publish=publish_state())


def deck_names_match(left, right):
    """The strict spelling match used by game-history deck statistics."""
    return str(left or "").casefold() == str(right or "").casefold()


def renamed_deck_roster(roster, source, target):
    """Move a roster deck to `target`, folding it into that deck when present.

    The target's configured details win a merge.  An imported deck is usually
    bare, so this both avoids overwriting an established deck's art and lets
    any details which only exist on the source fill gaps in the target.
    """
    decks = roster["decks"]
    source_key = next((name for name in decks if deck_names_match(name, source)), "")
    target_key = next((name for name in decks if deck_names_match(name, target)), "")
    merging = bool(target_key and not deck_names_match(source_key, target_key))

    if source_key and merging:
        source_entry = decks.pop(source_key)
        decks[target_key] = {**source_entry, **decks[target_key]}
    elif source_key:
        # This also permits a casing-only rename.
        source_entry = decks.pop(source_key)
        decks[target] = source_entry

    for entry in roster["players"].values():
        listed = entry.get("decks")
        if not isinstance(listed, list):
            continue
        replaced = [target if deck_names_match(name, source) else name for name in listed]
        deduped, seen = [], set()
        for name in replaced:
            key = str(name).casefold()
            if key not in seen:
                seen.add(key)
                deduped.append(name)
        if deduped != listed:
            entry["decks"] = deduped
    return merging


def rename_profile_decks(source, target):
    """Keep saved table presets attached to a deck after it is renamed."""
    changed = 0
    try:
        files = list(PROFILE_DIR.glob("*.json"))
    except OSError:
        return changed
    for path in files:
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(saved, dict):
            continue
        # Older presets inferred their deck from their filename; make that
        # association explicit when their filename was the old deck name.
        deck = saved.get("deck") if isinstance(saved, dict) else ""
        inferred = path.stem if not deck else deck
        if not deck_names_match(inferred, source):
            continue
        saved["deck"] = target
        try:
            write_json_file(path, saved)
            changed += 1
        except OSError:
            app.logger.warning("Could not update renamed deck in %s", path.name)
    if changed:
        profile_deck_cache.clear()
    return changed


@app.post("/api/public/decks/rename")
def rename_public_deck():
    """Rename one deck everywhere, or merge it into an existing deck.

    Deck names are the join between the roster and recorded results.  Merely
    changing the roster key would split the leaderboard, so this deliberately
    rewrites every matching recorded result too.
    """
    payload = request.get_json(force=True, silent=True) or {}
    source = clean_game_text(payload.get("source"), "Current deck name", GAME_DECK_MAX)
    target = clean_game_text(payload.get("target"), "New deck name", GAME_DECK_MAX)
    if deck_names_match(source, target) and source == target:
        raise ValueError("Choose a different deck name")

    with history_lock:
        history_before = copy.deepcopy(game_history)
        target_in_history = any(
            deck_names_match(player.get("deck"), target)
            for game in history_before for player in game.get("players") or []
            if isinstance(player, dict)
        )
        renamed_games = 0
        for game in game_history:
            for player in game.get("players") or []:
                if isinstance(player, dict) and deck_names_match(player.get("deck"), source):
                    player["deck"] = target
                    renamed_games += 1

        with roster_lock:
            roster = load_roster()
            source_in_roster = any(deck_names_match(name, source) for name in roster["decks"])
            target_in_roster = any(deck_names_match(name, target) for name in roster["decks"])
            if not source_in_roster and not renamed_games:
                raise ValueError(f"No deck called {source}")
            merging = renamed_deck_roster(roster, source, target)
            # A target known only through game history is still a merge: move
            # the source's roster details to its established statistics name.
            merging = merging or ((target_in_roster or target_in_history) and not deck_names_match(source, target))
            try:
                write_json_file(ROSTER_FILE, roster)
                save_game_history()
            except Exception:
                game_history[:] = history_before
                raise

    table_changed = False
    with state_lock:
        for player in table_state["players"]:
            if deck_names_match(player.get("deck"), source):
                player["deck"] = target
                table_changed = True
        if table_changed:
            save_table_state()
    profiles = rename_profile_decks(source, target)
    action = "Merged" if merging else "Renamed"
    return ok(f"{action} {source} as {target}", roster=roster, target=target,
              merged=merging, games=renamed_games, profiles=profiles, publish=publish_state())


def deck_game_count(history, name):
    """How many recorded results used a deck, matched as the statistics match."""
    return sum(1 for game in history for player in game.get("players") or []
               if isinstance(player, dict) and deck_names_match(player.get("deck"), name))


def deleted_deck_roster(roster, name):
    """Take a deck out of the roster: its own entry, and its name on every
    player's list of decks. Returns whether it was anywhere to take out."""
    decks = roster["decks"]
    keys = [key for key in decks if deck_names_match(key, name)]
    for key in keys:
        decks.pop(key)
    found = bool(keys)
    for entry in roster["players"].values():
        listed = entry.get("decks")
        if not isinstance(listed, list):
            continue
        kept = [deck for deck in listed if not deck_names_match(deck, name)]
        if kept != listed:
            found = True
            if kept:
                entry["decks"] = kept
            else:
                entry.pop("decks")
    return found


@app.post("/api/public/decks/delete")
def delete_public_deck():
    """Delete a deck that has never been played.

    Only an unplayed deck can go: recorded results name their deck, and
    deleting one with results would leave them pointing at nothing (merge it
    into another deck instead). Table presets for the deck are left alone.
    """
    payload = request.get_json(force=True, silent=True) or {}
    name = clean_game_text(payload.get("name"), "Deck name", GAME_DECK_MAX)
    # Held throughout, so no game can be recorded with the deck mid-delete.
    with history_lock:
        played = deck_game_count(game_history, name)
        if played:
            raise ValueError(f"{name} has {played} recorded game{'s' if played != 1 else ''}, so it cannot be "
                             "deleted. Merge it into another deck or mark it discontinued instead")
        with roster_lock:
            roster = load_roster()
            if not deleted_deck_roster(roster, name):
                raise ValueError(f"No deck called {name}")
            write_json_file(ROSTER_FILE, roster)
    return ok(f"Deleted {name}", roster=roster, publish=publish_state())


def clean_card_fx(value, count):
    """A deck's card animations for the public site: one per commander card,
    in the shape the table keeps them (see COMMANDER_FX_EFFECTS), or [] for
    none. Anything unrecognised in one falls back to that field's default."""
    if not isinstance(value, list):
        return []
    cleaned = []
    for saved in value[:count]:
        fx = default_commander_fx()
        apply_commander_fx(fx, saved)
        cleaned.append(fx)
    # Without any effect the site shows the plain cards.
    return cleaned if any(fx["effect"] != "none" for fx in cleaned) else []


def player_card_fx(player):
    """A seat's commander animations, one per card it shows."""
    keys = ("commander_fx", "second_commander_fx") if player.get("two_commanders") else ("commander_fx",)
    return [copy.deepcopy(player[key]) for key in keys if isinstance(player.get(key), dict)]


def sync_roster_card_fx():
    """Give each roster deck the card animations of its saved preset.

    The effects are picked per seat on the lights page and kept in the deck's
    preset, but the public site is built from the roster alone, so this copies
    them over. A deck without a preset keeps whatever the roster has.
    """
    presets = {deck_key(profile["deck"]): profile["name"] for profile in reversed(list_profiles()) if profile["deck"]}
    with roster_lock:
        roster = load_roster()
        changed = False
        for name, entry in roster["decks"].items():
            preset = presets.get(deck_key(name))
            if not preset:
                continue
            try:
                saved = json.loads(profile_path(preset).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(saved, dict):
                continue
            card_fx = clean_card_fx(player_card_fx(saved), len(entry.get("cards") or []))
            if card_fx != (entry.get("card_fx") or []):
                if card_fx:
                    entry["card_fx"] = card_fx
                else:
                    entry.pop("card_fx", None)
                changed = True
        if changed:
            write_json_file(ROSTER_FILE, roster)
    return changed


def save_roster_entry(group, name, payload):
    """Validate and store one roster entry, an empty one removing it. Returns the roster."""
    if group == "decks" and "card_fx" not in payload:
        # The /public editor does not edit the animations: keep the saved ones.
        saved = next((value for key, value in load_roster()["decks"].items() if key.casefold() == name.casefold()), {})
        payload = {**payload, "card_fx": saved.get("card_fx") or []}
    entry = roster_entry_from_payload(group, payload)
    # A deck saved with a commander gets what is missing from Scryfall: its
    # colours, and the card's own colours, which a new commander replaces. Out
    # of reach is no reason to refuse the save: they stay unknown.
    if group == "decks" and entry.get("commander"):
        saved = next((value for key, value in load_roster()["decks"].items() if key.casefold() == name.casefold()), {})
        if saved.get("commander") != entry["commander"]:
            entry.pop("card_colors", None)
            entry.pop("type_line", None)
        if not entry.get("colors") or not entry.get("card_colors") or not entry.get("type_line"):
            try:
                found = lookup_color_identity(entry["commander"])
                for key in ("colors", "card_colors", "type_line"):
                    if found[key]:
                        entry.setdefault(key, found[key])
            except (RuntimeError, ValueError):
                pass
    with roster_lock:
        roster = load_roster()
        # Names match the way the statistics do, whatever case they were typed in.
        key = next((saved for saved in roster[group] if saved.casefold() == name.casefold()), name)
        if entry:
            roster[group][key] = entry
        else:
            roster[group].pop(key, None)
        write_json_file(ROSTER_FILE, roster)
    return roster


@app.post("/api/public/publish")
def publish_public_site():
    """Commit the public site's files and push, which republishes the site."""
    with publish_lock:
        branch = run_git("rev-parse", "--abbrev-ref", "HEAD")
        if branch != PUBLISH_BRANCH:
            raise RuntimeError(f"The site is published from {PUBLISH_BRANCH}, but this checkout is on {branch}")
        # Presets saved before the roster carried their card animations.
        sync_roster_card_fx()
        state = publish_state()
        if not state["changed"] and not state["unpushed"]:
            return ok("Nothing to publish: GitHub already has everything", publish=state)
        if state["changed"]:
            # GitHub runs the same build after the push. A roster naming a
            # missing picture fails it there, silently, leaving the old site
            # up; here it stops the publish and says why.
            build = subprocess.run([sys.executable, "build_site.py"], cwd=BASE_DIR, capture_output=True,
                                   text=True, encoding="utf-8", errors="replace", timeout=300)
            if build.returncode:
                lines = (build.stderr or build.stdout).strip().splitlines()
                raise RuntimeError(f"The site does not build, so nothing was pushed: {lines[-1] if lines else 'unknown error'}")
            # git refuses a path that neither exists nor is tracked, like
            # sound/Intro before any intro sound is uploaded.
            paths = [path for path in PUBLISH_PATHS if (BASE_DIR / path).exists() or run_git("ls-files", "--", path)]
            run_git("add", "--", *paths)
            run_git("commit", "-m", f"Update leaderboard ({datetime.now():%Y-%m-%d})", "--", *paths)
        run_git("push", timeout=180)
        return ok("Pushed. The public site updates in a minute or two", publish=publish_state())


# -----------------------------
# DEVICE SETUP
# -----------------------------
@app.get("/api/status")
def status():
    profiles = list_profiles()
    return jsonify({
        "ok": True,
        "bulb_ip": bulb.current_ip,
        "bulbs": {
            key: {"name": BULB_NAMES[key], "ip": controller.current_ip, "configured": bool(controller.current_ip)}
            for key, controller in bulbs.items()
        },
        "strip_connected": strip.is_ready(),
        "players": players_payload(),
        "names_revision": names_revision,
        "current_player": table_state["current_player"],
        "lights": [{"id": key, "label": LIGHT_LABELS[key], "ready": resolve_device(key) is not None}
                   for key in LIGHT_IDS],
        "fade_enabled": table_state["fade_enabled"],
        "fade_seconds": table_state["fade_seconds"],
        # The page builds its effect menus from this rather than hard-coding them.
        "effects": [{"id": effect, "label": lighting.EFFECT_LABELS[effect]} for effect in lighting.EFFECTS],
        "commander_fx_effects": [{"id": effect, "label": label} for effect, label in COMMANDER_FX_EFFECTS],
        "effect_seconds_min": lighting.EFFECT_SECONDS_MIN,
        "effect_seconds_max": lighting.EFFECT_SECONDS_MAX,
        "white_temp_min": lighting.WHITE_TEMP_MIN,
        "white_temp_max": lighting.WHITE_TEMP_MAX,
        "house_lights": house_lights,
        "house_temperature": HOUSE_TEMPERATURE,
        "profiles": profiles,
        # Deck presets come from the saved profiles and the leaderboard roster.
        "decks": list_roster_decks(profiles),
        # The lights page seats a player with a deck from these, as the
        # hosted tracker's picker does.
        "seat_catalog": seat_catalog(),
        "lobby": lobby_payload(),
        "pictures": list_roster_pictures(),
        "announcer_sounds": list_announcer_sounds(),
        "announcer_winner": announcer_winner_sound(),
        "announcer_death": announcer_death_sounds(),
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
def shared_table_state():
    """table_state for the pages, without the screen remote's code: that one
    only goes out inside its QR picture."""
    return {key: value for key, value in table_state.items() if key != "mirror_key"}


@app.get("/api/table")
def get_table_state():
    return jsonify({"ok": True, **shared_table_state(), "players": players_payload(),
                    "announcer_sounds": list_announcer_sounds(),
                    "announcer_winner": announcer_winner_sound(),
                    "announcer_death": announcer_death_sounds(),
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


@app.post("/api/players/<index>/commander-fx")
def set_commander_fx(index):
    """Change how one of this player's commander cards animates on the table.

    The body carries any of effect, focus, glow and area, plus "slot": 2 for
    the second commander of a partner pair.
    """
    payload = request.get_json(force=True, silent=True) or {}
    index = player_index(index)
    key = "second_commander_fx" if payload.get("slot") == 2 else "commander_fx"
    fields = {name: payload[name] for name in ("effect", "focus", "glow", "area") if name in payload}

    with state_lock:
        player = table_state["players"][index]
        fx = dict(player[key])
        apply_commander_fx(fx, fields, strict=True)
        player[key] = fx
        save_table_state()

    return ok(f"{player['name']}'s commander animation: {COMMANDER_FX_LABELS[fx['effect']].lower()}",
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
        name = profile_name(payload.get("profile") or player["deck"] or player["name"])
        profile = copy.deepcopy(player)
        profile["saved_at"] = datetime.now().isoformat(timespec="seconds")

    try:
        write_json_file(profile_path(name), profile)
    except OSError as error:
        raise RuntimeError(f"Could not write the profile: {error}") from error
    # A deck on the leaderboard takes the preset's card animations with it.
    sync_roster_card_fx()

    return ok(f"Saved {name} to {PROFILE_DIR.name}/{name}.json", profile=name, profiles=list_profiles())


@app.post("/api/players/<index>/profile/load")
def load_player_profile(index):
    """Put a saved profile onto a player: lights, sounds, commanders and pictures.

    A profile saved before profiles held a deck's pictures gets them from the
    leaderboard deck it belongs to, so older presets show up dressed too.
    """
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
    if not isinstance(saved, dict):
        raise ValueError(f"{name}.json is not a profile")

    deck, entry = roster_deck(saved.get("deck") or name)
    if entry:
        from_roster = deck_details_from_roster(deck, entry)
        missing = ("deck", "background_focus", *PLAYER_PICTURE_KEYS)
        saved = {**{key: from_roster[key] for key in missing if key not in saved}, **saved}

    with state_lock:
        apply_saved_player(table_state["players"][index], saved, keep_name=True)
        mark_preset_load(index)
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


@app.post("/api/players/<index>/deck/load")
def load_roster_deck(index):
    """Dress a seat as a leaderboard deck that has no preset of its own yet.

    Its commanders, sound and pictures come from the roster; the seat keeps
    its lights and entrance sound, ready to be tuned and saved as the preset.
    """
    payload = request.get_json(force=True, silent=True) or {}
    index = player_index(index)
    deck, entry = roster_deck(payload.get("deck"))
    if not deck:
        raise ValueError(f"The leaderboard has no deck called {payload.get('deck')}")
    details = deck_details_from_roster(deck, entry)

    with state_lock:
        player = table_state["players"][index]
        apply_deck_details(player, details)
        player["two_commanders"] = details["two_commanders"]
        for key in ("commander_name", "second_commander_name"):
            player[key] = details[key]
        for key in ("commander_sound", "second_commander_sound"):
            player[key] = known_or_blank(validate_commander_sound, details[key])
        mark_preset_load(index)
        save_table_state()

    return ok(f"Loaded the {deck} deck onto player {index + 1}. Set its lights, then save it as a preset",
              player=player_payload(index), players=players_payload())


@app.post("/api/players/<index>/deck")
def set_player_deck(index):
    """Set the deck a seat is playing, and the pictures the table display shows for it."""
    payload = request.get_json(force=True, silent=True) or {}
    index = player_index(index)
    details = {}
    if "deck" in payload:
        details["deck"] = str(payload["deck"] or "")
    for key in PLAYER_PICTURE_KEYS:
        if key in payload:
            details[key] = validate_picture(payload[key])
    if "background_focus" in payload:
        details["background_focus"] = clean_focus(payload["background_focus"])
    if "background_zoom" in payload:
        details["background_zoom"] = clean_zoom(payload["background_zoom"])
    # A new background was not cropped for.
    if "background_image" in payload and "background_focus" not in payload:
        details["background_focus"] = ""

    with state_lock:
        player = table_state["players"][index]
        apply_deck_details(player, details)
        save_table_state()
    return ok(f"Saved {player['name']}'s deck", player=player_payload(index))


@app.post("/api/players/<index>/deck/roster")
def add_player_deck_to_roster(index):
    """Write a seat's deck onto the leaderboard roster, ready for the next publish.

    The pictures and sound replace the deck's; what only the roster editor
    sets — its full commander name, colours, theme and the rest — is kept. A
    deck new to the roster takes its commander from the seat's commander names.
    """
    index = player_index(index)
    with state_lock:
        player = copy.deepcopy(table_state["players"][index])
    name = clean_game_text(player["deck"], "Deck name", GAME_DECK_MAX)
    deck, entry = roster_deck(name)
    deck = deck or name
    entry = dict(entry)

    if not entry.get("commander"):
        names = [player["commander_name"]] + ([player["second_commander_name"]] if player["two_commanders"] else [])
        entry["commander"] = " & ".join(part for part in names if part)
    if player["background_image"]:
        entry["art"] = player["background_image"]
        entry["art_focus"] = player["background_focus"]
    cards = [player[key] for key in ("commander_image", "second_commander_image")
             if player[key] and (key == "commander_image" or player["two_commanders"])]
    if cards:
        entry["cards"] = cards
    if player["commander_sound"]:
        entry["sound"] = player["commander_sound"]
    if cards:
        entry["card_fx"] = player_card_fx(player)
    roster = save_roster_entry("decks", deck, entry)

    # Listed on its player's page too, played yet or not.
    seat = player["name"]
    owner = next((key for key in roster["players"] if key.casefold() == seat.casefold()), "")
    if owner:
        decks = list(roster["players"][owner].get("decks") or [])
        if deck.casefold() not in {saved.casefold() for saved in decks}:
            roster = save_roster_entry("players", owner, {**roster["players"][owner], "decks": decks + [deck]})

    return ok(f"{deck} is on the leaderboard roster. Publish the site to put it online",
              publish=publish_state())


# -----------------------------
# NEW GAME: PLAYERS JOIN FROM THEIR PHONES
# -----------------------------
# "New game" on the table blanks every seat and puts a QR code in each corner.
# Scanning it opens /join/<seat> on that player's phone, where they say who
# they are and what they play: the seat is dressed as that deck and the table
# swaps the code for their name plaque. Each code carries a key that changes
# with every new game, so a code photographed last week, or a guessed URL,
# cannot take a seat in this one. The lights page seats players the same way.
SEAT_NAME_MAX = 18
THUMB_EDGE = 360
SCRYFALL_PICTURE = re.compile(r"^https://cards\.scryfall\.io/[A-Za-z0-9_./-]+\.(?:jpg|jpeg|png)(?:\?\d+)?$")
thumb_cache = {}
thumb_lock = threading.Lock()


def bump_lobby():
    table_state["lobby"]["revision"] = time.time_ns() // 1_000_000


def lobby_payload():
    lobby = table_state["lobby"]
    return {"active": lobby["active"], "revision": lobby["revision"],
            "seats": [{"claimed": lobby["claimed"][index], "name": table_state["players"][index]["name"],
                       "deck": table_state["players"][index]["deck"]} for index in range(PLAYER_COUNT)]}


def clean_seat_name(value):
    name = re.sub(r"\s+", " ", str(value or "")).strip()[:SEAT_NAME_MAX]
    if not name:
        raise ValueError("Choose who is sitting here")
    return name


def picture_thumb(path):
    """A small copy of a Backgrounds picture for menus on a phone, or "" for none."""
    return "/thumb/" + quote(path) if isinstance(path, str) and path and (BASE_DIR / path).is_file() else ""


def seat_catalog():
    """The players and decks a seat can be set to, as the hosted tracker lists them.

    Everyone on the roster or in a recorded game, each with the decks they
    play: the roster's list, then what they have played, then decks whose
    preset was saved for them. See build_site.tracker_catalog.
    """
    roster = load_roster()
    decks = roster["decks"]
    deck_list = []
    for name in sorted(decks, key=str.casefold):
        entry = decks[name]
        cards = [card for card in entry.get("cards") or [] if isinstance(card, str)]
        deck_list.append({"name": name, "commander": str(entry.get("commander") or ""),
                          "discontinued": entry.get("discontinued") is True,
                          "thumb": picture_thumb(entry.get("art") or (cards[0] if cards else ""))})

    players = {}
    for name, entry in roster["players"].items():
        players[name.casefold()] = {"name": name, "portrait": picture_thumb(entry.get("portrait")),
                                    "decks": [deck for deck in entry.get("decks") or [] if isinstance(deck, str)]}
    with history_lock:
        games = list(game_history)
    for game in games:
        for seat in game.get("players") or []:
            name = str(seat.get("name") or "").strip() if isinstance(seat, dict) else ""
            if name:
                player = players.setdefault(name.casefold(), {"name": name, "portrait": "", "decks": []})
                player["decks"].append(str(seat.get("deck") or ""))
    for deck, profile in build_site.deck_profiles(decks).items():
        owner = str(profile.get("name") or "").strip().casefold()
        if owner in players:
            players[owner]["decks"].append(deck)

    by_key = {deck_key(name): name for name in decks}
    for player in players.values():
        known = []
        for deck in player["decks"]:
            name = by_key.get(deck_key(deck))
            if name and name not in known:
                known.append(name)
        player["decks"] = known
    return {"players": sorted(players.values(), key=lambda player: player["name"].casefold()), "decks": deck_list}


def announcer_for(player, deck):
    """The entrance recording of this player with this deck: Players/<Player>_<Deck>.mp3."""
    for sound in list_announcer_sounds():
        who, _, what = Path(sound["file"]).stem.partition("_")
        if who.casefold() == player.casefold() and deck_key(what) == deck_key(deck):
            return sound["file"]
    return ""


def dress_seat(index, player, deck_name):
    """Seat `player` at `index` with a leaderboard deck and return the deck's name.

    The deck's saved preset is loaded when it has one, lights included;
    otherwise the roster's pictures, commanders, sound and card animations.
    The entrance announcement is this player's recording with this deck, or
    the preset's when the preset was saved for this player, or none.
    """
    global names_revision
    deck, entry = roster_deck(deck_name)
    if not deck:
        raise ValueError(f"The leaderboard has no deck called {deck_name}")
    details = deck_details_from_roster(deck, entry)
    profile = build_site.deck_profiles(load_roster()["decks"]).get(deck)
    announcer = announcer_for(player, deck)
    if not announcer and profile and str(profile.get("name") or "").strip().casefold() == player.casefold():
        announcer = known_or_blank(validate_announcer_sound, profile.get("announcer_sound"))

    with state_lock:
        target = table_state["players"][index]
        if profile:
            # A preset saved before presets held pictures takes the roster's.
            missing = ("background_focus", *PLAYER_PICTURE_KEYS)
            apply_saved_player(target, {**{key: details[key] for key in missing if key not in profile}, **profile},
                               keep_name=True)
        else:
            apply_deck_details(target, details)
            target["two_commanders"] = details["two_commanders"]
            for key in ("commander_name", "second_commander_name"):
                target[key] = details[key]
            for key in ("commander_sound", "second_commander_sound"):
                target[key] = known_or_blank(validate_commander_sound, details[key])
            saved_fx = entry.get("card_fx") if isinstance(entry.get("card_fx"), list) else []
            for position, key in enumerate(COMMANDER_FX_KEYS):
                target[key] = default_commander_fx()
                apply_commander_fx(target[key], saved_fx[position] if position < len(saved_fx) else None)
        target["deck"] = deck
        target["name"] = player
        target["announcer_sound"] = announcer
        mark_preset_load(index)
        names_revision += 1
        if table_state["lobby"]["active"]:
            table_state["lobby"]["claimed"][index] = True
            bump_lobby()
        save_table_state()
    if index == table_state["current_player"]:
        apply_player_lighting(index, fade=False)
    return deck


def fetch_scryfall_picture(url, folder, stem):
    """Save one of Scryfall's card pictures into Backgrounds and return its path."""
    if not SCRYFALL_PICTURE.match(str(url or "")):
        raise ValueError("That picture is not one of Scryfall's")
    lookup = urllib.request.Request(url, headers={"User-Agent": "MTGTable/1.0"})
    with urllib.request.urlopen(lookup, timeout=15) as response:
        data = response.read(ROSTER_UPLOAD_MAX + 1)
    if len(data) > ROSTER_UPLOAD_MAX:
        raise ValueError("That picture is too large")
    suffix = ".png" if url.split("?")[0].lower().endswith(".png") else ".jpg"
    with roster_lock:
        folder.mkdir(parents=True, exist_ok=True)
        target, copy_number = folder / f"{stem}{suffix}", 2
        while target.exists():
            target, copy_number = folder / f"{stem}-{copy_number}{suffix}", copy_number + 1
        target.write_bytes(data)
    return target.relative_to(BASE_DIR).as_posix()


def add_phone_deck(new_deck, player):
    """Put a deck made on a phone onto the roster, with its commander's art and
    card from Scryfall saved locally, and return its name.

    It goes online with the next Publish, like any roster change. Without
    Scryfall the deck is still made, without pictures.
    """
    name = clean_game_text(new_deck.get("name"), "Deck name", GAME_DECK_MAX)
    existing, _ = roster_deck(name)
    if existing:
        raise ValueError(f"There is already a deck called {existing}. Pick it from the list")
    commander = clean_game_text(new_deck.get("commander"), "Commander", ROSTER_COMMANDER_MAX)
    stem = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-")[:60] or "deck"
    entry = {"commander": commander}
    try:
        if new_deck.get("art_url"):
            entry["art"] = fetch_scryfall_picture(new_deck["art_url"], ROSTER_PICTURE_DIR / "Players", stem)
        if new_deck.get("card_url"):
            entry["cards"] = [fetch_scryfall_picture(new_deck["card_url"], ROSTER_PICTURE_DIR / "Commander", stem)]
    except (OSError, urllib.error.URLError) as error:
        app.logger.warning("Could not fetch %s's pictures from Scryfall (%s)", name, error)
    roster = save_roster_entry("decks", name, entry)
    # Listed on its player's page too, as "Put on public leaderboard" does.
    owner = next((key for key in roster["players"] if key.casefold() == player.casefold()), "")
    if owner:
        decks = list(roster["players"][owner].get("decks") or [])
        if name.casefold() not in {saved.casefold() for saved in decks}:
            save_roster_entry("players", owner, {**roster["players"][owner], "decks": decks + [name]})
    return name


def joining_seat(seat, key):
    """The seat index a phone's code is for, if it is still good: until the
    next New game, so a player can scan again mid-game to change their pick."""
    index = player_index(seat - 1)
    lobby = table_state["lobby"]
    if not lobby["keys"][index] or not secrets.compare_digest(str(key or ""), lobby["keys"][index]):
        raise ValueError("This code is from an earlier game. Scan the one on the table again")
    return index


def seat_key(index):
    """This seat's code key, made now if no New game has made one."""
    with state_lock:
        lobby = table_state["lobby"]
        if not lobby["keys"][index]:
            lobby["keys"][index] = secrets.token_urlsafe(6)
            save_table_state()
        return lobby["keys"][index]


def seat_taken_by_other(index, other):
    """Whether `other` seat's name is spoken for: claimed while joining, or
    anyone's once the game is under way."""
    lobby = table_state["lobby"]
    return other != index and (lobby["claimed"][other] or not lobby["active"])


def join_url(index):
    """The address in a seat's code: the PC's LAN address, which every phone can
    reach, rather than rpgtable.local, which Android does not always resolve."""
    port = request.host.rsplit(":", 1)[1] if ":" in request.host else "80"
    return f"http://{mdns.active_lan_ip()}:{port}/join/{index + 1}?k={seat_key(index)}"


@app.get("/thumb/<path:filename>")
def picture_thumbnail(filename):
    path = (BASE_DIR / filename).resolve()
    if (ROSTER_PICTURE_DIR.resolve() not in path.parents or not path.is_file()
            or path.suffix.lower() not in ROSTER_PICTURE_EXTENSIONS):
        abort(404)
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return send_file(path)
    key = (str(path), path.stat().st_mtime_ns)
    with thumb_lock:
        data = thumb_cache.get(key)
    if data is None:
        with Image.open(path) as image:
            image = ImageOps.exif_transpose(image).convert("RGB")
            image.thumbnail((THUMB_EDGE, THUMB_EDGE))
            buffer = io.BytesIO()
            image.save(buffer, "WEBP", quality=80)
            data = buffer.getvalue()
        with thumb_lock:
            thumb_cache[key] = data
    return Response(data, mimetype="image/webp")


@app.get("/join/<int:seat>")
def join_page(seat):
    player_index(seat - 1)
    return render_template("join.html", seat=seat)


@app.get("/api/lobby")
def get_lobby():
    return jsonify({"ok": True, **lobby_payload()})


@app.post("/api/lobby/start")
def start_lobby():
    """A new game: every seat back to its default name with no deck, and a
    fresh code for each. The seats keep their lights."""
    global names_revision
    with state_lock:
        for index, player in enumerate(table_state["players"]):
            player["name"] = DEFAULT_PLAYERS[index]["name"]
            apply_deck_details(player, {"deck": "", "background_focus": "", **{key: "" for key in PLAYER_PICTURE_KEYS}})
            player.update(two_commanders=False, commander_name="", second_commander_name="",
                          commander_sound="", second_commander_sound="", announcer_sound="")
        table_state["lobby"] = {"active": True, "keys": [secrets.token_urlsafe(6) for _ in range(PLAYER_COUNT)],
                                "claimed": [False] * PLAYER_COUNT, "revision": 0}
        bump_lobby()
        names_revision += 1
        save_table_state()
    return ok("Waiting for everyone to scan their code", lobby=lobby_payload(), players=players_payload())


@app.post("/api/lobby/end")
def end_lobby():
    with state_lock:
        table_state["lobby"]["active"] = False
        bump_lobby()
        save_table_state()
    return ok("Seats closed", lobby=lobby_payload())


@app.get("/api/lobby/qr/<int:seat>.svg")
def lobby_qr(seat):
    import segno

    index = player_index(seat - 1)
    buffer = io.BytesIO()
    segno.make(join_url(index), error="m").save(buffer, kind="svg", scale=10, border=2,
                                                 dark="#111", light="#fff", xmldecl=False)
    return Response(buffer.getvalue(), mimetype="image/svg+xml", headers={"Cache-Control": "no-store"})


@app.get("/api/join/<int:seat>")
def join_details(seat):
    index = joining_seat(seat, request.args.get("k"))
    player = table_state["players"][index]
    red, green, blue = colorsys.hsv_to_rgb(player["hue"] / 360, player["saturation"] / 100, 1.0)
    lobby = table_state["lobby"]
    taken = [{"seat": other + 1, "name": table_state["players"][other]["name"]}
             for other in range(PLAYER_COUNT) if seat_taken_by_other(index, other)]
    # Mid-game the seat already has its player: the phone opens on them.
    claimed = lobby["claimed"][index] or (not lobby["active"] and bool(player["deck"]))
    return jsonify({"ok": True, "seat": seat, "claimed": claimed, "joining": lobby["active"],
                    "name": player["name"], "deck": player["deck"],
                    "color": "#{:02x}{:02x}{:02x}".format(round(red * 255), round(green * 255), round(blue * 255)),
                    "taken": taken, "catalog": seat_catalog()})


@app.post("/api/join/<int:seat>")
def claim_seat(seat):
    """A phone takes its seat: `player` with a roster `deck`, or a `new_deck`
    { name, commander, art_url, card_url } made there. A seat can be claimed
    again, to change the pick, until the next New game."""
    payload = request.get_json(force=True, silent=True) or {}
    index = joining_seat(seat, payload.get("k"))
    player = clean_seat_name(payload.get("player"))
    with state_lock:
        taken = next((other for other in range(PLAYER_COUNT) if seat_taken_by_other(index, other)
                      and table_state["players"][other]["name"].casefold() == player.casefold()), None)
    if taken is not None:
        raise ValueError(f"{player} is already at seat {taken + 1}")
    new_deck = payload.get("new_deck")
    deck = add_phone_deck(new_deck, player) if isinstance(new_deck, dict) else payload.get("deck")
    deck = dress_seat(index, player, deck)
    return ok(f"{player} is at seat {seat} with {deck}", name=player, deck=deck)


# -----------------------------
# REMOTE CONTROL: A PLAYER'S PHONE DRIVES THEIR OWN SEAT
# -----------------------------
# The table page owns the game, so a phone never changes it here: its taps are
# queued as actions, the table takes them (long-polling /api/remote/actions)
# and applies them through the same functions its own buttons use, so the
# sounds, animations, statistics and eliminations all follow. After every
# change the table posts a snapshot of the game, which the phones wait on.
REMOTE_WAIT_SECONDS = 20
REMOTE_KEEP = 200
REMOTE_COUNTER_KINDS = {"commander", "poison", "energy", "experience", "tax"}
remote_changed = threading.Condition()
remote_actions = []
remote_last_id = 0
remote_snapshot = {"version": 0, "game": None}


OVERLAY_STEPS = {"close", "continue", "save", "later", "heads", "tails", "again"}


def overlay_step(payload):
    """What to do with what the table is showing (statistics, coin, recap, result)."""
    step = payload.get("do")
    if step not in OVERLAY_STEPS:
        raise ValueError("Unknown step")
    return step


def remote_action_from_payload(index, payload):
    action = payload.get("action")
    entry = {"seat": index, "action": action}

    def whole(name, low, high):
        value = payload.get(name)
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise ValueError(f"{name} must be a whole number from {low} to {high}")
        return value

    if action == "life":
        entry["amount"] = whole("amount", -50, 50)
    elif action == "counter":
        if payload.get("kind") not in REMOTE_COUNTER_KINDS:
            raise ValueError("Unknown counter")
        entry.update(kind=payload["kind"], source=whole("source", -1, 7), amount=whole("amount", -1, 1))
    elif action in ("emblem_add", "emblem_remove"):
        emblem = str(payload.get("emblem") or "")
        if not re.fullmatch(r"[a-z0-9-]{1,80}", emblem):
            raise ValueError("Unknown emblem")
        entry["emblem"] = emblem
    elif action == "commander":
        # Cast (play) or killed (not play): the first commander, or the partner.
        entry.update(slot=whole("slot", 0, 1), play=payload.get("play") is True)
    elif action == "designation":
        if payload.get("key") not in ("monarch", "initiative", "blessing"):
            raise ValueError("Unknown designation")
        # The seat it goes to; -1 for nobody.
        entry.update(key=payload["key"], to=whole("to", -1, PLAYER_COUNT - 1))
    elif action == "out":
        # Conceded, eliminated, or back in the game: the phone has asked first.
        if payload.get("mode") not in ("out", "conceded", "back"):
            raise ValueError("Unknown way out")
        entry["mode"] = payload["mode"]
    elif action == "coin":
        # One coin, called heads or tails, or the two-coin duel.
        if payload.get("call") not in ("heads", "tails", ""):
            raise ValueError("Call heads or tails")
        entry.update(double=payload.get("double") is True, call=payload.get("call"))
    elif action == "overlay":
        entry["do"] = overlay_step(payload)
    elif action == "tax_answer":
        ask = str(payload.get("id") or "")
        if not re.fullmatch(r"[a-z0-9]{1,24}", ask):
            raise ValueError("Unknown question")
        entry.update(id_asked=ask, raise_tax=payload.get("raise") is True)
    elif action == "death_answer":
        # Lethal numbers: out, or kept in by an effect. Asked on the table too.
        ask = str(payload.get("id") or "")
        if not re.fullmatch(r"[a-z0-9]{1,24}", ask):
            raise ValueError("Unknown question")
        entry.update(id_asked=ask, out=payload.get("out") is True)
    elif action != "end_turn":
        raise ValueError("Unknown action")
    return entry


@app.post("/api/remote/<int:seat>")
def remote_action(seat):
    """A phone's tap on its own seat: life, a counter, an emblem, or the end of its turn."""
    global remote_last_id
    payload = request.get_json(force=True, silent=True) or {}
    index = joining_seat(seat, payload.get("k"))
    entry = remote_action_from_payload(index, payload)
    with remote_changed:
        remote_last_id += 1
        entry["id"] = remote_last_id
        remote_actions.append(entry)
        del remote_actions[:-REMOTE_KEEP]
        remote_changed.notify_all()
    return jsonify({"ok": True, "id": entry["id"]})


@app.get("/api/remote/actions")
def remote_pending_actions():
    """The table's long poll: actions after `after`, waiting for one if there
    are none. A table just opened (after=-1) only learns where the queue is,
    so taps made while it was closed are not played back."""
    try:
        after = int(request.args.get("after", "-1"))
    except ValueError:
        after = -1
    with remote_changed:
        if after >= 0:
            remote_changed.wait_for(lambda: remote_last_id > after, timeout=REMOTE_WAIT_SECONDS)
        pending = [entry for entry in remote_actions if after >= 0 and entry["id"] > after]
        return jsonify({"ok": True, "last": remote_last_id, "actions": pending})


@app.post("/api/remote/state")
def remote_post_state():
    """The table's snapshot of the game, for the phones."""
    payload = request.get_json(force=True, silent=True)
    if not isinstance(payload, dict) or not isinstance(payload.get("seats"), list):
        raise ValueError("A game snapshot has seats")
    with remote_changed:
        remote_snapshot["version"] += 1
        remote_snapshot["game"] = payload
        remote_changed.notify_all()
    return jsonify({"ok": True, "version": remote_snapshot["version"]})


@app.get("/api/remote/<int:seat>/state")
def remote_get_state(seat):
    """A phone's long poll: the game once it is newer than `after`."""
    joining_seat(seat, request.args.get("k"))
    try:
        after = int(request.args.get("after", "0"))
    except ValueError:
        after = 0
    with remote_changed:
        remote_changed.wait_for(lambda: remote_snapshot["version"] > after and remote_snapshot["game"] is not None,
                                timeout=REMOTE_WAIT_SECONDS)
        return jsonify({"ok": True, "version": remote_snapshot["version"], "game": remote_snapshot["game"]})


# -----------------------------
# SCREEN REMOTE: THE WHOLE TABLE ON A TABLET
# -----------------------------
# The hub's "Screen remote" QR opens /mirror on a tablet or phone: a live
# picture of the table's browser window, where every tap is played back on
# this PC as the mouse (see screen_mirror.py). Unlike the seat codes it lasts
# from game to game, so a touch display by the table scans it once; "New code"
# on the table retires it, and with it every device that scanned it.
def mirror_key():
    with state_lock:
        if not table_state["mirror_key"]:
            table_state["mirror_key"] = secrets.token_urlsafe(12)
            save_table_state()
        return table_state["mirror_key"]


def check_mirror_key(key):
    if not secrets.compare_digest(str(key or ""), mirror_key()):
        abort(403, "This screen remote code has been replaced. Scan the one on the table again")
    if not screen_mirror.AVAILABLE:
        abort(503, "The screen remote only works when the table runs on Windows")


@app.get("/mirror")
def mirror_page():
    return render_template("mirror.html")


@app.get("/api/mirror/qr.svg")
def mirror_qr():
    import segno

    port = request.host.rsplit(":", 1)[1] if ":" in request.host else "80"
    # /remote asks: table controls on the phone, or the screen mirror.
    url = f"http://{mdns.active_lan_ip()}:{port}/remote?k={mirror_key()}"
    buffer = io.BytesIO()
    segno.make(url, error="m").save(buffer, kind="svg", scale=10, border=2, dark="#111", light="#fff", xmldecl=False)
    return Response(buffer.getvalue(), mimetype="image/svg+xml", headers={"Cache-Control": "no-store"})


@app.post("/api/mirror/key/new")
def new_mirror_key():
    with state_lock:
        table_state["mirror_key"] = secrets.token_urlsafe(12)
        save_table_state()
    return ok("New screen remote code: devices with the old one are locked out")


# -----------------------------
# TABLE REMOTE: THE WHOLE TABLE FROM A PHONE
# -----------------------------
# The hub's remote code opens /remote, which asks how to drive the table:
# "Table controls" (/host), phone buttons for everything the hub does, or the
# screen mirror (/mirror). Table controls ride the same relay as the seat
# phones: actions queued here with seat -1, applied by the table page, and
# the game's snapshot back by long poll. The code is the screen remote's.
HOST_ACTIONS = {"turn_next", "turn_back", "first_player", "start_entrance", "skip_entrance", "entrance_mode",
                "cover_again", "new_game", "reset", "draw", "coin", "daytime", "clock_stop", "clock_reset",
                "turn_timer", "house_lights", "lights_follow", "resend_lights", "starting_life", "direction",
                "stats", "ask_answer", "overlay"}


def check_host_key(key):
    if not secrets.compare_digest(str(key or ""), mirror_key()):
        abort(403, "This table remote code has been replaced. Scan the one on the table again")


def host_action_from_payload(payload):
    action = payload.get("action")
    if action not in HOST_ACTIONS:
        raise ValueError("Unknown table action")
    entry = {"seat": -1, "host": True, "action": action}
    if action == "coin":
        if payload.get("call") not in ("heads", "tails", ""):
            raise ValueError("Call heads or tails")
        entry.update(double=payload.get("double") is True, call=payload.get("call"))
    elif action == "daytime":
        if payload.get("value") not in ("none", "day", "night"):
            raise ValueError("Day, night or neither")
        entry["value"] = payload["value"]
    elif action == "direction":
        if payload.get("value") not in ("cw", "ccw"):
            raise ValueError("Clockwise or counter-clockwise")
        entry["value"] = payload["value"]
    elif action == "starting_life":
        value = payload.get("value")
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 999:
            raise ValueError("Starting life is a whole number")
        entry["value"] = value
    elif action == "overlay":
        entry["do"] = overlay_step(payload)
    elif action == "ask_answer":
        ask = payload.get("ask")
        if isinstance(ask, bool) or not isinstance(ask, int) or ask < 1:
            raise ValueError("Unknown question")
        # `id` is the queue's own number; the table's question is ask_id.
        entry.update(ask_id=ask, yes=payload.get("yes") is True)
    return entry


@app.get("/remote")
def remote_choice_page():
    """What the hub's remote code opens: table controls or the screen mirror."""
    return render_template("remote.html")


@app.get("/host")
def host_page():
    return render_template("host.html")


@app.post("/api/host")
def host_action():
    global remote_last_id
    payload = request.get_json(force=True, silent=True) or {}
    check_host_key(payload.get("k"))
    entry = host_action_from_payload(payload)
    with remote_changed:
        remote_last_id += 1
        entry["id"] = remote_last_id
        remote_actions.append(entry)
        del remote_actions[:-REMOTE_KEEP]
        remote_changed.notify_all()
    return jsonify({"ok": True, "id": entry["id"]})


@app.get("/api/host/state")
def host_state():
    """The game for the table remote, once it is newer than `after`."""
    check_host_key(request.args.get("k"))
    try:
        after = int(request.args.get("after", "0"))
    except ValueError:
        after = 0
    with remote_changed:
        remote_changed.wait_for(lambda: remote_snapshot["version"] > after and remote_snapshot["game"] is not None,
                                timeout=REMOTE_WAIT_SECONDS)
        return jsonify({"ok": True, "version": remote_snapshot["version"], "game": remote_snapshot["game"]})


@app.get("/api/host/seats")
def host_seats():
    """Each seat's own controls, for the table remote to open: its join page and code."""
    check_host_key(request.args.get("k"))
    return jsonify({"ok": True, "seats": [{"seat": index + 1, "url": f"/join/{index + 1}?k={seat_key(index)}"}
                                         for index in range(PLAYER_COUNT)]})


@app.post("/api/mirror/page")
def mirror_page_size():
    """The table page's visible size in physical pixels, so the screen remote
    shows the page alone and not the browser's tabs and address bar."""
    payload = request.get_json(force=True, silent=True) or {}
    width, height = payload.get("width"), payload.get("height")
    if not all(isinstance(value, int) and not isinstance(value, bool) and 100 <= value <= 10000
               for value in (width, height)):
        raise ValueError("A page size is two whole numbers of pixels")
    screen_mirror.set_page_size(width, height)
    return jsonify({"ok": True})


@app.get("/api/mirror/frame.jpg")
def mirror_frame():
    """The table screen as it is now, or 204 when it is the picture with crc `since`."""
    check_mirror_key(request.args.get("k"))
    try:
        width = int(request.args.get("w", "1280"))
        since = int(request.args["since"]) if request.args.get("since") else None
    except ValueError:
        raise ValueError("w and since are whole numbers")
    try:
        crc, jpeg, rect, found = screen_mirror.frame(width, since)
    except OSError:
        abort(503, "The table screen cannot be seen: is the PC locked or asleep?")
    headers = {"Cache-Control": "no-store", "X-Frame": str(crc), "X-Table-Found": "1" if found else "0",
               "X-Region": f"{rect[2] - rect[0]}x{rect[3] - rect[1]}"}
    if jpeg is None:
        return Response(status=204, headers=headers)
    return Response(jpeg, mimetype="image/jpeg", headers=headers)


@app.post("/api/mirror/input")
def mirror_input():
    """Taps, drags, scrolls and typing from the tablet, played on this PC in order."""
    payload = request.get_json(force=True, silent=True) or {}
    check_mirror_key(payload.get("k"))
    events = payload.get("events")
    if not isinstance(events, list) or len(events) > 100:
        raise ValueError("Send up to 100 screen remote events")
    screen_mirror.play(events)
    return jsonify({"ok": True})


@app.post("/api/players/<index>/seat")
def seat_player(index):
    """The lights page's Load: a player and one of the leaderboard's decks."""
    payload = request.get_json(force=True, silent=True) or {}
    index = player_index(index)
    player = clean_seat_name(payload.get("player"))
    deck = dress_seat(index, player, payload.get("deck"))
    return ok(f"{player} plays {deck} at seat {index + 1}", player=player_payload(index),
              players=players_payload())


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


@app.post("/api/players/<index>/name")
def set_player_name(index):
    """Rename one seat from the lights page; the tracker picks it up on its next poll."""
    global names_revision
    payload = request.get_json(force=True, silent=True) or {}
    index = player_index(index)
    name = re.sub(r"\s+", " ", str(payload.get("name") or "")).strip()[:18]
    if not name:
        raise ValueError("Give the player a name")

    with state_lock:
        table_state["players"][index]["name"] = name
        names_revision += 1
        save_table_state()
    return ok(f"Renamed to {name}", player=player_payload(index))


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

    return ok("; ".join(notes) or "No change", **{**shared_table_state(), "players": players_payload()})


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


def connect_strip_device():
    """Find and connect the LED strip, then light it for the current room."""
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
    return label


@app.post("/api/strip/connect")
def connect_strip():
    label = connect_strip_device()
    return ok(f"LED strip connected: {label}", label=label)


# ---------- AUTOMATIC LIGHT SETUP ----------
# On startup the bulbs are placed by the nickname they have in the Tapo app
# (case ignored, matched anywhere in the name), so a bulb that has picked up a
# new IP from the router still lands in its own position. Set
# MTG_AUTO_LIGHTS=0 to skip this and keep the saved positions.
BULB_NICKNAMES = {
    "stanza": "center",
    "armadio": "top_left",
    "lampada": "bottom_right",
}


def auto_lights_enabled():
    return os.environ.get("MTG_AUTO_LIGHTS", "1").strip() != "0"


def auto_assign_bulbs():
    """Discover the bulbs and put each named one in its position.

    Returns {bulb_id: ip} for the positions it filled. A position whose bulb is
    not found keeps whatever it had saved, so one bulb being off does not
    unmap the others.
    """
    global discovered_bulbs
    with device_lock:
        candidates = wait_for(discovery_controller.discover_all(), timeout=90)
    discovered_bulbs = {item["ip"]: item for item in candidates}

    placed = {}
    for item in candidates:
        name = str(item.get("name") or "").casefold()
        for keyword, bulb_id in BULB_NICKNAMES.items():
            if keyword in name and bulb_id not in placed:
                placed[bulb_id] = item["ip"]
                break
    if not placed:
        names = ", ".join(f"{item.get('name')} ({item['ip']})" for item in candidates)
        print(f"Lights: no bulb nicknames matched {', '.join(BULB_NICKNAMES)} — found {names}", flush=True)
        return placed

    with state_lock:
        # The same physical bulb must never sit in two positions: a saved
        # position still holding an IP that has just been placed elsewhere
        # lets go of it.
        for bulb_id, controller in bulbs.items():
            if bulb_id not in placed and controller.current_ip in placed.values():
                controller.clear_ip()
        for bulb_id, ip in placed.items():
            bulbs[bulb_id].set_ip(ip)
        save_table_state()
    for bulb_id in BULB_NAMES:
        where = placed.get(bulb_id)
        print(f"Lights: {BULB_NAMES[bulb_id].lower()} bulb "
              f"{'-> ' + where if where else 'not found, kept ' + (bulbs[bulb_id].current_ip or 'unassigned')}",
              flush=True)
    return placed


def auto_connect_lights():
    """Startup job: place the bulbs by nickname, then connect the LED strip."""
    try:
        placed = auto_assign_bulbs()
    except Exception as error:
        placed = {}
        print(f"Lights: bulb discovery failed ({error}); keeping the saved positions", flush=True)

    try:
        # Lights the whole room for the current player (or the house lights)
        # once it is connected, so the bulbs placed above are covered too.
        label = connect_strip_device()
        print(f"Lights: LED strip connected: {label}", flush=True)
        return
    except Exception as error:
        print(f"Lights: LED strip not connected ({error})", flush=True)

    # No strip to light the room through: give the newly placed bulbs their
    # colors directly.
    if placed:
        try:
            if house_lights:
                apply_house_lights()
            else:
                apply_player_lighting(table_state["current_player"], fade=False)
        except Exception as error:
            app.logger.warning("Could not light the newly placed bulbs: %s", error)


def start_auto_lights():
    if auto_lights_enabled():
        threading.Thread(target=auto_connect_lights, name="auto-lights", daemon=True).start()


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
    save_before_stopping()
    threading.Timer(0.5, stop_process).start()
    return ok("Server stopping. This page will go offline until you start it again.")


@app.post("/api/restart")
def restart_server():
    """Stop the server and start it again, the same way it was started.

    The new copy starts straight away but waits for this one to let go of the
    port before it serves (see wait_for_previous_server), so it reads the
    table and results this one has just saved. Pages are offline for the few
    seconds in between.
    """
    save_before_stopping()
    try:
        subprocess.Popen([sys.executable, *sys.argv], cwd=STARTUP_DIR, env={**os.environ, RESTART_ENV: "1"})
    except OSError as error:
        raise ValueError(f"Could not start a new server: {error}") from None
    threading.Timer(0.5, stop_process).start()
    return ok("Server restarting. Pages will be back in a few seconds.")


def save_before_stopping():
    try:
        save_table_state()
        with history_lock:
            save_game_history()
    except Exception:
        app.logger.exception("Could not save the table before stopping")


def stop_process():
    # os._exit skips atexit handlers, so withdraw the mDNS name by hand -
    # leaving it advertised would point phones at a port nobody answers.
    mdns.unregister()
    os._exit(0)


def wait_for_previous_server(host, port, timeout=20):
    """On a copy started by a restart, wait until the old copy has let go of
    the port, and report whether this copy is one. Windows would let both hold
    the port at once (see the README), with the old one still answering."""
    if not os.environ.pop(RESTART_ENV, None):
        return False
    probe_host = "127.0.0.1" if host in ("0.0.0.0", "") else host
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with socket.socket() as probe:
            probe.settimeout(0.3)
            if probe.connect_ex((probe_host, port)) != 0:
                break
        time.sleep(0.2)
    return True


load_table_state()
load_game_history()


if __name__ == "__main__":
    print("MTG table display:  http://127.0.0.1:5001/")
    print("Light controls:     http://127.0.0.1:5001/lights")
    print("On your phone, use http://rpgtable.local:5001 while on the same Wi-Fi")
    wait_for_previous_server("0.0.0.0", 5001)
    mdns.register(5001)
    start_drive_sync()
    start_auto_lights()
    try:
        app.run(host="0.0.0.0", port=5001, threaded=True)
    finally:
        mdns.unregister()
