"""Assemble the public leaderboard into ``_site/`` for GitHub Pages.

The published site is the ``site/`` folder plus what it reads:
``game_history.json``, the pictures and deck sounds named in
``site/roster.json``, the intro's sound named in ``site/intro.json``, the
site's overall volume in ``site/settings.json``, and the table's card
animations (``js/commander-fx.js``) for the decks' commander cards, and
the game statistics' awards and records (``js/game-stats.js``).
The life tracker goes to ``tracker/``: the table's ``index.html`` with its
stylesheet, scripts, sounds and the few pictures the page itself uses, marked
as having no table server (no lights; results go to the Google Drive inbox
or a file). Nothing else in the repository is copied, so the lights page and
any picture the roster does not mention stay off the public site.

Pictures are re-encoded on the way out. The originals are multi-megabyte PNGs
and the leaderboard shows a dozen of them at once.

    python build_site.py
    python -m http.server 8000 --directory _site
"""

import hashlib
import json
import re
import shutil
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
SITE_DIR = BASE_DIR / "site"
# A deck's sound is a file name in here, the folder the table plays them from.
SOUND_DIR = BASE_DIR / "sound" / "Commander"
# The intro's sound, picked in the editor on /public, is a file name in here.
INTRO_SOUND_DIR = BASE_DIR / "sound" / "Intro"
# The mana bursts' sounds, picked per colour in the editor on /public.
MANA_SOUND_DIR = BASE_DIR / "sound" / "Mana"
OUT_DIR = BASE_DIR / "_site"

# click.mp3 is the life tracker's own button click (sound/click.mp3), for the site's buttons.
PAGE_FILES = ("index.html", "site.css", "site.js", "click.mp3", "grimoire-leather.webp", "grimoire-paper.webp")
# Files the site shares with the table, published under the name on the left:
# the card animations the deck pages draw over each commander card, and the
# awards and records the game statistics are shown with.
SHARED_PAGE_FILES = {"commander-fx.js": "js/commander-fx.js", "game-stats.js": "js/game-stats.js"}
# index.html's own stylesheet and script. Pages caches every file for ten
# minutes and a browser reloading the page asks again only for the page itself,
# so each gets a ?v= of its contents: a new deploy is a new URL, never a stale
# stylesheet under new markup.
VERSIONED_FILES = ("site.css", "site.js", "commander-fx.js", "game-stats.js")
# The life tracker, published at tracker/ so it can be opened from a phone
# anywhere: the table's own page (index.html) with no server behind it. Its
# files keep their repository paths, which the page refers to relatively.
TRACKER_DIR = OUT_DIR / "tracker"
TRACKER_SCRIPTS = ("js/emblems.js", "js/commander-fx.js", "js/game-stats.js", "js/game-inbox.js", "js/app.js")
TRACKER_VERSIONED = ("css/style.css",) + TRACKER_SCRIPTS
TRACKER_ASSETS = ("static/coin_heads.png", "static/coin_tails.png", "Backgrounds/Sigil.jpg",
                  "Backgrounds/Commander/mtgback.jpg", "Backgrounds/Animations/Fire_trasparent.webm")
TRACKER_SOUND_TYPES = {".mp3", ".wav", ".ogg", ".m4a"}
# Longest edge, in pixels, of each published copy of a picture.
IMAGE_SIZES = {"full": 1600, "thumb": 480}
# Roster keys whose value is one picture, and those whose value is a list.
IMAGE_KEYS = ("portrait", "background", "art")
IMAGE_LIST_KEYS = ("cards",)

published = {}
published_sounds = {}


def publish_image(source):
    """Write the resized copies of one picture and return their site paths."""
    # Imported here so web.py can share the roster's key names without Pillow.
    from PIL import Image, ImageOps

    if source in published:
        return published[source]
    path = (BASE_DIR / source).resolve()
    if BASE_DIR not in path.parents or not path.is_file():
        raise SystemExit(f"site/roster.json: no such picture: {source}")
    slug = re.sub(r"[^a-z0-9]+", "-", f"{path.parent.name}-{path.stem}".lower()).strip("-")
    if any(entry["full"] == f"img/{slug}-full.webp" for entry in published.values()):
        raise SystemExit(f"site/roster.json: {source} collides with another picture named {slug}")
    entry = {}
    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
        for label, limit in IMAGE_SIZES.items():
            copy = image.copy()
            copy.thumbnail((limit, limit))
            entry[label] = f"img/{slug}-{label}.webp"
            copy.save(OUT_DIR / entry[label], "WEBP", quality=82)
    published[source] = entry
    return entry


