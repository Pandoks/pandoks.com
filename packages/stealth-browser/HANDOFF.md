# `stealth-browser` + `stealth-chromium` — context for the next Claude session

This is a one-page brief for any future Claude session picking up this work
after the migration from `~/Projects/sandbox/{stealth-browser,apex-browser,apex-chromium}/`
into `pandoks_browser/packages/{stealth-browser,stealth-chromium}/`. Read this
FIRST — it captures everything that doesn't survive a fresh checkout.

## TL;DR

A stealth headless-Chrome service designed to compete with Browserbase. It runs
*real* Chrome (not `--headless`) via Xvfb, drives it through `nodriver` (CDP-direct)
or patched Playwright (`patchright`), and exposes an HTTP API for managed sessions
with per-session proxies, session cloning, and `/fetch` for "browser-as-HTTP-client".

Stealth depth currently sits at **composite 1.000 on a 17-detector benchmark**
(CreepJS 0% headless / 0% stealth, all major fingerprinters pass, WebRTC + CDP
leaks closed, 6/7 anti-bot sites OK with the 1 BLOCK being IP-reputation, not
fingerprint).

Two packages here, by responsibility:

| Package | What it is | Language |
|---|---|---|
| [`stealth-browser`](.) | Importable Python lib + HTTP service | Python |
| [`stealth-chromium`](../stealth-chromium/) | C++ patches + Chromium build recipe (operator tooling, multi-hour build) | C++ + shell |

## What just happened (the migration)

Three sandbox projects collapsed into two monorepo packages:

| Sandbox source | Pandoks destination |
|---|---|
| `~/Projects/sandbox/stealth-browser/stealth/*.py` | `packages/stealth-browser/stealth_browser/*.py` |
| `~/Projects/sandbox/apex-browser/apex/*.py` | `packages/stealth-browser/stealth_browser/*.py` (same dir — merged) |
| `~/Projects/sandbox/apex-browser/personas/` | `packages/stealth-browser/personas/` |
| `~/Projects/sandbox/apex-chromium/*` | `packages/stealth-chromium/*` (whole tree) |

Notable code-level edits made during migration:

1. **`_paths.py` shim removed**. The old `apex-browser/apex/_paths.py` injected
   `../stealth-browser/` onto `sys.path`. With both halves in one package now,
   imports are regular relative imports.
2. **All `from stealth.X import Y` → `from stealth_browser.X import Y`**. The
   package was renamed from `stealth` → `stealth_browser`.
3. **All bare-sibling imports → relative imports** (`from session import X` →
   `from .session import X`). Apex's `core_nodriver.py`/`server.py`/etc.
   used to import their siblings without prefix; that doesn't work when the
   module lives inside a package.
4. **`session.py` name collision resolved**: apex's `session.py` (the HTTP
   `SessionManager`) won the name; stealth's `session.py` (the human-flow
   simulator) was renamed `human_session.py` so both survive.
5. **Added `run_server()` callable** at the bottom of `server.py` so the
   `[project.scripts]` `console_script` entry has a sync entry point.

Smoke-tested with `uv sync` + `uv run python -c 'from stealth_browser ...'` —
all imports clean.

**Sandbox is untouched.** Original projects still work where they live —
this was a copy, not a move. You can delete them whenever you're confident in
the migration.

## Repo conventions you must know

Pandoks_browser is a pnpm/SST/k3s monorepo. Read these first:

- `~/Projects/pandoks_browser/.claude/rules/universal.md` — pnpm-only,
  conventional commits (`feat()/fix()/update()/chore()/refactor()/cleanup()/build()`),
  comment density rules, no try/catch around AWS SDK, format/lint
  dispatchers.
- `~/Projects/pandoks_browser/.claude/rules/architecture.md` — SST topology
  + apps/packages map.
- `~/Projects/pandoks_browser/.claude/rules/workflows.md` — exact `pnpm`
  commands mirroring CI.
