# Gotchas (browser-side)

For pandoks.com / SST / k8s / cluster gotchas read
`.claude/rules/gotchas/*.md` first. This file covers the browser stack:
stealth-browser, stealth-chromium, and the `infra/builder/` SFN.

## `infra/builder/` — SFN builder

### `rootVolumeSizeGb` default is intentionally 30 GB

`step.ts:205-217`. The `ResolveInputs → ApplyDefaultRootVolumeSize`
Choice→Pass chain defaults to **30 GB** when the caller omits the field.
This is "intentionally small, so a quick smoke build doesn't overpay"
(`stealth-chromium/README.md:215-218`). **For Chromium builds you must
pass `rootVolumeSizeGb >= 200`** (~100 GB source + ~30 GB build output +
ccache + tarball staging). The current running SFN passes `200`. If
you ever see "no space left on device" from a build, this is the first
thing to check.

### BlockDeviceMappings must match the AMI's RootDeviceName exactly

`step.ts:18-36` comment. The launch template's root device is `/dev/sda1`
(Ubuntu) — overriding it requires `DeviceName: '/dev/sda1'` to match,
or the override is **silently ignored** by EC2 and you get the AMI's
default 8 GB volume. There's no error — the SFN just gives you a tiny
disk and the build fails ~30s in with "no space left."

### `git clone --depth 1 --branch <ref>` requires the branch to be pushed

`step.ts:188`. Local-only branches are invisible. Before triggering a
build, push your branch (`git push -u origin <branch>`) or the clone
fails immediately. The current `browser-iterations` branch is pushed —
verified via `git status` showing `Your branch is up to date with
'origin/browser-iterations'`.

### `States.Format` placeholder count

`step.ts:263` — `States.Format('bash -c \\'<script>\\'', $.id, $.ref,
$.command)`. The script in `step.ts:182-192` has exactly **three** `{}`
placeholders matching the three positional args. If you add another env
var that needs SFN substitution, add a `{}` AND a `$.<field>` arg
together — they're position-coupled. Wrong count = `States.Format`
runtime error halfway through the workflow.

### `executionTimeout` is `'86400'` as a string, in an array

`step.ts:264`. AWS-RunShellScript's `executionTimeout` parameter takes
**a string-typed array of one string**: `['86400']`. Not a number, not
a string scalar, not an int. 24-hour cap for the Chromium first-build
case. If you change it, keep the type — wrong type silently drops to
the SSM document default of 3600 seconds.

### AMI rebake requires bumping `VERSION` in `ami.ts`

`infra/builder/ami.ts:6` — `VERSION = '1.0.0'` is load-bearing. The
Image Builder pipeline is idempotent on `(name, version)` — without
bumping, a recipe change won't produce a new AMI and your "new" build
infra still runs on the old AMI. **The warning comment at `:5` says
exactly this.**

### Lifecycle policy: newest 10 AMIs kept per arch

`infra/builder/ami.ts:88-112`. If you bump VERSION more than 10x in a
row, older AMIs (plus their snapshots) are deleted. This is fine for
normal use; risky if you're trying to roll back to a 12-version-old AMI.

### `dev-builder` and `prod-builder` are both stage-derived

`infra/builder/builder.ts:110` — `name: \`${STAGE_NAME}-builder\``.
`STAGE_NAME` is `'dev'` for any non-prod stage (`infra/dns.ts:9`), so
the per-user `pandoks` stage's SFN is **also** named `dev-builder`. Two
developers on the same AWS account would collide — the SFN is a
singleton at the `dev`/`prod` namespace level. Not a per-user
namespaced resource.

### Spot instance interruption is a real failure path

`step.ts:36-44` — `marketType: 'spot'` triggers
`InstanceMarketOptions.MarketType=spot`, `SpotInstanceType=one-time`.
If the instance is reclaimed mid-build (which a 7-hour Chromium build
on a c7i.4xlarge spot is non-trivially likely to hit), the SSM command
status becomes `Failed` or `Cancelled` → `TerminateAfterFailure` →
`FailBuild`. You lose the work. **Use `on-demand` for cold builds.**
Spot is fine for warm incrementals (~45 min).

## `packages/stealth-chromium/` — Chromium patches

### `.patch` files in `patches/` are vestigial

