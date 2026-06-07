# `stealth-browser` + `stealth-chromium` — context for the next Claude session

One-page brief for any future Claude session (including a fresh Claude Cloud
session) picking up this work. Read this FIRST — it captures everything that
doesn't survive a fresh checkout. **Last substantively updated 2026-06-07**
(branch `claude/sleepy-hawking-PUugj`, after the residential-proxy IP layer was
made to actually work end-to-end — see the next section — on top of the
2026-06-06 WebGPU/WebGL work below).

## 🟢 IP / RESIDENTIAL-PROXY LAYER — VERIFIED WORKING (2026-06-07)

**Result (`stealth-proxypanel-20260607-055608`, proxied through Oxylabs
residential, US exit): iphey = `Trustworthy`; browserscan = 85% + Bot Detection
`NoDetection`; creepjs Intl=Worker=lang (locale coherent); 19/19 detectors load,
0 failures; no WebRTC leak of the EC2 IP.** Before this session the proxied
browser was 100% broken (0 connections to the proxy, every target hung/timed
out). The fixes, in order of discovery:

1. **CDP `Fetch` proxy-auth does NOT work** (it was the prior design). With
   `Fetch.enable(handle_auth_requests=True)` requests stalled at the
   interception layer — **zero** TCP connections ever reached the proxy, every
   navigation hung. Replaced with a **local authenticating forwarder**
   (`stealth_browser/proxy_forwarder.py`, `ProxyForwarder`): Chrome →
   `127.0.0.1:<port>` (no auth) → forwarder injects `Proxy-Authorization` and
   CONNECT-tunnels to the upstream, piping bytes verbatim so Chrome's real
   TLS/JA3 reaches the target untouched (no MITM). Wired in
   `browser.py.__aenter__`: if `proxy.has_auth()`, start the forwarder, point
   Chrome at the local no-auth endpoint, so `goto()._setup_proxy_auth` becomes a
   no-op (NO Fetch interception). One upstream host + sticky session per browser
   → one residential exit IP.
2. **Timezone↔exit-IP coherence.** iphey ("trying to hide your location") +
   browserscan ("IP timezone does not match", −10%) flagged the default
   `America/Los_Angeles` vs the actual exit (the pool rotates country per
   session: Spain/DC/Lithuania seen). `core_nodriver._match_identity_to_proxy`
   now runs **pre-launch**, Python-side (`urllib`) over the **same upstream
   proxy + sticky session** the browser uses (so geo = the exact exit IP), and
   builds the identity from it. Endpoints (curl-proven through the residential
   exit): **ipapi.co + ipwho.is** return a proper IANA timezone and survive the
   exit; **ipinfo.io / browserleaks / ipapi.is reset the TLS**; **get.geojs
   geolocates by ASN owner (wrong)**.