- `~/Projects/pandoks_browser/.claude/rules/conventions/{ts,go,shell,charts}.md`
  — per-language conventions.

**Python is new to this repo** — there's no existing `conventions/py.md`. The
stealth-browser package is the first Python member. Lint/format dispatchers
(`scripts/lint/`, `scripts/format/`) don't have a `py` subcommand yet — add one
when you want repo-wide Python linting (probably `ruff`).

## How Python coexists with pnpm

Three parallel workspace systems share the same on-disk layout:

| System | Workspace file | Members |
|---|---|---|
| pnpm | `pnpm-workspace.yaml` | `apps/*`, `packages/*` (every dir with a `package.json`) |
| Go | `go.work` | `./packages/valkey/reconciler` |
| **uv (NEW)** | **`pyproject.toml` (root)** | `packages/stealth-browser` |

`pnpm install` does NOT install Python deps. Run `cd packages/stealth-browser && uv sync`
separately, same as Go developers run `go mod tidy` in the reconciler dir.

`stealth-chromium` has a `package.json` for pnpm enumeration but is intentionally
**NOT** in the uv workspace — it has no `pyproject.toml` and uv would crash trying
to parse it.

## Apps NOT created — and why

The integration plan deliberately put **nothing in `apps/`**. Every existing
`apps/*` carries deployment-specific config (`apps/example/` has `kube/`,
`apps/web/` is a SvelteKit build, `apps/functions/` is Lambda handlers).
Today there's no deployment to configure, so the package is the unit. The
console-script entry (`uv run stealth-browser`) is the runnable.

`apps/stealth-browser/` shows up the moment there's a real deployment —
typically a `kube/{kustomization,stealth-browser,dev-patch}.yaml` overlay
referencing a Docker image of this package.

## What's running right now (in the SANDBOX, not the monorepo)

The sandbox still has live work in progress. Don't confuse it with the
migrated package:

- **An apex-chromium build** is/was running on `/Volumes/X9Pro/apex-chromium-build/`
  — Chrome **148.0.7778.179** with the C++ fingerprint patches. The last
  attempt failed at the `v8_context_snapshot_generator` link step with
  `dyld: unknown imports format` — a stale-toolchain artifact from many
  interrupted builds, NOT an apex code bug.
  See `~/Projects/sandbox/apex-chromium-build/build148_v2.log` for the
  failure trace.
- **The first apex-chromium v1 binary works** and lives at
  `/Volumes/X9Pro/apex-chromium-build/chromium/src/out/apex/Chromium.app/Contents/MacOS/Chromium`.
  It has the original 21 C++ patches (covered below) but NOT the
  newer WebGL `readPixels` + canvas `measureText` farbling patches.
- **A 22-detector benchmark** lives at `~/Projects/sandbox/benchmark/` — verified
  composite 1.000 against the v1 binary. NOT migrated yet (could become
  `packages/stealth-bench/` later if desired).

## C++ patches — current status

**For the full list, the patch-adding workflow, the env-var convention,
and which mechanism each patch uses, read
[`../stealth-chromium/README.md`](../stealth-chromium/README.md).** That's
the source of truth — this section is a summary.

Patches land via **three mechanisms** (not all `.patch` files!):

| # | Mechanism | Count | Where |
|---|---|---|---|
| 1 | Full-file `chromium_src/` overlay | 2 | `chromium_src/<path>/<file>.cc` + `apply.sh` OVERLAYS list |
| 2 | Anchor edit (preferred) | 23 | `EDITS = [...]` in `scripts/apply_edits.py` |
| 3 | `.patch` files (documentation only — NOT applied) | 11 | `patches/*.patch` |

