"""Assemble the public leaderboard into ``_site/`` for GitHub Pages.

The published site is the ``site/`` folder plus what it reads:
``game_history.json``, the pictures and deck sounds named in
``site/roster.json``, the intro's sound named in ``site/intro.json``, and the
site's overall volume in ``site/settings.json``.
Nothing else in the repository is copied, so the life tracker, the lights
page, the table's other sounds and any picture or sound the roster does not
mention stay off the public site.

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
PAGE_FILES = ("index.html", "site.css", "site.js", "click.mp3")
# index.html's own stylesheet and script. Pages caches every file for ten
# minutes and a browser reloading the page asks again only for the page itself,
# so each gets a ?v= of its contents: a new deploy is a new URL, never a stale
# stylesheet under new markup.
VERSIONED_FILES = ("site.css", "site.js")
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
    # The sound as it opens, the thud and the page turn.
    for key in ("sound", "thud", "page"):
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
    page = (OUT_DIR / "index.html").read_text(encoding="utf-8")
    for name in VERSIONED_FILES:
        version = hashlib.sha256((OUT_DIR / name).read_bytes()).hexdigest()[:10]
        page, count = re.subn(rf'(href|src)="{re.escape(name)}"', rf'\1="{name}?v={version}"', page)
        if count != 1:
            raise SystemExit(f"site/index.html: expected one reference to {name}, found {count}")
    (OUT_DIR / "index.html").write_text(page, encoding="utf-8")


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
    size = sum(file.stat().st_size for file in OUT_DIR.rglob("*") if file.is_file())
    print(f"Built {OUT_DIR.name}/: {len(roster['players'])} players and {len(roster['decks'])} decks "
          f"in the roster, {len(published)} pictures, {len(published_sounds)} sounds, {size / 1_000_000:.1f} MB")


if __name__ == "__main__":
    main()
