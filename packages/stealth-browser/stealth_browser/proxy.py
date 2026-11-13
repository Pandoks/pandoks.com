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
import urllib.parse
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


def _socks5_tunnel(proxy: ProxyConfig, host: str, port: int,
                   timeout: float):
    """Open a SOCKS5 CONNECT tunnel to (host, port); return the raw socket.

    Implements the RFC 1928 handshake (client greeting -> chosen auth method
    -> CONNECT -> reply). Supports the no-auth (0x00) and username/password
    (0x02) methods, which cover real vendor proxies. Returns None if the
    handshake or CONNECT fails.
    """
    import socket
    s = socket.create_connection((proxy.host, proxy.port), timeout=timeout)
    try:
        # greeting: version 5, 2 methods offered (no-auth, user/pass)
        s.sendall(b"\x05\x02\x00\x02")
        chosen = s.recv(2)
        if len(chosen) < 2 or chosen[0] != 0x05:
            raise OSError("bad SOCKS5 greeting reply")
        if chosen[1] == 0x02:
            # RFC 1929 sub-negotiation: ver(1) ulen(1) user plen(1) pass
            user = (proxy.username or "").encode()
            pw = (proxy.password or "").encode()
            s.sendall(b"\x01" + bytes([len(user)]) + user
                      + bytes([len(pw)]) + pw)
            ok = s.recv(2)
            if len(ok) < 2 or ok[1] != 0x00:
                raise OSError("SOCKS5 auth rejected")
        elif chosen[1] != 0x00:
            raise OSError(f"SOCKS5 chose unsupported method {chosen[1]}")
        # CONNECT to host:port, domain-name addressing
        s.sendall(b"\x05\x01\x00\x03" + bytes([len(host)]) + host.encode()
                  + port.to_bytes(2, "big"))
        resp = s.recv(4)
        if len(resp) < 4 or resp[1] != 0x00:
            raise OSError(f"SOCKS5 CONNECT failed (reply {resp!r})")
        # drain the bound address (BND.ADDR + BND.PORT) per address type
        atyp = resp[3]
        if atyp == 0x01:
            s.recv(6)
        elif atyp == 0x03:
            ln = s.recv(1)[0]
            s.recv(ln + 2)
        elif atyp == 0x04:
            s.recv(18)
        return s
    except Exception:  # noqa: BLE001 - tunnel setup failure -> no lookup
        s.close()
        return None


def _geo_request_through_proxy(proxy: ProxyConfig, url: str,
                               timeout: float):
    """Fetch one JSON endpoint THROUGH the configured proxy (synchronous).

    HTTP/HTTPS: an urllib opener whose ProxyHandler points at the proxy;
    credentials are sent as a pre-emptive Proxy-Authorization header (CPython
    forwards a request-level Proxy-Authorization into the CONNECT tunnel).
    SOCKS5: a minimal RFC 1928 CONNECT tunnel + http.client over it.
    """
    import base64
    parsed = urllib.parse.urlparse(url)
    if proxy.scheme == "socks5":
        import http.client
        import ssl
        default_port = 443 if parsed.scheme == "https" else 80
        tunnel = _socks5_tunnel(proxy, parsed.hostname, parsed.port
                                or default_port, timeout)
        if tunnel is None:
            return None
        try:
            if parsed.scheme == "https":
                wrapped = ssl.create_default_context().wrap_socket(
                    tunnel, server_hostname=parsed.hostname)
                conn = http.client.HTTPSConnection(parsed.hostname,
                                                  timeout=timeout)
                # the socket is already connected (and now TLS-wrapped);
                # hand it to http.client so it skips its own connect()
                conn.sock = wrapped
            else:
                conn = http.client.HTTPConnection(parsed.hostname,
                                                 timeout=timeout)
                conn.sock = tunnel
            # Connection: close so the response is delimited by EOF even when
            # an endpoint replies with a bare HTTP/1.0 body (no Content-Length)
            conn.request("GET", parsed.path or "/",
                         headers={"Connection": "close"})
            with conn.getresponse() as r:
                return json.load(r)
        finally:
            tunnel.close()
    handler = urllib.request.ProxyHandler({
        "http": f"{proxy.scheme}://{proxy.host}:{proxy.port}",
        "https": f"{proxy.scheme}://{proxy.host}:{proxy.port}",
    })
    headers = {}
    if proxy.has_auth():
        cred = base64.b64encode(
            f"{proxy.username}:{proxy.password}".encode()).decode()
        headers["Proxy-Authorization"] = f"Basic {cred}"
    opener = urllib.request.build_opener(handler)
    req = urllib.request.Request(url, headers=headers)
    with opener.open(req, timeout=timeout) as r:
        return json.load(r)


def lookup_exit_geo(timeout: float = 8.0,
                    proxy: ProxyConfig | None = None) -> dict | None:
    """Look up the geolocation of the CURRENT outbound IP.

    Run this AFTER the proxy is in effect (e.g. from inside the browser, or
    from a process already routed through the proxy) so it returns the proxy's
    exit location, not your real one. With `proxy` set, the lookup itself is
    routed through that proxy (HTTP CONNECT or SOCKS5), which is what a
    caller needs when the browser does not exist yet and the exit IP must be
    known BEFORE launch. Returns a normalized dict:
        {ip, city, region, country, timezone, latitude, longitude}
    or None if every endpoint fails.
    """
    for url in _IPGEO_ENDPOINTS:
        try:
            if proxy is not None and proxy.configured:
                raw = _geo_request_through_proxy(proxy, url, timeout)
            else:
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