`stealth-chromium/README.md:41-47`. The header comment in `apply.sh`
claims it applies them — **that comment is wrong**. `apply.sh` does
**not** apply `patches/*.patch`. Real patching is `chromium_src/`
overlays + `apply_edits.py` anchor edits. If you find yourself reading
`patches/*.patch` to understand current behavior, **stop** — read
`apply_edits.py` instead.

### Three patch mechanisms, only two are active

`stealth-chromium/README.md:38-47`. (1) `chromium_src/` overlay full-file
replacements (2 files), (2) anchor edits via `apply_edits.py` `EDITS`
list (23 entries), (3) `.patch` files (11 — documentation only, NOT
applied). The total **shipped** count is 25 distinct edits.

### `APEX_*` env-var prefix is legacy and intentional

`stealth-chromium/README.md:14-17`, `HANDOFF.md:270-280`. Build scripts
and C++ patches use `APEX_*` because the code lived in
`~/Projects/sandbox/apex-chromium/`. **Not renamed** because the
in-flight v2 build references those exact strings. New code MUST match
the existing prefix. When you eventually rename, the migration is a
one-shot `grep -rln APEX_CHROMIUM_WORK ... | xargs sed`.

### Three patches are intentionally deferred

`HANDOFF.md:157-162` and `stealth-chromium/README.md:326-332`:

- RAF/audio quantum jitter — Chrome already clamps `performance.now()`
  to 100µs; need empirical evidence before patching the scheduler.
- Per-eTLD+1 reseeding — `EtldSeed(host)` helper exists in
  `chromium_src/apex_fingerprint.h` but no patch consumes it yet.
- (V2 build: WebGL `readPixels` + canvas `measureText` farbling — done
  in `apply_edits.py` but the v2 binary build currently fails at link.)

### `apply.sh` step 0 (shared headers) needs extending when adding a new module

`stealth-chromium/README.md:74-81`. The `for dir in ... ; do` block at
~line 33 of `apply.sh` copies `apex_fingerprint.h` (and module-local
helpers) into each Blink module directory that needs it. **If you add a
patch in a new module dir, you MUST extend that loop**, or the helper
header isn't where the patched `.cc` expects it and the build fails
with a missing include.

### The 100GB Chromium checkout lives OUTSIDE the repo

`HANDOFF.md:216-218`, `stealth-chromium/README.md:159-161`. The
`stealth-chromium` package is the **recipe** for patching a Chromium
checkout, not the checkout itself. The checkout lives on the operator's
external SSD (`/Volumes/X9Pro/apex-chromium-build/chromium/src/`) for
local builds, or `/build` on the ephemeral EC2 (via SFN) for cloud
builds.

### v2 build failure mode: stale-toolchain artifact

`HANDOFF.md:189-202`. The local v2 build fails at
`ld64.lld` linking `v8_context_snapshot_generator.o` with `dyld:
unknown imports format`. This is a stale-toolchain artifact from
repeated interrupted builds, **not** an apex code bug. Recovery: delete
the cached link inputs
(`out/apex/obj/v8/v8_context_snapshot_generator/` + matching
`.ninja_deps` entry) and re-link. No source change needed. **Or**
accept the v1 binary at
`/Volumes/X9Pro/apex-chromium-build/chromium/src/out/apex/Chromium.app/...`
which has 23/25 edits applied (missing only the v2-added WebGL/canvas
farbling).

## `packages/stealth-browser/` — Python service

### "First Python member" — no `conventions/py.md` yet

`HANDOFF.md:78-80`. `scripts/lint/main.sh`, `scripts/format/main.sh`,
`scripts/fix/main.sh` have no `py` subcommand. The dispatcher pattern
is to **add subcommands**, not blanket-apply. Until then, run `ruff`
manually inside `packages/stealth-browser/`.

### Three parallel workspace systems share one on-disk layout

`HANDOFF.md:82-97`. pnpm (`pnpm-workspace.yaml`) sees every dir with a
`package.json`, including `stealth-chromium/` (which has a wrapper
`package.json` for pnpm enumeration only — **not** in the uv
workspace). uv (`pyproject.toml` at root) sees **only**
`packages/stealth-browser/`. Go (`go.work`) sees only
`packages/valkey/reconciler/`. `pnpm install` does **NOT** install
Python deps — `cd packages/stealth-browser && uv sync` is a separate
step.

### `stealth-chromium` is intentionally NOT a uv member

`pyproject.toml:14-16` comment. It has no `pyproject.toml`; uv would
crash trying to parse it. The `package.json` wrapper exists only so
pnpm sees the directory (and the `# Heads up — legacy naming` block
in the README reaches it).