Total: **2 overlays + 23 anchor edits = 25 distinct edits**, covering
~20 web-facing surfaces (navigator, screen, WebGL, canvas, audio, fonts,
WebRTC, V8 inspector, battery, speech, media-devices). The full surface
list with per-surface env-var names lives in
[the stealth-chromium README](../stealth-chromium/README.md#whats-already-patched).

Verified compile-clean on Chromium 148. The v1 binary on `/Volumes/X9Pro/`
has 23 of the 25 edits applied; v2 adds WebGL `readPixels` noise and
canvas `measureText` farbling but is currently failing at link &mdash; see
"Open work" #2.

Three patches were intentionally **deferred** (not started):
- RAF/audio quantum jitter — Chrome already clamps `performance.now()` to
  100µs; need empirical evidence we need more before patching the scheduler.
- Per-eTLD+1 reseeding — the `EtldSeed(host)` helper exists in
  `chromium_src/apex_fingerprint.h` but no patch consumes it yet.

## Open work (continue from here)

In priority order:

1. **Verify the migrated package still runs end-to-end against a live
   browser.** Import-only smoke-test passed (every module importable,
   `run_server` callable) but the service has NOT been started against a
   real browser since the migration. To verify:
   ```sh
   # terminal A
   cd packages/stealth-browser
   uv sync
   APEX_CORE=patchright PORT=8089 uv run stealth-browser

   # terminal B (with the service running):
   curl -s localhost:8089/health
   SID=$(curl -s -XPOST localhost:8089/sessions \
         -H 'content-type: application/json' -d '{}' | jq -r .id)
   curl -s -XPOST localhost:8089/sessions/$SID/navigate \
         -H 'content-type: application/json' \
         -d '{"url":"https://example.com"}'
   curl -s -XDELETE localhost:8089/sessions/$SID
   ```
   Likely first-run hiccups: missing system Chrome (install Chrome or set
   `APEX_CHROME_PATH`), or `patchright`/`nodriver` downloading their
   browser binary on first start (~30s lag).
2. **Decide what to do with the v2 build failure.** The v2 build is on the
   X9Pro external SSD &mdash; mount it, then:
   ```sh
   tail -200 /Volumes/X9Pro/apex-chromium-build/build148_v2.log
   ```
   Last seen failure: `ld64.lld` linking
   `obj/v8/v8_context_snapshot_generator/v8_context_snapshot_generator.o`
   fails with `dyld: unknown imports format` &mdash; a stale-toolchain
   artifact from repeated interrupted builds, not an apex code bug. The
   canonical recovery: delete the cached link inputs
   (`out/apex/obj/v8/v8_context_snapshot_generator/` and the matching
   `.ninja_deps` entry) and re-link &mdash; no source change needed. Or
   accept the v1 binary as "good enough" and ship without the WebGL-
   readPixels / measureText farbling.
3. **Migrate the benchmark** if you want it in-repo. Lives at
   `~/Projects/sandbox/benchmark/` — would become `packages/stealth-bench/`
   with the same pnpm wrapper pattern.
4. **Wire deploy when ready.** That's the moment `apps/stealth-browser/`
   appears with a `kube/` overlay. The integration plan
   (`pandoks_browser/.claude/artifacts/2026-05-26-stealth-browser-monorepo-integration.html`)
   sketched it but did NOT execute it — by design.
5. **Add a Python lint/format dispatcher** to
   `scripts/lint/main.sh` + `scripts/format/main.sh` (a `py` subcommand
   running `ruff`). Currently those scripts have no Python awareness.

## Things that aren't in this repo (intentionally)

- The 100GB Chromium source checkout — lives on the external SSD at
  `/Volumes/X9Pro/apex-chromium-build/chromium/src/`. The
  `stealth-chromium` package is just the **recipe** for patching that
  checkout, not the checkout itself.
- The patched Chromium binary itself — also outside the repo. When
  packaged for deployment, it'll be baked into a multi-stage Docker
  image referenced by the eventual `apps/stealth-browser/`.
- The integration-plan HTML artifact lives at
  `.claude/artifacts/2026-05-26-stealth-browser-monorepo-integration.html`
  (gitignored). Open it for the full rationale of the package split.

## How to run things

### Prerequisites

Before running anything:

- **System Google Chrome** installed (the service defaults to driving real
  Chrome, not bundled Chromium). On macOS: install Chrome.app the normal
  way. On Linux: `apt-get install google-chrome-stable` (or set
  `APEX_CHROME_PATH` to a custom binary &mdash; e.g. the patched
  stealth-chromium output).
- **Xvfb** on Linux only (Docker, headless servers). The service is
  *headful* by design (real Chrome, not `--headless`) so a display is
  required. Not needed on macOS &mdash; the WindowServer is the display.
  The repo's `entrypoint.sh` wraps the service in `Xvfb-run` automatically.
- **`jq`** if you'll use the smoke-test curl commands below (`brew install jq`).
- **`uv`** &mdash; the Python package manager (`brew install uv`).

### Environment variables (Python service)

| Var | Values | Purpose |
|---|---|---|
| `APEX_CORE` | `nodriver` \| `patchright` | Which automation transport to use. `nodriver` = CDP-direct (B's stack, generally stealthier). `patchright` = patched Playwright (A's stack, better high-level ergonomics). Both drive real Chrome. |
| `PORT` | int, default `8088` | HTTP service port. |
| `APEX_CHROME_PATH` | abs path | Override the Chrome binary. Point here at the patched stealth-chromium output once it's built. |
| `APEX_FP_*` | see [stealth-chromium README](../stealth-chromium/README.md#apex_fp_-env-var-convention) | Per-session fingerprint overrides &mdash; only meaningful when running the *patched* binary. The Python service sets these per session from `fp_profiles.py`. |
| `OXYLABS_USERNAME` / `OXYLABS_PASSWORD` / `OXYLABS_PROXIES` | strings | Residential proxy credentials. Optional. |

### Commands

```sh
# stealth-browser service (Python)
cd packages/stealth-browser
uv sync
APEX_CORE=patchright PORT=8089 uv run stealth-browser

# stealth-chromium build (multi-hour, runs on operator machine)
cd packages/stealth-chromium
APEX_CHROMIUM_WORK=/Volumes/X9Pro/apex-chromium-build scripts/setup.sh
APEX_CHROMIUM_WORK=/Volumes/X9Pro/apex-chromium-build scripts/apply.sh
APEX_CHROMIUM_WORK=/Volumes/X9Pro/apex-chromium-build scripts/build.sh
```

> **Env var naming note.** Build scripts and C++ patches both use the
> `APEX_*` prefix (legacy from when the code lived in
> `~/Projects/sandbox/apex-chromium/`). It has NOT been renamed to
> `STEALTH_*` because an in-flight v2 build still references those exact
> strings. New code should match the existing `APEX_*` prefix. When you
> eventually start fresh, the rename is a one-shot:
>
> ```sh
> grep -rln APEX_CHROMIUM_WORK packages/stealth-chromium/ \
>   | xargs sed -i '' 's|APEX_CHROMIUM_WORK|STEALTH_CHROMIUM_WORK|g'
> ```

## What the user values (from .claude/rules + recent sessions)

- **Verified > inferred.** Don't make claims without checking. Use the
  `verify` skill before recommending facts; the `dig` skill before
  bailing with "I don't know."
- **No deploy until asked.** The user explicitly trimmed scope twice
  during this migration. Don't add `kube/`, `Dockerfile`, helm chart,
  CI matrix entries unless explicitly requested.
- **HTML artifacts for any non-trivial explainer.** Per the `html`
  skill. The migration plan was an HTML artifact at
  `.claude/artifacts/2026-05-26-stealth-browser-monorepo-integration.html`.
- **Conventional commits with type-only prefix.** The active set:
  `feat() fix() update() chore() refactor() cleanup() build()`.
  PR number in parens at end when applicable.
- **No commits unless asked.** This migration was explicitly
  "do it now but don't commit."
