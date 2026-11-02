# `@pandoks.com/stealth-browser`

Stealth headless Chrome service. Single Python package combining:

- **The stealth core** (driving real Chrome via nodriver / patchright with
  coherent per-session identity, formerly the `stealth-browser/stealth/`
  library).
- **The HTTP service** (managed session lifecycle, `/sessions/:id/*` API,
  formerly the `apex-browser/apex/` server).

Everything imports as `stealth_browser.*`. The `_paths.py` sys-path shim
that the old standalone projects needed is gone -- one importable package
now.

## Run

```sh
cd packages/stealth-browser
uv sync
APEX_CORE=patchright PORT=8089 uv run stealth-browser
```

`stealth-browser` is the [`[project.scripts]`](./pyproject.toml) console
entry; it calls `stealth_browser.server.run_server()`.

## Import as a library

```python
from stealth_browser import StealthBrowser, Identity, Human
from stealth_browser.session import SessionManager           # HTTP service session lifecycle
from stealth_browser.human_session import HumanSession       # browsing-flow simulator

async with StealthBrowser(Identity()) as sb:
    tab = await sb.goto("https://example.com")
```

> **`session.py` vs `human_session.py`** &mdash; both packages had a file
> called `session.py`. Apex's `SessionManager` (HTTP service session
> lifecycle) kept the canonical name. Stealth's `HumanSession` (the
> human-like browsing-flow simulator: realistic scrolls, dwell, click
> patterns) was renamed to `human_session.py`. They do different jobs;
> you may need either or both depending on your use case.

## Patched Chromium

When the [`stealth-chromium`](../stealth-chromium/) package's build script
has produced a patched Chromium binary, point at it with
`APEX_CHROME_PATH=/path/to/patched/Chromium` -- the service reads that
env var and switches to the patched binary, activating the C++
fingerprint patches.

## Persistent profiles

A named profile (`persistent: "<name>"` on session create) keeps
cookies/localStorage/history under its on-disk dir across sessions. A profile
created before round 2026-11-02 may carry baked-in permission grants from
sessions that pre-granted `geolocation`/`notifications` at context creation;
the browser legitimately never re-prompts for an already-granted permission,
so such a profile reports terminal states forever. The driver no longer
pre-grants anything -- profiles created after this change start at `prompt`
-- but an **existing named profile needs a one-time reset** (delete its
on-disk dir) once, to shed the baked-in grants.

## MCP server

`stealth-mcp` (stdio) exposes the service to AI agents as MCP tools:
`stealth_create` / `stealth_navigate` / `stealth_click` / `stealth_type` /
`stealth_eval` / `stealth_text` / `stealth_fetch` / `stealth_screenshot` /
`stealth_close`. Point it at the service with `STEALTH_BROWSER_URL`
(default `http://127.0.0.1:8089`). The agent manages one session implicitly;
`stealth_create(persistent="<name>")` binds it to an identity profile.
