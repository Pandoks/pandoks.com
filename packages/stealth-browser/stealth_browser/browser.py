"""Production stealth browser -- the thing you actually import and use.

`StealthBrowser` is the winning configuration from benchmark.py: nodriver
driving real Google Chrome stable, headful, with a coherent identity applied
over CDP before navigation.

Design rules (each one is load-bearing -- see README):
  * REAL Chrome, not Chrome-for-Testing and not bundled Chromium -- authentic
    version string, TLS surface and JS feature set.
  * HEADFUL, never --headless -- headless Chrome has its own detectable
    rendering quirks (CreepJS scored the headless baseline 67% headless).
  * No Playwright/Selenium shim -- nodriver speaks CDP directly, so there is
    no automation-protocol handshake to fingerprint.
  * No JS-injection "stealth plugin" -- CreepJS catches the act of overwriting
    a native property; we change nothing the page can introspect.
  * Identity coherence -- timezone / locale / geo / notification permission set
    over CDP *before* the page loads, so the first fingerprint tick is clean.

Usage:
    import asyncio
    from stealth_browser.browser import StealthBrowser

    async def main():
        async with StealthBrowser() as sb:
            page = await sb.goto("https://example.com")
            html = await sb.content(page)
            print(html[:200])

    asyncio.run(main())
"""

from __future__ import annotations

import asyncio
import random

import nodriver as uc
from nodriver import cdp

from .profile import (Identity, chrome_launch_flags, chrome_path,
                      in_container)

# Resolved per-environment: $CHROME_PATH (Docker) -> OS default -> PATH.
REAL_CHROME = chrome_path()

# NOTE: there is intentionally NO JS-based WebGL/getParameter override here.
# WebGL vendor/renderer are spoofed NATIVELY by the patched binary
# (APEX_FP_WEBGL_*). A JS override -- and especially the Function.prototype.
# toString proxy a naive one needs to hide itself -- is exactly the tampering
# CreepJS's "lies" detector hunts for, so it would LOWER the stealth score.
# A prior dead _WEBGL_NORMALIZE_JS doing this was removed (2026-06-05); on a
# GPU-less host the honest fix is a real GPU matching the persona, not a JS
# lie (see stealth-chromium #6 analysis).


