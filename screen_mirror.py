"""The table screen on a tablet: pictures of it out, taps back in as clicks.

The table page runs in a browser on this PC. /mirror on a tablet shows a live
picture of that browser window and every tap on it is played back here as the
mouse, so the whole table can be driven from a touch display: the hub, the
trays, dialogs, everything, exactly as if the screen were touched.

Windows only (the table PC): the picture is a screen grab (Pillow) of the
window whose title is the table page's, and the mouse and keyboard are
SendInput. Coordinates are physical pixels, so this process is made
DPI-aware before the first grab.
"""

import ctypes
import io
import sys
import threading
import time
import zlib

TABLE_TITLE = "MTG Commander Table"
REGION_SECONDS = 1.5
FRAME_SECONDS = 0.05
PRESS_MAX_SECONDS = 8
WIDTH_MIN, WIDTH_MAX = 480, 1920
WHEEL_MAX = 2400
TEXT_MAX = 200
KEYS = {"backspace": 0x08, "tab": 0x09, "enter": 0x0D, "escape": 0x1B,
        "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28, "delete": 0x2E}

AVAILABLE = sys.platform == "win32"

lock = threading.Lock()
ready = False
region_cache = {"at": 0.0, "rect": None, "found": False}
# The table page's own size in physical pixels, as it reports it: the part of
# its browser window below the tabs and address bar. Without it the whole
# window is sent, browser and all.
page_size = {"width": 0, "height": 0}
frame_cache = {"at": 0.0, "width": 0, "rect": None, "crc": None, "jpeg": b""}
press = {"down": False, "token": 0}

if AVAILABLE:
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    dwmapi = ctypes.WinDLL("dwmapi")

    ULONG_PTR = ctypes.c_size_t
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                    ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                    ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                    ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]

    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD), ("wParamH", wintypes.WORD)]

    class INPUTUNION(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

    class INPUT(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("u", INPUTUNION)]

    user32.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
    user32.MonitorFromWindow.restype = wintypes.HANDLE
    user32.MonitorFromPoint.argtypes = [wintypes.POINT, wintypes.DWORD]
    user32.MonitorFromPoint.restype = wintypes.HANDLE
    user32.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MONITORINFO)]
    user32.GetSystemMetrics.argtypes = [ctypes.c_int]
    user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
    dwmapi.DwmGetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]

    INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
    MOUSE_MOVE, MOUSE_LEFTDOWN, MOUSE_LEFTUP, MOUSE_WHEEL = 0x0001, 0x0002, 0x0004, 0x0800
    MOUSE_VIRTUALDESK, MOUSE_ABSOLUTE = 0x4000, 0x8000
    KEY_UP, KEY_UNICODE = 0x0002, 0x0004
    MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY = 2, 1
    DWMWA_EXTENDED_FRAME_BOUNDS = 9
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 76, 77, 78, 79


def setup():
    """Physical pixels everywhere: grabs, window rectangles and the cursor."""
    global ready
    if ready:
        return
    if not AVAILABLE:
        raise RuntimeError("The screen remote only works when the table runs on Windows")
    try:
        user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # per-monitor v2
    except AttributeError:
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except (AttributeError, OSError):
            user32.SetProcessDPIAware()
    ready = True


def monitor_rect(monitor):
    info = MONITORINFO()
    info.cbSize = ctypes.sizeof(MONITORINFO)
    user32.GetMonitorInfoW(monitor, ctypes.byref(info))
    rect = info.rcMonitor
    return rect.left, rect.top, rect.right, rect.bottom


def window_rect(hwnd):
    """The window as drawn, without the invisible resize border Windows adds."""
    rect = wintypes.RECT()
    if dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(rect), ctypes.sizeof(rect)):
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return rect.left, rect.top, rect.right, rect.bottom


def table_windows():
    found = []

    def visit(hwnd, _):
        length = user32.GetWindowTextLengthW(hwnd)
        if length and user32.IsWindowVisible(hwnd) and not user32.IsIconic(hwnd):
            text = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, text, length + 1)
            if text.value.startswith(TABLE_TITLE):
                found.append(hwnd)
        return True

    user32.EnumWindows(WNDENUMPROC(visit), 0)
    return found


def set_page_size(width, height):
    """The table page's visible size in physical pixels (innerWidth x devicePixelRatio)."""
    with lock:
        page_size.update(width=int(width), height=int(height))
        region_cache["at"] = 0.0


def page_area(left, top, right, bottom):
    """The page inside its browser window: the browser's tabs and address bar
    sit on top, so the page is the window's bottom, centred across. In F11
    full screen the page is the whole window."""
    width, height = page_size["width"], page_size["height"]
    if not width or not height or width > right - left + 4 or height > bottom - top + 4:
        return left, top, right, bottom
    width, height = min(width, right - left), min(height, bottom - top)
    page_left = left + (right - left - width) // 2
    return page_left, bottom - height, page_left + width, bottom


def find_region():
    """The table's browser window, kept to its monitor; the main screen if no
    window shows the table page (another tab is open, or it is minimised)."""
    windows = table_windows()
    if windows:
        foreground = user32.GetForegroundWindow()

        def score(hwnd):
            left, top, right, bottom = window_rect(hwnd)
            return (hwnd == foreground, (right - left) * (bottom - top))

        hwnd = max(windows, key=score)
        left, top, right, bottom = page_area(*window_rect(hwnd))
        m_left, m_top, m_right, m_bottom = monitor_rect(user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST))
        rect = (max(left, m_left), max(top, m_top), min(right, m_right), min(bottom, m_bottom))
        if rect[2] - rect[0] > 100 and rect[3] - rect[1] > 100:
            return rect, True
    if region_cache["rect"]:
        return region_cache["rect"], False
    return monitor_rect(user32.MonitorFromPoint(wintypes.POINT(0, 0), MONITOR_DEFAULTTOPRIMARY)), False


