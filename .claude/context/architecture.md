# Architecture (browser-side detail)

For pandoks.com architecture (SST topology, Lambda handlers, k3s overlays),
read `.claude/rules/architecture.md` first. This file zooms in on the
**three new subsystems on `browser-iterations`**: the stealth Chrome service,
the patched Chromium recipe, and the ephemeral EC2 builder that produces
the binary.

## High-level layering

```
                                  ┌───────────────────────────┐
                                  │  packages/stealth-browser │  Python HTTP service
                                  │  (real Chrome, headful)   │  + library
                                  └────────────┬──────────────┘
                                               │ APEX_CHROME_PATH points at ↓
                                  ┌────────────┴──────────────┐
                                  │ packages/stealth-chromium │  C++ patch recipe (NOT a fork)
                                  │ — overlays + anchor edits │  (chromium source lives OUT of repo)
                                  └────────────┬──────────────┘
                                               │ produced by ↓
                                  ┌────────────┴──────────────┐
                                  │     infra/builder/        │  Ephemeral EC2 builder
                                  │ AMI + SFN + S3 artifacts  │  (generic — first heavy user: chromium)
                                  └───────────────────────────┘
```

## `infra/builder/` — ephemeral EC2 builder (NEW)

A **generic** ephemeral EC2 build runner exposed as an SST/AWS Step
Functions state machine. Chromium is its first heavy user; the design is
deliberately not chromium-specific.

| File | What it provisions |
| --- | --- |
| `infra/builder/ami.ts` | EC2 Image Builder pipeline: x86 + arm64 Ubuntu 24 AMIs baked from `ami.yaml`. Lifecycle policy keeps newest 10. `VERSION` const at `:6` — **bump it to force a rebake**. |
| `infra/builder/ami.yaml` | Image Builder component data (pre-installs clang, lld, ninja, ccache, depot_tools deps). Read in via `readFileSync` at `ami.ts:31`. |
| `infra/builder/builder.ts` | IAM roles, launch templates (x86 / arm64), instance profile, SSM Parameter for GitHub PAT (`/builders/<stage>/github-cloning-pat`), and the StateMachine itself. |
| `infra/builder/step.ts` | The SFN definition — pure JSON returned by `builderStateMachineDefinition()`. Arch routing, market routing (spot/on-demand), SSM wait loop, build wait loop, always-terminate cleanup. |
| `infra/builder/types.ts` | `ARM_INSTANCE_TYPES` / `X86_INSTANCE_TYPES` const arrays. **Shared with `apps/functions/`** (see file header at `:1-5`) so handlers can validate inputs without importing SST. |

**Resource names** (stage `dev` shown): `dev-builder` SFN, `dev-builder-x86`
+ `dev-builder-arm64` launch templates, `personal-pandoks-builderartifactsbucketbucket-*`
S3, `personal-pandoks-buildercachebucketbucket-*` S3,
`/builders/dev/github-cloning-pat` SSM SecureString.

### SFN flow (every box is a state in `step.ts`)

```
ResolveInputs ─┬─> ApplyDefaultRootVolumeSize ─> PickIdSource
               └────────────────────────────────> PickIdSource

PickIdSource ─┬─> ResolveInputsWithId (caller passed $.id)
              └─> ResolveInputsWithExecutionId (use $$.Execution.Name as id)

→ ChooseArchitecture (Choice on $.instanceType match against
                       ARM_INSTANCE_TYPES vs X86_INSTANCE_TYPES, else FailInvalidInstanceType)
→ ChooseMarket{X86,Arm64}  (Choice on $.marketType)
→ Launch{Spot,OnDemand}{X86,Arm64}  (ec2:runInstances with
   BlockDeviceMappings overriding root EBS to $.rootVolumeSizeGb GB
   on /dev/sda1, DeleteOnTermination=true)

→ WaitForSSM (60s) → CheckSSMReady (ssm:describeInstanceInformation)
   → IsSSMReady (loop back to WaitForSSM until PingStatus=Online)

→ RunBuild (ssm:sendCommand AWS-RunShellScript, executionTimeout=86400)
   — templated bash that:
     export BUILD_ID=<id>; BUILDER_CACHE_BUCKET=<bkt>; BUILDER_ARTIFACTS_BUCKET=<bkt>
     git clone --depth 1 --branch <ref> https://x-access-token:$TOKEN@github.com/<org>/<repo>
     cd /opt/repo; <command>

→ WaitForBuild (60s) → CheckBuildStatus → IsBuildDone
   (Success → TerminateAfterSuccess → Done.
    Failed/Cancelled/TimedOut → TerminateAfterFailure → FailBuild)
```

