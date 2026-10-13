"""ELK-BLEDOM/Triones BLE strip control: connect, solid color, power, effects.

Ported from LightRPG's driver. Effects here are the strip's own built-in ones:
a single command puts the chip into an animation it then runs by itself. That
matters because the alternative — writing a frame at a time from Python — has
to cross a BLE link that answers late and unevenly, which any fast effect turns
into visible jitter.
"""

import asyncio
import threading
from typing import Optional, Tuple

try:
    from bleak import BleakClient, BleakScanner
except ImportError:  # pragma: no cover - surfaced as a clear error on first use
    BleakClient = None
    BleakScanner = None


BLEDOM_NAME_PARTS = ("ELK-BLEDOM", "BLEDOM")
BLEDOM_SCAN_SECONDS = 5.0
BLEDOM_CONNECT_TIMEOUT_SECONDS = 20.0
BLEDOM_WRITE_CHAR_UUID = "0000fff3-0000-1000-8000-00805f9b34fb"
BLEDOM_WHITE_BYTE = 0x10
# FFF3 is normally a write-without-response characteristic. A completed Bleak
# call therefore means Windows queued the packet, not that the controller chip
# consumed it. These inexpensive strips occasionally drop such a packet while
# remaining connected. Repeating the state-changing packet after a short gap is
# cheap, idempotent, and materially more reliable than trusting that silent
# success.
BLEDOM_RELIABLE_WRITE_COPIES = 2
BLEDOM_RELIABLE_WRITE_GAP_SECONDS = 0.06
BLEDOM_OPERATION_ATTEMPTS = 2
# Power is the one thing these controllers disagree about. Two packet forms are
# in circulation and the shorter one is eight bytes where every command this
# strip actually obeys — color, effect, brightness — is nine, so a controller
# that wants fixed-width frames drops it on the floor. Both forms go out, and
# then power-off writes black, which is what reliably makes it go dark: a color
# write is the one command this strip is known to honour. Power-on puts the last
# color back for the same reason.
BLEDOM_POWER_ON_COMMANDS = (
    bytes([0x7E, 0x04, 0x04, 0x01, 0xFF, 0x00, 0x01, 0xEF]),
    bytes([0x7E, 0x00, 0x04, 0xF0, 0x00, 0x01, 0xFF, 0x00, 0xEF]),
)
BLEDOM_POWER_OFF_COMMANDS = (
    bytes([0x7E, 0x04, 0x04, 0x01, 0x00, 0x00, 0x01, 0xEF]),
    bytes([0x7E, 0x00, 0x04, 0x00, 0x00, 0x00, 0xFF, 0x00, 0xEF]),
)
# The prefix on a color write. The color itself is what lights the strip, so
# this only has to not get in the way.
BLEDOM_POWER_ON_COMMAND = BLEDOM_POWER_ON_COMMANDS[0]

# Built-in effects, run on the strip's own chip after one "select effect"
# command. The IDs come from LightRPG, which carries them over from the wider
# reverse-engineered ELK-BLEDOM/Triones protocol family (documented by projects
# such as the "elkbledom" Home Assistant integration) that this module's
# power-on and color commands already match.
BLEDOM_EFFECT_SPEED_MIN = 1
BLEDOM_EFFECT_SPEED_MAX = 100
BLEDOM_EFFECT_SPEED_DEFAULT = 50
BLEDOM_EFFECT_BRIGHTNESS_MIN = 1
BLEDOM_EFFECT_BRIGHTNESS_MAX = 100
BLEDOM_EFFECT_BRIGHTNESS_DEFAULT = 100
BLEDOM_EFFECTS = {
    "jump_rgb": 0x87,
    "jump_rgbycmw": 0x88,
    "crossfade_rgb": 0x89,
    "crossfade_rgbycmw": 0x8A,
    "crossfade_red": 0x8B,
    "crossfade_green": 0x8C,
    "crossfade_blue": 0x8D,
    "crossfade_yellow": 0x8E,
    "crossfade_cyan": 0x8F,
    "crossfade_magenta": 0x90,
    "crossfade_white": 0x91,
    "blink_rgbycmw": 0x95,
    "blink_red": 0x96,
    "blink_green": 0x97,
    "blink_blue": 0x98,
    "blink_yellow": 0x99,
    "blink_cyan": 0x9A,
    "blink_magenta": 0x9B,
    "blink_white": 0x9C,
}

