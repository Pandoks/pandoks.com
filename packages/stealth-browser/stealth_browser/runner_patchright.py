"""Candidate B -- patchright with real Chrome (channel='chrome').

patchright is a drop-in Playwright replacement that patches the loud automation
tells: it removes the `Runtime.enable` CDP leak Cloudflare watches for, strips
`HeadlessChrome` from the UA, and fixes `navigator.webdriver`. With
channel='chrome' it drives the real installed Google Chrome, not bundled
Chromium -- so the version string, feature set and TLS surface are all stable
real-Chrome.

Kept deliberately minimal: patchright already does the patching. We only add a
coherent identity (timezone/locale/geo) and light human motion. We do NOT add a
JS-injection "stealth plugin" -- CreepJS catches the overwrite itself, so naive
JS patching lowers the score instead of raising it.
"""

from __future__ import annotations

from patchright.async_api import async_playwright

from .profile import Identity, chrome_launch_flags


async def _new_context(p, identity: Identity, *, headless: bool):
    """A real-Chrome context with a coherent identity. No JS-patch shims."""
    flags = chrome_launch_flags(identity, headless=headless)
    # Use a persistent context: a real user has history/cookies/a profile dir.
    # An ephemeral, perfectly-empty profile is itself mildly suspicious.
    browser = await p.chromium.launch(
        channel="chrome",          # real Google Chrome, not bundled Chromium
        headless=headless,
        args=flags,
    )
    context = await browser.new_context(
        locale=identity.locale,
        timezone_id=identity.timezone,
        geolocation={"latitude": identity.latitude,
                     "longitude": identity.longitude},
        permissions=["geolocation"],
        viewport={"width": identity.viewport_width,
                  "height": identity.viewport_height},
        screen={"width": identity.screen_width,
                "height": identity.screen_height},
        device_scale_factor=identity.device_scale_factor,
        is_mobile=False,
        has_touch=False,
        color_scheme="light",
        extra_http_headers={"Accept-Language": identity.accept_language},
    )
    return browser, context


async def run_probe(url: str, probe_js: str, *, headless: bool = False) -> dict:
    identity = Identity()
    async with async_playwright() as p:
        browser, context = await _new_context(p, identity, headless=headless)
        try:
            page = await context.new_page()
            await page.goto(url, wait_until="domcontentloaded", timeout=45000)
            await page.wait_for_timeout(2000)
            await _humanize(page)
            result = await page.evaluate(probe_js)
            return result or {}
        finally:
            await context.close()
            await browser.close()


async def render_creepjs(url: str, extract_js: str, *,
                         headless: bool = False, wait: int = 14) -> dict:
    identity = Identity()
    async with async_playwright() as p:
        browser, context = await _new_context(p, identity, headless=headless)
        try:
            page = await context.new_page()
            await page.goto(url, wait_until="domcontentloaded", timeout=45000)
            await _humanize(page)
            last: dict = {}
            elapsed = 0
            while elapsed < wait:
                await page.wait_for_timeout(2000)
                elapsed += 2
                last = await page.evaluate(extract_js) or {}
                if last.get("trust") is not None and last.get("lies") is not None:
                    break
            return last
        finally:
            await context.close()
            await browser.close()


async def _humanize(page) -> None:
    """Light real-user motion. Detectors flag perfectly inert sessions."""
    try:
        await page.mouse.move(220, 180, steps=12)
        await page.mouse.move(640, 420, steps=18)
        await page.mouse.wheel(0, 240)
        await page.wait_for_timeout(400)
        await page.mouse.wheel(0, -120)
        await page.wait_for_timeout(300)
    except Exception:  # noqa: BLE001 - humanizing is best-effort
        pass
