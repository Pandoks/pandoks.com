# `stealth-browser` + `stealth-chromium` — context for the next Claude session

One-page brief for any future Claude session (including a fresh Claude Cloud
session) picking up this work. Read this FIRST — it captures everything that
doesn't survive a fresh checkout. **Last substantively updated 2026-06-05**
(branch `claude/sleepy-hawking-PUugj`, after the platform-fix + WebGPU +
GL-libs-packaging work).

## 🟢 LATEST VERIFIED STATE (2026-06-05)

**Latest green build:** `stealth-chromium-149audio-20260605-180008`
(Chromium `149.0.7827.53`, off commit `a8d743b`) — passed all 21
binary-string asserts AND the in-build runtime self-check scored
**29/29 surfaces = 1.000, ALL CLEAN** (uploaded to the artifact prefix as
`runtime-selfcheck.log`). The self-check is now a two-pass differential
(stock baseline vs spoofed); the audio FP fix below is confirmed:
`PASS OfflineAudioContext farbled vs stock`. WebGL also PASS on the builder.
WebGPU still SKIP (no software adapter even on the GPU-less builder).

Earlier milestone: build `stealth-chromium-149final-20260605-153624`
(off `a79f0c4`) was the first fully-green binary; verified
**26/26 surfaces** locally (now 29/29 with the added differential checks),
zero JS-visible tampering (every toString-native check passes). Includes `navigator.platform` — the surface that silently
dropped from 6 prior builds (root cause: it was patched on the LTO-dead
`NavigatorID::platform()`; fix moved it to the reachable
`NavigatorBase::platform()`). WebGL spoof confirmed live
(`Google Inc. (Apple)` / `ANGLE … Apple M1 Pro`). Automation surface clean:
`navigator.webdriver=false`, no `cdc_` props, correct 5-entry PDF plugin
list + 2 mimeTypes, `window.chrome` present, Notification permission
internally consistent (no headless mismatch tell).

**Two bugs found by closing the runtime-verification gap** (downloading the
binary and running it, not just `strings`-checking):
1. The artifact whitelist shipped **no GL/Vulkan libs** → the binary had NO
   working WebGL/WebGPU (a glaring bot tell). Fixed: `sfn-build.sh` now
   globs every top-level `.so`/`.so.N`/`_icd.json` (ANGLE + SwiftShader).
2. `verify_patched_binary.py` couldn't launch as root → added nodriver
   `sandbox=False`.

**WebGPU coherence** (`apex-webgpu-adapterinfo`): patch is linked + asserted
+ statically verified, but **runtime-unverified** — this ephemeral GPU-less
container can't produce a software WebGPU adapter (flag-brittle; not a patch
defect). Verify on a host with a real GPU or working SwiftShader-Vulkan.

**Blocked from THIS container (egress policy MITMs browser TLS/QUIC):**
the live fingerprinter panel (`fingerprint_benchmark.py` → cert errors /
`ERR_QUIC_PROTOCOL_ERROR`) and the Oxylabs proxy test (`:60000` blocked).
`curl` returns 200 but Chrome rejects the MITM'd certs. **Run the panel +
proxy test from the production host or a clean-egress environment.**

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
an AWS Step Functions state machine** (`dev-builder`), triggered by one
`aws stepfunctions start-execution` call (or fully automatically via Renovate →
GitHub Actions). Your laptop is never pinned. See "Cloud build" below.

---

## 🟢 CURRENT: how to build patched Chromium (cloud)

The build pipeline is in `infra/builder/` (SST/Pulumi) + `packages/stealth-chromium/scripts/`.
It launches a fresh c7i/c7g EC2 from a pre-baked AMI, restores caches from S3,
applies the patches, compiles, uploads the binary to S3, and self-terminates —
even on failure.

### Trigger a build (manual, from any machine with AWS creds)

```sh
export AWS_PROFILE=Personal AWS_REGION=us-west-1   # 12-hour SSO; rerun `pnpm sso` when expired
BUILD_ID="stealth-chromium-$(date +%Y%m%d-%H%M%S)"
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:us-west-1:343487555569:stateMachine:dev-builder \
  --name "$BUILD_ID" \
  --input "$(jq -nc --arg id "$BUILD_ID" --arg ref "$(git rev-parse --abbrev-ref HEAD)" \
    '{id:$id, ref:$ref, instanceType:"c7i.16xlarge", marketType:"on-demand",
      storageSizeGib:200, command:"bash packages/stealth-chromium/scripts/sfn-build.sh"}')"
```

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
EXEC=arn:aws:states:us-west-1:343487555569:execution:dev-builder:$BUILD_ID
aws stepfunctions describe-execution --execution-arn "$EXEC" \
  --query '{status:status,started:startDate,stopped:stopDate}' --output json
