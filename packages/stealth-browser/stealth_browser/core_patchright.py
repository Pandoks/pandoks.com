"""Variant 2 core -- patchright + real Chrome (channel='chrome').

The same apex core interface as NodriverCore, but backed by patchright driving
real Google Chrome. patchright patches the loud automation tells (Runtime.enable
leak, HeadlessChrome UA, navigator.webdriver) but still performs a Playwright
CDP handshake -- the variant the four-way benchmark exists to measure against
the nodriver core.

Identity coherence (timezone/locale/geo) is applied via new_context options,
mirroring stealth-browser/runner_patchright.py.
"""

from __future__ import annotations


from patchright.async_api import async_playwright

from stealth_browser.profile import Identity, chrome_launch_flags
from stealth_browser.proxy import from_env as proxy_from_env


class PatchrightCore:
    """A single stealth browser session backed by patchright + real Chrome."""

    backend = "patchright"

    def __init__(self, identity: Identity | None = None,
                 *, headless: bool = False, use_proxy: bool = True,
                 proxy=None):
        self.identity = identity or Identity()
        self.headless = headless
        self._pw = None
        self._browser = None
        self._context = None
        self._page = None
        # explicit per-session ProxyConfig wins; env is the fallback.
        self._proxy = (proxy if proxy is not None
                       else (proxy_from_env() if use_proxy else None))

    @property
    def profile(self) -> dict:
        idn = self.identity
        return {
            "backend": self.backend,
            "timezone": idn.timezone,
            "locale": idn.locale,
            "platform": idn.platform_name,
            "viewport": {"width": idn.viewport_width,
                         "height": idn.viewport_height},
            "proxy": {"active": self._proxy is not None},
        }

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
        launch_kwargs: dict = {
            "channel": "chrome",  # real Google Chrome, not bundled Chromium
            "headless": self.headless,
            "args": chrome_launch_flags(idn, headless=self.headless),
            # Playwright injects --enable-automation as a DEFAULT arg (outside
            # our args list above); strip it so the launcher-hygiene guarantee
            # holds for this backend too. patchright also removes it, but
            # making it explicit means a patchright behaviour change can't
            # silently re-cloak us.
            "ignore_default_args": ["--enable-automation"],
        }
        # use the apex-chromium patched binary when available so the C++
        # fingerprint patches are active for this variant too.
        #
        # The APEX_FP_* fingerprint config MUST be passed via launch(env=...):
        # Playwright's driver subprocess froze its environment when
        # async_playwright().start() ran above, so a later os.environ.update
        # would NOT reach the spawned Chrome. `env=` sets the child process
        # environment explicitly and reliably.
        from fp_profiles import (pick_profile, fp_env, patched_chrome_path)
        import os as _os
        patched = patched_chrome_path()
        if patched is not None:
            launch_kwargs["executable_path"] = patched
            launch_kwargs.pop("channel", None)  # explicit path overrides channel
            self._fp_profile = pick_profile()
            self._fp_seed = __import__("random").getrandbits(32)
            # full child env = inherited env + the APEX_FP_* overrides
            launch_kwargs["env"] = {
                **_os.environ,
                **fp_env(self._fp_profile, self._fp_seed),
            }
        proxy = self._proxy_dict()
        if proxy is not None:
            launch_kwargs["proxy"] = proxy
        self._browser = await self._pw.chromium.launch(**launch_kwargs)
        self._context = await self._browser.new_context(
            locale=idn.locale,
            timezone_id=idn.timezone,
            geolocation={"latitude": idn.latitude, "longitude": idn.longitude},
            permissions=["geolocation", "notifications"],
            viewport={"width": idn.viewport_width,
                      "height": idn.viewport_height},
            screen={"width": idn.screen_width, "height": idn.screen_height},
            device_scale_factor=idn.device_scale_factor,
            is_mobile=False,
            has_touch=False,
            color_scheme="light",
            extra_http_headers={"Accept-Language": idn.accept_language},
        )
        self._page = await self._context.new_page()

    async def navigate(self, url: str) -> dict:
        resp = await self._page.goto(
            url, wait_until="domcontentloaded", timeout=45000)
        # light human motion -- detectors flag inert sessions
        try:
            await self._page.mouse.move(220, 180, steps=12)
            await self._page.mouse.move(640, 420, steps=18)
            await self._page.mouse.wheel(0, 240)
            await self._page.wait_for_timeout(400)
            await self._page.mouse.wheel(0, -120)
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
        await self._page.click(selector)

    async def type_text(self, selector: str, text: str) -> None:
        await self._page.fill(selector, "")
        await self._page.type(selector, text, delay=80)

    async def scroll(self, amount: int) -> None:
        await self._page.mouse.wheel(0, amount)

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
        if self._pw is not None:
            await self._pw.stop()
        self._pw = self._browser = self._context = self._page = None
