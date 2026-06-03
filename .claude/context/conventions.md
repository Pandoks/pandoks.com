# Conventions (browser-side detail)

For the established conventions on TypeScript, infra, shell, charts, Go,
Svelte, read `.claude/rules/conventions/*.md`. **Python is new to this
repo** and has no rules entry yet — the section below is the first
synthesis, drawn from `packages/stealth-browser/stealth_browser/*.py`.

## Code style — Python (NEW, no rules entry yet)

The Python code in `packages/stealth-browser/stealth_browser/` was
migrated from `~/Projects/sandbox/{stealth-browser,apex-browser}/`
(`HANDOFF.md:28-60`). It is the **first Python member** of the monorepo
and predates any in-repo Python style guide. The taste rules below come
from reading the migrated files; they are descriptive, not prescriptive.

### Naming

- Module names `snake_case` — `core_nodriver.py`, `human_session.py`,
  `fp_profiles.py`, `runner_patchright.py`.
- Classes `PascalCase` — `SessionManager`, `ServiceError`,
  `NodriverCore`, `PatchrightCore`, `StealthBrowser`, `Identity`, `Human`.
  See `stealth_browser/session.py:26, 66, 76`,
  `stealth_browser/core_nodriver.py:32`.
- Constants `SCREAMING_SNAKE` — `PORT`, `BACKEND` at
  `stealth_browser/server.py:45-46`; `PERSONA_POOL` imported at
  `stealth_browser/core_nodriver.py:29`; `POOL` const inside
  `personas/__init__.py`.
- **Module-scope clients/singletons lowercase** — `manager` at
  `stealth_browser/server.py:48` (the `SessionManager` instance).
- "Private" prefix `_` for helpers and instance attrs:
  `_make_core` (`session.py:35`), `_get` (`session.py:122`),
  `_sweep_loop` (`session.py:254`), `_sessions`, `_sweeper`.
- **Env-var prefix `APEX_*`** is legacy from the sandbox project and
  intentionally not renamed yet (`stealth-chromium/README.md:13-17`).
  New code should match — `APEX_CORE`, `APEX_FP_*`, `APEX_CHROME_PATH`,
  `APEX_PROFILE`, `APEX_CHROMIUM_WORK`.

### Function shape

- **`from __future__ import annotations`** at the top of every module
  (`server.py:33`, `session.py:12`, `core_nodriver.py:13`,
  `identity.py:16`). Standard for the codebase.
- Function/method names `snake_case`. Async-by-default for handlers and
  I/O — `async def create` / `navigate` / `do_fetch` / `screenshot` in
  `session.py:89, 129, 166, 156`.
- **Type annotations on signatures, not on locals.**
  `def __init__(self, sid: str, core):` (`session.py:69`),
  `async def create(self, headless: bool = False, proxy=None,
   parent_sid: str | None = None, profile_label: str | None = None) -> dict:`
  (`session.py:89-91`). The `proxy=None` and `core` params are
  un-annotated — duck-typed cross-backend contract.
- **Modern PEP 604 unions** (`str | None`), not `Optional[str]`. Real
  examples at `session.py:79-83, 90, 161, 254`.
- `__slots__` for hot per-session containers — `_ManagedSession.__slots__
   = ("id", "core", "last_used", "lock")` (`session.py:67`). Used when
  there are many short-lived instances and attribute lookup latency
  matters.
- Default to early-return guards (`session.py:103-104`,
  `server.py:164-165, 171-172, 180-181`).

### Module layout

`session.py` and `server.py` both follow a 5-section shape:

1. **Module docstring** (multi-paragraph, motivating the design choice).
2. **`from __future__ import annotations`**.
3. **External imports** (stdlib first, then third-party), then
   **internal relative imports** (`from .session import …`,
   `from .core_nodriver import NodriverCore`).
4. **Module-scope constants + singleton clients** —
   `PORT`, `BACKEND`, `manager` in `server.py:45-48`.
5. **Class / function definitions**, then `if __name__ == "__main__":`
   guard (only in entrypoint modules like `server.py:287`).

### Comments / docstrings

- **Module docstrings** are mandatory in this codebase and are long
  (multi-paragraph). They explain motivation, not the API surface. See
  `server.py:1-31`, `session.py:1-10`, `core_nodriver.py:1-11`,
  `identity.py:1-14`. This is unusual density for the rest of the
  monorepo (which is comment-light) and reflects the migration
  context.
- **Function docstrings** for any public method, with the JSON body
  shape inlined as a comment block when the function takes complex
  request bodies. See `session.py:91-102` (`create`),
  `session.py:166-188` (`do_fetch`), `server.py:9-25` (the API
  surface mini-spec inside the module docstring).
- **`# noqa: BLE001`** for intentional broad `except Exception`. Two
  uses: `session.py:240` (best-effort teardown), `server.py:240`
  (unhandled-route fallback). Don't add new ones without justifying.
- **`# pragma: no cover -- Windows`** for the
  `loop.add_signal_handler` Windows fallback (`server.py:270`).

### Error handling

- **`ServiceError(Exception)`** is the HTTP-status-carrying error type
  (`session.py:26-32`). `_route` raises it; `_handle` catches it and
  serializes to JSON (`server.py:238-242`).
- HTTP status codes match real semantics: 400 malformed, 404 no such
  session, 429 session limit, 500 unhandled, 502 unexpected shape.
