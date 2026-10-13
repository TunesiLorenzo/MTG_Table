"""Local server for the MTG Commander Table display and light controls.

Usage:
    python serve.py [--port 8000] [--no-browser]

Serves this directory over HTTP and opens the display in the default browser.
Press F11 (or the hub's Fullscreen button) once it loads.
"""

import argparse
import threading
import webbrowser

import mdns
from web import app


def main():
    parser = argparse.ArgumentParser(description="Serve the MTG Commander Table display.")
    parser.add_argument("--port", type=int, default=5001, help="port to listen on (default: 5001)")
    parser.add_argument("--host", default="0.0.0.0", help="interface to bind (default: all)")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    parser.add_argument("--hostname", default=mdns.DEFAULT_HOSTNAME,
                        help="mDNS name to publish, without .local (default: {})".format(mdns.DEFAULT_HOSTNAME))
    parser.add_argument("--no-mdns", action="store_true", help="do not advertise the .local name")
    args = parser.parse_args()

    url = "http://localhost:{}/".format(args.port)
    print("MTG Commander Table serving at {}".format(url))
    print("Bound to {}:{} - other devices on the LAN can open it too.".format(args.host, args.port))
    print("Ctrl+C to stop.")

    if not args.no_mdns:
        mdns.register(args.port, hostname=args.hostname)

    if not args.no_browser:
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()

    try:
        app.run(host=args.host, port=args.port, threaded=True, use_reloader=False)
    finally:
        mdns.unregister()


if __name__ == "__main__":
    main()
