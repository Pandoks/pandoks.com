"""Variant 1 core -- nodriver + real Chrome (stealth-browser's winner).

Wraps stealth-browser's StealthBrowser behind the apex core interface. This is
the empirically-proven stack: real Google Chrome, headful, CDP-direct (no
Playwright handshake), coherent identity applied before navigation, zero JS
tampering.

Every core exposes the same interface so session.py is backend-agnostic:
  open()  navigate(url)  eval_js(expr)  click/type/scroll  screenshot()
  extract_text(selector?)  close()
"""

from __future__ import annotations


import base64

from nodriver import cdp
from stealth_browser.browser import StealthBrowser
from stealth_browser.profile import Identity, identity_for_ip_geo
from stealth_browser.human import Human
from stealth_browser.runner_nodriver import _unwrap
from stealth_browser.proxy import from_env as proxy_from_env, lookup_exit_geo

import os
import random

from .fp_profiles import pick_profile, fp_env, patched_chrome_path
from .personas import POOL as PERSONA_POOL


class NodriverCore:
    """A single stealth browser session backed by nodriver + real Chrome.

    When the apex-chromium patched binary is available (APEX_CHROME_PATH set),
    this core also picks a per-session host-coherent fingerprint profile and
    exports it as APEX_FP_* env vars before launch -- so the C++ patches spoof
    canvas/WebGL/audio/navigator/screen natively. With stock Chrome the env
    vars are inert and the core behaves exactly as before.

    When a proxy is configured (PROXY_HOST env var), each session routes
    through it and the Identity is rebuilt to match the proxy's exit-IP
    geolocation -- so timezone/locale/geo agree with the network, never
    contradict it.
    """

    backend = "nodriver"

    def __init__(self, identity: Identity | None = None,
                 *, headless: bool = False, use_proxy: bool = True,
                 proxy=None):
        self.identity = identity or Identity()
        self.headless = headless
        self._sb: StealthBrowser | None = None
        self._tab = None
        self._human: Human | None = None
        # per-session fingerprint profile (only meaningful with apex-chromium)
        self._fp_profile = pick_profile()
        self._fp_seed = random.getrandbits(32)
        self._patched_chrome = patched_chrome_path()
        # per-session proxy: an explicit ProxyConfig (from the request body)
        # takes priority over env defaults; env is used as fallback so
        # operator-level config keeps working. None -> direct connection.
        self._proxy = (proxy if proxy is not None
                       else (proxy_from_env() if use_proxy else None))
        self._exit_geo: dict | None = None
        # persistent persona profile -- a "lived-in" Chrome profile dir with
        # accumulated cookies/history. None -> ephemeral (pool exhausted).
        self._persona = PERSONA_POOL.acquire()

    @property
    def profile(self) -> dict:
        idn = self.identity
        p = self._fp_profile
        return {
            "backend": self.backend,
            "timezone": idn.timezone,
            "locale": idn.locale,
            "platform": idn.platform_name,
            "viewport": {"width": idn.viewport_width,
                         "height": idn.viewport_height},
            "fingerprint": {
                "patched_binary": self._patched_chrome is not None,
                "device_profile": p.label,
                "webgl_renderer": p.webgl_renderer,
                "seed": self._fp_seed,
            },
            "proxy": {
                "active": self._proxy is not None,
                "exit_geo": self._exit_geo,
            },
            "persona": (str(self._persona.name)
                        if self._persona is not None else "ephemeral"),
        }

    async def open(self) -> None:
        # Export the per-session fingerprint into the environment so the
        # apex-chromium patched binary picks it up at launch. Set on os.environ
        # because nodriver spawns Chrome as a child process and inherits it.
        if self._patched_chrome is not None:
            os.environ.update(fp_env(self._fp_profile, self._fp_seed))

        # UA-STRING COHERENCE is handled NATIVELY in the binary (apex-ua-platform
        # in user_agent_utils.cc swaps the reduced-UA OS token from the same
        # APEX_FP_UA_PLATFORM env), NOT via --user-agent: the flag disables the
        # whole UA Client Hints API (navigator.userAgentData becomes null -- a
        # worse tell than the UA mismatch it fixes).
        kwargs: dict = {"headless": self.headless}
        if self._patched_chrome is not None:
            kwargs["chrome_path"] = self._patched_chrome
        if self._proxy is not None:
            kwargs["proxy"] = self._proxy
        # persistent persona profile: a "lived-in" user_data_dir with real
        # accumulated cookies/history. Falls back to ephemeral when the pool
        # is exhausted (still isolated, just not warmed).
        if self._persona is not None:
            kwargs["extra_args"] = [f"--user-data-dir={self._persona}"]

        self._sb = StealthBrowser(self.identity, **kwargs)
        await self._sb.__aenter__()

        # With a proxy, make the identity agree with the exit IP. A US
        # fingerprint on a German exit is the classic coherence "lie".
        if self._proxy is not None:
            await self._match_identity_to_proxy()

    async def _match_identity_to_proxy(self) -> None:
        """Rebuild Identity from the proxy exit IP's geolocation."""
        try:
            # look up the exit geo through the proxied browser itself
            tab = await self._sb._browser.get("about:blank")  # type: ignore[union-attr]
            import json as _json
            raw = await tab.evaluate(
                "fetch('https://ipapi.co/json/').then(r=>r.text())",
                await_promise=True, return_by_value=True)
            payload = raw if isinstance(raw, str) else getattr(
                getattr(raw, "deep_serialized_value", None), "value", None)
            if payload:
                geo_raw = _json.loads(payload)
                geo = {
                    "ip": geo_raw.get("ip"),
                    "city": geo_raw.get("city"),
                    "region": geo_raw.get("region"),
                    "country": geo_raw.get("country_code")
                    or geo_raw.get("country"),
                    "timezone": geo_raw.get("timezone"),
                    "latitude": geo_raw.get("latitude"),
                    "longitude": geo_raw.get("longitude"),
                }
                if geo.get("timezone"):
                    self._exit_geo = geo
                    self.identity = identity_for_ip_geo(geo)
        except Exception:  # noqa: BLE001 - proxy geo match is best-effort
            pass

    async def navigate(self, url: str) -> dict:
        if self._sb is None:
            raise RuntimeError("core not opened")
        # nodriver's background update_targets() can transiently raise
        # "No target with given id found" on fast-changing Chromium builds
        # (a target closed between get_targets and attach). It is a benign
        # housekeeping race -- retry the navigation once before giving up.
        last_err: Exception | None = None
        for attempt in range(2):
            try:
                self._tab = await self._sb.goto(url, settle=2.0)
                self._human = await self._sb.human_for(self._tab)
                title = await self._sb.eval_js(
                    self._tab, "document.title") or ""
                final_url = await self._sb.eval_js(
                    self._tab, "location.href") or url
                return {
                    "url": url,
                    "finalUrl": final_url if isinstance(final_url, str)
                    else url,
                    "title": title if isinstance(title, str) else "",
                    "status": 200,  # nodriver does not surface HTTP status
                }
            except Exception as e:  # noqa: BLE001
                last_err = e
                if attempt == 0:
                    await __import__("asyncio").sleep(1.5)
        raise RuntimeError(f"navigate failed after retry: {last_err}")

    async def eval_js(self, expression: str):
        if self._tab is None:
            raise RuntimeError("navigate first")
        # await_promise=True so probes that return a Promise (e.g. the async
        # WebRTC leak probe) settle before the value is read. It is a no-op for
        # plain values, so it is safe to pass unconditionally.
        result = await self._tab.evaluate(
            expression, await_promise=True, return_by_value=True)
        # return plain JSON-able value; _unwrap normalizes dicts
        if isinstance(result, (str, int, float, bool)) or result is None:
            return result
        return _unwrap(result)

    async def click(self, selector: str) -> None:
        el = await self._tab.select(selector)
        await self._human.click(el)

    async def type_text(self, selector: str, text: str) -> None:
        el = await self._tab.select(selector)
        await self._human.type_into(el, text)

    async def scroll(self, amount: int) -> None:
        await self._human.scroll(amount)

    async def screenshot(self) -> bytes:
        result = await self._tab.send(
            cdp.page.capture_screenshot(format_="png"))
        return base64.b64decode(result) if result else b""

    async def extract_text(self, selector: str | None = None) -> str:
        if selector:
            expr = (f"(document.querySelector({selector!r})||{{}})"
                    f".innerText || ''")
        else:
            expr = "document.body ? document.body.innerText : ''"
        text = await self._sb.eval_js(self._tab, expr)
        return text if isinstance(text, str) else ""

    async def close(self) -> None:
        if self._sb is not None:
            await self._sb.__aexit__(None, None, None)
            self._sb = None
            self._tab = None
            self._human = None
        # return the persona to the pool so another session can reuse its
        # warmed profile. Done after the browser closes (Chrome holds the dir
        # lock until exit).
        PERSONA_POOL.release(self._persona)
        self._persona = None

    # ----- session-clone (shared-login multi-session) --------------------
    async def dump_state(self) -> dict:
        """Capture cookies + per-origin storage via CDP for hand-off."""
        cookies = await self._tab.send(
            __import__("nodriver").cdp.network.get_all_cookies())
        cookie_list = [
            {"name": c.name, "value": c.value, "domain": c.domain,
             "path": c.path, "expires": c.expires,
             "httpOnly": c.http_only, "secure": c.secure,
             "sameSite": (c.same_site.value if c.same_site else None)}
            for c in cookies
        ]
        # localStorage: snapshot the current origin's storage. Cross-origin
        # storage would require visiting each origin -- callers can do that
        # explicitly via navigate+/eval if they need multi-origin clones.
        ls = await self._sb.eval_js(
            self._tab,
            "(() => { const o = {}; "
            "for (let i=0; i<localStorage.length; i++) {"
            " const k = localStorage.key(i); o[k] = localStorage.getItem(k); }"
            " return o; })()",
        ) or {}
        cur_origin = await self._sb.eval_js(self._tab, "location.origin") or ""
        return {
            "cookies": cookie_list,
            "origins": ([{"origin": cur_origin, "localStorage": [
                {"name": k, "value": v} for k, v in ls.items()
            ]}] if cur_origin and ls else []),
        }

    async def restore_state(self, state: dict) -> None:
        """Inject cookies via CDP (call BEFORE first navigation)."""
        if not state or not state.get("cookies"):
            self._pending_origins = state.get("origins", []) if state else []
            return
        nd = __import__("nodriver")
        cdp_cookies = []
        for c in state["cookies"]:
            kwargs = {"name": c["name"], "value": c["value"]}
            for k in ("domain", "path", "expires", "secure"):
                if c.get(k) is not None:
                    kwargs[k] = c[k]
            if c.get("httpOnly") is not None:
                kwargs["http_only"] = c["httpOnly"]
            cdp_cookies.append(nd.cdp.network.CookieParam(**kwargs))
        await self._tab.send(nd.cdp.network.set_cookies(cdp_cookies))
        self._pending_origins = state.get("origins") or []

    async def _flush_pending_origins(self) -> None:
        for origin in getattr(self, "_pending_origins", []):
            try:
                tab = await self._sb.goto(origin["origin"], settle=1.0)
                for kv in origin.get("localStorage") or []:
                    await self._sb.eval_js(
                        tab,
                        f"localStorage.setItem({__import__('json').dumps(kv['name'])},"
                        f" {__import__('json').dumps(kv['value'])})",
                    )
            except Exception:  # noqa: BLE001 - best-effort
                continue
        self._pending_origins = []
