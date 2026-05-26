"""Candidate A -- nodriver driving real Chrome 148.

nodriver connects to Chrome's DevTools port over a plain WebSocket with NO
Playwright/Selenium layer in between. That is the point: there is no
accessibility shim, no Playwright `Runtime.enable` handshake, so the
automation-protocol fingerprint -- the decisive 2026 detection vector -- is
absent. The browser itself is unmodified real Chrome, so TLS/HTTP2/JS surfaces
are all authentic for free.

Identity coherence (timezone / locale / geolocation) is applied over CDP via
Emulation.setTimezoneOverride etc. *before* the page navigates -- so the page's
fingerprinting JS sees the intended, coherent identity from its first tick, not
the host machine's real timezone.
"""

from __future__ import annotations

import nodriver as uc
from nodriver import cdp

from .profile import Identity, chrome_launch_flags, chrome_path

# Real Google Chrome stable, not Chrome-for-Testing. Resolved per-environment.
REAL_CHROME = chrome_path()


async def _start(identity: Identity, *, headless: bool):
    """Launch real Chrome via nodriver with our launch flags."""
    return await uc.start(
        browser_executable_path=REAL_CHROME,
        headless=headless,
        browser_args=chrome_launch_flags(identity, headless=headless),
        lang=identity.locale,
    )


async def _apply_identity(tab, identity: Identity) -> None:
    """Push timezone / locale / geo emulation onto the tab over CDP.

    Done on a blank tab BEFORE navigating to the target, so the override is
    live before any page script reads Intl/Date/geolocation.
    """
    try:
        await tab.send(cdp.emulation.set_timezone_override(identity.timezone))
    except Exception:  # noqa: BLE001 - keep going; partial identity still better
        pass
    try:
        await tab.send(cdp.emulation.set_locale_override(identity.locale))
    except Exception:  # noqa: BLE001
        pass
    try:
        await tab.send(cdp.emulation.set_geolocation_override(
            latitude=identity.latitude,
            longitude=identity.longitude,
            accuracy=80,
        ))
    except Exception:  # noqa: BLE001
        pass


async def _open(browser, identity: Identity, url: str):
    """Open a blank tab, apply identity overrides, then navigate to url."""
    # start on about:blank so emulation lands before the target page loads
    tab = await browser.get("about:blank")
    await _apply_identity(tab, identity)
    await tab.get(url)
    return tab


async def run_probe(url: str, probe_js: str, *, headless: bool = False) -> dict:
    """Launch real Chrome via nodriver, navigate, return the probe result."""
    identity = Identity()
    browser = await _start(identity, headless=headless)
    try:
        tab = await _open(browser, identity, url)
        await tab.sleep(2)            # let the page run its fingerprinting JS
        await _humanize(tab)
        result = await tab.evaluate(
            _as_expression(probe_js), return_by_value=True)
        return _unwrap(result)
    finally:
        browser.stop()


async def render_creepjs(url: str, extract_js: str, *,
                         headless: bool = False, wait: int = 26) -> dict:
    """Render the CreepJS page and scrape its verdict after it computes.

    CreepJS computes for ~15-20s. We poll the extractor until it reports a
    decisive verdict (headless/stealth percentages resolved).
    """
    identity = Identity()
    browser = await _start(identity, headless=headless)
    try:
        tab = await _open(browser, identity, url)
        await _humanize(tab)
        deadline = wait
        last: dict = {}
        while deadline > 0:
            await tab.sleep(3)
            deadline -= 3
            last = _unwrap(await tab.evaluate(
                _as_expression(extract_js), return_by_value=True))
            if last.get("ready"):
                break
        return last
    finally:
        browser.stop()


async def _humanize(tab) -> None:
    """A little real-user motion: scroll + move. Detectors watch for inertness."""
    try:
        await tab.scroll_down(120)
        await tab.sleep(0.4)
        await tab.scroll_up(60)
        await tab.sleep(0.3)
    except Exception:  # noqa: BLE001 - humanizing is best-effort
        pass


def _as_expression(fn_js: str) -> str:
    """checks.PROBE_JS / creepjs.EXTRACT_JS are arrow functions `() => {...}`.

    nodriver.evaluate runs a JS *expression*, not a function. Wrap the arrow
    function in an immediately-invoked call so it executes: `(() => {...})()`.
    """
    return f"({fn_js.strip()})()"


def _deep(node):
    """Decode a CDP DeepSerializedValue tree into plain Python."""
    t = getattr(node, "type_", None)
    v = getattr(node, "value", None)
    if t is None and isinstance(node, dict):
        t, v = node.get("type"), node.get("value")
    if t == "object":
        out = {}
        for pair in (v or []):
            k, child = pair
            out[k] = _deep(child)
        return out
    if t == "array":
        return [_deep(child) for child in (v or [])]
    if t in ("undefined", "null"):
        return None
    if t is None:
        return node
    return v


def _unwrap(value):
    """Normalize any nodriver.evaluate output to a plain dict."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        return {}
    deep = getattr(value, "deep_serialized_value", None)
    if deep is not None:
        decoded = _deep(deep)
        return decoded if isinstance(decoded, dict) else {}
    if hasattr(value, "value") and value.value is not None:
        v = value.value
        return v if isinstance(v, dict) else {}
    if isinstance(value, list):
        out = {}
        for pair in value:
            try:
                k, meta = pair
                out[k] = meta.get("value") if isinstance(meta, dict) else meta
            except (ValueError, TypeError):
                continue
        return out
    return {}
