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

import random

from patchright.async_api import async_playwright

from stealth_browser.human_patchright import PatchrightHuman
from stealth_browser.profile import Identity, chrome_launch_flags
from stealth_browser.proxy import from_env as proxy_from_env


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
                                                 patched_chrome_path,
                                                 real_display_size)
        import os as _os
        # The launch window must fit the REAL display: a window larger than
        # the screen it is on is the impossible-geometry tell. The screen
        # itself is never spoofed (no APEX_FP_SCREEN_* is sent) so the binary
        # reports the real display natively and stays coherent.
        real = real_display_size()
        if real is not None:
            idn.viewport_width = min(idn.viewport_width, real[0])
            idn.viewport_height = min(idn.viewport_height, real[1])
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
        # NOT set -- the browser reports the real (Xvfb) display, which is
        # truthful and coherent. Permissions are NOT pre-granted: a virgin
        # profile sits at 'prompt', and terminal (granted/denied) states on a
        # never-visited site are an automation tell. Geolocation comes from
        # the proxy's real IP.
        ctx_opts = dict(launch_kwargs)
        ctx_opts.update(
            extra_http_headers={"Accept-Language": idn.accept_language},
        )
        if self.persistent:
            # a named, on-disk profile: cookies/localStorage/history persist
            # across sessions. It keeps its own fingerprint coherence by
            # inheriting the same identity launch options on relaunch.
            # The debug port is safe on a non-default user-data-dir (Chrome
            # 136 only ignores it on the default profile).
            port = random.randint(41000, 49999)
            self.cdp_endpoint = f"http://127.0.0.1:{port}"
            ctx_opts["args"] = list(ctx_opts["args"]) + [
                f"--remote-debugging-port={port}",
            ]
            self._context = await self._pw.chromium.launch_persistent_context(
                self.persistent, **ctx_opts)
            self._browser = None
            self._page = self._context.pages[-1] if self._context.pages \
                else await self._context.new_page()
            return
        self.cdp_endpoint = None
        self._browser = await self._pw.chromium.launch(**launch_kwargs)
        self._context = await self._browser.new_context(**ctx_opts)
        self._page = await self._context.new_page()

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
        return await self._page.evaluate(expression)

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
