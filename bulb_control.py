"""Tapo smart bulb control: network discovery, identification, and direct setters.

Ported from LightRPG's controller, limited to the static surface the table uses.
Lighting effects and effect sounds are deliberately not implemented here.
"""

import asyncio
import ipaddress
import json
import os
import socket
import threading

from tapo import ApiClient

# ---------- LOCAL SETTINGS ----------
DEFAULT_IP = "192.168.0.105"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CREDENTIALS_FILE = os.environ.get(
    "MTG_TABLE_TAPO_CREDENTIALS",
    os.path.join(BASE_DIR, "tapo_credentials.json"),
)

# Auto-discovery scans 192.168.0.x.
# Keep this prefix as-is if your network is always 192.168.0.*
SCAN_PREFIX = "192.168.0."
SCAN_FIRST = 1
SCAN_LAST = 254
DISCOVERY_BROADCAST_SECONDS = 3
SCAN_TIMEOUT_SECONDS = 2.0
SCAN_CONCURRENCY = 64
# -------------------------------------------


def load_credentials():
    username = os.environ.get("TAPO_USERNAME", "").strip()
    password = os.environ.get("TAPO_PASSWORD", "")
    if username and password:
        return username, password

    try:
        with open(CREDENTIALS_FILE, "r", encoding="utf-8") as credentials_file:
            credentials = json.load(credentials_file)
    except FileNotFoundError as exc:
        raise RuntimeError(
            "Missing tapo_credentials.json. Copy tapo_credentials.example.json, "
            "enter your local Tapo login, and keep that file private."
        ) from exc

    username = str(credentials.get("username", "")).strip()
    password = str(credentials.get("password", ""))
    if not username or not password:
        raise RuntimeError("tapo_credentials.json must contain a username and password")
    return username, password


USERNAME, PASSWORD = load_credentials()


async def connect(ip):
    client = ApiClient(USERNAME, PASSWORD)
    bulb = await client.l535(ip)
    return bulb


async def connect_and_probe(ip):
    """Return a bulb object only if this IP responds like a Tapo bulb."""
    try:
        bulb = await asyncio.wait_for(connect(ip), timeout=SCAN_TIMEOUT_SECONDS)
        await asyncio.wait_for(bulb.get_device_info(), timeout=SCAN_TIMEOUT_SECONDS)
        return bulb
    except Exception:
        return None


def build_scan_ips(preferred_ip=None, excluded_ips=None):
    """Prioritize known IPs, then scan each private /24 network seen by this PC."""
    ips = []
    excluded = set(excluded_ips or ())

    def add(ip):
        if ip and ip.startswith(SCAN_PREFIX) and ip not in excluded and ip not in ips:
            ips.append(ip)

    add(preferred_ip)
    add(DEFAULT_IP)

    prefixes = [SCAN_PREFIX]
    try:
        local_addresses = socket.gethostbyname_ex(socket.gethostname())[2]
    except OSError:
        local_addresses = []
    try:
        route_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        route_socket.connect(("8.8.8.8", 80))
        local_addresses.append(route_socket.getsockname()[0])
        route_socket.close()
    except OSError:
        pass

    for address in local_addresses:
        try:
            parsed = ipaddress.ip_address(address)
            if parsed.version == 4 and parsed.is_private and not parsed.is_loopback:
                prefix = ".".join(address.split(".")[:3]) + "."
                if prefix not in prefixes:
                    prefixes.insert(0, prefix)
        except ValueError:
            continue

    # Common DHCP areas first, then everything else, on every detected subnet.
    last_octets = list(range(100, 121)) + list(range(2, 100)) + list(range(121, SCAN_LAST + 1)) + [1]
    for prefix in prefixes:
        for last_octet in last_octets:
            if SCAN_FIRST <= last_octet <= SCAN_LAST:
                add(f"{prefix}{last_octet}")

    return ips


async def scan_for_bulb(preferred_ip=None, excluded_ips=None):
    semaphore = asyncio.Semaphore(SCAN_CONCURRENCY)

    async def probe(ip):
        async with semaphore:
            bulb = await connect_and_probe(ip)
            if bulb is None:
                return None
            return ip, bulb

    tasks = [asyncio.create_task(probe(ip)) for ip in build_scan_ips(preferred_ip, excluded_ips)]
    try:
        for task in asyncio.as_completed(tasks):
            result = await task
            if result is not None:
                for other in tasks:
                    if other is not task and not other.done():
                        other.cancel()
                return result
    finally:
        await asyncio.gather(*tasks, return_exceptions=True)

    raise RuntimeError(f"No Tapo bulb found on {SCAN_PREFIX}{SCAN_FIRST}-{SCAN_LAST}")


