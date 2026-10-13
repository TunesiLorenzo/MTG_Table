"""Turn lighting: crossfades between player colors, per-light effects, and cues.

Every light — the three bulbs and the table LED — carries its own color (or a
white temperature) and its own effect, and a turn change hands all of them over
at once. Four kinds of animation exist:

  * the crossfade, which moves the solid lights from the previous player's
    colors to this player's,
  * effects painted here, a frame at a time, for lights that cannot run their
    own,
  * effects a device can run by itself, which are handed over once and then left
    alone. The BLE strip is the reason: a frame at a time over Bluetooth arrives
    late and unevenly, so anything fast — a flicker above all — reads as jitter,
    while its own chip animates at a steady rate for free, and
  * cues: a moment of the game — a hit, a commander reveal, the entrance — that
    takes some lights over for a few seconds and then hands each one back to
    whatever its plan has it doing by then. See play_cue.

Fades, painted effects and cues share one painter thread, because two writers
on one light fight: run apart, the older write can land last and strand a light
on a half-faded color. See _run_painter.

Fades and effects are replaced by the next plan, so a fast sequence of turn
changes always ends on the newest player's lighting. A cue plays on over a turn
change and then lands on the new player's plan.

A light's value is (hue, saturation, brightness, temperature). `temperature` is
None for a color, or a kelvin value for white; a white also carries the hue and
saturation that approximate it, so devices with no white channel and every
crossfade keep working without a special case.
"""

import colorsys
import math
import threading
import time
from concurrent.futures import CancelledError

# Tapo bulbs are driven over the network; ~8 updates a second is as fast as a
# crossfade can usefully push them. The BLE strip is slower still. Each is the
# pause a light gets, after answering one frame of a fade or an effect, before
# it is sent the next.
BULB_STEP_SECONDS = 0.12
STRIP_STEP_SECONDS = 0.2
# A cue is a moment, not a mood: its frames go out as soon as the light has
# answered the one before. The strip answers within a few tens of milliseconds,
# which is what lets it follow a spin or ease smoothly through a fade.
CUE_STEP_SECONDS = 0.05
# How often the painter looks for a light that is ready for its next frame.
# Nothing is written this often — a light is only sent a frame once it has
# answered the last one — so this only bounds how long a ready light waits.
PAINT_TICK_SECONDS = 0.03

# Every write is timed. A cue step whose moment is known in advance — the end
# of a card flip, the last click of the spin — is sent this share of the
# light's usual round trip early, so it lands on the moment rather than a round
# trip after it: a bulb changes while it handles the request, just before it
# answers.
LEAD_FACTOR = 0.85
LEAD_SECONDS_MAX = 0.6
# What to assume about a light before its first write has been timed.
BULB_LATENCY_DEFAULT = 0.25
STRIP_LATENCY_DEFAULT = 0.05
# A reconnect can take a second or more; one of those must not convince the
# painter that every later step needs sending that early.
LATENCY_SAMPLE_MAX = 1.0
LATENCY_WEIGHT = 0.3

# A light that did not take a write is left alone a little longer after each
# miss, so an unplugged bulb is not hammered every frame.
RETRY_SECONDS_MIN = 0.5
RETRY_SECONDS_MAX = 5.0
# A light that only needs putting back on its color — after a fade, a cue, or
# a turn change it missed — is given up on after this many misses in a row;
# Resend lights is there for the rest.
SETTLE_ATTEMPTS = 3
# The two ends of a swap change together, so one waits for the other to be
# free, but not for longer than this on a partner that has stopped answering.
SYNC_WAIT_SECONDS = 1.0
# A cue step shorter than this goes to the strip without its safety copy: the
# next step replaces it before a lost packet could matter, and the copy would
# only hold that next step back.
TRANSIENT_STEP_SECONDS = 0.25

FADE_SECONDS_MIN = 0.2
FADE_SECONDS_MAX = 10.0
EFFECT_SECONDS_MIN = 0.4
EFFECT_SECONDS_MAX = 20.0
EFFECT_SECONDS_DEFAULT = 2.0

# How far down a pulse dims before coming back up, and how far a flicker dips.
PULSE_FLOOR = 0.2
FLICKER_FLOOR = 0.35

STRIP_ID = "strip"

# "Swap sides" trades colors between the two bulbs facing each other across the
# table, and leaves the one between them alone. These ids mirror the room laid
# out in web.py; a light with no partner here simply sits the effect out.
SWAP_PARTNERS = {"top_left": "bottom_right", "bottom_right": "top_left"}

# White is a mode a light can be in instead of a color, matching the range the
# Tapo bulbs accept on their dedicated white channel.
MODE_COLOR = "color"
MODE_WHITE = "white"
MODES = (MODE_COLOR, MODE_WHITE)
WHITE_TEMP_MIN = 2500
WHITE_TEMP_MAX = 6500
WHITE_TEMP_DEFAULT = 2700

EFFECT_NONE = "none"

# Effects are pure functions of a light's base color and the wall clock, so a
# light can join or leave one mid-run without a visible jump, and changing a
# period never makes the brightness or hue leap.
EFFECTS = (EFFECT_NONE, "pulse", "breathe", "cycle", "flicker", "blink")
EFFECT_LABELS = {
    EFFECT_NONE: "Solid",
    "pulse": "Pulse",
    "breathe": "Breathe",
    "cycle": "Swap sides",
    "flicker": "Flicker",
    "blink": "Blink",
}


def clamp(value, low, high):
    return max(low, min(high, value))


def scale_brightness(brightness, scale):
    """Dim a brightness without ever reaching zero: 0 reads as off on a bulb."""
    return max(1, int(round(brightness * scale)))


def kelvin_rgb(kelvin):
    """Approximate RGB for a color temperature (Tanner Helland's fit).

    The page draws its white pad from the same curve, so what a phone shows and
    what a strip with no white channel emits agree.
    """
    temp = clamp(float(kelvin), WHITE_TEMP_MIN, WHITE_TEMP_MAX) / 100.0
    if temp <= 66:
        red = 255.0
        green = 99.4708025861 * math.log(temp) - 161.1195681661
        blue = 0.0 if temp <= 19 else 138.5177312231 * math.log(temp - 10) - 305.0447927307
    else:
        red = 329.698727446 * (temp - 60) ** -0.1332047592
        green = 288.1221695283 * (temp - 60) ** -0.0755148492
        blue = 255.0
    return tuple(int(clamp(round(channel), 0, 255)) for channel in (red, green, blue))