def publish_sound(name, folder=SOUND_DIR, source="site/roster.json"):
    """Copy one sound as it is (they are small already) and return its site path.

    A deck's sound comes from sound/Commander; one from another folder is
    published under that folder's name, so the two never collide."""
    if (folder, name) in published_sounds:
        return published_sounds[(folder, name)]
    path = (folder / name).resolve()
    if path.parent != folder or not path.is_file():
        raise SystemExit(f"{source}: no such sound in {folder.relative_to(BASE_DIR).as_posix()}: {name}")
    prefix = "" if folder == SOUND_DIR else f"{folder.name.lower()}-"
    target = "sound/" + prefix + re.sub(r"[^a-z0-9]+", "-", path.stem.lower()).strip("-") + path.suffix.lower()
    if target in published_sounds.values():
        raise SystemExit(f"{source}: {name} collides with another sound named {target}")
    shutil.copy2(path, OUT_DIR / target)
    published_sounds[(folder, name)] = target
    return target


def publish_intro():
    """site/intro.json, the opening's settings, pointing at its published sound."""
    path = SITE_DIR / "intro.json"
    if not path.is_file():
        return
    intro = json.loads(path.read_text(encoding="utf-8"))
    # Unlocking the chain, the pentacle's glow, thuds and page turns.
    for key in ("chain", "sound", "thud", "page"):
        if intro.get(key):
            intro[key] = publish_sound(intro[key], INTRO_SOUND_DIR, "site/intro.json")
    (OUT_DIR / "intro.json").write_text(json.dumps(intro, ensure_ascii=False), encoding="utf-8")


def publish_mana_sounds():
    """site/mana_sounds.json, each colour's burst sound pointing at its published
    file; "" (built in) and "none" stay as they are."""
    path = SITE_DIR / "mana_sounds.json"
    if not path.is_file():
        return
    sounds = json.loads(path.read_text(encoding="utf-8"))
    for entry in sounds.values():
        if entry.get("sound") and entry["sound"] != "none":
            entry["sound"] = publish_sound(entry["sound"], MANA_SOUND_DIR, "site/mana_sounds.json")
    (OUT_DIR / "mana_sounds.json").write_text(json.dumps(sounds, ensure_ascii=False), encoding="utf-8")


def publish_settings():
    """site/settings.json, the site's overall volume, copied as it is."""
    path = SITE_DIR / "settings.json"
    if path.is_file():
        shutil.copy2(path, OUT_DIR / "settings.json")


def publish_roster():
    roster = json.loads((SITE_DIR / "roster.json").read_text(encoding="utf-8"))
    for group in ("players", "decks"):
        for entry in roster.setdefault(group, {}).values():
            for key in IMAGE_KEYS:
                if entry.get(key):
                    entry[key] = publish_image(entry[key])
            for key in IMAGE_LIST_KEYS:
                if entry.get(key):
                    entry[key] = [publish_image(source) for source in entry[key]]
    for entry in roster["decks"].values():
        if entry.get("sound"):
            entry["sound"] = publish_sound(entry["sound"])
    (OUT_DIR / "roster.json").write_text(json.dumps(roster, ensure_ascii=False), encoding="utf-8")
    return roster


def publish_page():
    """Copy the page's files, pointing index.html at this build's stylesheet and script."""
    for name in PAGE_FILES:
        shutil.copy2(SITE_DIR / name, OUT_DIR / name)
    for name, source in SHARED_PAGE_FILES.items():
        shutil.copy2(BASE_DIR / source, OUT_DIR / name)
    page = (OUT_DIR / "index.html").read_text(encoding="utf-8")
    for name in VERSIONED_FILES:
        version = hashlib.sha256((OUT_DIR / name).read_bytes()).hexdigest()[:10]
        page, count = re.subn(rf'(href|src)="{re.escape(name)}"', rf'\1="{name}?v={version}"', page)
        if count != 1:
            raise SystemExit(f"site/index.html: expected one reference to {name}, found {count}")
    (OUT_DIR / "index.html").write_text(page, encoding="utf-8")