async def discover_all_bulbs():
    """Return every authenticated Tapo color bulb visible on the local network."""
    found = {}
    client = ApiClient(USERNAME, PASSWORD)

    # Tapo's UDP broadcast discovery is both faster and independent of a fixed
    # 192.168.x.x prefix. Some routers block broadcast replies, so the subnet
    # scan runs alongside it. This avoids waiting for one discovery method before
    # starting the other, while retaining the scan for networks that drop UDP.
    async def collect_broadcast_results():
        try:
            discovery = await client.discover_devices(
                "255.255.255.255",
                timeout_s=DISCOVERY_BROADCAST_SECONDS,
            )
            async for maybe_result in discovery:
                try:
                    result = maybe_result.get()
                    if type(result).__name__ != "ColorLight":
                        continue
                    found[result.ip] = {
                        "ip": result.ip,
                        "name": result.nickname or "Tapo bulb",
                        "model": result.model or "Color light",
                    }
                except Exception:
                    continue
        except Exception:
            pass

    # Always supplement broadcast results with direct probes. Broadcast packets
    # can be dropped for only one device, and returning early here would make a
    # partial broadcast result look like a complete inventory.
    semaphore = asyncio.Semaphore(SCAN_CONCURRENCY)

    async def probe(ip):
        async with semaphore:
            bulb = await connect_and_probe(ip)
            if bulb is None:
                return None
            try:
                info = await asyncio.wait_for(bulb.get_device_info(), timeout=SCAN_TIMEOUT_SECONDS)
                return {
                    "ip": ip,
                    "name": getattr(info, "nickname", None) or "Tapo bulb",
                    "model": getattr(info, "model", None) or "Color light",
                }
            except Exception:
                return {"ip": ip, "name": "Tapo bulb", "model": "Color light"}

    scan_tasks = [asyncio.create_task(probe(ip)) for ip in build_scan_ips()]
    broadcast_task = asyncio.create_task(collect_broadcast_results())
    scan_results = await asyncio.gather(*scan_tasks)
    await broadcast_task
    for result in scan_results:
        if result is not None:
            # Prefer the richer nickname/model returned by UDP when both
            # discovery methods find the same bulb.
            found.setdefault(result["ip"], result)

    if not found:
        raise RuntimeError("No compatible Tapo color bulbs responded on the local network")
    return sorted(found.values(), key=lambda item: tuple(int(part) for part in item["ip"].split(".")))


async def blink_bulb(ip, cycles=4):
    """Blink a bulb for identification, then restore its original power state."""
    bulb = await connect(ip)
    info = await bulb.get_device_info()
    was_on = bool(info.device_on)
    original_brightness = max(1, min(100, int(info.brightness)))
    try:
        # Maximum brightness and a slower cadence make the selected bulb easy
        # to distinguish, even if it was previously dimmed or switched off.
        await bulb.on()
        await bulb.set_brightness(100)
        for _ in range(cycles):
            await asyncio.sleep(0.6)
            await bulb.off()
            await asyncio.sleep(0.6)
            await bulb.on()
    finally:
        try:
            await bulb.set_brightness(original_brightness)
        finally:
            if was_on:
                await bulb.on()
            else:
                await bulb.off()


# -----------------------------
# DIRECT SETTERS
# -----------------------------
async def send_light_state(bulb, *, hue=None, saturation=None, brightness=None, temperature=None):
    """Apply everything named here in a single request.

    The Tapo API takes power, color and brightness together, and each separate
    call is its own round trip over Wi-Fi. Sending them one at a time cost three
    trips per write, which is most of a second on a bulb — enough to turn an
    effect into a lurch and to make a turn change visibly lag the table.
    """
    params = bulb.set().on()
    if hue is not None and saturation is not None:
        params = params.hue_saturation(int(hue), int(saturation))
    if temperature is not None:
        params = params.color_temperature(int(temperature))
    if brightness is not None:
        params = params.brightness(int(brightness))
    await params.send(bulb)