def kelvin_to_hue_saturation(kelvin):
    """A white temperature as hue and saturation, for devices without a white channel."""
    red, green, blue = kelvin_rgb(kelvin)
    hue, saturation, _ = colorsys.rgb_to_hsv(red / 255.0, green / 255.0, blue / 255.0)
    return int(round(hue * 360)) % 360, int(round(saturation * 100))


def light_value(light):
    """One light's saved settings as the value the writers take."""
    brightness = int(light["brightness"])
    if light.get("mode") == MODE_WHITE:
        temperature = int(light.get("temperature", WHITE_TEMP_DEFAULT))
        hue, saturation = kelvin_to_hue_saturation(temperature)
        return (hue, saturation, brightness, temperature)
    return (int(light["hue"]), int(light["saturation"]), brightness, None)


def builtin_speed(seconds):
    """A period in seconds as a device's own 1-100 speed dial, 100 being fastest.

    Log spacing, so the dial does not spend most of its travel on the fastest
    couple of seconds.
    """
    seconds = clamp(float(seconds or EFFECT_SECONDS_DEFAULT), EFFECT_SECONDS_MIN, EFFECT_SECONDS_MAX)
    span = math.log(EFFECT_SECONDS_MAX / EFFECT_SECONDS_MIN)
    fraction = 1.0 - math.log(seconds / EFFECT_SECONDS_MIN) / span
    return max(1, int(round(clamp(fraction, 0.0, 1.0) * 100)))


def effect_frame(effect, base, seconds, now, partner=None):
    """The value a light shows at time `now`, given its base value.

    `partner` is the value the light across the table is holding, which only
    "swap sides" uses.
    """
    hue, saturation, brightness, temperature = base
    seconds = clamp(float(seconds or EFFECT_SECONDS_DEFAULT), EFFECT_SECONDS_MIN, EFFECT_SECONDS_MAX)
    # Phase comes from the wall clock rather than a step count, so a slow device
    # falls behind in smoothness only, never in timing.
    phase = (now % seconds) / seconds
    wave = 0.5 - 0.5 * math.cos(2.0 * math.pi * phase)
    swell = (hue, saturation, scale_brightness(brightness, 0.6 + 0.4 * wave), temperature)

    if effect == "pulse":
        return (hue, saturation,
                scale_brightness(brightness, PULSE_FLOOR + (1.0 - PULSE_FLOOR) * wave), temperature)
    if effect == "breathe":
        # Same shape as a pulse but shallower, for a light you still want to see by.
        return swell
    if effect == "cycle":
        # Swap sides: the two bulbs facing each other trade colors and trade
        # back. Each holds a color for half the period and then changes straight
        # over — no blend through the colors in between, which on a red and a
        # blue would put both of them on magenta on the way past. Both ends read
        # the same phase, so they change together. A light with nobody to trade
        # with — the bulb between them, or the strip — holds what it has.
        if partner is None:
            return base
        return base if phase < 0.5 else partner
    if effect == "blink":
        return (hue, saturation, brightness if phase < 0.5 else 1, temperature)
    if effect == "flicker":
        # Three waves that never line up read as a candle, and need no state.
        wobble = (0.55 * math.sin(2.0 * math.pi * phase)
                  + 0.30 * math.sin(2.0 * math.pi * phase * 2.7 + 1.3)
                  + 0.15 * math.sin(2.0 * math.pi * phase * 5.3 + 2.1))
        return (hue, saturation,
                scale_brightness(brightness, clamp(0.72 + 0.28 * wobble, FLICKER_FLOOR, 1.0)), temperature)
    return base


def hsv_to_rgb255(hue, saturation):
    """Full-value RGB for a hue/saturation pair; brightness is sent separately."""
    red, green, blue = colorsys.hsv_to_rgb(hue / 360.0, saturation / 100.0, 1.0)
    return int(red * 255), int(green * 255), int(blue * 255)


def blend(start, end, amount):
    """Interpolate two light values around the hue circle."""
    if amount >= 1.0:
        return end
    start_hue, start_sat, start_bri, start_temp = start
    end_hue, end_sat, end_bri, end_temp = end

    # Take the short way round, so red -> magenta does not sweep through green.
    delta = (end_hue - start_hue) % 360
    if delta > 180:
        delta -= 360

    # Two whites cross-fade along the temperature dial. Anything else travels in
    # color, using the stand-in hue of whichever end is white, and only becomes
    # a real white on the last frame — which `amount >= 1` above returns whole.
    temperature = None
    if start_temp is not None and end_temp is not None:
        temperature = int(round(start_temp + (end_temp - start_temp) * amount))

    return (
        # Round first, then wrap, so 359.9 lands on 0 rather than 360.
        int(round(start_hue + delta * amount)) % 360,
        int(round(start_sat + (end_sat - start_sat) * amount)),
        max(1, int(round(start_bri + (end_bri - start_bri) * amount))),
        temperature,
    )


# ------------------------------------------------------------------ cues --
# A cue is a few seconds of choreography for some of the lights. Each light it
# takes gets a Track: (seconds, step) pairs, and the moment it lets go. A step
# says what the light shows from its time until the next step:
PLAN = ("plan",)   # whatever its plan has it doing, as if there were no cue
DARK = ("dark",)   # the strip black; a bulb down to its dimmest, never off

# How the painter marks a write that restarts the strip's own effect, rather
# than setting a color; and one that only changes that effect's brightness,
# leaving it running.
_CHIP = "chip"
_CHIP_DIM = "chip-dim"


def _is_light_value(value):
    """A (hue, saturation, brightness, temperature) value, not a chip command."""
    return value is not None and not isinstance(value[0], str)


def solid(value):
    """A step holding one fixed value."""
    return ("solid", value)


def dimmed(factor):
    """A step holding the light's plan color at a fraction of its brightness."""
    return ("dim", float(factor))


def animated(effect, value, seconds, offset=0.0):
    """A step running one of the effects above on a value of the cue's own.

    `offset` moves the effect's clock, so lights running the same effect do not
    move in lockstep.
    """
    return ("effect", effect, value, float(seconds), float(offset))