class StealthBrowser:
    """A real-Chrome stealth session. Async context manager."""

    def __init__(self, identity: Identity | None = None,
                 *, headless: bool = False,
                 chrome_path: str = REAL_CHROME,
                 proxy=None,
                 extra_args: list[str] | None = None):
        # headless defaults to False on purpose -- see module docstring.
        # proxy: an optional ProxyConfig (stealth.proxy.from_env()). When set,
        # all of Chrome's traffic routes through it and proxy auth is handled
        # over CDP. Leave None to connect directly.
        # extra_args: additional Chrome command-line flags appended to the
        # stealth launch flags -- e.g. --user-data-dir for a persistent
        # persona profile. Optional; empty by default.
        self.identity = identity or Identity()
        self.headless = headless
        self.chrome_path = chrome_path
        self.proxy = proxy
        self.extra_args = list(extra_args or [])
        self._browser = None

    async def __aenter__(self) -> "StealthBrowser":
        args = chrome_launch_flags(self.identity,
                                   headless=self.headless,
                                   proxy=self.proxy)
        args += self.extra_args
        self._browser = await uc.start(
            browser_executable_path=self.chrome_path,
            headless=self.headless,
            browser_args=args,
            lang=self.identity.locale,
        )
        return self

    async def __aexit__(self, *exc) -> None:
        if self._browser is not None:
            self._browser.stop()
            self._browser = None

    async def goto(self, url: str, *, settle: float = 2.0):
        """Open a tab with a coherent identity applied, navigate, return tab.

        The identity (timezone / locale / geo / notification grant) is pushed
        onto a blank tab over CDP BEFORE we navigate to `url`, so the target
        page's fingerprinting JS sees the intended identity from tick zero.
        """
        if self._browser is None:
            raise RuntimeError("use 'async with StealthBrowser() as sb:'")

        tab = await self._browser.get("about:blank")
        await self._setup_proxy_auth(tab)
        await self._apply_identity(tab)
        await tab.get(url)
        # Bring the tab to the foreground so document.hasFocus() is true and
        # the page is visibilityState 'visible'. Interaction-based challenges
        # (Cloudflare Turnstile, press-and-hold) watch for a focused, visible
        # tab with a real cursor -- a backgrounded tab looks automated.
        await self._safe(tab, cdp.page.bring_to_front())
        await tab.sleep(settle)
        await self.humanize(tab)
        return tab

    async def _setup_proxy_auth(self, tab) -> None:
        """Wire up proxy authentication over CDP.

        Chrome's --proxy-server flag carries no credentials. When the proxy
        demands auth, Chrome emits Fetch.authRequired; we answer it with the
        username/password from the ProxyConfig. Requests that are NOT auth
        challenges are continued untouched, so this adds no observable
        fingerprint -- it only satisfies the proxy handshake.
        """
        if self.proxy is None or not self.proxy.has_auth():
            return

        async def _on_auth(event):
            await self._safe(tab, cdp.fetch.continue_with_auth(
                request_id=event.request_id,
                auth_challenge_response=cdp.fetch.AuthChallengeResponse(
                    response="ProvideCredentials",
                    username=self.proxy.username,
                    password=self.proxy.password,
                )))

        async def _on_request(event):
            # not an auth challenge -- let the request proceed untouched
            await self._safe(tab, cdp.fetch.continue_request(
                request_id=event.request_id))

        tab.add_handler(cdp.fetch.AuthRequired, _on_auth)
        tab.add_handler(cdp.fetch.RequestPaused, _on_request)
        await self._safe(tab, cdp.fetch.enable(handle_auth_requests=True))

    async def human_for(self, tab) -> "Human":
        """Return a Human input driver bound to this tab's real viewport.

        Use this to drive natural mouse motion / clicking / scrolling / typing:

            tab = await sb.goto(url)
            h = await sb.human_for(tab)
            await h.read_scroll(screens=2)
            btn = await tab.find("Sign in")
            await h.click(btn)
        """
        from .human import Human  # local import avoids a cycle
        w, h = self.identity.viewport_width, self.identity.viewport_height
        try:
            # use the page's real innerWidth/innerHeight when available
            dims = await tab.evaluate(
                "JSON.stringify([window.innerWidth, window.innerHeight])",
                return_by_value=True)
            import json
            raw = dims if isinstance(dims, str) else getattr(
                getattr(dims, "deep_serialized_value", None), "value", None)
            if raw:
                w, h = json.loads(raw)
        except Exception:  # noqa: BLE001 - fall back to identity viewport
            pass
        return Human(tab, viewport=(w, h))

    async def _apply_identity(self, tab) -> None:
        idn = self.identity
        # timezone: the classic coherence "lie" if it disagrees with the exit
        # IP. The default Identity now matches the real network's IP-geo.
        await self._safe(tab, cdp.emulation.set_timezone_override(idn.timezone))
        # locale: keeps Intl / Accept-Language consistent.
        await self._safe(tab, cdp.emulation.set_locale_override(idn.locale))
        # geolocation: ONLY override when explicitly asked. A normal Chrome user
        # has not granted geolocation; pushing coordinates that disagree with
        # the IP is exactly what iphey flags as "trying to hide your location".
        if idn.override_geolocation:
            await self._safe(tab, cdp.emulation.set_geolocation_override(
                latitude=idn.latitude, longitude=idn.longitude, accuracy=80))
        # Grant notifications so the permissions/Notification pair is coherent.
        # A fresh headless-y profile leaving Notification = 'denied' is one of
        # CreepJS's "like headless" signals (the permissions-bug check).
        await self._safe(tab, cdp.browser.grant_permissions(
            permissions=[cdp.browser.PermissionType.NOTIFICATIONS],
        ))
        # NOTE on WebGL in containers: a GPU-less container renders WebGL via
        # SwiftShader. We do NOT patch the WebGL renderer string in JS --
        # CreepJS specifically detects such patches (and the toString masking
        # needed to hide them) as tampering, which RAISES the stealth %. A
        # real software GL that reports a non-SwiftShader string must come
        # from the driver layer (see Dockerfile / launch flags), not JS.
        # Patching JS to hide SwiftShader is strictly worse than SwiftShader.

    @staticmethod
    async def _safe(tab, coro) -> None:
        """Send a CDP command, swallowing failures (partial identity is OK)."""
        try:
            await tab.send(coro)
        except Exception:  # noqa: BLE001
            pass

    @staticmethod
    async def humanize(tab) -> None:
        """Inject a little real-user motion. Detectors flag perfectly inert
        sessions; a real human scrolls and pauses irregularly."""
        try:
            await tab.scroll_down(random.randint(90, 160))
            await tab.sleep(random.uniform(0.3, 0.7))
            await tab.scroll_up(random.randint(40, 90))
            await tab.sleep(random.uniform(0.2, 0.5))
        except Exception:  # noqa: BLE001 - humanizing is best-effort
            pass

    @staticmethod
    async def content(tab) -> str:
        """Return the page's current rendered HTML."""
        html = await tab.evaluate(
            "document.documentElement.outerHTML", return_by_value=True)
        if isinstance(html, str):
            return html
        deep = getattr(html, "deep_serialized_value", None)
        if deep is not None and getattr(deep, "value", None):
            return deep.value
        return str(html)

    @staticmethod
    async def eval_js(tab, expression: str):
        """Evaluate a JS expression and return its (best-effort) value."""
        return await tab.evaluate(expression, return_by_value=True)

    @staticmethod
    async def api_request(tab, url: str, *, method: str = "GET",
                          headers: dict | None = None,
                          body: str | None = None,
                          json_body: dict | None = None) -> dict:
        """Make an HTTP request to an API endpoint THROUGH the real browser.

        The request is issued via `fetch()` from inside the currently-loaded
        page, so it rides the browser's genuine network stack: real TLS/JA3
        fingerprint, real HTTP/2, and -- crucially -- the browser-generated
        `Sec-Fetch-*` and `Sec-Ch-Ua*` headers that an HTTP library (requests,
        httpx, curl) cannot forge correctly. To the API it is indistinguishable
        from a fetch a real user's browser made.

        IMPORTANT: navigate the tab to a page on (or related to) the API's
        site FIRST -- `await sb.goto("https://api-host/")` -- so the request
        carries a real Origin/Referer and any session cookies. A fetch from
        `about:blank` has no origin and looks anomalous.

        Returns {status, ok, headers, body, json?}. `json` is included when the
        response parses as JSON.

        Example:
            tab = await sb.goto("https://example.com/")
            r = await sb.api_request(tab, "https://example.com/api/items",
                                     headers={"Accept": "application/json"})
            print(r["status"], r["json"])
        """
        import json as _json

        opts: dict = {"method": method.upper()}
        hdrs = dict(headers or {})
        if json_body is not None:
            opts["body"] = _json.dumps(json_body)
            hdrs.setdefault("Content-Type", "application/json")
        elif body is not None:
            opts["body"] = body
        if hdrs:
            opts["headers"] = hdrs

        # The fetch runs in the page context -> genuine browser request.
        # We never set User-Agent / Sec-* by hand: the browser fills those in
        # itself, correctly. Forging them would create inconsistencies.
        expr = (
            "(async () => {"
            "  const r = await fetch(%s, %s);"
            "  const text = await r.text();"
            "  const h = {}; r.headers.forEach((v,k)=>h[k]=v);"
            "  return JSON.stringify({"
            "    status: r.status, ok: r.ok, headers: h, body: text"
            "  });"
            "})()" % (_json.dumps(url), _json.dumps(opts))
        )
        res = await tab.evaluate(expr, await_promise=True, return_by_value=True)
        raw = res if isinstance(res, str) else getattr(
            getattr(res, "deep_serialized_value", None), "value", "{}")
        out = _json.loads(raw or "{}")
        # opportunistically parse a JSON response body
        try:
            out["json"] = _json.loads(out.get("body", ""))
        except (ValueError, TypeError):
            pass
        return out