# -----------------------------
# CONTROLLER
# -----------------------------
class TapoController:
    def __init__(self, initial_ip=DEFAULT_IP):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run_loop, daemon=True)
        self.thread.start()

        self.bulb = None
        self.current_ip = initial_ip or ""
        # What this bulb was last told. A frame that changes nothing else can
        # then cost one small request instead of a full one.
        self._sent = {}
        # One write to a bulb at a time. Two that overlap both decide what to
        # send from the same stale picture, and if the older one lands last the
        # bulb keeps the older color while this side believes it has the newer —
        # a light left out of step that nothing afterwards puts right.
        self._write_lock = asyncio.Lock()

    def _run_loop(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def run_coro(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    def set_ip(self, ip):
        ip = ip.strip()
        if not ip:
            raise ValueError("IP cannot be empty")

        if ip != self.current_ip:
            self.current_ip = ip
            self.bulb = None
            self._sent = {}

    def clear_ip(self):
        """Forget this controller's assigned bulb without changing bulb power."""
        self.bulb = None
        self.current_ip = ""
        self._sent = {}

    async def _get_bulb(self):
        if self.bulb is None:
            # A new connection knows nothing about what this bulb is showing.
            self._sent = {}
            if self.current_ip:
                # An assigned/manual IP is authoritative. Never replace it with
                # whichever other bulb happens to answer a network scan first.
                self.bulb = await connect_and_probe(self.current_ip)
                if self.bulb is None:
                    raise RuntimeError(
                        f"No Tapo bulb responded at the assigned IP {self.current_ip}. "
                        "Check that address or run Discover and assign all bulbs."
                    )
            else:
                self.current_ip, self.bulb = await scan_for_bulb()
        return self.bulb

    async def _apply_state(self, force, sync_barrier=None, **wanted):
        """Send one request carrying only the fields that actually changed.

        Most frames of an effect move brightness and nothing else, and most turn
        changes leave at least one field alone, so this is the difference between
        a light that keeps up and one that trails the table. `force` sends the
        lot regardless, for the controls that mean "put this on the bulb now"
        even if we believe it is already showing it.

        Returns whether a request actually went out, so whoever times the round
        trips is not fooled by a write that cost nothing.
        """
        async with self._write_lock:
            bulb = await self._get_bulb()
            fields = {key: value for key, value in wanted.items()
                      if force or self._sent.get(key) != value}
            if not fields and self._sent.get("on"):
                # Do not strand the other half of a synchronized pair. It may
                # still have a real change to send even when this bulb is
                # already showing the requested value.
                if sync_barrier is not None:
                    try:
                        sync_barrier.wait(timeout=1.0)
                    except threading.BrokenBarrierError:
                        pass
                return False
            if "hue" in fields or "saturation" in fields:
                # The API carries these two together, so neither travels alone.
                fields["hue"], fields["saturation"] = wanted["hue"], wanted["saturation"]

            # A swap is only convincing when both bulbs start their network
            # request together. Each controller owns a separate event-loop
            # thread, so this barrier holds the faster one after preparation
            # until its partner is ready. The timeout keeps a slow/offline bulb
            # from preventing the other one from changing at all.
            if sync_barrier is not None:
                try:
                    sync_barrier.wait(timeout=1.0)
                except threading.BrokenBarrierError:
                    pass

            try:
                await send_light_state(bulb, **fields)
            except Exception:
                # The cached session can go bad with nothing local to show it —
                # the bulb rebooted, took a new DHCP lease, or Wi-Fi hiccuped.
                # Drop it so the next write reconnects instead of repeating the
                # same failure against a dead object forever.
                self.bulb = None
                raise

            self._sent.update(wanted, on=True)
            # Color and white temperature override each other on the bulb, so
            # whichever was not just set is no longer something we know.
            if "temperature" in wanted:
                self._sent.pop("hue", None)
                self._sent.pop("saturation", None)
            elif "hue" in wanted:
                self._sent.pop("temperature", None)
            return True

    def find_bulb(self, excluded_ips=None):
        self.bulb = None
        return self.run_coro(self._find_bulb(excluded_ips))

    async def _find_bulb(self, excluded_ips=None):
        self.current_ip, self.bulb = await scan_for_bulb(self.current_ip, excluded_ips)
        return self.current_ip

    def forget_state(self):
        """Forget what we believe this bulb is showing, so the next write says it all.

        For the resend button: the cache here exists to keep round trips down,
        and it is exactly what stops a bulb that has drifted from being put
        right.
        """
        self._sent = {}

    def apply_hsv(self, h, s, b, force=False, sync_barrier=None):
        return self.run_coro(self._apply_state(
            force, sync_barrier=sync_barrier,
            hue=int(h), saturation=int(s), brightness=int(b)))

    def apply_white(self, temp, brightness, force=False, sync_barrier=None):
        return self.run_coro(self._apply_state(
            force, sync_barrier=sync_barrier,
            temperature=int(temp), brightness=int(brightness)))

    def get_light_state(self):
        return self.run_coro(self._get_light_state())

    async def _get_light_state(self):
        bulb = await self._get_bulb()
        try:
            info = await bulb.get_device_info()
        except Exception:
            self.bulb = None
            raise
        return {
            "brightness": max(1, int(info.brightness)),
            "device_on": bool(info.device_on),
        }

    def apply_brightness(self, brightness):
        return self.run_coro(self._apply_state(False, brightness=max(1, min(100, int(brightness)))))

    def set_power(self, enabled):
        return self.run_coro(self._set_power(enabled))

    async def _set_power(self, enabled):
        bulb = await self._get_bulb()
        try:
            if enabled:
                await bulb.on()
            else:
                await bulb.off()
        except Exception:
            self.bulb = None
            raise
        # An off bulb still remembers its color, so only the power is news.
        self._sent["on"] = bool(enabled)

    def discover_all(self):
        return self.run_coro(discover_all_bulbs())

    def identify(self, ip):
        return self.run_coro(blink_bulb(ip))