def plan_dimmed(factor, seconds):
    """A step keeping every light on its plan, eased down to a fraction of its
    brightness over `seconds`: effects keep running, only dimmer, and a strip
    running its own effect is dimmed on the chip rather than stopped. A track
    ending on this eases back up to full over its fade_out."""
    return ("plan_dim", float(factor), float(seconds))


def faded(step, seconds):
    """Another step, eased into over `seconds` from whatever the light was
    showing as it began, instead of switched to at once."""
    return ("fade", step, float(seconds))


class Track:
    """One light's part in a cue: its steps, and when it lets go of the light.

    `fade_out` is how long the light then takes to ease back to its plan; zero
    hands it straight back.
    """

    def __init__(self, steps, end, fade_out=0.0):
        self.steps = sorted(steps, key=lambda step: step[0])
        self.end = float(end)
        self.fade_out = float(fade_out)

    def step_at(self, elapsed):
        """The step in force `elapsed` seconds in, as (index, start, step, next start).

        The step is None before the first one: until then the light keeps its
        plan. The next start is None after the last step.
        """
        index, start, current, following = None, None, None, None
        for position, (at, step) in enumerate(self.steps):
            if at > elapsed:
                following = at
                break
            index, start, current = position, at, step
        return index, start, current, following


class Cue:
    """Tracks for some of the lights, played together. See TurnLighting.play_cue.

    `priority` settles which cue a light follows when two want it. `group`
    names the cue for release(). `compensate` sends every step early by the
    light's measured round trip, so it lands on its moment: right for
    choreography timed to something on screen, pointless for a reaction to a
    press, which cannot be sent before it happens.
    """

    def __init__(self, tracks, group, priority, compensate=False):
        self.tracks = tracks
        self.group = group
        self.priority = priority
        self.compensate = compensate


class _Playing:
    """A track in progress on one light."""

    def __init__(self, track, began, cue):
        self.track = track
        self.began = began
        self.group = cue.group
        self.priority = cue.priority
        self.compensate = cue.compensate
        # release() can bring this forward; the track itself is never changed.
        self.end = track.end
        # Painter-only state for easing: the last value worked out for the
        # light, the fade step in progress and where it started, and where the
        # ease back to the plan started.
        self.shown = None
        self.fade_index = None
        self.fade_from = None
        self.release_from = None

    @property
    def over(self):
        """Seconds into the track at which the light is fully back on its plan."""
        return self.end + self.track.fade_out