def deck_key(name):
    """How names are matched, as web.py does: "NivMizzet" is "Niv-Mizzet"."""
    return re.sub(r"[^0-9a-z]+", "", str(name or "").casefold())


def short_commander_name(name):
    """A commander as the damage tracker labels it: "Arcades", not "Arcades, the Strategist"."""
    return str(name or "").split(",")[0].strip()[:40]


def tracker_picture(source, size="full"):
    """A picture for the tracker, from tracker/: the published copy, or "" if it is missing."""
    if not source or not isinstance(source, str) or not (BASE_DIR / source).is_file():
        return ""
    return "../" + publish_image(source)[size]


def roster_preset(name, entry):
    """What a leaderboard deck brings to a seat, as web.py's deck_details_from_roster."""
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
        "second_commander_sound": "",
        "background_image": entry.get("art") or "",
        "background_focus": entry.get("art_focus") or "",
        "commander_image": cards[0] if cards else "",
        "second_commander_image": cards[1] if two else "",
    }


PROFILE_PRESET_KEYS = (
    "two_commanders", "commander_name", "second_commander_name", "commander_sound", "second_commander_sound",
    "background_image", "background_focus", "background_zoom", "commander_image", "second_commander_image",
    "commander_fx", "second_commander_fx", "background_brightness", "commander_brightness",
)


def deck_profiles(decks):
    """The saved preset (profiles/*.json) of each leaderboard deck, by deck name.

    A profile names its deck, or is named after it (NivMizzet for Niv-Mizzet),
    or after its commander (Guff for Commodore Guff). Where two claim one
    deck the most recently saved wins, as on the table.
    """
    by_key = {deck_key(name): name for name in decks}
    found = {}
    for path in sorted((BASE_DIR / "profiles").glob("*.json")):
        try:
            profile = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            continue
        if not isinstance(profile, dict):
            continue
        deck = by_key.get(deck_key(profile.get("deck"))) or by_key.get(deck_key(path.stem))
        if not deck:
            stem = deck_key(path.stem)
            deck = next((name for name, entry in decks.items()
                         if stem and stem in deck_key(entry.get("commander"))), "")
        if not deck:
            continue
        saved = str(profile.get("saved_at") or "")
        if deck not in found or saved > found[deck][0]:
            found[deck] = (saved, profile)
    return {deck: profile for deck, (_, profile) in found.items()}


def sound_files(folder, pattern=None):
    if not folder.is_dir():
        return []
    names = [item.name for item in folder.iterdir()
             if item.is_file() and item.suffix.lower() in TRACKER_SOUND_TYPES
             and (pattern is None or pattern.fullmatch(item.name))]
    return sorted(names, key=lambda name: (len(name), name.casefold()))