The **always-terminate** invariant matters: every error path leads to
`TerminateAfterFailure` (`step.ts:285-297`) which retries up to 5x at 15s
intervals. No instance leakage even on cascading failures.

### Caller contract (input shape)

```json
{
  "id": "stealth-chromium-...",   // optional — defaults to SFN execution name
  "ref": "browser-iterations",     // required — git branch to clone
  "instanceType": "c7i.4xlarge",   // must be in ARM_INSTANCE_TYPES ∪ X86_INSTANCE_TYPES
  "marketType": "on-demand",       // "spot" or "on-demand"
  "rootVolumeSizeGb": 200,         // optional — defaults to 30 GB (intentionally small)
  "command": "bash packages/stealth-chromium/scripts/sfn-build.sh"
}
```

## `packages/stealth-chromium/` — C++ patch recipe (NEW)

**Not a fork** — a `chromium_src/` overlay + anchor-edit set that mutates
an upstream Chromium source checkout in-place. Three patch mechanisms; **only
the first two actually run**:

| # | Mechanism | Count | Where |
| - | --------- | ----- | ----- |
| 1 | Full-file `chromium_src/` overlay | 2 | `chromium_src/<path>/<file>.cc` + listed in `scripts/apply.sh` `OVERLAYS=()` |
| 2 | Anchor edit | 23 | `EDITS = [...]` in `scripts/apply_edits.py` |
| 3 | `.patch` files (documentation only) | 11 | `patches/*.patch` — **NOT applied** |

**Total: 25 distinct edits** spanning ~20 web-facing surfaces (navigator,
screen, WebGL, canvas, audio, fonts, WebRTC, V8 inspector, battery, speech,
media-devices). Full surface table at
`packages/stealth-chromium/README.md:298-321`.

`apply_edits.py` schema (`packages/stealth-chromium/README.md:50-72`):

```python
{
  "file": "third_party/blink/renderer/<path>/<file>.cc",
  "header": '#include "<helper-header.h>"',  # optional
  "marker": "apex-<short-name>",             # unique → idempotent
  "anchor": "EXACT code substring (unique in file)",
  "where": "after" | "before" | "after-block",
  "inject": "C++ to splice in",
}
```

`scripts/sfn-build.sh` is the EC2-side entrypoint. It runs `setup.sh →
apply.sh → build.sh`, then packages the binary as `chromium-148.0.7778.179.tar.zst`
and uploads to `s3://<artifacts>/<BUILD_ID>/`. On failure it uploads
`build-failure.log` (last 1MB) **before** termination so the operator can
diagnose post-mortem.

## `packages/stealth-browser/` — Python HTTP service (NEW)

A FastAPI-style (but no framework — raw asyncio) HTTP service that owns
per-session browser lifecycle. **Drives real Google Chrome** (or the
patched stealth-chromium binary when `APEX_CHROME_PATH` is set), headful
under Xvfb on Linux.

Two pluggable backends behind the same interface, selected by `APEX_CORE`:

- `nodriver` (CDP-direct, no Playwright handshake — stealthier transport).
- `patchright` (patched Playwright — better high-level ergonomics).

Both expose: `open / navigate / eval_js / click / type / scroll /
screenshot / extract_text / close / dump_state / restore_state`.

### Endpoint surface (`server.py:121-227`)

```
GET    /health                         → { ok, sessions, backend }
POST   /sessions                       → { id, profile }
                                       body: { headless?, proxy?, parent?, profile? }
POST   /sessions/:id/navigate          → { url }
POST   /sessions/:id/click             → { selector }
POST   /sessions/:id/type              → { selector, text }
POST   /sessions/:id/scroll            → { amount }
POST   /sessions/:id/eval              → { expression } → { result }
POST   /sessions/:id/fetch             → fetch INSIDE the page (real TLS+cookies)
GET    /sessions/:id/screenshot        → image/png
GET    /sessions/:id/text?selector=    → { text }
DELETE /sessions/:id                   → { ok }
```