class TurnLighting:
    """Owns every write to the lights that happens on a turn change or a cue."""

    def __init__(self, resolve_device, device_lock, logger=None):
        # resolve_device(device_id) -> controller, or None when unconfigured.
        self.resolve_device = resolve_device
        self.device_lock = device_lock
        self.logger = logger

        self._state_lock = threading.Lock()
        # Device id -> the light's base value: what its plan has it showing. For
        # a light running an effect this stays the value the effect swings
        # around, not the frame last written; mid-fade it is where the fade has
        # got to; under a cue it is what the cue hands the light back to.
        self._colors = {}
        # Device id -> (effect name, period in seconds) for lights animated here.
        self._effects = {}
        # Device id -> the effect request a device is running on its own, kept so
        # an unchanged plan does not restart it mid-swing.
        self._delegated = {}
        # Device id -> (start value, end value, when it began, how long) while a
        # crossfade is in flight.
        self._fades = {}
        # The last value each device is known to have taken, so a light that is
        # not actually moving — a swap with no partner, a finished fade, a held
        # flash — costs no traffic at all.
        self._painted = {}
        # Device id -> the track it is playing, for lights a cue has taken.
        self._cues = {}
        # Device id -> misses so far, for lights the painter still has to put
        # back on their plan: after a cue lets go, a fade ends, or a plan's own
        # write did not land.
        self._settling = {}
        # Lights set by hand on the lights page since a plan last drove them. A
        # cue leaves them alone: handing one back "as it was" would undo the hand.
        self._manual = set()
        # Whether any plan has been laid out since the server started. Until
        # then nothing is known about what the lights show.
        self._laid_out = False
        # Device id -> a count bumped whenever what this class believes about
        # that light is reset: a new plan, a resend, a hand on it. A frame
        # worked out before a bump is stale and is not sent, and a write sent
        # before one is not trusted when it answers. Per light, so a turn change
        # does not unsettle the lights a cue is busy with.
        self._epochs = {}
        # Per device: a write on its way, when it went, when the light last
        # answered, when to try again after a miss, misses in a row, and how
        # long the light usually takes to answer.
        self._inflight = set()
        self._sent_at = {}
        self._answered_at = {}
        self._retry_at = {}
        self._misses = {}
        self._latency = {}

        # One thread paints every repeating write. See _run_painter.
        self._painter_stop = threading.Event()
        self._painter_thread = None
        # Set to have the painter look again at once instead of at its next tick.
        self._wake = threading.Event()

        # One plan at a time. Laying a plan out involves slow writes, and two
        # turn changes arriving together used to interleave them — the strip
        # ending up on one player while the bulbs were on the next. A plan that
        # is already stale by the time it gets the lock steps aside.
        self._plan_lock = threading.Lock()
        self._plan_generation = 0

    # ------------------------------------------------------------- helpers --

    def _log(self, message, *args):
        if self.logger:
            self.logger.warning(message, *args)

    def available(self, targets):
        return [device for device in targets if self.resolve_device(device) is not None]

    def color_of(self, device_id):
        with self._state_lock:
            return self._colors.get(device_id)

    def effect_of(self, device_id):
        with self._state_lock:
            entry = self._effects.get(device_id)
        return entry[0] if entry else EFFECT_NONE

    def forget_effects(self, *device_ids):
        """Drop what we believe a device is showing or running.

        Something outside a turn change touched it — a manual color, a power
        switch, a reconnect — so the next plan has to send its effect again
        rather than assume it is still running, and the painter has to write it
        again rather than assume its last frame is still on the light.
        """
        with self._state_lock:
            for device_id in device_ids:
                self._delegated.pop(device_id, None)
                self._painted.pop(device_id, None)
            # A write already on its way was decided before this; when it
            # answers, it must not be taken as what the light now shows.
            self._bump(device_ids)

    def _bump(self, device_ids):
        """Mark what is known about these lights as reset. Under _state_lock."""
        for device_id in device_ids:
            self._epochs[device_id] = self._epochs.get(device_id, 0) + 1

    # -------------------------------------------------------------- writing --

    def _send_value(self, controller, device_id, value, reliable=True, barrier=None):
        """Start one write to one light; returns the controller's future.

        `value` is a light value, or (_CHIP, request) to restart the strip's own
        effect. `reliable` is the strip's safety copy (see bledom_led), and
        `barrier` holds a bulb's request until its swap partner's is ready too.
        """
        if value[0] == _CHIP:
            return controller.apply_effect(*value[1])
        if value[0] == _CHIP_DIM:
            return controller.apply_effect_brightness(value[2], reliable=reliable)
        hue, saturation, brightness, temperature = value
        if device_id == STRIP_ID:
            red, green, blue = hsv_to_rgb255(hue, saturation)
            return controller.apply_color(red, green, blue, brightness, reliable=reliable)
        if temperature is not None:
            # A bulb has a real white channel, and its whites look far better
            # than the same temperature mixed out of RGB.
            return controller.apply_white(temperature, brightness, sync_barrier=barrier)
        return controller.apply_hsv(hue, saturation, brightness, sync_barrier=barrier)

    def _write(self, colors):
        """Put a plan's values on its lights now, and wait for them to land.

        This is the plan's own path, so a turn change with no fade has landed by
        the time apply_plan returns. The controllers hand back futures, so the
        lights are written in parallel and waited on once.

        Each value becomes that light's base color straight away, whether or not
        the light takes it: the base is what the light should be showing. A
        light that misses its write is handed to the painter to retry (see
        _settling), which is how one dropped write no longer leaves a light out
        of step until its color next happens to change. A light a cue has taken
        is not written at all; its new base is what the cue hands it back to.

        Returns the devices that took their value.
        """
        with self._state_lock:
            self._colors.update(colors)
            direct = {device: color for device, color in colors.items() if device not in self._cues}
            # Anything the painter worked out from the old bases is stale now.
            self._bump(direct)
            epochs = {device: self._epochs[device] for device in direct}

        futures = []
        with self.device_lock:
            for device_id, color in direct.items():
                controller = self.resolve_device(device_id)
                if controller is None:
                    continue
                try:
                    started = time.monotonic()
                    future = self._send_value(controller, device_id, color)
                    future.add_done_callback(
                        lambda done, device=device_id, began=started: self._timed(device, began, done))
                    futures.append((device_id, future))
                except Exception:
                    self._log("Could not send a color to %s", device_id)

            written, missed = set(), set()
            for device_id, future in futures:
                try:
                    future.result(timeout=20)
                    written.add(device_id)
                except Exception:
                    missed.add(device_id)
                    self._log("%s did not accept a color in time", device_id)

        with self._state_lock:
            for device in written:
                if self._epochs.get(device) == epochs[device]:
                    self._painted[device] = direct[device]
            for device in missed:
                self._painted.pop(device, None)
                self._settling.setdefault(device, 0)
        if missed:
            self._ensure_painter()
        return written

    def _timed(self, device_id, started, future):
        """Fold a finished write's round trip into that light's average.

        Runs on the light's own thread, so it takes only _state_lock: the plan
        path holds device_lock while it waits on these same threads.
        """
        finished = time.monotonic()
        try:
            if future.exception() is not None or future.result() is False:
                # Failed, or a bulb already showing the value sent nothing.
                return
        except CancelledError:
            return
        with self._state_lock:
            self._note_latency(device_id, finished - started)

    def _note_latency(self, device_id, seconds):
        """Fold one round trip into a light's running average. Under _state_lock."""
        seconds = clamp(seconds, 0.0, LATENCY_SAMPLE_MAX)
        previous = self._latency.get(device_id)
        self._latency[device_id] = (seconds if previous is None
                                    else previous + LATENCY_WEIGHT * (seconds - previous))

    def _lead(self, device_id):
        """How early to send a light a step timed to a moment. Under _state_lock."""
        default = STRIP_LATENCY_DEFAULT if device_id == STRIP_ID else BULB_LATENCY_DEFAULT
        return min(LEAD_SECONDS_MAX, LEAD_FACTOR * self._latency.get(device_id, default))

    @property
    def latency_ms(self):
        """Device id -> its usual round trip in milliseconds, for the status page."""
        with self._state_lock:
            return {device: int(round(seconds * 1000)) for device, seconds in self._latency.items()}

    # ---------------------------------------------------------------- fading --

    def _cancel_fades(self):
        """Drop any crossfade still in flight; a new plan supersedes it."""
        with self._state_lock:
            # A new plan is a reason to paint every light at least once, whatever
            # the last frame happened to be — except the lights a cue is
            # painting, whose frames the plan does not change.
            reset = [device for device in
                     set(self._colors) | set(self._fades) | set(self._effects) | set(self._painted)
                     if device not in self._cues]
            self._fades.clear()
            for device in reset:
                # A strip's running effect is kept: the plan either leaves it
                # running or replaces it, and a dim needs to know which it is.
                if _is_light_value(self._painted.get(device)):
                    self._painted.pop(device, None)
            self._bump(reset)

    def apply_plan(self, plan, fade_seconds=0.0):
        """Point every light in `plan` at its own value and effect.

        `plan` maps a device id to {"color": value, "effect": name, "seconds":
        period}. A light left out of the plan keeps the value it has but stops
        animating, so one player's effect never outlives their turn.

        Returns how many devices were addressed. Zero is a normal outcome: the
        tracker fires this on every turn change even with no lights set up yet.
        """
        with self._state_lock:
            self._plan_generation += 1
            generation = self._plan_generation

        with self._plan_lock:
            with self._state_lock:
                superseded = generation != self._plan_generation
            if superseded:
                # A newer plan arrived while this one waited its turn. Laying
                # this one out would only be undone, and on the way past it
                # would show the table a player who is no longer up.
                return len(plan)
            return self._lay_out_plan(plan, fade_seconds)

    def _lay_out_plan(self, plan, fade_seconds):
        self._cancel_fades()
        usable = {device: item for device, item in plan.items() if self.resolve_device(device) is not None}
        with self._state_lock:
            self._laid_out = True
            # The game drives these again, so cues may use them again.
            self._manual.difference_update(usable)

        # Work the whole plan out before touching a device. Deciding what each
        # light should do is free; writing to one is not, and a crossfade that
        # only starts its clock after a slow command has gone out arrives that
        # much later — late enough, with the next turn already taken, to leave a
        # light sitting on a half-faded color.
        requests = {}
        for device, item in usable.items():
            request = self._delegation_request(device, item)
            if request is not None:
                requests[device] = request

        _, stopped = self._set_effect_state(
            {device: (item.get("effect", EFFECT_NONE), item.get("seconds", EFFECT_SECONDS_DEFAULT))
             for device, item in usable.items() if device not in requests}
        )

        animated, solid = {}, {}
        for device, item in usable.items():
            if device in requests:
                # Its chip is about to own the light; all this side keeps is the
                # base value, for the status page and for a later fade to start
                # from.
                with self._state_lock:
                    self._colors[device] = item["color"]
                continue
            target = animated if self.effect_of(device) != EFFECT_NONE else solid
            target[device] = item["color"]

        # An animated light only needs its base color moved; the painter owns
        # every write to it and picks the new base up on its next frame.
        if animated:
            with self._state_lock:
                self._colors.update(animated)

        if solid:
            self._start_fades(solid, fade_seconds)
        self._ensure_painter()

        # The fade is running by now, so these — all slow, none of them part of
        # it — cost it nothing. Lights this player does not drive are rested
        # last of all; anything in the plan is already being written above, so
        # resting it first would only flash the previous color on the way past.
        self._rest_stopped(stopped, rewritten=usable)
        self._release_delegated(keep=set(requests), rewritten=usable)
        self._send_delegated(requests, usable)
        return len(usable)

    def _start_fades(self, solid, fade_seconds):
        """Schedule the solid lights, fading the ones there is a start color for.

        A light with nowhere to fade from — never driven, or already showing the
        target — is written here and now, so a turn change with no fade still
        lands on the device before this call returns.
        """
        seconds = clamp(fade_seconds, FADE_SECONDS_MIN, FADE_SECONDS_MAX) if fade_seconds > 0 else 0.0
        began = time.monotonic()

        immediate = {}
        with self._state_lock:
            for device, end in solid.items():
                start = self._colors.get(device)
                if seconds <= 0 or start is None or start == end:
                    immediate[device] = end
                else:
                    self._fades[device] = (start, end, began, seconds)

        if immediate:
            self._write(immediate)

    # --------------------------------------------------------------- effects --

    def _delegation_request(self, device, item):
        """What to ask a device to run by itself, or None if it cannot.

        This is what keeps the BLE strip smooth: one command and its own chip
        animates at a steady rate, where a frame every fifth of a second over
        Bluetooth arrives late and unevenly — visible on any effect, and worst
        on a flicker, whose whole shape is in the timing. The cost is that the
        chip only knows its own palette, so the effect runs in the nearest color
        it has rather than the exact one picked.

        Deciding costs nothing — a capability check and some arithmetic — which
        is why it is separate from _send_delegated, the part that waits on a
        device.
        """
        controller = self.resolve_device(device)
        effect = item.get("effect", EFFECT_NONE)
        if controller is None or effect == EFFECT_NONE:
            return None
        if not hasattr(controller, "supports_effect") or not controller.supports_effect(effect):
            return None

        hue, saturation, brightness, _ = item["color"]
        return (effect, hue, saturation, builtin_speed(item.get("seconds")), brightness)

    def _send_delegated(self, requests, plan):
        """Hand each device the effect it is to run, then leave it to it.

        A device already running exactly this is left alone; re-sending would
        only restart the effect mid-swing. One that will not take the command
        falls back to being painted from here, so a strip that missed a write
        still animates.
        """
        for device, request in requests.items():
            with self._state_lock:
                if self._delegated.get(device) == request:
                    continue
                if device in self._cues:
                    # A cue has the strip, and its next frame would only stop
                    # the effect again. The painter starts it as the cue lets go.
                    self._delegated[device] = request
                    continue

            controller = self.resolve_device(device)
            try:
                if controller is None:
                    raise RuntimeError(f"{device} went away before its effect could be sent")
                with self.device_lock:
                    controller.apply_effect(*request).result(timeout=20)
            except Exception:
                self._log("Could not hand the %s effect to %s; painting it here instead",
                          request[0], device)
                item = plan.get(device, {})
                with self._state_lock:
                    self._delegated.pop(device, None)
                    self._effects[device] = (request[0], clamp(
                        float(item.get("seconds") or EFFECT_SECONDS_DEFAULT),
                        EFFECT_SECONDS_MIN, EFFECT_SECONDS_MAX))
                self._ensure_painter()
                continue

            with self._state_lock:
                self._delegated[device] = request
                self._painted[device] = (_CHIP, request)

    def _release_delegated(self, keep, rewritten=()):
        """Take back every device that is no longer running its own effect.

        A device whose chip is still animating has to be given something solid
        to stop it. Anything in `rewritten` is about to be written anyway.
        """
        with self._state_lock:
            released = [device for device in self._delegated if device not in keep]
            for device in released:
                self._delegated.pop(device)

        resting = {}
        for device in released:
            color = self.color_of(device)
            if device not in rewritten and color is not None and self.resolve_device(device) is not None:
                resting[device] = color
        if resting:
            self._write(resting)

    def set_effects(self, effects, rewritten=()):
        """Declare which lights animate: {device id: (effect name, seconds)}.

        Entries with no effect are dropped. A light that stops animating is put
        back on its base color rather than left wherever its last frame landed —
        unless it is named in `rewritten`, meaning the caller is about to set it
        itself.
        """
        wanted, stopped = self._set_effect_state(effects)
        self._rest_stopped(stopped, rewritten)
        return len(wanted)

    def _set_effect_state(self, effects):
        """Record which lights animate here; write nothing. Returns (wanted, stopped)."""
        wanted = {}
        for device, entry in effects.items():
            effect, seconds = entry
            if not effect or effect == EFFECT_NONE or effect not in EFFECTS:
                continue
            wanted[device] = (effect, clamp(float(seconds or EFFECT_SECONDS_DEFAULT),
                                            EFFECT_SECONDS_MIN, EFFECT_SECONDS_MAX))

        with self._state_lock:
            stopped = set(self._effects) - set(wanted)
            self._effects = wanted

        if wanted:
            self._ensure_painter()
        return wanted, stopped

    def _rest_stopped(self, stopped, rewritten=()):
        """Put lights that just stopped animating back on their base color."""
        resting = {}
        for device in stopped:
            if device in rewritten:
                continue
            color = self.color_of(device)
            if color is not None and self.resolve_device(device) is not None:
                resting[device] = color
        if resting:
            self._write(resting)

    # ------------------------------------------------------------------ cues --

    def play_cue(self, cue, take_room=False):
        """Hand some lights to a cue; returns the lights it took.

        A light already playing a cue of higher priority keeps it. A light set
        by hand is left alone, unless `take_room`: a show that starts the game
        and owns the whole room. Nothing is written here. The painter plays the
        tracks, and as each one ends its light goes back to whatever its plan
        has it doing by then — including a plan that changed mid-cue, which is
        how a turn passed during a cue lands on the new player.
        """
        reachable = [device for device in cue.tracks if self.resolve_device(device) is not None]
        now = time.monotonic()
        taken = []
        with self._state_lock:
            for device in reachable:
                if device in self._manual and not take_room:
                    continue
                current = self._cues.get(device)
                if (current is not None and current.priority > cue.priority
                        and now - current.began < current.over):
                    continue
                playing = _Playing(cue.tracks[device], now, cue)
                if current is not None:
                    # Carry on from what the last cue left the light showing,
                    # so a fade into this one starts there instead of jumping.
                    playing.shown = current.shown
                self._cues[device] = playing
                self._settling.pop(device, None)
                self._manual.discard(device)
                taken.append(device)
        if taken:
            self._ensure_painter()
        return taken

    def release(self, group, after=0.0):
        """Let go of the lights playing a cue from `group`, `after` seconds from now.

        For a cue with no fixed end, whose moment the tracker says is over. A
        track that eases back starts early enough to be back on the plan by
        then, and a compensated cue lets go early by each light's round trip,
        like any of its steps, so the room is back as the moment ends rather
        than after it.
        """
        now = time.monotonic()
        with self._state_lock:
            for playing in self._cues.values():
                if playing.group == group:
                    let_go = max(0.0, float(after) - playing.track.fade_out)
                    playing.end = min(playing.end, now - playing.began + let_go)
        self._wake.set()

    def cancel_cues(self, *device_ids):
        """Drop cues without putting anything back; every cue, given no ids.

        For callers about to set these lights themselves: the house lights, a
        resend, a hand on the lights page.
        """
        with self._state_lock:
            dropped = device_ids or list(self._cues)
            for device in dropped:
                self._cues.pop(device, None)
                self._settling.pop(device, None)
            self._bump(dropped)

    def taken_by_hand(self, *device_ids):
        """These lights are about to be set from the lights page. See _manual."""
        if not device_ids:
            return
        self.cancel_cues(*device_ids)
        with self._state_lock:
            self._manual.update(device_ids)

    def is_cued(self, device_id):
        with self._state_lock:
            return device_id in self._cues

    @property
    def has_laid_out(self):
        """Whether any plan has been put on the lights since the server started."""
        with self._state_lock:
            return self._laid_out

    # --------------------------------------------------------------- painting --

    def _ensure_painter(self):
        """Start the painter if there is anything to paint and none is running.

        The decision is made under the same lock the painter uses to decide it
        has nothing left to do, so a plan arriving as the painter retires always
        starts a fresh one instead of landing on a thread about to exit.
        """
        with self._state_lock:
            if not (self._fades or self._effects or self._cues or self._settling):
                return
            if self._painter_thread is not None and self._painter_thread.is_alive():
                # Look at the new work now rather than at the next tick.
                self._wake.set()
                return
            self._painter_stop = threading.Event()
            self._painter_thread = threading.Thread(
                target=self._run_painter, args=(self._painter_stop,), daemon=True, name="light-painter"
            )
            self._painter_thread.start()

    def _run_painter(self, stop):
        """Paint every light that is mid-fade, animating, playing a cue or settling.

        Fades, effects and cues share this one thread deliberately. Two writers
        on one light decide what to send from the same stale picture, and the
        older write can land last: a fade would strand a light on a half-faded
        color. With one painter there is only ever one opinion of what each
        light shows next, and a fade's frames come from the clock, so its last
        one always lands exactly on the target color.

        What it does not do is paint in lockstep. Each light is sent its next
        frame as soon as it has answered the last one (after its step pause),
        and never has more than one write on its way: a slow light gets fewer
        frames, each of them current, instead of a queue of stale ones, and it
        holds nobody else up. When every frame waited for every light, a bulb
        taking a quarter of a second set the pace for the strip as well, so the
        strip could neither flash on time nor follow a spin. The two ends of a
        swap still change together: see _pair_swaps.
        """
        try:
            while not stop.is_set():
                self._wake.clear()
                if not self._paint(time.monotonic()):
                    return
                self._wake.wait(PAINT_TICK_SECONDS)
        except Exception:
            if self.logger:
                self.logger.exception("Light painting stopped after an error")
        finally:
            with self._state_lock:
                if self._painter_thread is threading.current_thread():
                    self._painter_thread = None

    def _paint(self, now):
        """One pass: work out what each light should show, and send it to the free ones.

        Returns False once there is nothing left to paint.
        """
        with self._state_lock:
            self._advance(now)
            if not (self._fades or self._effects or self._cues or self._settling):
                # Retiring under the lock: see _ensure_painter.
                self._painter_thread = None
                return False
            epochs = dict(self._epochs)
            bases = dict(self._colors)
            fades = set(self._fades)
            effects = dict(self._effects)
            cues = dict(self._cues)
            # Settling light -> what it is to be put back on.
            settling = {device: self._rest_value(device) for device in self._settling}
            # Strip -> the effect its chip is actually running, which is what a
            # dim has to act on (a new plan's effect only starts after the cue).
            chips = {device: shown[1] for device, shown in self._painted.items()
                     if shown is not None and shown[0] in (_CHIP, _CHIP_DIM)}
            leads = {device: self._lead(device) for device in cues}

        reachable = {device for device in set(cues) | fades | set(effects) | set(settling)
                     if self.resolve_device(device) is not None}
        if set(settling) - reachable:
            # Unassigned or disconnected since: there is nothing to put back.
            with self._state_lock:
                for device in set(settling) - reachable:
                    self._settling.pop(device, None)

        frames = {}
        for device in reachable:
            frame = self._frame(device, now, bases, fades, effects, cues, settling, chips, leads)
            if frame is not None:
                frames[device] = frame
        self._dispatch(frames, effects, cues, epochs, now)
        return True

    def _advance(self, now):
        """Move time on. Under _state_lock.

        A fade's value becomes the light's base as it goes. Finished fades and
        cues hand their lights to _settling, and a settling light that already
        shows what it should, or that is being painted anyway, is done.
        """
        for device, (start, end, began, seconds) in list(self._fades.items()):
            # Driving the fade from the clock rather than a step count keeps its
            # duration honest when a device answers slowly.
            elapsed = now - began
            amount = 1.0 if elapsed >= seconds else max(0.0, elapsed / seconds)
            # Where the fade has got to is the light's color from now on: what
            # the next fade starts from, and what a cue over it hands back to.
            self._colors[device] = blend(start, end, amount)
            if amount >= 1.0:
                del self._fades[device]
                self._settling.setdefault(device, 0)

        for device, playing in list(self._cues.items()):
            if self._cue_clock(device, playing, now) >= playing.over:
                del self._cues[device]
                self._settling.setdefault(device, 0)

        for device in list(self._settling):
            if device in self._cues or device in self._fades or device in self._effects:
                # Being painted anyway, and that puts it back as well.
                del self._settling[device]
            elif self._rest_value(device) in (None, self._painted.get(device)):
                del self._settling[device]

    def _rest_value(self, device):
        """What a light shows with nothing painting it. Under _state_lock."""
        if device in self._delegated:
            request = self._delegated[device]
            shown = self._painted.get(device)
            if shown is not None and shown[0] == _CHIP_DIM and shown[1] == request:
                # The chip never stopped; only its brightness needs putting back.
                return (_CHIP_DIM, request, request[4])
            return (_CHIP, request)
        return self._colors.get(device)

    def _cue_clock(self, device, playing, now, lead=None):
        """How far into its track a light is; ahead by its lead on a compensated cue.

        Without `lead`, it is looked up, which needs _state_lock.
        """
        elapsed = now - playing.began
        if playing.compensate:
            elapsed += self._lead(device) if lead is None else lead
        return elapsed

    def _frame(self, device, now, bases, fades, effects, cues, settling, chips, leads):
        """What a light should show now, as (value, pause, reliable); None leaves it be.

        `pause` is how long the light rests after answering its last write
        before this one may go, and `reliable` asks for the strip's safety copy.
        """
        base = bases.get(device)
        if base is None:
            # Never driven since the server started, so there would be nothing
            # to hand it back to afterwards. Leave it as it is.
            return None
        playing = cues.get(device)
        if playing is not None:
            elapsed = self._cue_clock(device, playing, now, leads.get(device, 0.0))
            if elapsed >= playing.end:
                # Let go, and easing back to the plan: see Track.fade_out.
                span = playing.track.fade_out
                amount = 1.0 if span <= 0 else min(1.0, (elapsed - playing.end) / span)
                last = playing.track.steps[-1][1] if playing.track.steps else None
                if last is not None and last[0] == "plan_dim":
                    # Brightness back up on the plan itself, effects still running.
                    factor = last[1] + (1.0 - last[1]) * amount
                    playing.shown = self._plan_dim_value(device, factor, now, base, bases, effects, chips)
                    return playing.shown, CUE_STEP_SECONDS, amount >= 1.0
                target = self._plan_value(device, now, base, bases, effects)
                if playing.release_from is None:
                    playing.release_from = playing.shown if _is_light_value(playing.shown) else target
                playing.shown = blend(playing.release_from, target, amount)
                return playing.shown, CUE_STEP_SECONDS, amount >= 1.0
            index, start, step, following = playing.track.step_at(elapsed)
            if step is not None:
                value, settled = self._step_value(device, step, now, base, bases, effects,
                                                  playing, index, start, elapsed, chips)
                if value is None:
                    return None
                playing.shown = value
                until = playing.end if following is None else min(following, playing.end)
                # Frames of a fade or an effect are replaced within moments,
                # so they go without the strip's safety copy; a value that
                # holds gets it.
                return value, CUE_STEP_SECONDS, settled and until - elapsed >= TRANSIENT_STEP_SECONDS
        pause = STRIP_STEP_SECONDS if device == STRIP_ID else BULB_STEP_SECONDS
        if device in fades:
            return base, pause, True
        if device in effects:
            value = self._effect_value(device, now, bases, effects)
            return None if value is None else (value, pause, True)
        if device in settling:
            return settling[device], CUE_STEP_SECONDS, True
        return None

    def _step_value(self, device, step, now, base, bases, effects, playing, index, start, elapsed, chips):
        """The value one cue step puts on a light right now, as (value, settled).

        `settled` is False while the value is still moving — a fade on its way,
        an effect — and True once it holds.
        """
        kind = step[0]
        if kind == "plan_dim":
            _, factor, seconds = step
            amount = 1.0 if seconds <= 0 else min(1.0, max(0.0, (elapsed - start) / seconds))
            value = self._plan_dim_value(device, 1.0 - (1.0 - factor) * amount, now, base, bases, effects, chips)
            return value, amount >= 1.0
        if kind == "fade":
            _, target, seconds = step
            to_value, _ = self._step_value(device, target, now, base, bases, effects,
                                           playing, index, start, elapsed, chips)
            if to_value is None:
                return None, True
            if playing.fade_index != index:
                playing.fade_index = index
                playing.fade_from = (playing.shown if _is_light_value(playing.shown)
                                     else self._plan_value(device, now, base, bases, effects))
            amount = 1.0 if seconds <= 0 else min(1.0, max(0.0, (elapsed - start) / seconds))
            return blend(playing.fade_from, to_value, amount), amount >= 1.0
        if kind == "solid":
            return step[1], True
        if kind == "dim":
            hue, saturation, brightness, temperature = base
            return (hue, saturation, scale_brightness(brightness, step[1]), temperature), True
        if kind == "dark":
            if device == STRIP_ID:
                # Black: the one way this strip is reliably dark (bledom_led).
                return (0, 0, 0, None), True
            # A bulb switched off would need a request of its own to come back
            # on; its dimmest is one write either way.
            hue, saturation, _, temperature = base
            return (hue, saturation, 1, temperature), True
        if kind == "effect":
            _, effect, value, seconds, offset = step
            return effect_frame(effect, value, seconds, now + offset), False
        return self._plan_value(device, now, base, bases, effects), True

    def _plan_dim_value(self, device, factor, now, base, bases, effects, chips):
        """The light's plan at `factor` of its brightness (see plan_dimmed)."""
        if device in chips:
            request = chips[device]
            return (_CHIP_DIM, request, max(1, int(round(request[4] * factor))))
        hue, saturation, brightness, temperature = self._plan_value(device, now, base, bases, effects)
        return (hue, saturation, scale_brightness(brightness, factor), temperature)

    def _plan_value(self, device, now, base, bases, effects):
        """What the light's plan has it showing right now.

        A strip whose chip runs its effect counts as its plain color here, since
        restarting the chip for a moment would only be cut off again.
        """
        if device in effects:
            value = self._effect_value(device, now, bases, effects)
            return base if value is None else value
        return base

    def _effect_value(self, device, now, bases, effects):
        """An animated light's frame at `now`; None with no base to swing around."""
        base = bases.get(device)
        if base is None:
            return None
        effect, seconds = effects[device]
        partner = SWAP_PARTNERS.get(device)
        if effect == "cycle":
            partner_effect = effects.get(partner)
            if partner_effect is not None and partner_effect[0] == "cycle":
                # A two-ended swap is one animation, even though the
                # settings are stored per light. Previously each end
                # honored its own period (8.0s versus 7.6s is enough
                # to drift visibly within a few cycles). The mean is
                # symmetric, so both ends derive the same shared
                # clock without arbitrarily making one side master.
                seconds = (seconds + partner_effect[1]) / 2.0
        return effect_frame(effect, base, seconds, now, partner=bases.get(partner))

    def _dispatch(self, frames, effects, cues, epochs, now):
        """Send each light its frame, if the frame is news and the light is free."""
        with self._state_lock:
            painted = dict(self._painted)
            inflight = set(self._inflight)
            answered = dict(self._answered_at)
            retry = dict(self._retry_at)
            sent_at = dict(self._sent_at)

        changed = {device for device, frame in frames.items() if painted.get(device) != frame[0]}
        ready = {}
        for device in changed:
            value, pause, reliable = frames[device]
            if (device in inflight or now < retry.get(device, 0.0)
                    or now < answered.get(device, float("-inf")) + pause):
                continue
            ready[device] = (value, reliable)

        barriers = self._pair_swaps(ready, changed, effects, cues, inflight, retry, sent_at, now)
        if not ready:
            return
        with self.device_lock:
            with self._state_lock:
                current = {device: self._epochs.get(device, 0) for device in ready}
            for device, (value, reliable) in ready.items():
                if current[device] != epochs.get(device, 0):
                    # What this was worked out from was reset meanwhile — a new
                    # plan, a resend. It is worked out again next pass.
                    continue
                self._send(device, value, reliable, barriers.get(device), current[device])

    def _pair_swaps(self, ready, changed, effects, cues, inflight, retry, sent_at, now):
        """Keep the two ends of a swap changing together. Returns device -> barrier.

        Both ends calculate from the same phase, so both want to change on the
        same pass. One that is still busy makes the other wait for it, though
        not for longer than SYNC_WAIT_SECONDS on a partner that has stopped
        answering. When both go, their prepared Tapo requests are also held at
        a barrier until both are ready to leave; otherwise one bulb's
        connection or setup latency is visible as a late side.
        """
        barriers = {}
        for device in list(ready):
            partner = SWAP_PARTNERS.get(device)
            if (partner not in changed or device in cues or partner in cues
                    or effects.get(device, (None,))[0] != "cycle"
                    or effects.get(partner, (None,))[0] != "cycle"):
                continue
            if partner in ready:
                if device not in barriers:
                    barriers[device] = barriers[partner] = threading.Barrier(2)
                continue
            partner_stuck = (now < retry.get(partner, 0.0)
                             or (partner in inflight
                                 and now - sent_at.get(partner, now) >= SYNC_WAIT_SECONDS))
            if not partner_stuck:
                del ready[device]
        return barriers

    def _send(self, device, value, reliable, barrier, epoch):
        """Start one painter write and note it as on its way. Under device_lock."""
        controller = self.resolve_device(device)
        if controller is None:
            return
        started = time.monotonic()
        with self._state_lock:
            self._inflight.add(device)
            self._sent_at[device] = started
        try:
            future = self._send_value(controller, device, value, reliable=reliable, barrier=barrier)
        except Exception:
            with self._state_lock:
                self._inflight.discard(device)
            self._log("Could not send a color to %s", device)
            return
        future.add_done_callback(
            lambda done: self._answered(device, value, started, epoch, done))

    def _answered(self, device, value, started, epoch, future):
        """A light answered a painter write. Runs on that light's own thread.

        Only _state_lock is taken here: the plan path holds device_lock while it
        waits on these same threads, so waiting for that here could deadlock.
        """
        now = time.monotonic()
        try:
            error = future.exception()
        except CancelledError as cancelled:
            error = cancelled
        with self._state_lock:
            self._inflight.discard(device)
            self._answered_at[device] = now
            if error is None:
                self._misses.pop(device, None)
                self._retry_at.pop(device, None)
                if self._epochs.get(device, 0) == epoch:
                    # A chip effect back at its own brightness is simply that
                    # effect running, as if it had been restarted.
                    if value[0] == _CHIP_DIM and value[2] == value[1][4]:
                        value = (_CHIP, value[1])
                    self._painted[device] = value
                if _is_light_value(value) and future.result() is not False:
                    self._note_latency(device, now - started)
            else:
                misses = self._misses.get(device, 0) + 1
                self._misses[device] = misses
                self._retry_at[device] = now + min(
                    RETRY_SECONDS_MAX, RETRY_SECONDS_MIN * 2 ** min(misses - 1, 8))
                self._painted.pop(device, None)
                if device in self._settling:
                    self._settling[device] += 1
                    if self._settling[device] >= SETTLE_ATTEMPTS:
                        del self._settling[device]
        if error is not None:
            self._log("%s did not take a light change: %s", device, error)
        self._wake.set()

    @property
    def effects_running(self):
        """Device id -> effect name, whether animated here or on the device."""
        with self._state_lock:
            running = {device: effect for device, (effect, _) in self._effects.items()}
            running.update({device: request[0] for device, request in self._delegated.items()})
        return running
