"""HTTP service -- the apex stealth-browser product surface.

A small JSON/REST API over SessionManager, ported route-for-route from
headless-stealth/src/service/server.ts. Same endpoints, same JSON shapes, so
the benchmark harness's HttpServiceDriver works against apex unchanged.

  GET    /health                       -> { ok, sessions, backend }
  POST   /sessions                     -> create; body: {
                                            headless?, proxy?, parent?,
                                            profile? }
                                       proxy: { server, username, password }
                                       parent: sid to clone cookies from
                                       profile: device persona substring
                                                ("m1 pro" / "rtx 3060" ...)
  POST   /sessions/:id/navigate        -> { url }
  POST   /sessions/:id/click           -> { selector }
  POST   /sessions/:id/type            -> { selector, text }
  POST   /sessions/:id/scroll          -> { amount }
  POST   /sessions/:id/eval            -> { expression } -> { result }
  POST   /sessions/:id/fetch           -> { url, method?, headers?, body?,
                                            credentials?, timeout_ms? }
                                       -> { status, headers, body, url }
  GET    /sessions/:id/screenshot      -> image/png
  GET    /sessions/:id/text?selector=  -> { text }
  DELETE /sessions/:id                 -> { ok }

Built on asyncio's stream server (no framework dependency) so it stays fully
async alongside the async stealth cores.

Run:  APEX_CORE=nodriver PORT=8089 uv run python -m apex.server
"""

from __future__ import annotations


import asyncio
import json
import os
import re
import signal
from urllib.parse import urlparse, parse_qs

from .session import SessionManager, ServiceError

PORT = int(os.environ.get("PORT", "8089"))
BACKEND = os.environ.get("APEX_CORE", "nodriver")

manager = SessionManager()


# --------------------------------------------------------------------------
# Minimal HTTP/1.1 request parsing over asyncio streams.
# --------------------------------------------------------------------------

class Request:
    def __init__(self, method: str, path: str, query: dict,
                 headers: dict, body: bytes):
        self.method = method
        self.path = path
        self.query = query
        self.headers = headers
        self.body = body

    def json(self) -> dict:
        raw = self.body.decode("utf-8", "replace").strip()
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ServiceError(400, "invalid JSON body") from exc
        return parsed if isinstance(parsed, dict) else {}


async def _read_request(reader: asyncio.StreamReader) -> Request | None:
    line = await reader.readline()
    if not line:
        return None
    try:
        method, target, _ = line.decode("latin1").split(" ", 2)
    except ValueError:
        raise ServiceError(400, "malformed request line")
    headers: dict[str, str] = {}
    while True:
        h = await reader.readline()
        if h in (b"\r\n", b"\n", b""):
            break
        k, _, v = h.decode("latin1").partition(":")
        headers[k.strip().lower()] = v.strip()
    body = b""
    length = int(headers.get("content-length", "0") or "0")
    if length:
        body = await reader.readexactly(length)
    parsed = urlparse(target)
    query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
    return Request(method, parsed.path, query, headers, body)


def _response(status: int, body: bytes, content_type: str) -> bytes:
    reason = {200: "OK", 201: "Created", 400: "Bad Request",
              404: "Not Found", 429: "Too Many Requests",
              500: "Internal Server Error"}.get(status, "OK")
    head = (
        f"HTTP/1.1 {status} {reason}\r\n"
        f"content-type: {content_type}\r\n"
        f"content-length: {len(body)}\r\n"
        f"connection: close\r\n\r\n"
    ).encode("latin1")
    return head + body


def _json_response(status: int, obj) -> bytes:
    return _response(status, json.dumps(obj).encode("utf-8"),
                     "application/json")


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------

