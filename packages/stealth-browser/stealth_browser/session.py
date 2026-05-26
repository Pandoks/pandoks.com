"""Session manager -- owns the browser lifecycle behind the HTTP service.

Ported from headless-stealth/src/service/sessions.ts. One browser process per
session (full isolation -- separate profile, no shared state). Sessions
idle-expire so leaked sessions do not pile up browser processes.

The stealth backend is pluggable: NodriverCore (Variant 1) or PatchrightCore
(Variant 2), selected by the APEX_CORE env var. Both expose the identical core
interface, so this manager is backend-agnostic.
"""

from __future__ import annotations


import asyncio
import os
import time
import uuid

from stealth_browser.profile import Identity

from .core_nodriver import NodriverCore
from .core_patchright import PatchrightCore


class ServiceError(Exception):
    """An error carrying an HTTP status code."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _make_core(headless: bool, proxy=None, profile_label: str | None = None):
    """Build a core for the configured backend (APEX_CORE env var).

    `proxy` is an optional ProxyConfig overriding the env-var default.
    `profile_label` is an optional device-profile selector ("m1 pro",
    "rtx 3060", exact label, etc.) -- substring-matched against the
    fp_profiles registry. Falls through to host-coherent random when None
    or not matched.
    """
    backend = os.environ.get("APEX_CORE", "nodriver").lower()
    identity = Identity()
    # Per-session APEX_PROFILE override -- temporarily set it so the core's
    # pick_profile() in __init__ picks the right one, then restore so global
    # default behaviour returns. Threadsafe enough for the manager's lock.
    prev = os.environ.get("APEX_PROFILE")
    if profile_label:
        os.environ["APEX_PROFILE"] = profile_label
    try:
        if backend == "patchright":
            return PatchrightCore(identity, headless=headless, proxy=proxy)
        if backend == "nodriver":
            return NodriverCore(identity, headless=headless, proxy=proxy)
        raise ServiceError(500, f"unknown APEX_CORE: {backend!r}")
    finally:
        if profile_label:
            if prev is None:
                os.environ.pop("APEX_PROFILE", None)
            else:
                os.environ["APEX_PROFILE"] = prev


class _ManagedSession:
    __slots__ = ("id", "core", "last_used", "lock")

    def __init__(self, sid: str, core):
        self.id = sid
        self.core = core
        self.last_used = time.monotonic()
        self.lock = asyncio.Lock()  # serialize ops on one session's browser


class SessionManager:
    """Owns per-session browsers, idle expiry, and concurrency limits."""

    def __init__(self, *, idle_s: float = 300.0, max_sessions: int = 10):
        self.idle_s = idle_s
        self.max_sessions = max_sessions
        self._sessions: dict[str, _ManagedSession] = {}
        self._sweeper: asyncio.Task | None = None

    def start(self) -> None:
        if self._sweeper is None:
            self._sweeper = asyncio.create_task(self._sweep_loop())

    async def create(self, headless: bool = False, proxy=None,
                     parent_sid: str | None = None,
                     profile_label: str | None = None) -> dict:
        """Create one isolated session.

        `proxy` is an optional ProxyConfig built from the request body via
        `stealth.proxy.from_dict`. None means "use the env default" (which is
        in turn None if PROXY_HOST isn't set -- i.e. direct connection).

        `parent_sid` (optional): clone cookies + localStorage from an existing
        session. The new session keeps its OWN fresh fingerprint + proxy peer,
        so it looks to the server like the same authenticated user signing in
        from a new device/IP. This is the shared-login multi-session pattern.
        """
        if len(self._sessions) >= self.max_sessions:
            raise ServiceError(
                429, f"session limit reached ({self.max_sessions})")
        parent_state = None
        if parent_sid is not None:
            parent = self._get(parent_sid)
            async with parent.lock:
                parent_state = await parent.core.dump_state()
        core = _make_core(headless, proxy=proxy, profile_label=profile_label)
        await core.open()
        if parent_state:
            await core.restore_state(parent_state)
        sid = str(uuid.uuid4())
        self._sessions[sid] = _ManagedSession(sid, core)
        profile = dict(core.profile)
        if parent_sid is not None:
            profile["cloned_from"] = parent_sid
        return {"id": sid, "profile": profile}

    def _get(self, sid: str) -> _ManagedSession:
        s = self._sessions.get(sid)
        if s is None:
            raise ServiceError(404, f"no such session: {sid}")
        s.last_used = time.monotonic()
        return s

    async def navigate(self, sid: str, url: str) -> dict:
        s = self._get(sid)
        async with s.lock:
            result = await s.core.navigate(url)
        result["sessionId"] = sid
        return result

    async def eval_js(self, sid: str, expression: str):
        s = self._get(sid)
        async with s.lock:
            return await s.core.eval_js(expression)

    async def click(self, sid: str, selector: str) -> None:
        s = self._get(sid)
        async with s.lock:
            await s.core.click(selector)

    async def type_text(self, sid: str, selector: str, text: str) -> None:
        s = self._get(sid)
        async with s.lock:
            await s.core.type_text(selector, text)

    async def scroll(self, sid: str, amount: int) -> None:
        s = self._get(sid)
        async with s.lock:
            await s.core.scroll(amount)

    async def screenshot(self, sid: str) -> bytes:
        s = self._get(sid)
        async with s.lock:
            return await s.core.screenshot()

    async def extract_text(self, sid: str, selector: str | None = None) -> str:
        s = self._get(sid)
        async with s.lock:
            return await s.core.extract_text(selector)

    async def do_fetch(self, sid: str, spec: dict) -> dict:
        """Browser-as-HTTP-client: run fetch() INSIDE the page context.

        Why this beats stuffing fetch into the generic /eval endpoint:
          * The request rides the page's REAL TLS / HTTP-2 / cookies / cache
            -- so JA3/JA4/UA all match a genuine Chrome request.
          * Cookies from prior navigations apply automatically (the killer
            feature: log in via the browser, then make N authenticated API
            calls without re-doing auth).
          * SameSite/Origin/Referer follow the real page rules.
          * Stays out of CSP cross-origin rejection because the page can
            fetch any URL fetch() permits.

        Spec shape (a subset of the WHATWG fetch options):
          {"url": str,                        # required
           "method": "GET"|"POST"|...,        # default GET
           "headers": {str: str},             # optional
           "body": str | None,                # optional, sent as-is
           "credentials": "include"|"same-origin"|"omit",  # default include
           "timeout_ms": int}                 # default 30000

        Returns: {"status": int, "headers": {...}, "body": str, "url": str}
        """
        url = spec.get("url")
        if not url or not isinstance(url, str):
            raise ServiceError(400, "fetch needs 'url' (string)")
        method = (spec.get("method") or "GET").upper()
        headers = spec.get("headers") or {}
        body = spec.get("body")
        credentials = spec.get("credentials") or "include"
        timeout_ms = int(spec.get("timeout_ms") or 30000)

        # The JS runs INSIDE the page -- AbortController for timeout,
        # then return a single dict so playwright/nodriver auto-serialize it.
        # Single-expression form (no const declarations) -- Playwright's
        # page.evaluate(<string>) is parsed as an expression, not a block.
        opts = {"method": method, "headers": headers,
                "credentials": credentials}
        if body is not None:
            opts["body"] = body
        # JSON-encode the args once, splice as JS literals.
        import json as _json
        expr = (
            "(() => {"
            "const c = new AbortController();"
            f"const t = setTimeout(() => c.abort(), {timeout_ms});"
            f"const opts = Object.assign({_json.dumps(opts)},"
            " {signal: c.signal});"
            f"return fetch({_json.dumps(url)}, opts).then(r =>"
            "  r.text().then(b => ({"
            "    status: r.status,"
            "    headers: Object.fromEntries(r.headers.entries()),"
            "    body: b,"
            "    url: r.url"
            "  }))"
            ").catch(e => ({status: 0, headers: {}, body: '',"
            " url: '', error: String(e)}))"
            ".finally(() => clearTimeout(t));"
            "})()"
        )
        s = self._get(sid)
        async with s.lock:
            result = await s.core.eval_js(expr)
        if isinstance(result, dict):
            return result
        raise ServiceError(502,
            f"fetch returned unexpected shape: {type(result).__name__}")

    async def destroy(self, sid: str) -> None:
        s = self._sessions.pop(sid, None)
        if s is not None:
            try:
                await s.core.close()
            except Exception:  # noqa: BLE001 - best-effort teardown
                pass

    def count(self) -> int:
        return len(self._sessions)

    async def shutdown(self) -> None:
        if self._sweeper is not None:
            self._sweeper.cancel()
            self._sweeper = None
        await asyncio.gather(
            *(self.destroy(sid) for sid in list(self._sessions)),
            return_exceptions=True,
        )

    async def _sweep_loop(self) -> None:
        while True:
            await asyncio.sleep(30)
            cutoff = time.monotonic() - self.idle_s
            stale = [sid for sid, s in self._sessions.items()
                     if s.last_used < cutoff]
            for sid in stale:
                print(f"[sessions] idle-expiring {sid}")
                await self.destroy(sid)