# How the table's effects map onto what the chip can do. The built-ins come in
# one flavour per named color, so an effect keeps its shape — a smooth swell or
# an abrupt switch — and lands on the closest color the chip has.
# "Swap sides" is a trade between two bulbs facing each other, so the strip —
# having nobody to trade with — is not in this table and simply holds its color.
BLEDOM_EFFECT_STYLES = {
    "pulse": "crossfade",
    "breathe": "crossfade",
    "blink": "blink",
    "flicker": "blink",
}
EFFECT_PALETTE = ((0, "red"), (60, "yellow"), (120, "green"), (180, "cyan"), (240, "blue"), (300, "magenta"))
EFFECT_WHITE_SATURATION = 15


def bledom_device_name(device) -> str:
    return (getattr(device, "name", None) or "").strip()


def bledom_device_label(device) -> str:
    name = bledom_device_name(device)
    return f"{name} ({device.address})" if name else device.address


def is_bledom_device(device) -> bool:
    name = bledom_device_name(device).upper()
    return any(part in name for part in BLEDOM_NAME_PARTS)


def build_bledom_rgb_command(red: int, green: int, blue: int, white_byte: int = BLEDOM_WHITE_BYTE) -> bytes:
    return bytes([0x7E, 0x07, 0x05, 0x03, red, green, blue, white_byte, 0xEF])


def clamp_speed(speed: int) -> int:
    return max(BLEDOM_EFFECT_SPEED_MIN, min(BLEDOM_EFFECT_SPEED_MAX, int(round(float(speed)))))


def build_bledom_effect_command(effect_id: int, speed: int = BLEDOM_EFFECT_SPEED_DEFAULT) -> bytes:
    """Build the select-built-in-effect packet."""
    return bytes([0x7E, 0x05, 0x03, max(0, min(255, int(effect_id))), clamp_speed(speed), 0xFF, 0xFF, 0x00, 0xEF])


def build_bledom_speed_command(speed: int = BLEDOM_EFFECT_SPEED_DEFAULT) -> bytes:
    """Build the standalone effect-speed packet many of these controllers want."""
    return bytes([0x7E, 0x04, 0x02, clamp_speed(speed), 0xFF, 0xFF, 0xFF, 0x00, 0xEF])


def build_bledom_brightness_command(brightness: int = BLEDOM_EFFECT_BRIGHTNESS_DEFAULT) -> bytes:
    """Build the overall-brightness packet, which only applies while an effect runs."""
    brightness = max(BLEDOM_EFFECT_BRIGHTNESS_MIN, min(BLEDOM_EFFECT_BRIGHTNESS_MAX, int(round(float(brightness)))))
    return bytes([0x7E, 0x04, 0x01, brightness, 0xFF, 0xFF, 0xFF, 0x00, 0xEF])


def nearest_effect_color(hue: float, saturation: float) -> str:
    """The built-in palette entry closest to a hue and saturation."""
    if saturation < EFFECT_WHITE_SATURATION:
        return "white"
    hue = float(hue) % 360
    return min(EFFECT_PALETTE, key=lambda entry: abs(((hue - entry[0] + 180) % 360) - 180))[1]


def builtin_effect_name(effect: str, hue: float = 0, saturation: float = 100) -> Optional[str]:
    """The on-chip effect that comes closest to one of the table's effects.

    None means the chip has nothing like it and the caller should animate the
    strip itself. The chip only knows seven colors, so an effect on the strip
    snaps to the nearest one rather than holding the player's exact color.
    """
    style = BLEDOM_EFFECT_STYLES.get(effect)
    if style is None:
        return None
    name = style if style in BLEDOM_EFFECTS else f"{style}_{nearest_effect_color(hue, saturation)}"
    return name if name in BLEDOM_EFFECTS else None


def scale_bledom_rgb(red: int, green: int, blue: int, brightness: int) -> Tuple[int, int, int]:
    """The strip has no brightness register for solid colors, so scale the RGB."""
    scale = max(0, min(100, int(brightness))) / 100
    return tuple(max(0, min(255, round(channel * scale))) for channel in (red, green, blue))


def _require_bleak():
    if BleakClient is None or BleakScanner is None:
        raise RuntimeError("Install bleak first: python -m pip install bleak")


