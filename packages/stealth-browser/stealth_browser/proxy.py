"""Proxy configuration -- per-session IP rotation, credentials from env.

Why proxies matter here: the single strongest signal that links many browser
sessions to ONE origin is the IP address. Routing each session through a
different residential exit IP is the legitimate way to make traffic look like
it comes from genuinely different network locations (geo-testing, realistic
traffic-source variety in your own analytics).

CREDENTIALS ARE NEVER HARD-CODED. They are read from environment variables (or
an untracked .env file you load yourself). Nothing secret touches git.

Set these before running:
    export PROXY_HOST=gate.example-proxies.com
    export PROXY_PORT=7000
    export PROXY_USER=your-username
    export PROXY_PASS=your-password

Optional, for rotating-gateway proxies that take a session id in the username:
    export PROXY_USER_TEMPLATE='your-user-session-{session}'
    -- each session substitutes {session} with a random id, so the gateway
       hands out a fresh exit IP per session.

A proxy that is a *tunnelling* proxy (HTTP CONNECT / SOCKS5) is required -- it
forwards the browser's own TLS handshake untouched. A TLS-terminating MITM
proxy would replace Chrome's authentic TLS fingerprint with its own.
"""

from __future__ import annotations

import json
import os
import random
import string
import urllib.request
from dataclasses import dataclass


@dataclass
class ProxyConfig:
    """One proxy endpoint. Built from env vars via `from_env()`."""

    host: str
    port: int
    username: str | None = None
    password: str | None = None
    scheme: str = "http"          # "http" or "socks5"

    @property
    def configured(self) -> bool:
        return bool(self.host and self.port)

    def chrome_flag(self) -> str:
        """The --proxy-server=... value for Chrome's launch flags.

        Note: Chrome's --proxy-server does NOT carry credentials. Auth is
        handled separately via CDP Fetch.authRequired (see browser.py).
        """
        return f"--proxy-server={self.scheme}://{self.host}:{self.port}"

    def has_auth(self) -> bool:
        return bool(self.username and self.password)


def _rand_session(n: int = 10) -> str:
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def from_env(*, session_id: str | None = None) -> ProxyConfig | None:
    """Build a ProxyConfig from environment variables.

    Returns None if PROXY_HOST is not set -- i.e. proxies are simply off and
    the browser connects directly. This keeps proxies fully optional.

    If PROXY_USER_TEMPLATE is set (contains "{session}"), each call substitutes
    a fresh random session id -> a rotating-gateway proxy hands out a new exit
    IP per session. Otherwise PROXY_USER / PROXY_PASS are used as-is.
    """
    host = os.environ.get("PROXY_HOST")
    port = os.environ.get("PROXY_PORT")
    if not host or not port:
        return None

    template = os.environ.get("PROXY_USER_TEMPLATE")
    if template and "{session}" in template:
        sid = session_id or _rand_session()
        username = template.replace("{session}", sid)
    else:
        username = os.environ.get("PROXY_USER")

    return ProxyConfig(
        host=host,
        port=int(port),
        username=username,
        password=os.environ.get("PROXY_PASS"),
        scheme=os.environ.get("PROXY_SCHEME", "http"),
    )


def from_dict(spec: dict, *, session_id: str | None = None) -> ProxyConfig:
    """Build a ProxyConfig from a caller-supplied dict (per-session API body).

    Accepts either a "server URL" form or explicit fields. apex is vendor-
    agnostic: callers bring whatever proxy they want (Oxylabs, Bright Data,
    Smartproxy, their own SOCKS5, an on-prem squid). The two accepted shapes:

      {"server": "http://gate.example.com:7777",
       "username": "...", "password": "..."}

      {"host": "gate.example.com", "port": 7777, "scheme": "http",
       "username": "...", "password": "..."}

    A {session} placeholder in `username` is substituted with `session_id` so
    rotating-gateway proxies (Oxylabs residential, Bright Data zone-style,
    Smartproxy) get a fresh exit IP per apex session.

    The chrome_flag/has_auth machinery downstream is identical for any vendor
    -- HTTP CONNECT + Basic auth is the universal proxy contract.
    """
    if "server" in spec:
        # Playwright-style "server" URL form
        from urllib.parse import urlparse
        u = urlparse(spec["server"])
        scheme = (u.scheme or "http").lower()
        host = u.hostname or ""
        port = u.port or (443 if scheme == "https" else 80)
    else:
        scheme = spec.get("scheme", "http").lower()
        host = spec.get("host", "")
        port = int(spec.get("port", 0))
    if not host or not port:
        raise ValueError("proxy spec needs server=URL or host+port")
    if scheme not in ("http", "https", "socks5"):
        raise ValueError(f"unsupported proxy scheme: {scheme!r}")

    # Vendors encode session/region targeting INTO the username field. Two
    # common templates apex substitutes:
    #   {session} -> per-apex-session nonce (rotating sticky sessions)
    #   {peer}    -> alias of {session}, matches Oxylabs residential
    #                "USERNAME-PEER" sticky-pool format
    # Examples that all yield a fresh IP per session:
    #   "customer-USER-cc-US-sessid-{session}"   (Oxylabs residential old SKU)
    #   "USER-{peer}"                            (Oxylabs hbproxy residential)
    #   "brd-customer-USER-zone-resi-session-{session}"  (Bright Data)
    #   "user-USER-session-{session}"            (Smartproxy)
    username = spec.get("username")
    if username:
        nonce = session_id or _rand_session()
        username = (username
                    .replace("{session}", nonce)
                    .replace("{peer}", nonce))
    return ProxyConfig(
        host=host, port=port, scheme=scheme,
        username=username, password=spec.get("password"),
    )


# --- IP geolocation -------------------------------------------------------
# After connecting through a proxy we look up the exit IP's real location, so
# the browser identity (timezone / locale / geo) can be matched to it. This is
# the honest direction: make the fingerprint agree with the network, never the
# reverse.

_IPGEO_ENDPOINTS = [
    "https://ipapi.co/json/",
    "http://ip-api.com/json/?fields=status,countryCode,region,regionName,"
    "city,lat,lon,timezone,query",
]


def lookup_exit_geo(timeout: float = 8.0) -> dict | None:
    """Look up the geolocation of the CURRENT outbound IP.

    Run this AFTER the proxy is in effect (e.g. from inside the browser, or
    from a process already routed through the proxy) so it returns the proxy's
    exit location, not your real one. Returns a normalized dict:
        {ip, city, region, country, timezone, latitude, longitude}
    or None if every endpoint fails.
    """
    for url in _IPGEO_ENDPOINTS:
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                raw = json.load(r)
        except Exception:  # noqa: BLE001 - try the next endpoint
            continue
        norm = _normalize_geo(raw)
        if norm:
            return norm
    return None


def _normalize_geo(raw: dict) -> dict | None:
    """Normalize the two IP-geo services' differing JSON shapes."""
    # ipapi.co shape
    if "timezone" in raw and "latitude" in raw:
        return {
            "ip": raw.get("ip"),
            "city": raw.get("city"),
            "region": raw.get("region"),
            "country": raw.get("country") or raw.get("country_code"),
            "timezone": raw.get("timezone"),
            "latitude": raw.get("latitude"),
            "longitude": raw.get("longitude"),
        }
    # ip-api.com shape
    if raw.get("status") == "success":
        return {
            "ip": raw.get("query"),
            "city": raw.get("city"),
            "region": raw.get("regionName"),
            "country": raw.get("countryCode"),
            "timezone": raw.get("timezone"),
            "latitude": raw.get("lat"),
            "longitude": raw.get("lon"),
        }
    return None
