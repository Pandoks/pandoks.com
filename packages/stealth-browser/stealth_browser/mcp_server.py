"""MCP server exposing the stealth-browser HTTP API to AI agents.

The agent never sees the HTTP API -- it gets these tools:
  stealth_create      create a session ("persistent": "<name>" for an
                      identity profile that keeps cookies/logins)
  stealth_navigate    go to a URL
  stealth_click       human-click a selector
  stealth_type        human-type into a selector
  stealth_eval        run JS on the page
  stealth_text        read page text
  stealth_fetch       browser-as-HTTP-client (real TLS + cookies)
  stealth_screenshot  PNG of the page
  stealth_close       destroy the session

Run:  stealth-mcp   (stdio MCP transport; talks to the service on
                     STEALTH_BROWSER_URL, default http://127.0.0.1:8089)
"""

from __future__ import annotations

import json
import os
import urllib.request

from mcp.server.fastmcp import FastMCP

BASE = os.environ.get("STEALTH_BROWSER_URL", "http://127.0.0.1:8089").rstrip("/")

mcp = FastMCP("stealth-browser")

# one default session per agent process -- created lazily, reused across
# tool calls, so the agent doesn't have to manage session ids at all.
_session_id: str | None = None


def _http(method: str, path: str, body: dict | None = None) -> object:
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json"},
        method=method,
    )
    try:
        resp = urllib.request.urlopen(req, timeout=120)
        raw = resp.read()
        return json.loads(raw) if raw else {"ok": True}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {detail}") from e


def _ensure_session() -> str:
    global _session_id
    if _session_id is None:
        r = _http("POST", "/sessions", {})
        _session_id = r["id"]
    return _session_id


@mcp.tool()
def stealth_create(persistent: str = "") -> str:
    """Create a browser session. Pass persistent=<name> for an identity
    profile that keeps cookies/logins across sessions. Skip for a fresh
    ephemeral browser."""
    global _session_id
    body = {"persistent": persistent} if persistent else {}
    r = _http("POST", "/sessions", body)
    _session_id = r["id"]
    return json.dumps(r["profile"])


@mcp.tool()
def stealth_navigate(url: str) -> str:
    """Navigate the session to a URL. Returns status/title/finalUrl."""
    sid = _ensure_session()
    return json.dumps(_http("POST", f"/sessions/{sid}/navigate", {"url": url}))


@mcp.tool()
def stealth_click(selector: str) -> str:
    """Human-like click on the first element matching the CSS selector
    (bezier path in, press-hold-release)."""
    sid = _ensure_session()
    _http("POST", f"/sessions/{sid}/click", {"selector": selector})
    return "clicked"


@mcp.tool()
def stealth_type(selector: str, text: str) -> str:
    """Human-like typing into the field matching the selector (clicks into
    it first, then types with variable inter-key timing)."""
    sid = _ensure_session()
    _http("POST", f"/sessions/{sid}/type", {"selector": selector, "text": text})
    return "typed"


@mcp.tool()
def stealth_eval(expression: str) -> str:
    """Run JavaScript on the page and return the result as a string."""
    sid = _ensure_session()
    r = _http("POST", f"/sessions/{sid}/eval", {"expression": expression})
    return json.dumps(r.get("result"))


@mcp.tool()
def stealth_text(selector: str = "") -> str:
    """Read the page's inner text (whole page, or of the matching selector)."""
    sid = _ensure_session()
    path = f"/sessions/{sid}/text"
    if selector:
        path += f"?selector={urllib.request.quote(selector)}"
    return _http("GET", path).get("text", "")


@mcp.tool()
def stealth_fetch(url: str, method: str = "GET", body: str = "") -> str:
    """Run an HTTP request INSIDE the page so it rides the session's real
    TLS fingerprint and cookies. Returns status + body."""
    sid = _ensure_session()
    r = _http("POST", f"/sessions/{sid}/fetch",
              {"url": url, "method": method, "body": body or None})
    return json.dumps(r)


@mcp.tool()
def stealth_screenshot(path: str) -> str:
    """Save a PNG screenshot of the page to `path` and return the path."""
    sid = _ensure_session()
    req = urllib.request.Request(f"{BASE}/sessions/{sid}/screenshot")
    data = urllib.request.urlopen(req, timeout=60).read()
    with open(path, "wb") as f:
        f.write(data)
    return path


@mcp.tool()
def stealth_close() -> str:
    """Destroy the session. Cookies persist if the session was persistent."""
    global _session_id
    if _session_id is not None:
        _http("DELETE", f"/sessions/{_session_id}")
        _session_id = None
    return "closed"


def main():
    mcp.run()

if __name__ == "__main__":
    main()
