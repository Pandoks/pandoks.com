"""Variant 2 core -- patchright + real Chrome (channel='chrome').

The same apex core interface as NodriverCore, but backed by patchright driving
real Google Chrome. patchright patches the loud automation tells (Runtime.enable
leak, HeadlessChrome UA, navigator.webdriver) but still performs a Playwright
CDP handshake -- the variant the four-way benchmark exists to measure against
the nodriver core.

Identity coherence (timezone/locale) is applied via the OS environment
(TZ/LANG/LC_ALL on launch), NOT via CDP Emulation overrides -- those are a
verified detection surface. Rendering uses the real (Xvfb) display directly.
"""

from __future__ import annotations

import json
import os
import random
import shutil
import tempfile

from patchright.async_api import async_playwright

from stealth_browser.human_patchright import PatchrightHuman
from stealth_browser.profile import Identity, chrome_launch_flags
from stealth_browser.proxy import from_env as proxy_from_env


def _seed_profile_prefs(profile_dir: str) -> None:
    """Pre-seed the profile Preferences with the fingerprint-stability prefs.

    The real-display binary is Helium (a Chromium fork). Its built-in
    anti-fingerprinting noise randomizes navigator.hardwareConcurrency per
    renderer and injects WebAudio jitter, so the same render gives a different
    hash every time (round-3 F18/F22) -- both are off-switchable only via the
    profile prefs, not the command line. The WebRTC IP-handling pref restores
    real-Chrome candidate gathering: Helium's ungoogled-chromium WebRTC
    restriction patch hides local IPs so hard that ICE emits ZERO candidates
    (round-3 F19). Helium prefs are inert in the container's stealth-chromium
    build, so the same seed is harmless there.
    """
    default_dir = os.path.join(profile_dir, "Default")
    os.makedirs(default_dir, exist_ok=True)
    path = os.path.join(default_dir, "Preferences")
    prefs: dict = {}
    if os.path.exists(path):
        try:
            with open(path) as f:
                prefs = json.load(f)
        except (json.JSONDecodeError, OSError):
            prefs = {}
    helium = prefs.setdefault("helium", {})
    helium.setdefault("noise", {})["enabled"] = False
    prefs.setdefault("webrtc", {})["ip_handling_policy"] = "default"
    with open(path, "w") as f:
        json.dump(prefs, f)