# Live probe of the EC2 (instance id is tagged with the build id):
INSTANCE=$(aws ec2 describe-instances \
  --filters "Name=tag:Id,Values=$BUILD_ID" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' --output text)
aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --parameters '{"commands":["#!/bin/bash","sudo grep -oE \"\\[[0-9]+/[0-9]+\\]\" /tmp/stealth-chromium-build-*.log | tail -1","sudo CCACHE_DIR=/build/.ccache ccache -s | head -8"]}'
```

### Fetch the built binary

```sh
ARTIFACTS=personal-pandoks-builderartifactsbucketbucket-oawuxubt
aws s3 cp "s3://$ARTIFACTS/$BUILD_ID/manifest.json" - | jq .
aws s3 cp "s3://$ARTIFACTS/$BUILD_ID/chromium-<version>.tar.zst" .
tar --use-compress-program 'zstd -d --long=27' -xf chromium-<version>.tar.zst -C /opt/stealth-chromium/
export APEX_CHROME_PATH=/opt/stealth-chromium/chrome
```

### Build-time profile (measured, c7i.16xlarge, us-west-1)

| Scenario | Wall time | Cost |
|---|---|---|
| Same-version warm (both caches hot) | ~17 min | ~$0.85 |
| Patch-release bump (warm ccache, same major) | ~45 min | ~$2.15 |
| Cold / new-major build (both caches cold) | ~86 min | ~$4.10 |

---

## 🟢 CURRENT: the caching system (read before touching setup.sh/build.sh)

Two independent caches in one S3 bucket
(`personal-pandoks-buildercachebucketbucket-dadcwbmn`). Full diagram in
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

### Version state — WE ARE A MAJOR VERSION BEHIND
- Our pin (`packages/stealth-chromium/chromium_version.txt`): **148.0.7778.215**
- Chrome stable as of 2026-06-03: **149.0.7827.53**
- The next build should bump to 149. Anchor edits *should* survive the major
  bump but this is unverified — run
  `APEX_CHROMIUM_WORK=$WORK python3 scripts/apply_edits.py --check` against a
  149 checkout to confirm no anchors drifted before trusting the build.

### THE BUILT BINARY IS NOT FINGERPRINT-TESTED
This is the biggest open gap. The SFN pipeline runs only
`setup.sh → apply.sh → build.sh` — it **does not run
`test_patched_binary.sh`**. So every binary we've produced (including the
`.215` one in S3) is verified to *compile*, but never verified to actually
*spoof fingerprints* at runtime. `test_patched_binary.sh` exists but is a
manual, headful, host-side step (loads `verify_patches.html`, runs a
16-detector benchmark). **The "composite 1.000 / 17-detector" claim below in
the patch section is STALE** — it predates the monorepo migration and was
measured against an old local binary, not the cloud-built `.215`.

**Top open items, in priority order:**
1. **Close the validation loop.** Run `test_patched_binary.sh` against the
   cloud `.215` binary (or wire it into the pipeline) to get a real, current
   stealth score. Right now "is it better than the market" is unproven on the
   shipped artifact.
2. **Bump to Chromium 149** + `apply_edits.py --check` for anchor drift +
   rebuild. The 148→149 bump is the natural forcing function to do #1 too.
3. **Close the Clark gaps** (see competitive section). Quick wins first:
   `navigator.connection` spoof, `storage.estimate()` quota, launcher hygiene.
4. **No `apps/stealth-browser/` deploy yet** — the Python service has no k8s
   deployment. When ready it becomes a `kube/` overlay over a Docker image of
   this package. Don't add it unless asked.
5. **No Python lint dispatcher** — `scripts/{lint,format}/main.sh` have no `py`
   subcommand. Add `ruff` when you want repo-wide Python linting.

---

## 🟢 CURRENT: C++ patch inventory

**25 distinct edits** (verified in `scripts/apply_edits.py` + `apply.sh`),
unchanged since the migration. Full per-surface table with env-var names lives
in [`../stealth-chromium/README.md`](../stealth-chromium/README.md#whats-already-patched).

Three patch mechanisms (only the first two are applied):

| # | Mechanism | Count | Where |
|---|---|---|---|
| 1 | Full-file `chromium_src/` overlay | 2 | `apply.sh` `OVERLAYS=()` (navigator hardwareConcurrency + deviceMemory) |
| 2 | Anchor edit (preferred) | 23 | `EDITS = [...]` in `scripts/apply_edits.py` |
| 3 | `.patch` files (DOC ONLY — NOT applied) | 11 | `patches/*.patch` — vestigial, ignore for current behavior |

The 23 anchor markers: WebGL renderer/vendor/readPixels, navigator
platform + userAgentData.platform, WebRTC no-leak, V8 CDP no-preview, canvas
getImageData/encode/measureText, audio noise, mediaDevices, fonts, screen
(5 dims), battery (4 fields), speech voices.

Deferred (not started): RAF/audio-quantum jitter (Chrome already clamps
`performance.now()` to 100µs); per-eTLD+1 reseeding (`EtldSeed()` helper exists
in `chromium_src/apex_fingerprint.h`, no consumer yet).

> **Stale benchmark claim (do not trust without re-running):** earlier docs
> cite "composite 1.000 on a 17-detector benchmark, CreepJS 0% headless." That
> was measured pre-migration against an old local binary. The cloud `.215`
> binary has NOT been benchmarked. Treat the patch set as "compiles clean,
> runtime-unverified" until `test_patched_binary.sh` runs against it.

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
battery/speech/mediaDevices patches not in Clark's catalog. Clark ships only 17
of its 49 cataloged patches; we ship 25 edits.

**Top gaps vs Clark's shipped patches** (ranked by 2025-26 detector weight;
🟢 quick / 🟡 medium / 🟠 port-from-Brave; ✅ = now shipped):
1. 🟡 `navigator.plugins`/`mimeTypes` PDF-viewer list — STILL OPEN
2. ✅ WebGPU `GPUAdapterInfo` coherence — vendor/architecture overridden +
   isFallbackAdapter forced false (`apex-webgpu-adapterinfo`), coherent with
   the WebGL GPU; launcher sets `APEX_FP_WEBGPU_*` per profile
3. ✅ `navigator.connection` spoof (`APEX_FP_NET_*`)
4. ✅ `getClientRects`/`getBoundingClientRect` jitter (`JitterCoord`)
5. ✅ AudioContext + AnalyserNode noise (`PerturbAnalyserFloat` added — was 1/3)
6. 🟢 WebGL numeric coherence — ANALYZED: it's DEPLOYMENT-gated, not a safe
   patch. Real Apple/Intel/AMD report `MAX_TEXTURE_SIZE` 16384, NVIDIA 32768,
   but a GPU-less host renders via SwiftShader → 8192 (matches no real GPU →
   tell). On a real-GPU host matching the persona's `gpu_class` the caps are
   already correct (the `fp_profiles` design); on SwiftShader, caps-spoofing
   is a band-aid that doesn't fix the render-OUTPUT pixel hash and risks
   allocation-probe detection (claim 16384, fail to allocate >8192). The
   verifier now prints a `[WebGL CAPS INCOHERENT]` warning when string<->caps
   disagree, so a GPU-less deployment is loud. **Action: deploy on GPU hosts
   whose class matches the persona pool (or accept WebGL won't pass).**
7. ✅ UA Client Hints `Sec-CH-UA-*` header coherence (`APEX_FP_UA_PLATFORM_VERSION`)
8. ✅ `--enable-automation` launcher hygiene
9. 🟡 fonts: path-1 (direct query) now OS-coherent (allowlist gated on
   `APEX_FP_UA_PLATFORM` — no more impossible Win+Mac combo). Path-2 (width
   measurement) still needs the deployment font bundle to match the persona.
10. ✅ `navigator.storage.estimate()` quota spoof (`APEX_FP_STORAGE_QUOTA`)

Also fixed this round: the **OfflineAudioContext audio fingerprint** was not
being farbled (only the `AudioBuffer(AudioBus*)` ctor was hooked; the offline
result bypasses it) — found by spoof-vs-stock differential, fixed via
`apex-audio-offline-noise`. The verifier is now a two-pass differential that
catches noise regressions like it.

Remaining: #1 plugins/mimeTypes is NOT a real gap (real-Chromium already has
the correct 5 PDF plugins — verified). #6 WebGL numeric coherence is
deployment-gated (real GPU host required — see above), not a patch.
Genuinely-open PATCH work: per-eTLD+1 noise reseeding (`EtldSeed` helper
exists, no call site consumes it yet). Genuinely-open DEPLOYMENT work: GPU
hosts matching the persona pool, and per-OS font bundles (fonts path-2).

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
fingerprint overrides, only meaningful with the patched binary), Oxylabs proxy
creds. The service has NOT been started against a live browser since the
migration — import-only smoke test passed; a real end-to-end run is still open.

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
artifact; the cloud builder compiles `.215` cleanly.

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