def region():
    """(left, top, right, bottom) of what the tablet sees, and whether it is the table window."""
    setup()
    now = time.monotonic()
    if now - region_cache["at"] > REGION_SECONDS:
        rect, found = find_region()
        region_cache.update(at=now, rect=rect, found=found)
    return region_cache["rect"], region_cache["found"]


def frame(width, since=None):
    """The screen as a JPEG at most `width` wide: (crc, jpeg, region, found).
    `jpeg` is None when the picture is the same as the one with crc `since`.
    Grabs are shared between tablets for a moment, so two cost one."""
    from PIL import Image, ImageGrab

    width = max(WIDTH_MIN, min(WIDTH_MAX, int(width)))
    with lock:
        rect, found = region()
        now = time.monotonic()
        if now - frame_cache["at"] > FRAME_SECONDS or frame_cache["width"] != width or frame_cache["rect"] != rect:
            image = ImageGrab.grab(bbox=rect, all_screens=True)
            if image.width > width:
                image = image.resize((width, max(1, round(image.height * width / image.width))), Image.BILINEAR)
            image = image.convert("RGB")
            crc = zlib.crc32(image.tobytes())
            if crc != frame_cache["crc"] or frame_cache["width"] != width:
                buffer = io.BytesIO()
                image.save(buffer, "JPEG", quality=72)
                frame_cache["jpeg"] = buffer.getvalue()
            frame_cache.update(at=now, width=width, crc=crc, rect=rect)
        crc, jpeg = frame_cache["crc"], frame_cache["jpeg"]
    return crc, (None if since is not None and since == crc else jpeg), rect, found



def send(*inputs):
    array = (INPUT * len(inputs))(*inputs)
    user32.SendInput(len(inputs), array, ctypes.sizeof(INPUT))


def mouse(flags, x=0, y=0, data=0):
    item = INPUT(type=INPUT_MOUSE)
    item.u.mi = MOUSEINPUT(dx=x, dy=y, mouseData=data & 0xFFFFFFFF, dwFlags=flags, time=0, dwExtraInfo=0)
    return item


def key(vk=0, scan=0, flags=0):
    item = INPUT(type=INPUT_KEYBOARD)
    item.u.ki = KEYBDINPUT(wVk=vk, wScan=scan, dwFlags=flags, time=0, dwExtraInfo=0)
    return item


def point(fx, fy):
    """A fraction of the mirrored picture, as SendInput's absolute coordinates."""
    left, top, right, bottom = region()[0]
    x = left + min(max(fx, 0.0), 1.0) * (right - left - 1)
    y = top + min(max(fy, 0.0), 1.0) * (bottom - top - 1)
    v_left, v_top = user32.GetSystemMetrics(SM_XVIRTUALSCREEN), user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
    v_width = max(2, user32.GetSystemMetrics(SM_CXVIRTUALSCREEN))
    v_height = max(2, user32.GetSystemMetrics(SM_CYVIRTUALSCREEN))
    return (round((x - v_left) * 65535 / (v_width - 1)), round((y - v_top) * 65535 / (v_height - 1)))


def move_to(fx, fy):
    x, y = point(fx, fy)
    return mouse(MOUSE_MOVE | MOUSE_ABSOLUTE | MOUSE_VIRTUALDESK, x, y)


def release_if_stuck(token):
    """A tablet that lost Wi-Fi mid-press must not leave the button held."""
    with lock:
        if press["down"] and press["token"] == token:
            press["down"] = False
            send(mouse(MOUSE_LEFTUP))


def fraction(event, name):
    value = event.get(name)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not -0.05 <= value <= 1.05:
        raise ValueError(f"{name} must be a fraction of the screen")
    return float(value)


def play(events):
    """Tap, drag, scroll and type from the tablet, in the order they happened."""
    setup()
    for event in events:
        kind = event.get("type") if isinstance(event, dict) else None
        if kind in ("down", "move", "up", "wheel"):
            x, y = fraction(event, "x"), fraction(event, "y")
            if kind == "down":
                with lock:
                    press["down"] = True
                    press["token"] += 1
                    token = press["token"]
                send(move_to(x, y), mouse(MOUSE_LEFTDOWN))
                threading.Timer(PRESS_MAX_SECONDS, release_if_stuck, args=(token,)).start()
            elif kind == "move":
                send(move_to(x, y))
            elif kind == "up":
                with lock:
                    press["down"] = False
                send(move_to(x, y), mouse(MOUSE_LEFTUP))
            else:
                amount = event.get("amount")
                if isinstance(amount, bool) or not isinstance(amount, int) or not -WHEEL_MAX <= amount <= WHEEL_MAX:
                    raise ValueError("A scroll is a whole number of wheel steps")
                if amount:
                    send(move_to(x, y), mouse(MOUSE_WHEEL, data=amount))
        elif kind == "key":
            vk = KEYS.get(event.get("key"))
            if not vk:
                raise ValueError("Unknown key")
            send(key(vk), key(vk, flags=KEY_UP))
        elif kind == "text":
            text = str(event.get("text") or "")[:TEXT_MAX]
            units = text.encode("utf-16-le")
            inputs = []
            for index in range(0, len(units), 2):
                unit = int.from_bytes(units[index:index + 2], "little")
                if unit in (10, 13):
                    inputs += [key(KEYS["enter"]), key(KEYS["enter"], flags=KEY_UP)]
                else:
                    inputs += [key(scan=unit, flags=KEY_UNICODE), key(scan=unit, flags=KEY_UNICODE | KEY_UP)]
            if inputs:
                send(*inputs)
        else:
            raise ValueError("Unknown screen remote event")
