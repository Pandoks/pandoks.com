# `stealth-browser` + `stealth-chromium` — context for the next Claude session

One-page brief for any future Claude session (including a fresh Claude Cloud
session) picking up this work. Read this FIRST — it captures everything that
doesn't survive a fresh checkout. **Last substantively updated 2026-06-06**
(branch `claude/sleepy-hawking-PUugj`, after WebGPU enable + limits/features
coherence, the in_container→Linux WebGL-gate fix, and 15-profile verification).

## 🟢 LATEST VERIFIED STATE (2026-06-06)

**Latest green build:** `stealth-chromium-149wgpu-20260606-075755`
(Chromium `149.0.7827.53`) — in-build self-check **34/34 = ALL CLEAN**.
Adds `apex-webgpu-limits` + `apex-webgpu-features` (WebGPU limits/features
coherence, see below). Binary surfaces all spoof; zero JS-visible tampering.

**WebGPU limits/features coherence (`apex-webgpu-limits` + `-features`):**
the adapter-info patch only spoofed vendor/arch — the ~40 `adapter.limits`
and the `features` set were raw SwiftShader, identical across all personas.
Two grounded tells fixed: (1) `maxTextureDimension1D/2D` 8192→16384 (real
GPUs report 16384; 8192 contradicted our spoofed WebGL `MAX_TEXTURE_SIZE`);
(2) ASTC/ETC2 texture-compression stripped for non-Apple personas (mobile
formats: ~93% macOS but ~0.6% Windows real support — web3dsurvey), BC kept.
Runtime-verified per family (`stealth-wgpulim-20260606-082750`): Apple →
maxTex2D 16384 + astc/etc2/bc; NVIDIA → maxTex2D 16384 + bc only (astc/etc2
stripped). build self-check asserts maxTex2D==16384 + ASTC-for-Apple.

**🔴→🟢 CRITICAL FIX — WebGL + WebGPU were DISABLED in the real launch path.**
The GL/WebGL/WebGPU flag block in `chrome_launch_flags` was gated on
`in_container()`, which only detects Docker (`/.dockerenv` or
`STEALTH_IN_DOCKER`). Under **containerd/CRI-O (k8s — our deploy target)**,
podman, bare EC2, and CI that check is **False**, so Chrome got none of
`--use-gl/--enable-webgl/--enable-unsafe-webgpu` and **silently disabled
WebGL + WebGPU** (`navigator` → "WebGL: disabled or unavailable", a glaring
bot tell). Every prior panel measured a WebGL-OFF browser; the verifier
(hardcoded flags) was the only thing that ever had WebGL, which masked the
bug. **Now gated on `platform == "Linux"`** (robust across
docker/containerd/k8s/bare-EC2; harmless on a real GPU). `--no-sandbox` /
`--disable-dev-shm-usage` split onto a root-or-container gate.
Fixed in `profile.py:chrome_launch_flags`.

**WebGPU enabled + coherent** (`profile.py` + `apex-webgpu-adapterinfo`):
`--enable-unsafe-webgpu --enable-features=Vulkan` make Chrome's bundled
SwiftShader Vulkan yield an adapter on a GPU-less box; the patch reports the
persona's GPU family with `isFallbackAdapter=false`. Was absent before
(`requestAdapter()`→null) — a coherence tell for macOS/Windows personas.

**WebGL software-renderer stability**: `--disable-gpu-watchdog`
`--disable-gpu-process-crash-limit` keep the slow llvmpipe GPU process from
being killed + GL permanently disabled under a heavy WebGL battery.

**Live panel after the fixes (`stealth-panel-20260606-064440`,
run-panel.sh, GPU-less datacenter IP):** WebGL **ALIVE + spoofed** in both
window and worker (`Google Inc. (Intel)` / `ANGLE (Intel, Intel(R) Iris(R)
Xe … D3D11)`), `ALIASED_LINE_WIDTH_RANGE [1,1]`, `POINT_SIZE [1,1024]`,
MAX_TEXTURE_SIZE 16384, WebGL2 on; **WebGPU present + hashed** (not
`unsupported`); CreepJS held at **0% headless / 0% stealth** (the now-visible
GPU surfaces introduce no new lie). Only residual tells are IP-based
(iphey suspicious, browserscan 85%, WebRTC IP) — clear with a residential
proxy. Proxy path verified compatible in code (CDP `Fetch.authRequired`
auth, `{session}`/`{peer}` rotation, identity geo-matched to exit IP).