async def write_packet(client: "BleakClient", char_uuid: str, packet: bytes, *, response: Optional[bool]) -> None:
    try:
        await client.write_gatt_char(char_uuid, packet, response=response)
    except TypeError:
        # Older bleak versions did not accept response=None cleanly.
        await client.write_gatt_char(char_uuid, packet)


async def write_packet_with_fallback(client: "BleakClient", char_uuid: str, packet: bytes) -> None:
    try:
        await write_packet(client, char_uuid, packet, response=False)
    except Exception:
        await write_packet(client, char_uuid, packet, response=True)


class BledomController:
    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run_loop, daemon=True)
        self.thread.start()

        self.device = None
        self.client = None
        # The built-in effect the chip was last told to run, or None when the
        # strip is holding a solid color.
        self.current_effect = None
        # The last color the strip was lit with, so switching it back on has
        # something to restore. Black is never remembered: that is "off".
        self.last_color = None
        # Whether the strip is powered, or None for "we have not said". A
        # controller that took a power-off will store a color and stay dark, so
        # anything that wants light has to know whether power is owed first.
        self.powered = None
        # One operation at a time. Each is several packets, and two overlapping
        # ones interleave into an order the strip was never meant to see —
        # ending on whichever color happened to land last.
        self._write_lock = asyncio.Lock()

    def _run_loop(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def run_coro(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    def is_ready(self):
        return self.client is not None and self.client.is_connected

    def scan_and_connect(self):
        return self.run_coro(self._scan_and_connect())

    def apply_color(self, red, green, blue, brightness, reliable=True):
        """Show a solid color. `reliable=False` skips the safety copy of the packet.

        That is for a frame the next one replaces within moments — a spin, the
        middle of a fade — where a lost packet does not matter and waiting out
        the copy would only hold the next frame back.
        """
        return self.run_coro(self._apply_color(red, green, blue, brightness, reliable))

    def set_power(self, enabled):
        return self.run_coro(self._set_power(enabled))

    def supports_effect(self, effect):
        """Whether the chip can run this effect itself."""
        return builtin_effect_name(effect) is not None

    def apply_effect(self, effect, hue, saturation, speed, brightness):
        """Start an effect on the strip and leave it running there.

        `speed` is the chip's own 1-100 dial rather than a period: the caller
        knows how fast it wants the effect, the chip owns the timing from then
        on, and nothing needs to be sent again until the effect changes.
        """
        return self.run_coro(self._apply_effect(effect, hue, saturation, speed, brightness))

    def apply_effect_brightness(self, brightness, reliable=True):
        """Dim or brighten the effect the chip is running, without restarting it."""
        return self.run_coro(self._apply_effect_brightness(brightness, reliable))

    async def _apply_effect_brightness(self, brightness, reliable):
        async with self._write_lock:
            async def apply():
                label = await self._ensure_connected()
                await self._write_packet(build_bledom_brightness_command(brightness), reliable=reliable)
                return label

            return await self._run_operation(apply)

    async def _disconnect_client(self):
        if self.client is None:
            return
        try:
            if self.client.is_connected:
                await self.client.disconnect()
        finally:
            self.client = None

    async def _scan_and_connect(self):
        _require_bleak()

        devices = await BleakScanner.discover(timeout=BLEDOM_SCAN_SECONDS)
        matches = [device for device in devices if is_bledom_device(device)]
        if not matches:
            raise RuntimeError("No ELK-BLEDOM LED strip found")

        await self._disconnect_client()
        self.device = matches[0]
        self.client = BleakClient(self.device, timeout=BLEDOM_CONNECT_TIMEOUT_SECONDS)
        await self.client.connect()
        # A strip we have only just met may have been switched off at the wall.
        self.powered = None
        return bledom_device_label(self.device)

    async def _ensure_connected(self):
        _require_bleak()

        if self.client is not None and self.client.is_connected:
            return bledom_device_label(self.device)
        if self.device is None:
            return await self._scan_and_connect()

        self.client = BleakClient(self.device, timeout=BLEDOM_CONNECT_TIMEOUT_SECONDS)
        await self.client.connect()
        # The link dropped and came back; what the strip did meanwhile is its
        # own business, so nothing is assumed about power or effect.
        self.powered = None
        self.current_effect = None
        return bledom_device_label(self.device)

    async def _write_packet(self, packet, *, reliable=False):
        copies = BLEDOM_RELIABLE_WRITE_COPIES if reliable else 1
        for copy in range(copies):
            await write_packet_with_fallback(self.client, BLEDOM_WRITE_CHAR_UUID, packet)
            if copy + 1 < copies:
                # Give the strip time to consume the first unacknowledged GATT
                # write before putting its safety copy into the Windows queue.
                await asyncio.sleep(BLEDOM_RELIABLE_WRITE_GAP_SECONDS)

    async def _run_operation(self, operation):
        """Run a complete command, reconnecting and replaying it once on error.

        Retrying only the packet that raised is insufficient: a reconnect loses
        our knowledge of power/effect state, and an RGB packet can be accepted
        while the strip remains logically off. Replaying the whole operation
        sends power and the requested final state in the right order.
        """
        last_error = None
        for attempt in range(BLEDOM_OPERATION_ATTEMPTS):
            try:
                return await operation()
            except Exception as error:
                last_error = error
                if attempt + 1 >= BLEDOM_OPERATION_ATTEMPTS:
                    raise
                if self.device is None:
                    # Discovery found nothing; rescanning inside one request can
                    # outlive the HTTP timeout and apply a stale command later.
                    raise
                await self._disconnect_client()
                self.powered = None
                self.current_effect = None
        raise last_error  # pragma: no cover - the loop always returns or raises

    async def _ensure_powered(self):
        """Power the strip on unless we already know it is.

        A color write is enough on a controller that ignored the power command,
        but one that took a power-off will accept the color and stay dark — so
        after an off, or on a connection we have not powered ourselves, the
        power-on has to go out first. In the steady state this costs nothing,
        which matters: an effect frame comes through here every fifth of a
        second.
        """
        if self.powered:
            return
        for packet in BLEDOM_POWER_ON_COMMANDS:
            await self._write_packet(packet, reliable=True)
        self.powered = True

    async def _apply_color(self, red, green, blue, brightness, reliable=True):
        async with self._write_lock:
            async def apply():
                label = await self._ensure_connected()
                scaled = scale_bledom_rgb(red, green, blue, brightness)
                await self._ensure_powered()
                await self._write_packet(build_bledom_rgb_command(*scaled), reliable=reliable)
                # An RGB write drops the chip out of whatever effect it was running.
                self.current_effect = None
                if any(scaled):
                    self.last_color = scaled
                return label

            return await self._run_operation(apply)

    async def _apply_effect(self, effect, hue, saturation, speed, brightness):
        name = builtin_effect_name(effect, hue, saturation)
        if name is None:
            raise ValueError(f"The strip has no built-in effect like {effect!r}")

        async with self._write_lock:
            async def apply():
                label = await self._ensure_connected()
                await self._ensure_powered()
                await self._write_packet(
                    build_bledom_effect_command(BLEDOM_EFFECTS[name], speed), reliable=True)
                # Some of these controllers ignore the speed byte in the effect packet
                # and only honour the standalone one, so both go out.
                await self._write_packet(build_bledom_speed_command(speed), reliable=True)
                await self._write_packet(build_bledom_brightness_command(brightness), reliable=True)
                self.current_effect = name
                return label

            return await self._run_operation(apply)

    async def _set_power(self, enabled):
        async with self._write_lock:
            async def apply():
                label = await self._ensure_connected()
                for packet in (BLEDOM_POWER_ON_COMMANDS if enabled else BLEDOM_POWER_OFF_COMMANDS):
                    await self._write_packet(packet, reliable=True)
                self.powered = bool(enabled)

                # Whether or not the strip understood those, a redundant color
                # write settles it even when an unacknowledged power packet was lost.
                if enabled:
                    red, green, blue = self.last_color or (255, 255, 255)
                    await self._write_packet(
                        build_bledom_rgb_command(red, green, blue), reliable=True)
                else:
                    await self._write_packet(
                        build_bledom_rgb_command(0, 0, 0), reliable=True)
                    self.current_effect = None
                return label

            return await self._run_operation(apply)

    def forget_state(self):
        """Forget what we believe the strip is doing, so the next write says it all.

        For the resend button: the caches here exist to keep traffic down, and
        they are exactly what stops a light that has drifted from being put
        right.
        """
        self.powered = None
        self.current_effect = None

    def reconnect(self):
        """Reconnect to the strip we already know about, without rescanning."""
        return self.run_coro(self._reconnect())

    async def _reconnect(self):
        await self._disconnect_client()
        # A fresh link has powered nothing and is running nothing we know of.
        self.powered = None
        self.current_effect = None
        return await self._ensure_connected()
