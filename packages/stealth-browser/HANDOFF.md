# `stealth-browser` + `stealth-chromium` — context for the next Claude session

One-page brief for any future Claude session (including a fresh Claude Cloud
session) picking up this work. Read this FIRST — it captures everything that
doesn't survive a fresh checkout. **Last substantively updated 2026-11-05**
(branch `browser-iterations`, after the round-2 stealth fixes + Widevine CDM
work).

> **Currency note.** Sections marked 🟢 CURRENT reflect the cloud build
> pipeline as actually deployed and validated. Sections marked 🟡 HISTORICAL
> describe the original migration and are kept for context but are no longer
> the active workflow.

---

## TL;DR

A stealth headless-Chrome service designed to compete with Browserbase. It runs
*real* Chrome (not `--headless`) via Xvfb, drives it through `nodriver`
(CDP-direct) or patched Playwright (`patchright`), and exposes an HTTP API for
managed sessions with per-session proxies, session cloning, and `/fetch` for
"browser-as-HTTP-client".

Two packages, by responsibility:

| Package | What it is | Language |
|---|---|---|
| [`stealth-browser`](.) | Importable Python lib + HTTP service | Python |
| [`stealth-chromium`](../stealth-chromium/) | C++ fingerprint patches + Chromium build recipe | C++ + shell |

**The single most important thing to know:** the Chromium build no longer runs
on anyone's local machine. It runs on an **ephemeral EC2 builder orchestrated by
the `dev-runner` AWS Step Functions state machine** (us-west-2 — a thin
launcher: launch the EC2, kick the build over SSM, poll until done), triggered
by one `aws stepfunctions start-execution` call (or fully automatically via
Renovate → GitHub Actions). Your laptop is never pinned. See "Cloud build"
below.

---

## 🟢 CURRENT: how to build patched Chromium (cloud)

The build pipeline is in `infra/builder/` (SST/Pulumi) + `packages/stealth-chromium/scripts/`.
The `dev-runner` SFN is a thin launcher: it launches the EC2 from a pre-baked
AMI, sends the build command over SSM, and polls until the run exits. The build
script (`packages/stealth-chromium/scripts/sfn-build.sh`) restores caches from
S3, fetches the Widevine CDM input files, applies the patches, compiles,
uploads the binary to S3, and self-terminates — even on failure.

### Trigger a build (manual, from any machine with AWS creds)

```sh
export AWS_PROFILE=Personal AWS_REGION=us-west-2   # 12-hour SSO; rerun when expired
BUILD_ID="stealth-chromium-$(date +%Y%m%d-%H%M%S)"
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:us-west-2:343487555569:stateMachine:dev-runner \
  --name "$BUILD_ID" \
  --input "$(jq -nc --arg id "$BUILD_ID" --arg ref "$(git rev-parse --abbrev-ref HEAD)" \
    '{id:$id, ref:$ref, instanceType:"c7i.16xlarge", marketType:"on-demand",
      storageSizeGib:200, command:"bash packages/stealth-chromium/scripts/sfn-build.sh"}')"
```

SSO login is `aws sso login --sso-session=personal --use-device-code
--no-browser` — the real session is `personal` (confirmed in `~/.aws/config`).
NOTE: the root `package.json` `pnpm sso` script still says
`--sso-session=Pandoks_`, which does not exist in `~/.aws/config` — stale;
use the explicit command above until that script is fixed.

The SFN clones the branch from GitHub (`ref` must be **pushed** — local-only
branches are invisible to the builder), so commit + push before triggering.

### Trigger a build (automatic — the intended default)

`.github/workflows/build-chromium.yaml` fires the SFN automatically when
`packages/stealth-chromium/chromium_version.txt` changes on `main`. Renovate
watches Google's version API (`renovate.json` custom datasource `chromium-stable`)
and opens a PR when a new stable ships; merging it triggers the build. **Zero
machine involvement.** The workflow also has a `workflow_dispatch` with
`instanceType`/`marketType`/`ref` inputs for manual runs from the Actions UI.

### Monitor a running build