async def _route(req: Request) -> bytes:
    p = req.path

    if req.method == "GET" and p == "/health":
        return _json_response(200, {
            "ok": True, "sessions": manager.count(), "backend": BACKEND})

    if req.method == "POST" and p == "/sessions":
        body = req.json()
        # Optional per-session proxy: caller supplies any vendor (Oxylabs,
        # Bright Data, Smartproxy, their own SOCKS5, on-prem squid) -- apex
        # is vendor-agnostic; the dict shape is documented in
        # stealth.proxy.from_dict. Omitting "proxy" uses the env default
        # (or no proxy if env isn't set).
        proxy_spec = body.get("proxy")
        proxy = None
        if proxy_spec:
            try:
                from stealth_browser.proxy import from_dict as _proxy_from_dict
                # the request id isn't known yet -- use a fresh nonce for
                # {session} substitution; rotating-gateway proxies hand out a
                # new exit IP per call regardless.
                proxy = _proxy_from_dict(proxy_spec)
            except ValueError as e:
                raise ServiceError(400, f"bad proxy spec: {e}")
        # Optional `parent`: clone cookies+localStorage from an existing
        # session for the shared-login multi-session pattern. The clone
        # keeps a fresh fingerprint + proxy peer (different "device").
        parent_sid = body.get("parent")
        # Optional `profile` selector: any substring of an fp_profiles label
        # ("m1 pro", "rtx 3060", "intel iris xe", etc.). Lets callers pin a
        # specific device persona per request -- the Browserbase-style
        # "give me a Windows desktop" UX.
        profile_label = body.get("profile")
        created = await manager.create(
            headless=bool(body.get("headless")),
            proxy=proxy, parent_sid=parent_sid,
            profile_label=profile_label)
        return _json_response(201, created)

    m = re.match(r"^/sessions/([^/]+)/navigate$", p)
    if req.method == "POST" and m:
        url = req.json().get("url")
        if not url:
            raise ServiceError(400, "missing 'url'")
        return _json_response(200, await manager.navigate(m.group(1), url))

    m = re.match(r"^/sessions/([^/]+)/click$", p)
    if req.method == "POST" and m:
        selector = req.json().get("selector")
        if not selector:
            raise ServiceError(400, "missing 'selector'")
        await manager.click(m.group(1), selector)
        return _json_response(200, {"ok": True})

    m = re.match(r"^/sessions/([^/]+)/type$", p)
    if req.method == "POST" and m:
        body = req.json()
        selector, text = body.get("selector"), body.get("text")
        if not selector or text is None:
            raise ServiceError(400, "missing 'selector' or 'text'")
        await manager.type_text(m.group(1), selector, text)
        return _json_response(200, {"ok": True})

    m = re.match(r"^/sessions/([^/]+)/scroll$", p)
    if req.method == "POST" and m:
        amount = req.json().get("amount")
        if not isinstance(amount, (int, float)):
            raise ServiceError(400, "missing numeric 'amount'")
        await manager.scroll(m.group(1), int(amount))
        return _json_response(200, {"ok": True})

    m = re.match(r"^/sessions/([^/]+)/eval$", p)
    if req.method == "POST" and m:
        expression = req.json().get("expression")
        if not expression:
            raise ServiceError(400, "missing 'expression'")
        result = await manager.eval_js(m.group(1), expression)
        return _json_response(200, {"result": result})

    # Browser-as-HTTP-client: run fetch() INSIDE the page so the request
    # rides the page's real TLS + cookies + JS context. The killer use case
    # is "log in once, then make N authenticated API calls" -- cookies set
    # by the prior navigation are automatically present here.
    m = re.match(r"^/sessions/([^/]+)/fetch$", p)
    if req.method == "POST" and m:
        spec = req.json()
        result = await manager.do_fetch(m.group(1), spec)
        return _json_response(200, result)

    m = re.match(r"^/sessions/([^/]+)/screenshot$", p)
    if req.method == "GET" and m:
        png = await manager.screenshot(m.group(1))
        return _response(200, png, "image/png")

    m = re.match(r"^/sessions/([^/]+)/text$", p)
    if req.method == "GET" and m:
        text = await manager.extract_text(
            m.group(1), req.query.get("selector"))
        return _json_response(200, {"text": text})

    m = re.match(r"^/sessions/([^/]+)$", p)
    if req.method == "DELETE" and m:
        await manager.destroy(m.group(1))
        return _json_response(200, {"ok": True})

    return _json_response(404, {"error": f"no route: {req.method} {p}"})


async def _handle(reader: asyncio.StreamReader,
                  writer: asyncio.StreamWriter) -> None:
    try:
        req = await _read_request(reader)
        if req is None:
            return
        try:
            out = await _route(req)
        except ServiceError as e:
            out = _json_response(e.status, {"error": e.message})
        except Exception as e:  # noqa: BLE001
            print(f"[server] unhandled: {type(e).__name__}: {e}")
            out = _json_response(500, {"error": str(e)})
        writer.write(out)
        await writer.drain()
    except (asyncio.IncompleteReadError, ConnectionResetError, ServiceError):
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass


async def main() -> None:
    manager.start()
    server = await asyncio.start_server(_handle, "127.0.0.1", PORT)
    print(f"[server] apex stealth Chrome service ({BACKEND}) on :{PORT}")

    stop = asyncio.Event()

    def _shutdown() -> None:
        print("[server] shutting down")
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _shutdown)
        except NotImplementedError:  # pragma: no cover -- Windows
            pass

    async with server:
        await stop.wait()
    await manager.shutdown()


def run_server() -> None:
    """Synchronous entry point for the [project.scripts] console_script.

    `stealth-browser` from a terminal lands here; we hand off to the async
    main() above. Kept tiny so testing main() directly stays straightforward.
    """
    asyncio.run(main())


if __name__ == "__main__":
    run_server()