class PatchrightCore:
    """A single stealth browser session backed by patchright + real Chrome."""

    backend = "patchright"

    def __init__(self, identity: Identity | None = None,
                 *, headless: bool = False, use_proxy: bool = True,
                 proxy=None, persistent: str | None = None):
        self.identity = identity or Identity()
        self.headless = headless
        # a name under the profiles volume (e.g. /profiles/<name>) that makes
        # the session's cookies/localStorage persist across restarts
        self.persistent = persistent
        self.cdp_endpoint: str | None = None
        self._pw = None
        self._browser = None
        self._context = None
        self._page = None
        self._human = None
        # temp user-data-dir backing non-persistent sessions (removed on close)
        self._profile_dir: str | None = None
        # explicit per-session ProxyConfig wins; env is the fallback.
        self._proxy = (proxy if proxy is not None
                       else (proxy_from_env() if use_proxy else None))

    @property
    def profile(self) -> dict:
        idn = self.identity
        d = {
            "backend": self.backend,
            "timezone": idn.timezone,
            "locale": idn.locale,
            "platform": idn.platform_name,
            "rendering": "real display (no Emulation override)",
            "proxy": {"active": self._proxy is not None},
        }
        if self.persistent:
            d["persistent"] = self.persistent
            d["cdp"] = self.cdp_endpoint
        return d

    def _human(self):
        """Lazily build the human-input driver for the current page."""
        if self._human is None or self._human.page is not self._page:
            self._human = PatchrightHuman(self._page)
        return self._human

    def _proxy_dict(self) -> dict | None:
        """Translate a ProxyConfig into Playwright's proxy option shape."""
        p = self._proxy
        if p is None:
            return None
        d: dict = {"server": f"{p.scheme}://{p.host}:{p.port}"}
        if p.has_auth():
            d["username"] = p.username
            d["password"] = p.password
        return d

    async def open(self) -> None:
        idn = self.identity
        self._pw = await async_playwright().start()
        from stealth_browser.fp_profiles import (pick_profile, fp_env,
                                                 patched_chrome_path)
        import os as _os
        # Identity (timezone/locale) is set via the OS environment, NOT via
        # Playwright's context options: locale= / timezone_id= ride the CDP
        # Emulation.* domains, which are a verified detection surface
        # (rebrowser's sensitive-methods list). Chrome reads TZ and LANG
        # natively, so the same coherence with zero Emulation traffic.
        # The same env= caveat as below applies: it must go via launch(env=).
        identity_env = {
            "TZ": idn.timezone,
            "LANG": idn.locale.replace("-", "_") + ".UTF-8",
            "LC_ALL": idn.locale.replace("-", "_") + ".UTF-8",
        }
        launch_kwargs: dict = {
            "channel": "chrome",  # real Google Chrome, not bundled Chromium
            "headless": self.headless,
            "args": chrome_launch_flags(idn, headless=self.headless),
        }
        # use the apex-chromium patched binary when available so the C++
        # fingerprint patches are active for this variant too.
        #
        # The env config MUST be passed via launch(env=...): Playwright's
        # driver subprocess froze its environment when async_playwright()
        # .start() ran above, so a later os.environ.update would NOT reach
        # the spawned Chrome. `env=` sets the child process environment
        # explicitly and reliably.
        patched = patched_chrome_path()
        if patched is not None:
            launch_kwargs["executable_path"] = patched
            launch_kwargs.pop("channel", None)  # explicit path overrides channel
            self._fp_profile = pick_profile()
            self._fp_seed = __import__("random").getrandbits(32)
            # full child env = inherited env + APEX_FP_* overrides + identity
            launch_kwargs["env"] = {
                **_os.environ,
                **identity_env,
                **fp_env(self._fp_profile, self._fp_seed),
            }
        else:
            launch_kwargs["env"] = {**_os.environ, **identity_env}
        proxy = self._proxy_dict()
        if proxy is not None:
            launch_kwargs["proxy"] = proxy
        # Context options kept to the non-Emulation minimum: viewport/screen/
        # device_scale_factor/color_scheme also ride Emulation.*, so they are
        # NOT set -- the browser reports the real display. The two context
        # options below are the exception, with the reasons:
        # no_viewport: patchright force-emulates its default 1280x720
        # viewport (innerWidth/Height AND screen) on every page unless
        # explicitly disabled. A real outer (the OS window) next to an
        # emulated inner/screen is the impossible-geometry tell (round-2 F9:
        # outer 960x540 < inner 1512x859). With it off, every page reports
        # the real window's inner/outer and the real screen -- coherent by
        # construction. In the container chrome_launch_flags sizes the window
        # to the Xvfb screen instead (outer >= inner still holds there).
        # Permissions are NOT pre-granted: a virgin profile sits at 'prompt',
        # and terminal (granted/denied) states on a never-visited site are an
        # automation tell. Geolocation comes from the proxy's real IP.
        ctx_opts = {
            "no_viewport": True,
            "extra_http_headers": {"Accept-Language": idn.accept_language},
        }
        # Every session launches through launch_persistent_context against a
        # profile dir we control, so the fingerprint-stability prefs
        # (_seed_profile_prefs) are pre-seeded before Chrome reads them. A
        # non-persistent session gets a fresh throwaway dir (same lifetime as
        # patchright's built-in temp profile); a persistent one reuses the
        # named path. Both keep cookies/localStorage living only inside the
        # session.
        if self.persistent:
            profile_dir = self.persistent
            self._profile_dir = None
        else:
            profile_dir = tempfile.mkdtemp(prefix="stealth-session-")
            self._profile_dir = profile_dir
        _seed_profile_prefs(profile_dir)
        # a named profile keeps its own CDP endpoint for attach/debug, like
        # any real device that stays reachable
        port = random.randint(41000, 49999)
        self.cdp_endpoint = f"http://127.0.0.1:{port}"
        launch_opts = dict(launch_kwargs, **ctx_opts)
        launch_opts["args"] = list(launch_opts["args"]) + [
            f"--remote-debugging-port={port}",
        ]
        self._context = await self._pw.chromium.launch_persistent_context(
            profile_dir, **launch_opts)
        self._browser = None
        self._page = self._context.pages[-1] if self._context.pages \
            else await self._context.new_page()

    async def navigate(self, url: str) -> dict:
        await self._flush_pending_origins()
        resp = await self._page.goto(
            url, wait_until="domcontentloaded", timeout=45000)
        # light human motion -- detectors flag inert sessions
        try:
            await self._human().move_to(220, 180)
            await self._human().move_to(640, 420)
            await self._human().scroll(240)
            await self._human().dwell(0.3, 0.7)
        except Exception:  # noqa: BLE001
            pass
        return {
            "url": url,
            "finalUrl": self._page.url,
            "title": await self._page.title(),
            "status": resp.status if resp else None,
        }

    async def eval_js(self, expression: str):
        return await self._eval_js_cdp(expression)

    async def _eval_js_cdp(self, expression: str):
        """Evaluate in the page via CDP Runtime.evaluate.

        Playwright's page.evaluate wraps the expression in a driver function
        and evaluates it with Runtime.callFunctionOn, which leaks a wrapper
        frame into Error.stack: 'eval at evaluate (:403:30), <anonymous>:N'
        (round-3 F21). Raw Runtime.evaluate reports the clean
        'at <anonymous>:1:1' a real Chrome eval shows. returnByValue +
        awaitPromise keep the page.evaluate semantics (serializable result,
        awaited promises). Falls back to page.evaluate on any protocol error.
        """
        session = await self._context.new_cdp_session(self._page)
        try:
            r = await session.send("Runtime.evaluate", {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
                "userGesture": True,
            })
        except Exception:  # noqa: BLE001 - fall back to the wrapper eval
            return await self._page.evaluate(expression)
        finally:
            try:
                await session.detach()
            except Exception:  # noqa: BLE001
                pass
        if r.get("exceptionDetails"):
            raise RuntimeError(
                r["exceptionDetails"].get("exception", {}).get(
                    "description", "eval failed"))
        res = r.get("result", {})
        if res.get("type") == "undefined":
            return None
        return res.get("value")

    async def click(self, selector: str) -> None:
        # human-like: curve in, dwell, press-hold-release (not one instant
        # isTrusted-shaped jump)
        await self._human().click(selector)

    async def type_text(self, selector: str, text: str) -> None:
        # human-like: click into the field, then type with variable timing
        await self._human().type_into(selector, text)

    async def scroll(self, amount: int) -> None:
        # human-like: several variable wheel ticks, not one jump
        await self._human().scroll(amount)

    async def screenshot(self) -> bytes:
        return await self._page.screenshot(type="png")

    async def extract_text(self, selector: str | None = None) -> str:
        if selector:
            loc = self._page.locator(selector).first
            return (await loc.inner_text()) or ""
        return (await self._page.locator("body").inner_text()) or ""

    async def close(self) -> None:
        if self._context is not None:
            await self._context.close()
        if self._browser is not None:
            await self._browser.close()
        if self._profile_dir is not None:
            shutil.rmtree(self._profile_dir, ignore_errors=True)
            self._profile_dir = None

    # ----- session-clone (shared-login multi-session) --------------------
    # The key use case: caller logs in via session A (one human-like flow),
    # then spawns N child sessions that share A's cookies/localStorage so
    # they're already authenticated. Each child gets a fresh FINGERPRINT and
    # fresh PROXY peer -- looking to the server like the user signing in
    # from many different devices, which is normal real-user behaviour.
    async def dump_state(self) -> dict:
        """Capture cookies + localStorage + sessionStorage for hand-off."""
        # storage_state() is Playwright's first-class API for exactly this --
        # returns a JSON-serializable dict that includes both.
        return await self._context.storage_state()

    async def restore_state(self, state: dict) -> None:
        """Inject cookies (must be called BEFORE the first navigation)."""
        if not state:
            return
        if state.get("cookies"):
            await self._context.add_cookies(state["cookies"])
        # localStorage/sessionStorage are restored by navigating to each
        # origin and setting them -- defer to the first navigate() call.
        self._pending_origins = state.get("origins") or []

    async def _flush_pending_origins(self) -> None:
        for origin in getattr(self, "_pending_origins", []):
            try:
                # set each origin's localStorage by visiting it and
                # injecting via a one-shot script.
                await self._page.goto(origin["origin"])
                kv = origin.get("localStorage") or []
                await self._page.evaluate(
                    "(items) => { for (const it of items) "
                    "localStorage.setItem(it.name, it.value); }",
                    kv,
                )
            except Exception:  # noqa: BLE001 - best-effort
                continue
        self._pending_origins = []
