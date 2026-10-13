"""Advertise the table server on the LAN over mDNS (Bonjour/zeroconf).

Registers an ``_http._tcp.local.`` service whose host record is
``rpgtable.local.`` pointing at this PC's active LAN address, so phones at the
table can open ``http://rpgtable.local:5001/`` instead of hunting for the
current DHCP address. Port 5001 keeps out of the way of LightRPG, which serves
its own page on 5000 from the same PC.

The advertisement is best-effort: if zeroconf is missing or the network refuses
the registration, the server still starts and the numeric IP still works.
"""

import atexit
import socket

DEFAULT_HOSTNAME = "rpgtable"
SERVICE_TYPE = "_http._tcp.local."
SERVICE_NAME = "MTG Table"

_zeroconf = None
_service_info = None


def active_lan_ip():
    """The address this PC uses to reach the LAN.

    Opening a UDP socket toward an off-subnet address makes the OS pick the
    route it would really use, which beats gethostbyname on a machine with a
    Bluetooth adapter, a VPN, and a hosts file all offering opinions. No packet
    is sent.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        return probe.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        probe.close()


def register(port, hostname=DEFAULT_HOSTNAME, service_name=SERVICE_NAME, ip=None):
    """Publish ``<hostname>.local.`` -> this PC on ``port``. Returns the IP used."""
    global _zeroconf, _service_info

    if _service_info is not None:
        unregister()

    try:
        from zeroconf import IPVersion, ServiceInfo, Zeroconf
    except ImportError:
        print("mDNS: zeroconf not installed - run 'python -m pip install zeroconf'")
        return None

    address = ip or active_lan_ip()
    if address == "127.0.0.1":
        print("mDNS: no LAN address found - skipping .local advertisement")
        return None

    info = ServiceInfo(
        SERVICE_TYPE,
        f"{service_name}.{SERVICE_TYPE}",
        addresses=[socket.inet_aton(address)],
        port=port,
        properties={"path": "/"},
        server=f"{hostname}.local.",
    )

    try:
        zc = Zeroconf(ip_version=IPVersion.V4Only)
        zc.register_service(info)
    except Exception as exc:  # a busy name or a firewalled interface, say
        print(f"mDNS: could not advertise {hostname}.local - {exc}")
        try:
            zc.close()
        except Exception:
            pass
        return None

    _zeroconf, _service_info = zc, info
    atexit.register(unregister)
    print(f"mDNS: http://{hostname}.local:{port}/ -> {address}:{port}")
    return address


def unregister():
    """Withdraw the advertisement. Safe to call twice, or when never registered."""
    global _zeroconf, _service_info

    zc, info = _zeroconf, _service_info
    _zeroconf, _service_info = None, None
    if zc is None:
        return
    try:
        if info is not None:
            zc.unregister_service(info)
    except Exception:
        pass
    finally:
        zc.close()