def tracker_catalog():
    """tracker/catalog.json: the players and decks a seat can be set to.

    It stands in for the table server on the phone. Each deck carries its
    preset in the shape the server hands the tracker (pictures, commander
    names and sounds, card animations), the roster's details under its saved
    profile's, and the entrance announcement of the player the profile is for.
    """
    roster = json.loads((SITE_DIR / "roster.json").read_text(encoding="utf-8"))
    decks = roster.get("decks") or {}
    profiles = deck_profiles(decks)
    history = json.loads((BASE_DIR / "game_history.json").read_text(encoding="utf-8"))

    deck_list = []
    owners = {}
    for name in sorted(decks, key=str.casefold):
        entry = decks[name]
        preset = roster_preset(name, entry)
        profile = profiles.get(name, {})
        for key in PROFILE_PRESET_KEYS:
            if key in profile and profile[key] is not None:
                preset[key] = profile[key]
        # The picker's tile: the deck's art, or else its commander card.
        thumb = tracker_picture(preset["background_image"], "thumb") or tracker_picture(preset["commander_image"], "thumb")
        for key in ("background_image", "commander_image", "second_commander_image"):
            preset[key] = tracker_picture(preset[key])
        for key in ("commander_sound", "second_commander_sound"):
            if preset[key] and not (BASE_DIR / "sound" / "Commander" / preset[key]).is_file():
                preset[key] = ""
        announcers = {}
        owner = str(profile.get("name") or "").strip()
        sound = profile.get("announcer_sound")
        if owner and sound and (BASE_DIR / "sound" / "Announcer" / "Players" / sound).is_file():
            announcers[owner.casefold()] = sound
        if owner:
            owners.setdefault(owner.casefold(), []).append(name)
        deck_list.append({
            "name": name,
            "commander": entry.get("commander") or "",
            "colors": entry.get("colors") or "",
            "discontinued": entry.get("discontinued") is True,
            "thumb": thumb,
            "preset": preset,
            "announcers": announcers,
        })

    # Everyone on the roster or in a recorded game, with the decks they play:
    # the roster's list, then what they have played, then presets made for them.
    players = {}
    for name, entry in (roster.get("players") or {}).items():
        players[name.casefold()] = {"name": name, "portrait": tracker_picture(entry.get("portrait"), "thumb"),
                                    "decks": list(entry.get("decks") or [])}
    for game in history.get("games", []):
        for seat in game.get("players", []):
            player = players.setdefault(seat["name"].casefold(), {"name": seat["name"], "portrait": "", "decks": []})
            player["decks"].append(seat.get("deck", ""))
    by_key = {deck_key(name): name for name in decks}
    for key, player in players.items():
        wanted = player["decks"] + owners.get(key, [])
        known = []
        for deck in wanted:
            name = by_key.get(deck_key(deck))
            if name and name not in known:
                known.append(name)
        player["decks"] = known

    sound_dir = BASE_DIR / "sound"
    catalog = {
        "players": sorted(players.values(), key=lambda player: player["name"].casefold()),
        "decks": deck_list,
        "sounds": {
            "crowd_sounds": sound_files(sound_dir, re.compile(r"crowd_\d+\.wav", re.IGNORECASE)),
            "coin_sounds": sound_files(sound_dir, re.compile(r"coin_\d+\.(wav|mp3|ogg|m4a)", re.IGNORECASE)),
            "announcer_death": {
                "intros": sound_files(sound_dir / "Announcer" / "Base" / "Death"),
                "players": sound_files(sound_dir / "Announcer" / "Players" / "Death"),
            },
        },
    }
    (TRACKER_DIR / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=1), encoding="utf-8")
    return catalog


def publish_tracker():
    """Copy the life tracker into tracker/, marked as having no table server."""
    for name in TRACKER_VERSIONED + TRACKER_ASSETS:
        target = TRACKER_DIR / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(BASE_DIR / name, target)
    sounds = [path for path in (BASE_DIR / "sound").rglob("*")
              if path.is_file() and path.suffix.lower() in TRACKER_SOUND_TYPES]
    for path in sounds:
        target = TRACKER_DIR / path.relative_to(BASE_DIR)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)

    page = (BASE_DIR / "index.html").read_text(encoding="utf-8")
    for name in TRACKER_VERSIONED:
        version = hashlib.sha256((TRACKER_DIR / name).read_bytes()).hexdigest()[:10]
        page, count = re.subn(rf'(href|src)="{re.escape(name)}"', rf'\1="{name}?v={version}"', page)
        if count != 1:
            raise SystemExit(f"index.html: expected one reference to {name}, found {count}")
    marker = '<script src="js/emblems.js'
    if page.count(marker) != 1:
        raise SystemExit("index.html: expected one js/emblems.js script to put the static flag before")
    page = page.replace(marker, '<script>window.MTG_TABLE_STATIC = true;</script>\n  ' + marker)
    (TRACKER_DIR / "index.html").write_text(page, encoding="utf-8")
    tracker_catalog()
    return len(sounds)


def main():
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    (OUT_DIR / "img").mkdir(parents=True)
    (OUT_DIR / "sound").mkdir()
    publish_page()
    shutil.copy2(BASE_DIR / "game_history.json", OUT_DIR / "game_history.json")
    roster = publish_roster()
    publish_intro()
    publish_mana_sounds()
    publish_settings()
    tracker_sounds = publish_tracker()
    size = sum(file.stat().st_size for file in OUT_DIR.rglob("*") if file.is_file())
    print(f"Built {OUT_DIR.name}/: {len(roster['players'])} players and {len(roster['decks'])} decks "
          f"in the roster, {len(published)} pictures, {len(published_sounds)} sounds, "
          f"and the tracker with {tracker_sounds} sounds, {size / 1_000_000:.1f} MB")


if __name__ == "__main__":
    main()