### Sandbox is untouched after migration

`HANDOFF.md:58-60`. Original projects at
`~/Projects/sandbox/{stealth-browser,apex-browser,apex-chromium}/`
still work where they live — migration was copy, not move. Delete
when you're confident.

### Two `session.py` files collided during migration

`HANDOFF.md:48-51`, `packages/stealth-browser/README.md:38-43`. Apex's
`session.py` (HTTP `SessionManager`) won the canonical name; stealth's
original `session.py` (the `HumanSession` browsing-flow simulator) was
renamed `human_session.py`. They do different jobs — if you need
both, import accordingly.

### `_paths.py` shim is gone, imports are real now

`HANDOFF.md:40-44`. The old `apex-browser/apex/_paths.py` injected
`../stealth-browser/` onto `sys.path`. **Removed.** All `from stealth.X`
→ `from stealth_browser.X`, all bare-sibling imports → relative imports
(`from .session import …`).

### `APEX_PROFILE` env var is set per-request and restored

`session.py:46-63`. `_make_core` temporarily overrides `APEX_PROFILE`
for the duration of `PatchrightCore.__init__` / `NodriverCore.__init__`
(which is when `pick_profile()` runs), then restores it. **Marked
"threadsafe enough for the manager's lock"** at `:48` — the manager's
asyncio.Lock serializes session creation, so the brief env-var window
can't be observed by another concurrent request. Don't add a second
mutator of this env var without re-thinking the lock.

### `fetch` runs INSIDE the page — that's the feature, not a bug

`session.py:166-188`, especially `:201`-style comment. The JS is
constructed as a single expression (no `const`) because
`page.evaluate(<string>)` is parsed as an expression, not a block. If
you refactor it, keep the IIFE shape `(() => { ... })()`.

### `proxy=None` does NOT mean "no proxy" universally

`session.py:103-104` comment. `None` means "use the env default." If
`PROXY_HOST` env is set, the request silently uses it. If you want
"force no proxy" semantics, you currently can't — the request body has
no `"proxy": false` shape. Worth fixing if it bites someone.

### Persona pool exhaustion silently falls back to ephemeral

`core_nodriver.py:69` — `PERSONA_POOL.acquire()` returns `None` when
the pool is drained. No error, no warning. Sessions still work but
look "fresher" than they should — no accumulated cookies/history. If
you're benchmarking stealth scores and several sessions in a row look
weaker than expected, check pool capacity.

### `idle_s=300` defaults to 5-minute session timeout

`session.py:79` — `SessionManager(__init__, idle_s=300.0,
max_sessions=10)`. Sessions idle past 300s are reaped by the
`_sweep_loop` (`:254-262`). `max_sessions=10` is the 429 cap. Both are
constructor args with defaults — not exposed via env vars yet.

## Cross-cutting

### `sst-env.d.ts` per-package proliferation

`git status` shows untracked `packages/stealth-browser/sst-env.d.ts`,
`packages/stealth-browser/sst.pyi`,
`packages/stealth-chromium/sst-env.d.ts`, and root-level `sst.pyi`.
The `.claude/rules/gotchas/infra.md` rule "**`sst-env.d.ts` is
auto-generated**" still applies — don't edit by hand. The `.pyi`
companions are SST's new Python stub generation (because Python
packages are now in the workspace). Treat them the same: regenerated,
not committed-from-scratch.

### Account `Personal`, region `us-west-1`

`sst.config.ts:11-13` — AWS profile is `'Personal'` unless running in
CI or with `AWS_ACCESS_KEY_ID` set. The SFN ARN format the operator
uses is
`arn:aws:states:us-west-1:343487555569:stateMachine:dev-builder`
(`stealth-chromium/README.md:195-196`). Account id `343487555569`.
When running aws-cli commands locally, always
`AWS_PROFILE=Personal AWS_REGION=us-west-1`.

### Two SFN executions just ran (state as of 2026-05-26)

- `stealth-chromium-148-20260526-130545` — **FAILED** (`BuildFailed`),
  ran 2 minutes.
- `stealth-chromium-148-20260526-132418` — **RUNNING** as of dive time,
  in the `WaitForBuild ↔ CheckBuildStatus` poll loop with
  `c7i.4xlarge`, `on-demand`, `rootVolumeSizeGb=200`, ref
  `browser-iterations`. This is the active "validate the binary works"
  run the user mentioned.