`session.py:166-232` (`do_fetch`) is the **browser-as-HTTP-client** killer
feature: the JS runs inside the live page so requests ride the page's
real TLS / HTTP-2 / cookies. Cookies set by prior navigation apply
automatically.

`session.py:89-120` (`create`) supports **session cloning**: pass
`parent: <sid>` to fork cookies+localStorage from an existing session, but
the clone gets its **own** fresh fingerprint and proxy — same logged-in
user, different "device."

### Identity / fingerprint coherence

`stealth_browser/identity.py` re-exports `Identity` /
`identity_for_ip_geo` from `profile.py`. The flow:

1. `_make_core` picks a device persona via `fp_profiles.pick_profile()`
   (optionally seeded by request body `profile`).
2. `NodriverCore.__init__` generates a per-session 32-bit `APEX_FP_SEED`
   (`core_nodriver.py:59`).
3. If `APEX_CHROME_PATH` points at a patched binary, every
   `APEX_FP_*` env var (canvas seed, WebGL renderer, screen dims, hardware
   concurrency, etc.) is set per-launch so the C++ patches activate.
4. If `PROXY_HOST` is set, the `Identity` is rebuilt against the proxy's
   exit-IP geo (timezone, locale, language all align with the network).

### Persona pool

`personas/` holds "lived-in" Chrome profile dirs (cookies, history,
accumulated state). `PERSONA_POOL.acquire()` (`core_nodriver.py:69`)
hands one out per session; exhausted pool falls back to ephemeral.

## Data flow — a session lifecycle

```
1.  POST /sessions {profile: "m1 pro"}
2.    SessionManager.create → _make_core("patchright", ...)
3.      PatchrightCore picks fp_profiles entry matching "m1 pro" substring
4.      patched_chrome_path() returns $APEX_CHROME_PATH if set, else None
5.      APEX_FP_* env vars exported (seed, screen, WebGL, hw concurrency, etc.)
6.      PERSONA_POOL.acquire() hands out a profile dir
7.      proxy_from_env() or request body builds ProxyConfig
8.      identity_for_ip_geo(proxy.exit_ip) aligns timezone/locale
9.      Chrome launched headful under Xvfb with all flags + env
10.   Returns { id: <uuid>, profile: {backend, timezone, ..., persona} }

11. POST /sessions/<id>/navigate {url: "https://..."}
12.   per-session asyncio.Lock — serializes ops on this browser
13.   core.navigate(url) — CDP Page.navigate (nodriver) or page.goto (patchright)

14. POST /sessions/<id>/fetch {url: ..., method: ...}
15.   eval_js(fetch_expr) — runs INSIDE the live page; rides real TLS+cookies

16. DELETE /sessions/<id>  or  idle-expire after 300s
17.   core.close() — Chrome terminates, persona returns to pool
```

## State storage (browser-side)

| Where | What |
| --- | --- |
| `s3://personal-pandoks-buildercachebucketbucket-*` | Chromium source tarball + ccache (warm-build acceleration) |
| `s3://personal-pandoks-builderartifactsbucketbucket-*/<BUILD_ID>/` | `chromium-148.0.7778.179.tar.zst`, `manifest.json`, `build-failure.log` |
| SSM `/builders/<stage>/github-cloning-pat` (SecureString) | GitHub PAT used by SFN bash to `git clone --depth 1` |
| `/build` on the EC2 instance (root EBS, `rootVolumeSizeGb`) | Chromium source + build output — vanishes with the instance |
| `~/Projects/sandbox/...` outside repo | The historic checkouts (apex-chromium-build, benchmark) — **not migrated** |
| External SSD `/Volumes/X9Pro/apex-chromium-build/` | Operator's local Chromium checkout (100GB) for local builds |

## Where things deliberately don't exist yet

- **No `apps/stealth-browser/`** — Python service has no deployment yet
  (`HANDOFF.md:99-109`). When added, it'll be a `kube/` overlay pointing
  at a Docker image of `packages/stealth-browser/`.
- **No `conventions/py.md`** under `.claude/rules/` — Python is new; the
  lint/format dispatchers (`scripts/{lint,format,fix}/main.sh`) have no
  `py` subcommand. Future work: add `ruff`.
- **No CI for stealth-browser/chromium yet.** No `paths-filter` entries
  in `tests.yaml`/`checks.yaml` for the new packages. The SFN builder
  pulls from GitHub directly, so CI integration is optional.