3. **Locale: full per-country, native (DONE via the `apex-languages` binary
   patch).** The hard surface was `navigator.languages` (the JS array): CDP
   `setLocaleOverride` moves Intl only, and `--lang`/`--accept-lang`/the profile
   `intl.accept_languages` pref all left it stuck on `["en-US"]` (a JS shim
   would move it but that's exactly the tampering CreepJS detects). So localizing
   the locale made `Intl(es-ES)` disagree with `navigator.languages(en-US)` — the
   internal inconsistency iphey flagged ("trying to hide your location") on a
   Spain exit. **Fix:** an apex-chromium C++ patch (`apply_edits.py` →
   `apex-languages`) on `NavigatorLanguage::languages()` (the mixin shared by
   window Navigator AND WorkerNavigator → window+worker coherent; `language()`
   returns `languages().front()` so it's covered too) returns
   `ParseAndSanitize(APEX_FP_LANGUAGES)` when set — the same file-local parser
   the stock path uses. `core_nodriver.open()` emits `APEX_FP_LANGUAGES` from the
   matched identity, and `identity_for_ip_geo` matches locale to the exit country
   (`es-ES` on a Spanish IP, `de-DE` on a German IP, via `_COUNTRY_LOCALE`).
   **Verified** (`stealth-langprobe-20260607-174249`, forced es-ES identity):
   `navigator.languages = ["es-ES","es","en"]`, `navigator.language = es-ES`,
   **worker** `["es-ES","es","en"]` — all coherent. Built into
   `stealth-chromium-149langs-20260607-165810` (34/34 self-check). Now Intl,
   navigator.language, navigator.languages, the worker scope, the `LANGUAGE`/
   `LANG` env and the timezone ALL agree with the exit-IP country. (Earlier
   builds without this patch fell back to en-US-everywhere; that fallback is
   still coherent on stock Chrome where the env var is inert.)

**Device profiles: 23 → 334** (`fp_profiles.py`, all verified real combos:
145 NVIDIA, 91 AMD, 47 Intel, 35 Apple, 15 Android, 1 llvmpipe). Built by a
generator from grounded primitives — exact ANGLE renderer strings WITH real PCI
device ids (techpowerup/pci.ids + corpora), Apple Metal strings + real Mac
screens, Android model codes + Adreno/Mali strings + viewport/DPR — expanded
across the real (screen, cores) combos per GPU. Invariants enforced:
deviceMemory is a power of two ≤ 8 (>8 or 6 is a bot tell), cores in the GPU
tier's band, every Windows renderer carries its 0x<PCIID>. Per-session farbling
seed still makes each session's canvas/audio/WebGL HASH unique (~4.3e9/template),
so these are the device *distribution*, not the fingerprint count. Also fixed 3
latent bugs (AMD renderers missing PCI id; RX 6700 label/string mismatch; A54
`deviceMemory=6`, an impossible non-power-of-two).

**Per-account STABLE fingerprints (the antidetect "profile" model).** A real
human's device doesn't change between logins, so each account must look like ONE
fixed machine every session -- distinct + unlinkable from other accounts.
`fp_profiles.persona_fingerprint(persona_dir)` generates the (device profile +
farbling seed) ONCE and persists it in `<persona>/apex-fingerprint.json`, then
reuses it every session. `core_nodriver` calls it (replacing the old random-
per-session profile+seed). Account binding: **`APEX_PERSONA=<account id>`** ->
`PersonaPool.acquire_named()` gives that account a dedicated persistent dir
(cookies/history) next to its saved fingerprint. **Diversity:** per-account
draws from ALL 334 profiles (`pick_profile(any_class=True)`) so accounts are
genuinely different machines (40 accounts -> 40 distinct devices across
nvidia/amd/intel/apple/android; Windows-heavy ~ real market share). Trade-off:
on a host whose GPU != the account's device the WebGL *render* shows the -5%
gap until real-GPU infra (strings/canvas/audio stay coherent + farbled).
`pick_profile()` default (`any_class=False`, host-coherent) stays for callers
that need render-matching; `APEX_PROFILE` still overrides. Ephemeral (pool
exhausted, no `APEX_PERSONA`) -> fresh fingerprint per session (correct for
throwaways). Verified locally (same account = identical profile+seed across
logins; different accounts = distinct; persisted). Python-only, no rebuild.
Set `APEX_PERSONA_DIR=/persistent/volume` in prod so personas survive restarts.

**Proxy is validated independently** (`proxy_curl_test.sh`, curl-only from a
clean-egress EC2 box): TCP `:60000` reachable, CONNECT 200, full TLS to
`ip.oxylabs.io` → residential exit IP. The **local sandbox blocks egress on
:60000**, so all proxy testing must run on EC2.

**Secret/cred handling for the panel** (owner-approved plaintext on the private
ephemeral builder box): the box CANNOT resolve SST secrets itself (the minimal
instance role has no provider tokens + no state-bucket access; secrets live
encrypted in the SST state bucket, not as plain SSM params). So creds are
resolved LOCALLY via `sst shell` (dummy provider tokens: `CLOUDFLARE_API_TOKEN`
etc. = `dummy`, since `shell` only reads state, never calls the providers) and
injected as plaintext env in the SFN command. `run-panel-proxied.sh` is a thin
env shim → `run-panel.sh`. NOTE: `sst.config.ts` picks profile `Personal` unless
`AWS_ACCESS_KEY_ID` is set, and the SSO *token* refresh fails even when role
creds are cached → run `eval "$(aws configure export-credentials --profile
Personal --format env)"` first so sst uses the env-cred path.

**Remaining (NOT IP-layer):** browserscan's other −5%s are **WebGL exception**
(GPU-less SwiftShader) + **Canvas Tampering** (intentional farbling tradeoff);
creepjs `likeHeadless=38` is the GPU-less box (WebGL doesn't match the RTX
persona). All GPU-dependent → clear with a real-GPU instance (the parallel
track), not the IP layer.

New files this session: `stealth_browser/proxy_forwarder.py`,
`scripts/proxy_curl_test.sh` (diagnostic). Removed: `scripts/proxy_cred_check.sh`.

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
adds **WebGPU vendor coherence per family** — all report
`adapter.info.vendor == gpu_class` (apple/nvidia/intel/amd) with
`isFallbackAdapter=false`, i.e. the WebGL↔WebGPU GPU cross-check agrees on
every persona, not just Apple/Intel.

**16th persona — Linux/Mesa-llvmpipe (`stealth-fulltest-20260606-195629`,
16/16 coherent).** The ONLY persona with a 100%-MEASURED GPU stack
(`scripts/stock_params.sh` on our own host, zero speculation): a GPU-less
Linux/VM. platform `Linux x86_64` + UA-CH `Linux` are GENUINE (host is Linux,
no OS spoofing); WebGL = Mesa llvmpipe (OpenGL, line-width `[1,255]`, point
`[1,256]`, maxTex 16384 — all measured); WebGPU left NATIVE (Chrome's bundled
SwiftShader, vendor `google`, fallback) — the honest pairing a real GPU-less
Linux Chrome reports. `fp_env` now sets per-`gpu_class` WebGL ranges +
WebGPU vendor; `profile_probe` is Linux/llvmpipe-aware. **Real-GPU-Linux +
mobile personas NOT added** — their per-device OpenGL float-ranges / mobile
GPU+touch+DPR data aren't publicly groundable, and shipping guessed values
is a tell; they need real-device dumps (and mobile needs a touch/DPR/UA-CH
emulation subsystem).

**Android MOBILE personas (17th/18th) — solved via CDP, NO rebuild
(`stealth-mobileprod-20260606-222356`).** Mobile is pure runtime CDP device
emulation (the DevTools/Puppeteer mechanism), wired into the launcher exactly
like timezone/locale -- no C++ patch. `StealthBrowser._apply_mobile`:
`setDeviceMetricsOverride(mobile=True)` (DPR + viewport + pointer:coarse/
hover:none) + `setTouchEmulationEnabled` (maxTouchPoints) + `setUserAgentOverride`
(reduced UA "Android 10; K" + navigator.platform + UA-CH metadata
mobile/platform/model, REUSING our real Chrome-149 brands -- never fabricated;
falls back to the measured `_CHROME_BRANDS` const since about:blank exposes
empty brands). `fp_env` emits only the GPU/cores/mem subset for mobile (CDP
owns the rest); `mobile_emulation_spec()` carries the CDP params.
Personas: **Samsung Galaxy S23** (Adreno 740, 360x780@3) + **Google Pixel 7**
(Mali-G710, 412x915@2.625). Production-path verified fully coherent: mobile=true,
UA-CH Android/model, maxTouchPoints 5, ontouchstart, DPR, pointer:coarse,
brands populated, mobile GPU. To pin one: `APEX_PROFILE='Galaxy S23'`. Scales
to any Android model by adding a row + its screen/DPR/GPU (all mineable).
`profile_probe` SKIPs mobile (it's raw-nodriver, no CDP path);
`mobile_prod_probe.py` validates the production path.
CreepJS-validated (`stealth-panel-mobile-20260606-223342`, pinned via
`run-panel-mobile.sh`): **0% headless / 0% stealth** with all mobile signals
coherent (touch:5, Android 14/SM-S911B, mobile, Adreno window+worker).
**Caveat — mobile needs a mobile/residential IP MORE than desktop:** on the
datacenter EC2 IP, `deviceinfo` flagged "you are a bot" and browserscan
dropped to 80% because a phone on an AWS IP is structurally impossible (phones
are on cellular/residential). The FINGERPRINT is coherent (CreepJS is
IP-independent); the flag is the IP layer (deferred). Pair mobile personas
with a mobile/residential proxy.

**iOS personas — deliberately NOT attempted (un-spoofable from Blink).** Every
iOS browser is forced onto Apple's WebKit/JavaScriptCore engine; apex-chromium
is Blink/V8. The engine fingerprint (JS quirks, WebGL/WebGPU impl, CSS support,
error-stack format) betrays a fake iPhone regardless of how perfectly UA/screen/
touch are set -- and engine-level checks are exactly what CreepJS/DataDome run.
A UA-only iOS persona would fool only weak checks and give false confidence, so
it's intentionally omitted. (EU DMA allows alt-engine iOS browsers since 17.4
but adoption is ~zero, so "iOS == WebKit" holds for fingerprinting.)

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

**Persona roster: 23** (8 Apple, 7 Windows, 3 Linux [llvmpipe + Intel-Mesa +
AMD-Mesa], 5 Android [S23/Pixel7/Pixel8/OnePlus11/A54]). Desktop+Linux all PASS
`full_test` (`stealth-fulltest-20260607-001708`, 18/18 + 5 mobile validated via
`mobile_prod_probe`); Linux real-GPU personas use the MEASURED Mesa ranges
(line 255/point 256 -- Intel iris + AMD radeonsi share Mesa with llvmpipe).
NVIDIA-Linux intentionally absent (proprietary-driver float-ranges unmeasured;
GPU quota=0).

**Residential proxy — recipe VERIFIED + wired (`proxy.py:_oxylabs_from_env`).**
The Oxylabs `hbproxy.net` residential SKU (user-confirmed working): **port
60000** (only open port), username MUST carry a **`-session-<id>` suffix**
(bare = 407; suffix = sticky exit IP), **http scheme, HTTPS targets only**.
Reads `OXYLABS_USERNAME / OXYLABS_PASSWORD / OXYLABS_PROXIES` (comma-sep hosts).
Residential IPs make BOTH desktop AND mobile personas IP-coherent (a phone on
home WiFi is normal). **Still TODO:** exercise it on our infra (creds can't go
in the SFN command -- it's logged) + run LIVE commercial anti-bot tests
(DataDome/Cloudflare) through it -- the real bar, only ever tested on open
fingerprint panels so far.

**Render-OUTPUT pixel coherence — INVESTIGATED (`stealth-rendersw-20260606-090309`,
`scripts/render_gpu.sh` + `render_probe.py`).** Same deterministic canvas2d +
WebGL scene rendered many ways on one box: raw llvmpipe and raw SwiftShader
produce DIFFERENT pixel hashes (render output is renderer-specific, so a real
GPU would differ too), but per-persona FARBLING makes each seed's hash unique
AND moved off the raw llvmpipe baseline (seeds 1001/2002/3003 all distinct
from each other and from raw), while `canvasStable=true` keeps it stable
WITHIN a session. Net: there is no FIXED software-renderer hash to blacklist —
each persona is a unique, real-looking, in-session-stable device, which is the
correct anti-bot behavior (NOT per-read randomization, which is itself a
Tor/Brave tell). Residual (untested): a detector that STRUCTURALLY infers
"software-rendered" from pixel characteristics despite the noise — exotic, and
CreepJS (hash + lie analysis) does not flag us. A true hardware-vs-software
delta is UNMEASURABLE on this account: the SFN whitelists instance types (IaC)
and the EC2 **G/VT GPU quota is 0** (on-demand AND spot) — a quota-increase
request is the only path, deliberately not initiated. The residential-proxy IP
test is the other remaining gap (deferred by the user).

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