**All 15 profiles runtime-verified (`stealth-fulltest-20260606-015651`,
clean EC2 spot, one browser/process):** **15/15 coherent** — every profile
correct on `navigator.platform`, `userAgentData.platform`,
`hardwareConcurrency`, `screen.width`, WebGL UNMASKED_RENDERER GPU-class,
the UA OS token, AND `ALIASED_LINE_WIDTH_RANGE[1]==1` (the new
`apex-webgl-ranges` patch — llvmpipe's native default is 255; real
D3D11/Metal GPUs report 1, so this closes a software-renderer tell).
Profiles span 8 Apple-Silicon Macs + 7 Windows (NVIDIA RTX 30/40, GTX
1660 Ti, Intel Iris Xe / UHD 630, AMD RX 6700/7600) with real ANGLE
renderer strings + PCI device IDs. Re-run `stealth-fulltest-20260606-071103`
adds **WebGPU vendor coherence per family** — all 15 report
`adapter.info.vendor == gpu_class` (apple/nvidia/intel/amd) with
`isFallbackAdapter=false`, i.e. the WebGL↔WebGPU GPU cross-check agrees on
every persona, not just Apple/Intel.

**Behavioral ghost-cursor confirmed (same run, vs `bot.incolumitas.com`):**
the CDP `Input.dispatchMouseEvent` stream from `human.py` fires real
in-page events — **724 mousemove + 724 pointermove, all `isTrusted:true`**.
A DataDome-class behavioral model receives genuine human-shaped input, not
synthetic JS dispatch. (incolumitas's own `Behavioral Score: ...` field
never numerically populates — that's its display, not our gap.)

**Earlier panel results** (`stealth-panel2/3/4`, pre WebGL-gate fix — these
ran with WebGL/WebGPU OFF in the panel browser; see the CRITICAL FIX above.
The non-GPU verdicts still stand; the WebGL/WebGPU lines were superseded by
`stealth-panel-20260606-064440`):

- ✅ `areyouheadless`: "You are NOT Chrome headless"
- ✅ `sannysoft`: all webdriver/automation checks pass (`webdriver=false`)
- ✅ CreepJS: **`0% headless`, `0% stealth`** (the decisive verdicts). UA now
  Windows-coherent in BOTH window + worker (`Chrome/149`, was Linux). `38%
like headless` = soft resemblance score (repo treats it as non-failing).
- ✅ `browserscan`: authenticity **85% → 90%** after the UA fix (one fewer
  `-5%` deduction).
- ✅ `bl_tls`: authentic real-Chrome JA3/JA4 (`t13d1517h2…`).
- ✅ instance-side verifier.txt: `MAX_TEXTURE_SIZE=16384 coherent` (headful
  Mesa llvmpipe — production's real WebGL), 31/31.
- ⚠️ `iphey`: "suspicious" but HW/SW "fine" → **datacenter IP**, not
  fingerprint. `bl_webrtc` leaks the EC2 IP (no proxy). Both clear with a
  residential proxy.

**This-session fixes (all built + validated):** UA-string OS coherence
(`apex-ua-platform`, native `GetUnifiedPlatform`), `canvas.toBlob` farbling
(`apex-canvas-encode-blob` + private SkBitmap), removed a dead JS
`_WEBGL_NORMALIZE_JS` toString-proxy landmine, corrected #6 (WebGL caps are
coherent in production via headful Mesa llvmpipe = 16384; the 8192 was a
`--headless` artifact), verifier now runs headful-on-Xvfb.

**Fonts:** `run-panel` installs MS core fonts + metric clones (Carlito=Calibri,
Caladea=Cambria) + `fc-cache` — verified 358 fonts visible, `Calibri→Carlito`
resolves. CreepJS still counts `6/51` (its own width-expectation methodology,
not a system misconfig). Production wants these fonts + fontconfig aliases
baked into the per-persona image.

**incolumitas (`bot.incolumitas.com`, panel5)** — the most detailed open bot
test, run for the IP-independent fingerprint/automation verdict: **~40 tests
pass** (fpscanner PHANTOM*\*/HEADCHR*\*/SELENIUM/CHR_DEBUG, intoli webDriver +
webDriverAdvanced, custom puppeteerExtraStealthUsed + worker/serviceworker
consistency — all OK). The ONLY automation "FAIL" is `fpscanner.WEBDRIVER`,
which is a stale-library FALSE POSITIVE: it flags the mere presence of
`navigator.webdriver` (a standard W3C property every Chrome 89+ ships).
Verified our state == real Chrome (webdriver=false, property present, zero
cdc/phantom/selenium artifacts) — real Chrome fails it identically; removing
the property would be WORSE (diverges from real Chrome). Only real negative:
`is_datacenter: true` (the IP).

**Still genuinely blocked / deployment-side:** residential-proxy test — creds
exist (Oxylabs hbproxy.net + SST `OxylabsWebUnblocker*`) but the hbproxy
endpoints reject with `403 proxy_ip_not_allowed` (account is IP-allowlist
auth; source IP not whitelisted) — needs the Oxylabs dashboard set to
user:pass auth OR a whitelisted static IP. (WebGPU runtime is now RESOLVED —
present + coherent via SwiftShader Vulkan, see the CRITICAL FIX above.) Only
the residual render-OUTPUT pixel coherence (llvmpipe vs claimed GPU) and the
residential-proxy IP test remain.

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

- statically verified, but **runtime-unverified** — this ephemeral GPU-less
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
_real_ Chrome (not `--headless`) via Xvfb, drives it through `nodriver`
(CDP-direct) or patched Playwright (`patchright`), and exposes an HTTP API for
managed sessions with per-session proxies, session cloning, and `/fetch` for
"browser-as-HTTP-client".

Two packages, by responsibility:

| Package                                    | What it is                                      | Language    |
| ------------------------------------------ | ----------------------------------------------- | ----------- |
| [`stealth-browser`](.)                     | Importable Python lib + HTTP service            | Python      |
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

| Scenario                                     | Wall time | Cost   |
| -------------------------------------------- | --------- | ------ |
| Same-version warm (both caches hot)          | ~17 min   | ~$0.85 |
| Patch-release bump (warm ccache, same major) | ~45 min   | ~$2.15 |
| Cold / new-major build (both caches cold)    | ~86 min   | ~$4.10 |

---

## 🟢 CURRENT: the caching system (read before touching setup.sh/build.sh)

Two independent caches in one S3 bucket
(`personal-pandoks-buildercachebucketbucket-dadcwbmn`). Full diagram in
`.claude/artifacts/2026-05-27-caching-explainer.html` and
`.claude/artifacts/2026-05-28-chromium-build-pipeline-report.html`.

| Cache          | S3 key                                                     | What                                                                                | Keyed on                     | Restored / updated                                                         |
| -------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| Rolling source | `chromium-src-rolling-v3.tar.zst` (~10 GiB)                | full Chromium checkout + `.apex-cache-ready` sentinel (records last-synced version) | static rolling name          | restored every build; re-uploaded only when tree changed (`CACHE_DIRTY=1`) |
| ccache         | `ccache-chromium<MAJOR>-clang<N>-nomod.tar.zst` (~4-5 GiB) | ~30k compiled `.o` files                                                            | Chromium MAJOR + clang MAJOR | restored if key exists; re-uploaded only if grew >100 MB or cold           |

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
   major-keyed ccache provides the cross-version _compile_ savings instead.

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

### Version state — ON CHROMIUM 149 (current)

- Building **149.0.7827.53** (Chrome stable). Anchor edits survived the
  148→149 bump; the `149wgl` build is green with 25 edits applied.

### Validation loop — CLOSED

The binary IS now fingerprint-tested, two ways:

1. **In-build, every build:** `sfn-build.sh` step 4.6 runs
   `verify_patched_binary.py` headful-on-Xvfb (production's real WebGL
   mode) and uploads `runtime-selfcheck.log`. The `149wgl` build scored
   **31/31 surfaces spoofed, ALL CLEAN**, MAX_TEXTURE_SIZE 16384 coherent.
2. **On-demand, all profiles + behavioral:** `full_test.sh` (driven by the
   same SFN) loops `profile_probe.py` over every `fp_profiles.PROFILES`
   entry one-browser-per-process and runs `behavior_probe.py`. Latest run
   `stealth-fulltest-20260606-015651`: **15/15 profiles coherent**, ghost
   cursor fires **724 trusted mouse events**. See the verified-state block
   at the top.

Plus live fingerprinter panels (`run-panel.sh`): CreepJS 0% headless / 0%
stealth, sannysoft/areyouheadless pass, incolumitas ~40 tests pass,
authentic JA3/JA4 TLS. The only remaining tells are **datacenter-IP**
(iphey "suspicious", WebRTC IP leak) — both clear with a residential proxy.

**Top open items, in priority order:**

1. **Residential-proxy validation.** The only unproven surface is IP-based
   (iphey/WebRTC). Oxylabs `hbproxy.net` residential is IP-allowlist auth
   and the container egress IP isn't allowlisted (`403
proxy_ip_not_allowed`); validate from an allowlisted host or via the
   panel box once its egress IP is added to the Oxylabs allowlist.
2. **Close the Clark gaps** (see competitive section). Quick wins first:
   `navigator.connection` spoof, `storage.estimate()` quota, launcher hygiene.
3. **No `apps/stealth-browser/` deploy yet** — the Python service has no k8s
   deployment. When ready it becomes a `kube/` overlay over a Docker image of
   this package. Don't add it unless asked.
4. **No Python lint dispatcher** — `scripts/{lint,format}/main.sh` have no `py`
   subcommand. Add `ruff` when you want repo-wide Python linting.

---

## 🟢 CURRENT: C++ patch inventory

**39 anchor edits** (count via `marker` keys in `scripts/apply_edits.py`)

- 2 full-file overlays. Full per-surface table with env-var names lives
  in [`../stealth-chromium/README.md`](../stealth-chromium/README.md#whats-already-patched).

Three patch mechanisms (only the first two are applied):

| #   | Mechanism                               | Count | Where                                                                   |
| --- | --------------------------------------- | ----- | ----------------------------------------------------------------------- |
| 1   | Full-file `chromium_src/` overlay       | 2     | `apply.sh` `OVERLAYS=()` (navigator hardwareConcurrency + deviceMemory) |
| 2   | Anchor edit (preferred)                 | 37    | `EDITS = [...]` in `scripts/apply_edits.py`                             |
| 3   | `.patch` files (DOC ONLY — NOT applied) | 11    | `patches/*.patch` — vestigial, ignore for current behavior              |

The anchor markers cover: WebGL renderer/vendor/readPixels +
ALIASED_LINE_WIDTH/POINT_SIZE ranges (`apex-webgl-ranges`), navigator
platform + userAgentData.platform + UA-string OS token
(`apex-ua-platform`), WebGPU adapterInfo, WebRTC no-leak, V8 CDP
no-preview, canvas getImageData/toBlob/encode/measureText, audio
noise (online + OfflineAudioContext), mediaDevices, fonts, screen
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
6. ✅ WebGL numeric coherence — RESOLVED, and NOT a real gap in production.
   **Correction to an earlier wrong analysis:** production runs HEADFUL on
   Xvfb, where `profile.chrome_launch_flags` routes WebGL through ANGLE-GL on
   **Mesa llvmpipe → `MAX_TEXTURE_SIZE` 16384** (coherent with real
   Intel/Apple/AMD; locally verified). The 8192 I'd flagged was a
   `--headless=new` SwiftShader artifact in the VERIFIER, NOT production. Fixed
   the verifier to run headful-on-Xvfb (same flags as production) so it sees
   the real 16384 and the `[WebGL caps]` check passes. No GPU host needed for
   caps. (The only residual is render-OUTPUT: llvmpipe pixels vs the claimed
   GPU — a deep, rare vector; caps + renderer string are coherent.)
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

**Noise-surface differential audit (spoof-on vs stock, two seeds), 2026-06-05:**
| surface | fires? |
|---|---|
| canvas `toDataURL` | ✅ |
| canvas `getImageData` | ✅ |
| canvas `measureText` | ✅ |
| WebGL `readPixels` | ✅ |
| WebAudio `getChannelData` (AudioBuffer-from-bus) | ✅ |
| `OfflineAudioContext` render | ✅ (after this round's fix) |
| `AnalyserNode.getFloatFrequencyData` | ✅ |
| `clientRect` jitter | ✅ |
| **canvas `toBlob`** | 🔴 **NOT farbled — known gap** |

`canvas.toBlob()` is un-farbled: it `peekPixels(&src_data_)` (the SkImage's own
memory) then `ImageDataBuffer::Create(src_data_)`, bypassing the readPixels
hook `apex-canvas-encode` uses for `toDataURL`. So `toDataURL` and `toBlob` of
the same canvas now DISAGREE (a coherence tell if a detector compares both —
uncommon). LOWER priority than the working surfaces. SAFE FIX (not yet done):
in `canvas_async_blob_creator.cc` after `peekPixels`, perturb a PRIVATE copy of
the pixels (NOT `src_data_` in place — that may mutate a shared `SkImage`),
which needs an owned buffer member on the class.

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