- **No try/catch around individual core operations** inside the manager.
  The per-session `asyncio.Lock` is the only coordination — if a core
  op raises, it propagates up to `_handle` which becomes a 500.
- Best-effort teardown is the one place `except Exception` is allowed —
  `destroy()` at `session.py:234-240`.

### Repetition vs reuse

- **Backend selection happens in one place** — `_make_core`
  (`session.py:35-63`) picks `PatchrightCore` vs `NodriverCore` from
  `APEX_CORE`. The cores then expose identical interfaces so the rest
  of the manager is backend-agnostic.
- **`PERSONA_POOL.acquire()` returns None on exhaustion**
  (`core_nodriver.py:69`) and the caller falls through to ephemeral —
  no extracted helper. This is the project's "almost-but-not-quite"
  pattern: both paths exist inline rather than a polymorphic abstraction.
- **fetch JS expression is inlined as a string** with `_json.dumps`
  for safe splicing (`session.py:207-225`). Not extracted to a separate
  file. The author values seeing the full JS at the call site.

### Async patterns

- **`asyncio.Lock` per session** (`session.py:73`) — serializes ops on
  one browser process. Sessions don't share locks.
- **Background sweeper task** for idle expiry (`session.py:85-87,
  254-262`). Started by `SessionManager.start()` not in `__init__`.
- **Sync-to-async shim** for the `[project.scripts]` console entry —
  `run_server()` at `server.py:278-284` wraps `asyncio.run(main())` so
  `stealth-browser` from the shell still works.

## Code style — TypeScript (browser-side additions)

The TS style rules in `.claude/rules/conventions/ts.md` and
`.claude/rules/conventions/infra.md` apply unchanged. Specific browser-side
observations:

- **Inter-package shared types live in `infra/builder/types.ts`** rather
  than `apps/functions/src/lib/` because both infra (`infra/builder/step.ts`)
  and Lambda code consume them (`infra/builder/types.ts:1-5` header
  explicitly notes this). Pattern: shared SST/non-SST constants belong in
  `infra/<area>/types.ts`.
- **SFN definitions return JSON-stringified objects** —
  `builderStateMachineDefinition` returns
  `$resolve([...]).apply(... JSON.stringify({...}))`
  (`infra/builder/step.ts:174-194`). Don't try to use Pulumi outputs
  inside the SFN definition without `$resolve` first.
- **Bash templating inside SFN tasks uses `{}` placeholders +
  `States.Format`** (`step.ts:184-191, 263`). The bash string is built
  with `{}` literal placeholders, then `States.Format(<str>, $.id,
  $.ref, $.command)` substitutes them at SFN runtime. Don't try to
  interpolate the SFN variables directly into the bash — they aren't in
  scope at JSON-definition time.
- **`Resource.<Name>.value` for SST-linked resources**, `process.env`
  only for non-SST plumbing — same as the rule in
  `.claude/rules/conventions/ts.md` Lambda-handler section. The builder
  uses `process.cwd()` to find `ami.yaml` (`ami.ts:31`) since it's a
  build-time file, not an SST-managed resource.

## Code style — POSIX shell (browser-side additions)

`packages/stealth-chromium/scripts/sfn-build.sh:1-26` is **bash, not POSIX
sh** (note `#!/usr/bin/env bash`, `set -euo pipefail`, `trap … ERR`,
array syntax `WHITELIST=( … )`). This is correct — the SFN runs it on
Ubuntu via `AWS-RunShellScript`, which is bash. The repo's
`.claude/rules/conventions/shell.md` POSIX rules apply only to
`scripts/cluster/` / `scripts/lib/` / `scripts/lint,format,fix/`. Bash
under `packages/*/scripts/` is its own world; document its conventions
locally if they multiply.

Notable patterns in `sfn-build.sh`:

- **`set -euo pipefail`** at line 18 — strict mode, no silent failures.
- **Mandatory env-var assertions** via `: "${VAR:?msg}"` syntax
  (`sfn-build.sh:20-22`). Fail fast if the SFN forgot to set something.
- **Failure-log upload trap** at `:35-41` — `trap cleanup_on_failure
  ERR` uploads the last 1MB of the build log to S3 **before** the SFN
  terminates the instance, so the operator can diagnose post-mortem
  without having to keep the instance alive.
- **`exec > >(tee -a "$LOG_FILE") 2>&1`** at `:26` — redirects
  everything (including subprocess output) to both stdout (CloudWatch
  via SSM) and a local logfile (the failure-tail source).
- **Whitelist tar extraction** — `WHITELIST=( chrome ... )` at `:73-84`
  with existence-check loop. Skips multi-GB of object files that ninja
  leaves behind, only ships what the binary actually needs at runtime.

## Code style — Markdown (HANDOFF docs)

`packages/stealth-browser/HANDOFF.md` is a one-page operator brief
intentionally written for "the next Claude session." Style:

- **Tables for every comparison** — sandbox→pandoks paths, patch
  mechanisms, env vars, cost ballparks. Avoid prose lists when a 3+
  column table would do.
- **Code blocks with the literal commands** (`uv sync`, `curl`, `aws
  stepfunctions ...`). Pasteable, not narrative.
- **`> [!NOTE]` / `> [!WARNING]` GitHub admonitions** sparingly — only
  for instructions a reader could miss at a glance.
- **Section titles `## What's running right now`** style — present
  tense, operator's POV.
