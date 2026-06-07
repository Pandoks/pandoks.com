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


import asyncio
import base64
import json
import urllib.request

from nodriver import cdp
from stealth_browser.browser import StealthBrowser
from stealth_browser.profile import Identity, identity_for_ip_geo
from stealth_browser.human import Human
from stealth_browser.runner_nodriver import _unwrap
from stealth_browser.proxy import from_env as proxy_from_env

import os
import random

from .fp_profiles import (fp_env, patched_chrome_path, mobile_emulation_spec,
                          persona_fingerprint)
from .personas import POOL as PERSONA_POOL


def _write_locale_pref(persona_dir, accept_language: str) -> None:
    """Set navigator.languages natively via the profile's intl.accept_languages
    pref (the only no-JS-tampering way; the flags don't set the JS array).

    `persona_dir` is the Chrome --user-data-dir; the pref lives in
    <dir>/Default/Preferences. Merges into an existing (warmed) Preferences so
    cookies/history are preserved. Best-effort -- a pref write must never block a
    session. `accept_language` is the q-valued header form; we strip the q-values
    to the plain list Chrome stores (e.g. "es-ES,es,en").
    """
    import json as _json
    from pathlib import Path
    langs = ",".join(t.split(";")[0].strip()
                     for t in accept_language.split(",") if t.strip())
    if not langs:
        return
    try:
        default_dir = Path(persona_dir) / "Default"
        default_dir.mkdir(parents=True, exist_ok=True)
        pref_path = default_dir / "Preferences"
        prefs: dict = {}
        if pref_path.exists():
            try:
                prefs = _json.loads(pref_path.read_text() or "{}")
            except Exception:  # noqa: BLE001 - corrupt/partial -> start fresh
                prefs = {}
        intl = prefs.setdefault("intl", {})
        intl["accept_languages"] = langs
        intl["selected_languages"] = langs
        pref_path.write_text(_json.dumps(prefs))
    except Exception:  # noqa: BLE001 - pref write is best-effort
        pass


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
        self._patched_chrome = patched_chrome_path()
        # per-session proxy: an explicit ProxyConfig (from the request body)
        # takes priority over env defaults; env is used as fallback so
        # operator-level config keeps working. None -> direct connection.
        self._proxy = (proxy if proxy is not None
                       else (proxy_from_env() if use_proxy else None))
        self._exit_geo: dict | None = None
        # persona profile dir. ACCOUNT model: APEX_PERSONA=<account id> pins a
        # dedicated dir so the account always reuses its cookies/history; without
        # it, the rotating pool hands out any free dir (None -> ephemeral).
        _acct = os.environ.get("APEX_PERSONA", "").strip()
        self._persona = (PERSONA_POOL.acquire_named(_acct) if _acct
                         else PERSONA_POOL.acquire())
        # fingerprint (device profile + farbling seed) STABLE per persona/account
        # -- saved next to the persona and reused every session, so the account
        # is ONE fixed device over time (distinct + unlinkable across accounts).
        # Only meaningful with apex-chromium; ephemeral -> fresh per session.
        self._fp_profile, self._fp_seed = persona_fingerprint(self._persona)

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

        # PROXY IDENTITY COHERENCE, done BEFORE launch. The single strongest
        # IP-layer tell is a browser timezone/locale that disagrees with the
        # exit IP -- iphey ("trying to hide your location") and browserscan
        # ("IP timezone does not match", -10%) flag it instantly. We look the
        # exit geo up over the SAME upstream proxy + sticky session the browser
        # will use, so the geo is for the exact exit IP, then build the identity
        # from it so --lang (launch flag) AND the timezone override both agree
        # from tick zero. Done pre-launch because locale is a launch flag.
        if self._proxy is not None:
            await self._match_identity_to_proxy()

        # Align the process locale to the identity so the WORKER scope's
        # navigator.language matches the main thread. --lang only sets the main
        # thread; a Web Worker inherits its locale from the renderer process's
        # LANGUAGE/LANG env, which otherwise stays the box default (en-US) ->
        # CreepJS flags the main<->worker locale mismatch and browserscan flags
        # "webpage language does not match the system". Chrome resolves the
        # web-exposed locale from these env vars via its bundled ICU data, so no
        # glibc locale-gen is required. Inherited by the Chrome child process.
        _loc = self.identity.locale.replace("-", "_")
        os.environ["LANGUAGE"] = _loc
        os.environ["LANG"] = f"{_loc}.UTF-8"

        # navigator.languages (the JS array) is set NATIVELY by the apex-languages
        # binary patch from APEX_FP_LANGUAGES -- the ONLY coherent way to move it
        # (flags/prefs/CDP don't), so a per-exit-country locale (es-ES on a
        # Spanish IP) no longer disagrees with Intl. Comma list, q-values
        # stripped. Inert on stock Chrome (env var ignored).
        if self._patched_chrome is not None:
            os.environ["APEX_FP_LANGUAGES"] = ",".join(
                t.split(";")[0].strip()
                for t in self.identity.accept_language.split(",") if t.strip())

        # navigator.languages follows the PROFILE pref intl.accept_languages,
        # NOT --lang/--accept-lang (empirically Chrome left the JS array [en-US]
        # on a non-US exit even with --accept-lang set, so iphey flagged a
        # language<->IP mismatch). Write the pref into the persona's Preferences
        # so the array matches the exit-IP locale natively -- no JS override (a
        # JS shim to navigator.languages is exactly the tampering CreepJS hunts).
        if self._persona is not None:
            _write_locale_pref(self._persona, self.identity.accept_language)

        # PER-OS FONT ISOLATION: expose ONLY the persona-OS font set so the font
        # fingerprint matches the claimed OS (a Mac must not show Calibri, a
        # Windows box must not show Roboto). Point this session's FONTCONFIG_FILE
        # at the matching per-OS config (built by setup-fonts.sh). Linux personas
        # + missing config -> default fontconfig (the box IS Linux, so coherent).
        _font_root = os.environ.get("APEX_FONT_ROOT", "/opt/apex-fonts")
        _osd = {"Windows": "windows", "macOS": "macos",
                "Android": "android"}.get(self._fp_profile.ua_platform)
        _conf = os.path.join(_font_root, f"{_osd}.conf") if _osd else ""
        if _conf and os.path.exists(_conf):
            os.environ["FONTCONFIG_FILE"] = _conf
        else:
            os.environ.pop("FONTCONFIG_FILE", None)

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
        # Mobile (Android) personas emulate the device over CDP at runtime.
        kwargs["mobile_spec"] = mobile_emulation_spec(self._fp_profile)

        self._sb = StealthBrowser(self.identity, **kwargs)
        await self._sb.__aenter__()

    async def _match_identity_to_proxy(self) -> None:
        """Rebuild Identity from the proxy exit IP's geolocation (pre-launch).

        Looked up over the SAME upstream proxy + sticky session the browser will
        use, so the timezone/locale/geo are for the exact exit IP. Best-effort:
        on any failure the default identity stands (still internally coherent).
        """
        loop = asyncio.get_running_loop()
        geo = await loop.run_in_executor(None, self._lookup_exit_geo_via_proxy)
        if geo and geo.get("timezone"):
            self._exit_geo = geo
            self.identity = identity_for_ip_geo(geo)

    def _lookup_exit_geo_via_proxy(self) -> dict | None:
        """Fetch exit-IP geo THROUGH the upstream proxy (blocking; run in an
        executor). curl-proven endpoints: ipapi.co + ipwho.is return a proper
        IANA timezone and survive the residential exit (ipinfo/browserleaks
        reset it; get.geojs geolocates by ASN owner -> wrong). Tries each until
        one yields a timezone.
        """
        p = self._proxy
        if p is None or not p.has_auth():
            return None
        proxy_url = f"http://{p.username}:{p.password}@{p.host}:{p.port}"
        handler = urllib.request.ProxyHandler(
            {"https": proxy_url, "http": proxy_url})
        opener = urllib.request.build_opener(handler)
        for url, parse in (("https://ipapi.co/json/", self._parse_ipapi),
                           ("https://ipwho.is/", self._parse_ipwhois)):
            try:
                with opener.open(url, timeout=15) as r:
                    geo = parse(json.load(r))
                if geo.get("timezone"):
                    return geo
            except Exception:  # noqa: BLE001 - try the next endpoint
                continue
        return None

    @staticmethod
    def _parse_ipapi(d: dict) -> dict:
        return {
            "ip": d.get("ip"), "city": d.get("city"),
            "region": d.get("region"),
            "country": d.get("country_code") or d.get("country"),
            "timezone": d.get("timezone"),
            "latitude": d.get("latitude"), "longitude": d.get("longitude"),
        }

    @staticmethod
    def _parse_ipwhois(d: dict) -> dict:
        tz = d.get("timezone")
        if isinstance(tz, dict):  # ipwho.is nests timezone under .id
            tz = tz.get("id")
        return {
            "ip": d.get("ip"), "city": d.get("city"),
            "region": d.get("region"),
            "country": d.get("country_code") or d.get("country"),
            "timezone": tz,
            "latitude": d.get("latitude"), "longitude": d.get("longitude"),
        }

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

    async def idle_activity(self, seconds: float = 14.0) -> None:
        """Generate human-like BEHAVIORAL signals for ~`seconds`: curved mouse
        paths (the ghost cursor in human.py) + occasional scrolls + pauses.

        This is what behavioral anti-bot (DataDome, incolumitas's
        behavioralClassificationScore, Cloudflare's behavior layer) actually
        scores -- mouse-movement curvature/velocity, scroll cadence, idle
        jitter. Passive navigation produces NONE of it, so a behavioral
        classifier sees a perfectly inert session = bot. Call this on a tab
        whose challenge watches behavior.
        """
        import asyncio
        import time
        if self._human is None:
            return
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                await self._human.wander(n=random.randint(1, 2))
                if random.random() < 0.45:
                    await self._human.scroll(random.randint(80, 280))
                await asyncio.sleep(random.uniform(0.25, 0.8))
            except Exception:  # noqa: BLE001 - best-effort behavior
                break

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