```sh
EXEC=arn:aws:states:us-west-2:343487555569:execution:dev-runner:$BUILD_ID
aws stepfunctions describe-execution --execution-arn "$EXEC" \
  --query '{status:status,started:startDate,stopped:stopDate}' --output json
# Live probe of the EC2 (instance id is tagged with the build id):
INSTANCE=$(aws ec2 describe-instances \
  --filters "Name=tag:Id,Values=$BUILD_ID" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' --output text)
aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --parameters '{"commands":["#!/bin/bash","sudo grep -oE \"\\[[0-9]+/[0-9]+\\]\" /tmp/stealth-chromium-build-*.log | tail -1","sudo CCACHE_DIR=/build/.ccache ccache -s | head -8"]}'
```

### Fetch + validate the built binary

`scripts/validate_artifact.sh [BUILD_ID]` does the whole thing: downloads
`manifest.json` + the tarball from the artifacts bucket
(default `personal-pandoks-runnerartifactsstorebucket-uadorowo`, us-west-2),
`zstd -t`s it, checks size + sha256 against the manifest, extracts to
`/var/tmp/stealth-artifact-<BUILD_ID>/`, sanity-checks the binary in a
container, and **hard-fails if the bundled Widevine CDM is missing** (a
CDM-less artifact reports `NotSupportedError` for `com.widevine.alpha` — the
container can't component-update it later). It then prints the bake commands.

```sh
cd packages/stealth-chromium
scripts/validate_artifact.sh "$BUILD_ID"    # download + verify + extract
export APEX_CHROME_PATH=/var/tmp/stealth-artifact-$BUILD_ID/chromium/chrome
```

### Build-time profile (measured, c7i.16xlarge)

| Scenario | Wall time | Cost |
|---|---|---|
| Same-version warm (both caches hot) | ~17 min | ~$0.85 |
| Patch-release bump (warm ccache, same major) | ~45 min | ~$2.15 |
| Cold / new-major build (both caches cold) | ~86 min | ~$4.10 |

---

## 🟢 CURRENT: the caching system (read before touching setup.sh/build.sh)

Two independent caches in one S3 bucket (exported to the build as
`RUNNER_CACHE_BUCKET`; the legacy name `BUILDER_CACHE_BUCKET` is also accepted
by `setup.sh`). Full diagram in
`.claude/artifacts/2026-05-27-caching-explainer.html` and
`.claude/artifacts/2026-05-28-chromium-build-pipeline-report.html`.

| Cache | S3 key | What | Keyed on | Restored / updated |
|---|---|---|---|---|
| Rolling source | `chromium-src-rolling-v3.tar.zst` (~10 GiB) | full Chromium checkout + `.apex-cache-ready` sentinel (records last-synced version) | static rolling name | restored every build; re-uploaded only when tree changed (`CACHE_DIRTY=1`) |
| ccache | `ccache-chromium<MAJOR>-clang<N>-nomod.tar.zst` (~4-5 GiB) | ~30k compiled `.o` files | Chromium MAJOR + clang MAJOR | restored if key exists; re-uploaded only if grew >100 MB or cold |

**Critical invariants — do not break these (each was a hard-won fix):**

1. **`use_clang_modules = false` in `build/args.gn`** is load-bearing. Chromium's
   default `-fmodules` flag makes BOTH ccache and sccache treat ~88% of compiles
   as uncacheable. Disabling it took cacheable from 11.8% → 99.96%. Don't
   re-enable modules without a replacement caching strategy.
2. **`use_siso = false` + `cc_wrapper = "ccache"`** (`build/args.gn`). siso
   bypasses ccache; plain ninja routes every compile through it.
3. **`CACHE_DIRTY` is declared before step 2 in `setup.sh`** and set in the
   cache-miss branch. If you move it back inside step 3, the rolling cache
   silently never persists (this bug hid for 10 builds — every build was
   secretly source-cold while ccache masked it on wall-time).
4. **ccache env in `build.sh`:** `CCACHE_BASEDIR=$WORK` (path-portable hashes),
   `CCACHE_COMPILERCHECK=content` (mtime resets after tar extract),
   `CCACHE_MAXSIZE=50G`.
5. **`GOPATH`/`GOMODCACHE`/`GOCACHE` exported in `build.sh`** for dawn/tint's
   Go codegen. On a fresh EC2 `$HOME` is unusable, so without these the
   `dawn:generate_sources` action dies with "module cache not found." Only
   surfaces on truly-clean cold builds (the cache used to mask it).
6. **Cross-version source fetch is intentionally cold** (~25 min). We tried
   `git fetch --deepen` to make it incremental; it worked but ballooned the
   cache 10→35 GiB and taxed the common same-version path. Reverted. The
   major-keyed ccache provides the cross-version *compile* savings instead.

**Invalidation:** Chromium version bump does NOT invalidate the rolling source
cache (it advances via the sentinel). It DOES rotate the ccache key on a
**major** bump (`chromium148` → `chromium149`); patch releases reuse the ccache.
To force a clean rebuild: `aws s3 rm s3://<cache-bucket>/ --recursive`.

**Failure diagnostics:** `sfn-build.sh`'s ERR trap uploads `build-failure.log`
(1 MB tail) + a path-agnostic `compile-errors.log` (greps the full log for
`FAILED:`/`error:`, works for plain ninja) to
`s3://$ARTIFACTS/$BUILD_ID/`. Always check `compile-errors.log` first on a failure.

---

## 🟢 CURRENT: status & open work

### Version state — pin is current (157)
- Our pin (`packages/stealth-chromium/chromium_version.txt`): **157.0.8103.38**
  (bumped 2026-11-05, "Linux-Stable-plausible"). The old "we're a major version
  behind at 148" state is resolved — the stack was rebased to 157
  (commit `113043f7`).
- Anchor edits were re-fitted for 157; `apply_edits.py --check` is the drift
  gate (see "Local validation loop" below).

### Branch state — `browser-iterations` carries the full stealth stack
This branch is the working integration branch for the round-2 stealth fixes.
Subsystems it covers (all verified in the tree):

- **UA / UA-CH personas** — brand + full-variant + low/high-entropy
  client-hint headers (`apex-ua-brand`, `apex-ua-latent-ua-string`,
  `apex-ua-latent-ch-low/high`, `apex-uadata-platform`).
- **`navigator.platform`** — persona-coherent (`apex-platform`).
- **Web Bluetooth** — `--enable-features=WebBluetooth` launcher flag
  (`stealth-browser/stealth_browser/profile.py`), not a C++ patch.
- **Fonts deny/allow** — `queryLocalFonts` policy + `document.fonts.check`
  realism (`apex-font-allow`, `apex-font-deny`, `apex-font-system-ui`,
  `apex-font-generic-mono`, `apex-font-generic-mono-worker`).
- **Canvas v2.1 content-keyed lock** — farbling keyed on canvas content plus
  repair rules + fail-closed key (`apex-canvas-getimagedata`,
  `apex-canvas-encode`, `APEX_FP_CANVAS_KEY`).
- **WebGPU identity/limits/features spoofing** — GPUAdapterInfo, backend,
  features, limits (adapter + device), cross-origin compile-state leak
  (`apex-webgpu-identity`, `apex-webgpu-limits`, `apex-webgpu-features`,
  `apex-webgpu-device-limits`, `apex-webgpu-device-features`).
- **WebAuthn platform override** —
  `isUserVerifyingPlatformAuthenticatorAvailable()` (`apex-webauthn-platform`).
- **WebCodecs / mediaCapabilities hw overrides** — decoder/encoder
  `isConfigSupported` + `powerEfficient` (`apex-webcodecs-decoder-hw`,
  `apex-webcodecs-encoder-hw`, `apex-media-power`).
- **HEVC / Dolby Vision codecs** — MSE/WebCodecs/EME lists
  (`apex-media-hevc`, `apex-media-dv`).
- **Widevine CDM bundling** — CDM files fetched by `setup.sh` and shipped in
  the artifact (see the cloud-build section).
- **Regression scripts** — `temporal_audit.py` (same-session drift) +
  `header_fidelity.py` (JA4H header byte-fidelity), both in
  `packages/stealth-browser/scripts/`.
- **Expanded battery** — `adversarial.py` (local detector battery + CreepJS
  cross-check + hard-target anti-bot probes).

**Branch head and the merge decision are left to the user** — this doc does not
prescribe merging.

### THE BUILT BINARY IS NOT FINGERPRINT-TESTED IN THE PIPELINE
Still the biggest open gap. The SFN pipeline runs only
`setup.sh → apply.sh → build.sh` — it does **not** run `test_patched_binary.sh`
(the headful verify page + detector benchmark). So every binary we've produced
is verified to *compile*, but never verified to actually *spoof fingerprints*
at runtime by the pipeline itself. `scripts/validate_artifact.sh` closes the
artifact-integrity half (it hard-fails a tarball missing the Widevine CDM) but
is a host-side post-download check, not wired into the pipeline. The composite
benchmark against the cloud binary is still unrun.

### Local validation loop (offline, no build needed)
- **Anchor drift** — against a real 157 checkout at `$WORK`:
  `APEX_CHROMIUM_WORK=$WORK python3 scripts/apply_edits.py --check`
  (dry-run: every anchor findable, exits 1 with a failure count on drift) and
  `--verify` (post-apply gate: every marker must be present in the tree).
- **Artifact integrity** — `scripts/validate_artifact.sh [BUILD_ID]`: downloads
  and extracts the tarball to a temp dir, hard-fails if the Widevine CDM
  (`manifest.json` / `libwidevinecdm.so`) is missing.
- **Probe suites** (now committed in the repo, not /var/tmp):
  - `scripts/cdp_probe.py` — raw-CDP probe of the patched binary with
    `APEX_FP_*` set; isolates the C++ patches from any automation framework.
  - `scripts/webgpu_probe.py` — WebGPU surface probe against the running
    stealth-browser service (adapter identity + cross-origin compile-state
    leak).
  - `scripts/webgpu_probe_cdp.py` — WebGPU raw-CDP probe of the binary itself
    (`--no-fp` = what stock leaks, `--fp` = what the patched binary presents).
- **Regression scripts** — `stealth-browser/scripts/temporal_audit.py`
  (same-session fingerprint drift; exits non-zero on any drift) and
  `stealth-browser/scripts/header_fidelity.py` (JA4H byte-fidelity against a
  raw-socket echo server). Both verified clean as of 2026-11.
- **Adversarial battery** — `stealth-browser/scripts/adversarial.py`: local
  detector battery (`checks.py` `PROBE_JS`), CreepJS cross-check, and
  hard-target anti-bot probes (Cloudflare/DataDome/Akamai/Kasada/HUMAN/Amazon).

**Top open items, in priority order:**
1. **Close the composite-benchmark loop.** Run `test_patched_binary.sh` (or
   the adversarial battery) against the current cloud-built 157 binary to get
   a real stealth score. Temporal-stability and header-fidelity audits are
   clean, but "is it better than the market" is still unproven on the shipped
   artifact.
2. **Wire `validate_artifact.sh` into the pipeline** so the CDM-presence gate
   runs at build time, not only host-side after download.
3. **Remaining Clark gaps** (see competitive section — the WebGPU, UA-CH,
   fonts, and mediaCapabilities gaps are now closed):
   `navigator.plugins`/`mimeTypes`, `getClientRects` jitter, AudioContext +
   AnalyserNode noise, `navigator.storage.estimate()` quota, launcher hygiene.
   (`navigator.connection` spoof dropped: round-4 verification proved our
   values already match real Chrome on this host — see below.)
4. **No `apps/stealth-browser/` deploy yet** — the Python service has no k8s
   deployment. When ready it becomes a `kube/` overlay over a Docker image of
   this package. Don't add it unless asked.
5. **No Python lint dispatcher** — `scripts/{lint,format}/main.sh` have no `py`
   subcommand. Add `ruff` when you want repo-wide Python linting.

### Verified-real ground truth (round 4, 2026-11-02)

Probed against real Google Chrome 156.0.8078.80 (stable, kept at
`/var/tmp/real-chrome/`) on this host — headless + headful, after a real
navigation and on about:blank. These three round-4 low findings are NOT
defects; our values match real Chrome exactly, so patching them would DIVERGE:

- `chrome.csi` / `chrome.loadTimes` are bare functions with no enumerable
  properties in real Chrome 156 (the object-with-timing shape is old Chrome).
- `performance.memory.jsHeapSizeLimit` = 4395630592 after navigation on this
  64 GB host (the 4294705152 canonical is the low-RAM value); on about:blank
  `performance.memory` is `{}` in real Chrome too.
- `navigator.connection` = {4g, rtt:0, downlink ~1.6} after real traffic —
  real Chrome wobbles downlink the same (1.6-1.75) and reports rtt=0.

Also learned: real Chrome 156 exposes NO `chrome.app` on web pages (object is
just `[loadTimes, csi]`); our `app` overlay (F16, round 3) is extra — low
severity, flag to the defense if they weigh shape. Probe script kept at
`/var/tmp/real-chrome/probe.py` / `probe_blank.py`.

---

## 🟢 CURRENT: C++ patch inventory

**42 distinct edits** (verified in `scripts/apply_edits.py` + `apply.sh`:
40 anchor edits + 2 overlays). Full per-surface table with env-var names lives
in [`../stealth-chromium/README.md`](../stealth-chromium/README.md#whats-already-patched)
(note: the README's own count is stale — the tree is the source of truth).

Three patch mechanisms (only the first two are applied):

| # | Mechanism | Count | Where |
|---|---|---|---|
| 1 | Full-file `chromium_src/` overlay | 2 | `apply.sh` `OVERLAYS=()` (navigator hardwareConcurrency + deviceMemory) |
| 2 | Anchor edit (preferred) | 40 | `EDITS = [...]` in `scripts/apply_edits.py` |
| 3 | `.patch` files (DOC ONLY — NOT applied) | 14 | `patches/*.patch` — review-only, ignore for current behavior |

The 40 anchor markers, by surface: WebGL renderer/vendor/readPixels (3); UA
brand + latent UA string + low/high-entropy client hints + userAgentData
platform (5); navigator.platform + hardwareConcurrency coherence (2); V8 CDP
no-preview (1); canvas getImageData + encode (2); mediaDevices (1); fonts
allow/deny/system-ui/generic-mono/generic-mono-worker (5); screen 5 dims (5);
battery 4 fields (4); speech voices (1); WebGPU identity/limits/features +
device limits/features (5); WebCodecs decoder/encoder hw (2); mediaCapabilities
powerEfficient (1); HEVC (1); Dolby Vision (1); WebAuthn platform (1).

Removed edits (documented in `apply_edits.py`'s "removed edits" list — do not
re-add without new evidence): `apex-audio-noise` (moved the audio hash into a
rare cluster; stock is already common), `apex-measuretext-farbling` (its anchor
is gone on main), `apex-chrome-app-gone` (removing it created a distinguisher).

Deferred (not started): RAF/audio-quantum jitter (Chrome already clamps
`performance.now()` to 100µs); per-eTLD+1 reseeding (`EtldSeed()` helper exists
in `chromium_src/apex_fingerprint.h`, no consumer yet).

> **Stale benchmark claim (do not trust without re-running):** earlier docs
> cite "composite 1.000 on a 17-detector benchmark, CreepJS 0% headless." That
> was measured pre-migration against an old local binary. No cloud-built
> binary has been composite-benchmarked. The temporal-stability and
> header-fidelity audits ARE clean (2026-11), but treat the patch set as
> "compiles clean, composite-unverified" until the benchmark runs against the
> current 157 artifact.

---

## 🟢 CURRENT: competitive position (vs clark-browser)

Detailed analysis: `.claude/artifacts/2026-05-26-clark-vs-stealth-browser.html`
and `2026-05-26-clark-browser-audit.html`. The apples-to-apples comparison is
**stealth-chromium ↔ Clark** (the C++ patch layer); our HTTP-service half has
no Clark equivalent (that's the Browserbase/Steel lane).

**Where we already win:** real Google Chrome (not ungoogled — genuine TLS/JA3);
headful on Xvfb (Clark admits CreepJS still flags their `--headless=new`); full
HTTP service with session cloning + `/fetch` + first-class proxy (Clark has
none); anchor-edit patches survive version bumps (Clark's `.patch` files don't);
battery/speech/mediaDevices/WebGPU patches not in Clark's catalog. Clark ships
only 17 of its 49 cataloged patches; we ship 42 edits.

**Top gaps vs Clark's shipped patches** (ranked by 2025-26 detector weight;
🟢 quick / 🟡 medium / 🟠 port-from-Brave):
1. 🟡 `navigator.plugins`/`mimeTypes` PDF-viewer list
2. 🟠 `getClientRects`/`getBoundingClientRect` jitter (cross-session correlation)
3. 🟠 AudioContext + AnalyserNode noise (we only patch getChannelData, 1 of 3 levels)
4. 🟡 WebGL `getParameter`/`getSupportedExtensions` cross-field coherence
5. 🟢 `--enable-automation` launcher hygiene (operational guardrail)
6. 🟢 `navigator.storage.estimate()` quota spoof

(Closed since the 2026-05 audit: WebGPU `GPUAdapterInfo` coherence, UA Client
Hints `Sec-CH-UA-*` header coherence, `document.fonts.check()` realism — all
now shipped. `navigator.connection` spoof dropped: round-4 verification proved
our values already match real Chrome on this host.)

---

## 🟢 CURRENT: running the Python service locally

```sh
cd packages/stealth-browser
uv sync                                          # uv is separate from pnpm; see below
APEX_CORE=patchright PORT=8089 uv run stealth-browser   # PORT default in code is 8089
# smoke test in another terminal:
curl -s localhost:8089/health
SID=$(curl -s -XPOST localhost:8089/sessions -H 'content-type: application/json' -d '{}' | jq -r .id)
curl -s -XPOST localhost:8089/sessions/$SID/navigate -H 'content-type: application/json' -d '{"url":"https://example.com"}'
curl -s -XDELETE localhost:8089/sessions/$SID
```

Prereqs: system Google Chrome (or `APEX_CHROME_PATH` → patched binary), Xvfb on
Linux (service is headful by design), `jq`, `uv`. Env vars: `APEX_CORE`
(`nodriver`|`patchright`), `PORT`, `APEX_CHROME_PATH`, `APEX_FP_*` (per-session
fingerprint overrides, only meaningful with the patched binary),
`APEX_PERSONA_DIR`/`APEX_PERSONA_COUNT` (persistent-profile pool, default 4),
Oxylabs proxy creds. The service HAS been driven against live browsers since
the migration — `scripts/temporal_audit.py` and `scripts/header_fidelity.py`
(2026-11) run real sessions through it and both verified clean.

---

## 🟡 HISTORICAL: the migration (2026-05-26)

Three sandbox projects (`~/Projects/sandbox/{stealth-browser,apex-browser,apex-chromium}/`)
collapsed into `packages/{stealth-browser,stealth-chromium}/`. Code-level edits:
`_paths.py` shim removed; `from stealth.X` → `from stealth_browser.X`;
bare-sibling imports → relative; apex's `session.py` kept the name (HTTP
`SessionManager`), stealth's became `human_session.py`; added `run_server()`
for the console-script entry. Sandbox was a copy, not a move — originals
untouched.

The X9Pro external SSD (`/Volumes/X9Pro/apex-chromium-build/`) held the
original local build + a v1 binary + a 22-detector benchmark. **This is no
longer the build path** — the cloud SFN builder replaced it. The v2 link
failure described in old versions of this doc was a local stale-toolchain
artifact; the cloud builder compiles cleanly (`.215` at the time; the pin is
now 157).

---

## Repo conventions you must know

pandoks_browser is a pnpm/SST/k3s monorepo. Read `.claude/rules/`:
`universal.md` (pnpm-only, conventional commits `feat/fix/update/chore/refactor/cleanup/build`,
comment density, no try/catch around AWS SDK), `architecture.md`,
`workflows.md`, `conventions/{ts,go,shell,charts,svelte}.md`. Python is the
first non-JS/Go member and has no `conventions/py.md` yet.

**Three parallel workspaces share the on-disk layout:** pnpm
(`pnpm-workspace.yaml`, every dir with `package.json`), Go (`go.work`,
valkey/reconciler), uv (root `pyproject.toml`, only `stealth-browser`).
`pnpm install` does NOT install Python deps — run `uv sync` in the package.
`stealth-chromium` has a `package.json` for pnpm enumeration but is NOT a uv
member (no `pyproject.toml`).

**`APEX_*` env-var prefix is legacy and intentional** (`APEX_CHROMIUM_WORK`,
`APEX_FP_*`, `APEX_CORE`, `APEX_CHROME_PATH`). New code matches the existing
prefix. The rename to `STEALTH_*` is deferred.

## What the user values

- **Verified > inferred.** Check before claiming; measure the artifact, not a
  proxy (the caching saga's central lesson: a fast build ≠ a working cache).
- **No deploy until asked.** No `kube/`/Dockerfile/helm/CI matrix entries unless
  explicitly requested.
- **HTML artifacts for non-trivial explainers** (`.claude/artifacts/`).
- **Conventional commits**, type-only prefix, PR number in parens when applicable.
- **Cost estimates labeled as estimates** (Cost Explorer lags 12-48h).
- **No commits unless asked.**
