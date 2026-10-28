"""Bounded loopback health probe shared by the image and host operator tools.

This module deliberately depends only on the standard library. Importing it must
not require Django settings, a database connection, or host-side scripts.
"""

import ipaddress
import json
import socket
import ssl
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def probe_loopback(origin, *, ca_file=None):
    parsed = urlsplit(origin)
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise ValueError("Only an explicit loopback origin is permitted")
    addresses = socket.getaddrinfo(
        parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)
    )
    if any(not ipaddress.ip_address(item[4][0]).is_loopback for item in addresses):
        raise ValueError("Loopback name resolved outside loopback")
    client = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        NoRedirect(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=ca_file)),
    )
    started = time.perf_counter()
    tls_verified = False
    try:
        with client.open(origin.rstrip("/") + "/api/health/", timeout=3) as response:
            status = response.status
            tls_verified = parsed.scheme == "https"
            content = response.read(4097)
            data = json.loads(content) if len(content) <= 4096 else None
            healthy = (
                len(content) <= 4096
                and status == 200
                and isinstance(data, dict)
                and data.get("status") == "ok"
            )
    except urllib.error.HTTPError as error:
        status, healthy = error.code, False
        tls_verified = parsed.scheme == "https"
        error.close()
    except (OSError, ValueError):
        status, healthy = None, False
    return {
        "healthy": healthy,
        "status": status,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
        "transport": "loopback_" + parsed.scheme,
        "tls_verified": tls_verified,
    }
