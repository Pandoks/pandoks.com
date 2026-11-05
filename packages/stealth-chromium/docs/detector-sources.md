# Detector-source catalog — every external signal a detector can read from this browser

Audience: the stealth-chromium / stealth-browser maintainer. Scope: passive and
semi-passive signals a sophisticated detector (Fingerprint, Castle, Cloudflare,
DataDome, Akamai, CreepJS-class auditors) can observe about a session of this
stack. For each source: what leaks, whether the current patch set covers it
(checked against the live code, not the README), and the primary writeup.
No fixes are proposed; the gap ranking is the deliverable.

Code audited (worktree `/var/tmp/stealth-work`, branch `browser-iterations`,
HEAD `ea148bf7`, Chromium pin `157.0.8103.27`):
`packages/stealth-chromium/scripts/apply_edits.py` (26 `EDITS` entries, marker
names used as the checklist), `scripts/apply.sh` (2 full-file overlays),
`chromium_src/**` (overlay sources and helper headers), `build/args.gn`,
`Dockerfile`, `entrypoint.sh`, and `packages/stealth-browser/stealth_browser/
{fp_profiles,profile,browser,core_nodriver,core_patchright,human,
human_patchright,proxy,checks}.py`. Driver versions inspected: nodriver
0.50.99, patchright 1.64.3 (the venv at `/var/tmp/stealth-img/venv`).

"Verified" below means read in the code or fetched from the cited source
during this audit; "inferred" is marked as such.

---

## 1. Conclusion — what is uncovered, ranked by risk

The patch set is strong exactly where it was designed to be: the JS-visible
identity surface (UA, UA-CH headers and `userAgentData`, platform, cores,
memory, battery, voices, devices, WebGL strings, WebGPU vendor/arch) is set
natively from one persona record, and the TLS/HTTP-2 layer is untouched real
Chromium. The uncovered mass is in three places: signals that bypass the
proxy, signals that reveal the *real* OS/GPU underneath a cross-OS persona,
and fleet-level population signals. Ranked:

| Rank | Gap | Why it is the top risk | Rows |
|---|---|---|---|
| 1 | **WebRTC STUN reflexive candidate reveals the host's real egress IP past the proxy** | Chrome's default IP-handling policy gathers srflx candidates over UDP; SOCKS5/HTTP proxies in Chrome carry TCP only, so STUN goes direct and the page sees an IP that disagrees with every HTTP request. The forced-policy edit was removed and no `--force-webrtc-ip-handling-policy` flag is passed (both verified). For proxied mass scraping this is a one-probe unmask. | A8 |
| 2 | **Cross-OS persona on a Linux render stack** | In the container every session is a *Windows* persona (host GPU class falls back to `intel` because `lspci` is absent — verified) running on Linux/Xvfb. Fonts (only Liberation + Noto Color Emoji resolve; Segoe UI/Helvetica absent), emoji glyphs, CSS system colours (`ActiveText` = `rgb(255,0,0)` on Linux), `navigator.share` absent (Windows/ChromeOS/macOS only), BarcodeDetector absent for Mac personas, HEVC codec support, and `prefers-color-scheme` all say Linux. The font-policy header itself documents this residual. | B6, B9, C15, C17, B1 |
| 3 | **GPU truth behind the spoofed strings** | `UNMASKED_RENDERER` says "Intel Iris Xe D3D11" while `MAX_TEXTURE_SIZE`, extension list, shader precision, and rendered-pixel hashes are llvmpipe-via-ANGLE (Mesa is pulled in by `xvfb → libgl1 → libglx0 → libglx-mesa0 → libgl1-mesa-dri`, verified in Debian deps and in the local image). WebGPU on Linux shipped in Chrome 144, so on 157 the adapter exists and `isFallbackAdapter` is real (true on a CPU adapter) next to a spoofed `vendor: intel`. | B3, B2, B4 |
| 4 | **Fleet population signals** | (a) One persona tuple for all container sessions (rank 2 cause). (b) `fullVersionList`/`uaFullVersion` report `157.0.8103.27`, which was never a Linux Stable release — Stable went `156.0.8078.79 → 157.0.8103.38` (verified via chromiumdash). (c) The Chromium build applies `fieldtrial_testing_config.json` by default (Chromium builds do; branded Chrome does not) and `args.gn` does not set `disable_fieldtrial_testing_config`, so feature state differs from the stable population. Fingerprint already labels unbranded Chromium "Chromium-Based Browser". | C20, C21, A6 |
| 5 | **Input-stream structure and user-activation flips** | All input is CDP `Input.dispatch*` (nodriver `human.py`, patchright `page.mouse`): `isTrusted` is true but coalesced-event count, `pressure`, wheel-notch and hold-time structure are machine-shaped (the project measured this). Both cores send `userGesture: true` on every `Runtime.evaluate` (nodriver `tab.py`, `core_patchright.py:272`), flipping `navigator.userActivation` without any pointer/key event. | C14, D2 |
| 6 | **Noise surfaces silently dropped** | `apex-audio-noise` and `apex-measuretext-farbling` were removed from `EDITS` (comment block at the end of the list) but the README still lists WebAudio and `measureText` as patched, and `apply.sh` still copies the orphaned headers. AudioContext and TextMetrics hashes are therefore stock. | B5, B8 |
| 7 | nodriver core still uses `Emulation.setTimezoneOverride` / `setLocaleOverride` (patchright core uses `TZ`/`LANG`), Fetch-domain interception when proxy auth is on, `--disable-features` last-wins assumption unverified | D6, D4, D7 |
| 8 | Storage quota from a small container disk, timing/Wasm fingerprints, Local Font Access | C11, B11, C19 |

Everything else is either covered by a verified edit or covered by
construction (real, unpatched Chromium behaviour that already matches Chrome).

---

## 2. Status table — every source

Status: **COVERED** (edit verified and sufficient), **BY-CONSTRUCTION**
(nothing patched and the real value is the right one), **PARTIAL** (covered
on some paths / with a residual), **UNCOVERED**.

| ID | Source | What leaks | Status | Where (code) | Top writeup |
|---|---|---|---|---|---|
| A1 | TCP/IP SYN (p0f, JA4T) | Real OS of the stack that opens the TCP connection (TTL, window, option order) | PARTIAL | none; proxy decides (`proxy.py`) | p0f README §5 `sig = ver:ittl:olen:mss:wsize,scale:olayout:quirks:pclass`; `us_vs_os` reason code [S1]; JA4T [S2] |
| A2 | TLS ClientHello (JA3/JA4) | Browser + version + build via cipher/extension/ALPS/ECH/PQ set | BY-CONSTRUCTION | BoringSSL untouched; `args.gn` is release/official | JA4 spec [S2]; Cloudflare JA4 Signals [S3] |
| A3 | HTTP/2 SETTINGS / WINDOW_UPDATE / priority / pseudo-header order | Client implementation | BY-CONSTRUCTION | untouched net stack | Akamai "Passive Fingerprinting of HTTP/2 Clients" (Black Hat EU 2017) [S4] |
| A4 | QUIC / HTTP-3 | Same as A2/A3 for h3; `h2h3_ratio` | BY-CONSTRUCTION | behind a proxy Chrome never uses QUIC (TCP-only proxies) | JA4 `q` prefix [S2]; Cloudflare `h2h3_ratio_1h` [S3] |
| A5 | HTTP header set/order, `Accept-Language` ↔ `navigator.languages` | Locale coherence; header-order mismatch is a Cloudflare detection-ID example | PARTIAL | `--lang` (profile.py); patchright core adds `extra_http_headers` via CDP (`core_patchright.py:202`) | Cloudflare detection IDs [S5] |
| A6 | UA string + `Sec-CH-UA-*` + `userAgentData` (page/iframe/worker) | OS, arch, bitness, version, brands | COVERED, residual UNCOVERED (version currency) | `apex-ua-brand`, `apex-ua-latent-ua-string`, `apex-ua-latent-ch-low/high`, `apex-uadata-platform`, `apex-platform` | UA-CH spec [S6]; `user_agent_utils.cc` [S7]; chromiumdash releases [S8] |
| A7 | IP geo / ASN ↔ timezone ↔ locale | `timezone_mismatch`, `os_mismatch` | PARTIAL | `_match_identity_to_proxy` (core_nodriver), `identity_env` (core_patchright) | Fingerprint Smart Signals: VPN detection [S9] |
| A8 | WebRTC ICE candidates (host mDNS, srflx public IP) | Real egress IP that bypasses the proxy; LAN topology if mDNS off | **UNCOVERED** | no edit (removed, see apply_edits.py comment), no policy flag (profile.py comment) | Blink `webrtc_ip_handling_policy.h` [S10]; RFC 8828 §5.2 [S11]; Chromium `net/docs/proxy.md` [S12] |
| A9 | DNS resolution path | Resolver IP / leak when the client resolves | BY-CONSTRUCTION | Chrome resolves proxy-side for HTTP and SOCKS5 | `net/docs/proxy.md` [S12] |
| B1 | Canvas 2D hash (`getImageData`, `toDataURL`/`toBlob`/`convertToBlob`) | GPU/driver/font rasterizer; OS via emoji glyphs and AA | PARTIAL | `apex-canvas-getimagedata`, `apex-canvas-encode` (+ `_RGBA_NOISE_LOOP` skips) | Mowery & Shacham 2012 [S13]; Castle canvas-noise detection [S14]; fingerprintjs `canvas.ts` emoji [S15] |
| B2 | WebGL render hash (`readPixels`) | Real GPU/backend | PARTIAL | `apex-webgl-readpixels` | Cao, Li, Wijmans NDSS 2017 [S16] |
| B3 | WebGL numeric params / extensions / precision vs UNMASKED strings | Real GPU class | **UNCOVERED** | strings only: `apex-webgl-vendor`, `apex-webgl-renderer` | CreepJS `hasBadWebGL` and GPU-params checks [S17]; Castle Hidemium [S18] |
| B4 | WebGPU `GPUAdapterInfo` | vendor/architecture spoofed; `isFallbackAdapter`, `limits`, `features` real | PARTIAL | `apex-webgpu-identity` | `gpu_adapter.cc` [S19]; WebGPU on Linux in Chrome 144 [S20] |
| B5 | AudioContext / OfflineAudioContext hash | DSP/compiler/arch class | **UNCOVERED** (edit removed) | `apex_audio_noise.h` orphaned; "removed edits" note | Cao et al. [S16]; (Englehardt & Narayanan 2016 first measured audio FP) |
| B6 | Font enumeration by width/glyph fallback | Installed font set → OS | **UNCOVERED** | `apex_font_policy.h` header documents the residual | Fifield & Egelman 2015 [S21] |
| B7 | `document.fonts.check()` / `@font-face local()` | Font presence by direct query | PARTIAL | `apex-font-allow` → `FontCache::IsPlatformFamilyMatchAvailable` (call site verified in `font_face_set.cc`) [S22] | Fifield & Egelman [S21] |
| B8 | `measureText` / `TextMetrics` farbling | Font metrics hash | **UNCOVERED** (edit removed) | `apex_text_metrics_noise.h` orphaned | Fifield & Egelman [S21] |
| B9 | CSS system colours, `system-ui`, `prefers-color-scheme`, font smoothing | OS (`ActiveText` red on Linux), headless-like light scheme | **UNCOVERED** | none | CreepJS `hasKnownBgColor`, `prefersLightColor` [S17] |
| B10 | `screen.*`, `devicePixelRatio`, taskbar gap | Headless/VM (`screen == avail`), persona–display mismatch | PARTIAL | screen edits exist but `fp_env` deliberately never sets them; Xvfb `1920x1080x24` | CreepJS `noTaskbar`, `hasVvpScreenRes` [S17] |
| B11 | Timing (perf.now clamp, Wasm call-boundary ratios, GPU timing) | Engine/hardware regardless of strings | **UNCOVERED** (inherent) | none | Guri & Fibert, arXiv 2506.00719 [S23] |
| C1 | `navigator.platform`, `userAgent`, `userAgentData` | OS | COVERED | see A6 | UA-CH spec [S6] |
| C2 | `navigator.hardwareConcurrency` (page/iframe/worker/SW) | CPU count | COVERED | overlay `navigator_concurrent_hardware.cc` + `apex-hw-concurrency-coherent` | rebrowser `workerConsistency` [S24] |
| C3 | `navigator.deviceMemory` | RAM bucket | COVERED | overlay `navigator_device_memory.cc` (snaps to 0.25–8) | Fingerprint "Device Rarity" [S9] |
| C4 | Battery Status API | Laptop/desktop, level | COVERED | `apex-battery-*` (4 edits) | Olejnik et al. 2015 [S25] |
| C5 | Window geometry (`outer*` ≥ `inner*`) | Emulated viewport | BY-CONSTRUCTION | `no_viewport`, `--window-size` to Xvfb size | rebrowser `viewport` [S24] |
| C6 | `mediaDevices.enumerateDevices()` | Headless/VM (empty list) | COVERED (shape inferred) | `apex-devices` (empty id/label/groupId per kind) | BotD / CreepJS headless checks [S17] |
| C7 | `speechSynthesis.getVoices()` | OS; headless (0 voices) | COVERED | `apex-voices` + `apex_voices.h` | CreepJS headless [S17] |
| C8 | Permissions API ↔ `Notification.permission` | Headless (`denied`/`prompt` mismatch) | BY-CONSTRUCTION | no pre-grants (browser.py, core_patchright.py comments) | CreepJS `hasPermissionsBug` [S17] (origin: Vastel 2018 [S26]) |
| C9 | `navigator.plugins` / `mimeTypes` / `pdfViewerEnabled` | Headless | BY-CONSTRUCTION (inferred: `pdf_enable` default) | checks.py row 6 | CreepJS `noPlugins`, `pdfIsDisabled` [S17] |
| C10 | Storage partitioning / cookie semantics | Launch-flag tampering | BY-CONSTRUCTION | profile.py keeps `ThirdPartyStoragePartitioning` on | rebrowser `storagePartitioning` [S24] |
| C11 | `navigator.storage.estimate()` quota | Disk size (60% of disk) → VM/container | **UNCOVERED** | none | web.dev storage quota [S27] |
| C12 | WebAssembly feature set / API quirks | Engine version | BY-CONSTRUCTION (same V8 as Chrome 157) | — | wasm-feature-detect [S28]; arXiv 2506.00719 [S23] |
| C13 | Network Information API (`rtt`, `downlink`, `effectiveType`) | Network class; BotD collects `rtt` | BY-CONSTRUCTION (verified equal to real Chrome 156 on the Mac host, HANDOFF round 4) | — | WICG netinfo privacy section [S29]; BotD `rtt` source [S30] |
| C14 | Keyboard/pointer events: `isTrusted`, coalesced events, `pressure`, wheel notches, hold times | Synthetic input stream | PARTIAL | `human.py` (CDP `Input.dispatch*`), `human_patchright.py` (`page.mouse`) | project `input-stream-realism.md` (measured); CL 6917162 [S31] |
| C15 | MediaCapabilities / `isTypeSupported` (HEVC, platform codecs) | OS + hardware decoder | **UNCOVERED** | `proprietary_codecs=true` only | MDN video codecs: Chrome HEVC per-OS [S32]; W3C Media Capabilities §Privacy [S33] |
| C16 | OS-gated API presence (`navigator.share/canShare`, `BarcodeDetector`, `ContactsManager`, `downlinkMax`) | Real OS | **UNCOVERED** | none | Chrome 89 Web Share desktop (ChromeOS + Windows) [S34]; Shape Detection (macOS, ChromeOS, Android) [S35]; CreepJS `noWebShare` [S17] |
| C17 | Intl / timezone / locale | Coherence with IP | PARTIAL | A7 | Fingerprint `timezone_mismatch` [S9] |
| C18 | Local Font Access (`queryLocalFonts`) | Full font list (permission-gated) | UNCOVERED, low | README claims it; no edit targets `modules/font_access` (apply.sh only copies a header there) | — |
| C19 | `chrome.*` object shape, `chrome.runtime` | Headless/Chromium | BY-CONSTRUCTION (verified vs real Chrome 156, HANDOFF round 4) | `apex-chrome-app-gone` removed on evidence | CreepJS `hasBadChromeRuntime` [S17] |
| C20 | Chrome-vs-Chromium build residue (brands, Widevine, field trials, version) | Unbranded build | PARTIAL / **UNCOVERED** (field trials, version) | `apex-ua-brand`; `enable_widevine=true`; no `disable_fieldtrial_testing_config` | Fingerprint Sep-2026 roundup [S36]; `testing/variations/README.md` [S37]; chromiumdash [S8] |
| C21 | Population rarity / velocity (persona tuple frequency, IPs per visitor) | Fleet-level evidence | **UNCOVERED** | `PROFILES` has 7 rows; container always picks the Intel row (`detect_host_gpu_class`) | Fingerprint Device Rarity, Velocity, Browser Tampering `anomaly_score` [S9] |
| C22 | Profile state (cookies, history, `exit_type`) | Fresh-profile bot tell | PARTIAL | `personas.py` pool (nodriver); `persistent` optional (patchright) | — |
| D1 | `Runtime.enable` console/error serialization | CDP attached | COVERED | V8 getter guard (May 2025, in 157) + `apex-cdp-nopreview`; nodriver never sends `Runtime.enable` (verified grep) | Castle "classic CDP signal stopped working" [S38]; rebrowser `runtimeEnableLeak` [S24] |
| D2 | `userGesture:true` on `Runtime.evaluate` → `navigator.userActivation` flips | CDP evaluate | **UNCOVERED** | nodriver `tab.evaluate` (`user_gesture=True`), `core_patchright._eval_js_cdp` (`"userGesture": True`) | project `patchright-driver-analysis.md` row 3 |
| D3 | `sourceURL` stamps / wrapper frames in `Error.stack` | Driver | COVERED | raw `Runtime.evaluate`; `checks.py stackClean` | rebrowser `sourceUrlLeak` [S24] |
| D4 | Document re-serving (`Fetch.fulfillRequest`) → `nextHopProtocol === ''` | Driver | BY-AVOIDANCE / PARTIAL | no init scripts; nodriver proxy-auth path enables `Fetch` with `continueRequest` on every request (browser.py 187–194) | rebrowser `documentInterception` [S24] |
| D5 | Binding globals / `__pw*` / `__playwright_mark_target__` events | Driver | PARTIAL | `checks.py pwGlobals`; patchright CustomEvents residual (project driver doc) | rebrowser `cdpBindingGlobals`, `pwInitScripts` [S24] |
| D6 | `Emulation.*` overrides (timezone, locale) | CDP; don't reach workers | PARTIAL | browser.py 227–229 (nodriver core) vs env (patchright core) | rebrowser `workerConsistency` [S24] |
| D7 | Launch-flag side effects | popup blocking, IPC flood, site isolation, field trials | PARTIAL | profile.py; nodriver appends `--disable-features=IsolateOrigins,site-per-process`; last-wins unverified | rebrowser `popupBlocking`, `ipcFloodingProtection` [S24] |
| E1 | Behavioural telemetry (mouse event rate, teleport ratio, dwell) | Agent vs human | PARTIAL | `human.py` Bezier + dwell | project `first-principles-detection-theory.md` (arXiv 2607.26935) |

---

## 3. Per-source detail

### A. Network layer

**A1 — TCP/IP SYN fingerprint (p0f, JA4T).** p0f's signature is
`ver:ittl:olen:mss:wsize,scale:olayout:quirks:pclass`; the option layout
(`olayout`) is hard-coded per kernel and is what separates Linux
(`mss,sok,ts,nop,ws`) from Windows (`mss,nop,ws,nop,nop,sok`). p0f emits
`us_vs_os` when "OS fingerprint doesn't match User-Agent data" [S1]. Fingerprint
exposes the same idea as `os_mismatch` ("the network signature of the request
… does not match the signature of the OS of the client") [S9]. Coverage: no
code touches this. Through an HTTP CONNECT or SOCKS5 proxy the *proxy* opens
the TCP connection, so the target sees the proxy's stack (verified in the
project's own measured `tcp-ip-fingerprinting.md`). Direct connections from
the Linux container with a Windows/macOS persona are a mismatch. Status
PARTIAL: safe only when proxied.

**A2 — TLS ClientHello.** JA4 encodes TLS version, SNI presence, cipher and
extension counts, ALPN, and sorted cipher/extension/sigalg hashes [S2];
Cloudflare scores each JA4 against hourly population ratios over "15 million
unique JA4 fingerprints … per day" [S3]. Coverage: BY-CONSTRUCTION — no edit
touches `//net` or BoringSSL, and `args.gn` is `is_official_build=true`; the
project measured identical JA4 for direct vs passthrough-CONNECT. Residual
(inferred): field-trial testing config (C20) can flip TLS-adjacent features
(ECH, PQ groups), which would move JA4_c away from the stable population.

**A3 — HTTP/2 fingerprint.** Akamai's format is the SETTINGS values, the
WINDOW_UPDATE increment, PRIORITY frames and pseudo-header order [S4]. Chrome
157 (project-measured) is `1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p`.
Coverage: BY-CONSTRUCTION. Only a TLS-terminating proxy replaces it.

**A4 — QUIC.** JA4 prefixes `q` for QUIC [S2]; Cloudflare's `h2h3_ratio_1h`
is "the ratio of HTTP/2 and HTTP/3 requests combined with the total number of
requests for the JA4 fingerprint" [S3]. Coverage: BY-CONSTRUCTION. Behind a
proxy Chrome does not use QUIC ("SOCKSv5 is only used to proxy TCP-based URL
requests. It cannot be used to relay UDP traffic" [S12]); a real proxied user
looks the same.

**A5 — Header set/order and Accept-Language.** Cloudflare's own example of a
detection ID is a client "whose header order differs from the browser it
claims to be" [S5]. Coverage PARTIAL: both cores pass `--lang=<locale>`, which
drives `navigator.languages` and the default Accept-Language. The patchright
core additionally sets `extra_http_headers: {"Accept-Language": idn.accept_language}`
(`core_patchright.py:202`), applied via CDP `Network.setExtraHTTPHeaders`. For
non-US identities the explicit string (`de-DE,de;q=0.9,en;q=0.8`) may not equal
what Chrome would emit for `--lang=de-DE`, and the override path may change
header placement. Not measured here — inferred.

**A6 — UA / UA-CH / userAgentData.** The three `apex-ua-latent-*` edits set
`metadata.platform/platform_version/architecture/bitness/wow64/model` and the
UA OS segment inside `components/embedder_support/user_agent_utils.cc`, which
is the single producer for navigation hints, subresource hints and
`navigator.userAgentData` (edit comment, consistent with the file's role).
`apex-ua-brand` forces the Google Chrome brand: upstream only sets `brand`
under `#if !BUILDFLAG(CHROMIUM_BRANDING)` [S7], so an unbranded build emits a
two-entry list; the edit restores the triple. Linux `platform_version` is
correctly empty — upstream `GetPlatformVersion()` returns `std::string()` for
`IS_LINUX || IS_FUCHSIA` [S7]. Status COVERED.
Residual, UNCOVERED: the high-entropy `fullVersionList` / `uaFullVersion`
carry `157.0.8103.27` (`chrome/VERSION` at the tag [S39]). chromiumdash's
Linux Stable history is `156.0.8078.79 → 157.0.8103.38` (2026-11-02) [S8];
`.27` never shipped as Stable, so any detector that cross-references release
lists sees a version with zero real population.

**A7 — IP geo ↔ timezone ↔ locale.** Fingerprint's `timezone_mismatch` fires
"when the geolocated IP address of the device does not match the
originTimezone from the system settings" [S9]. Coverage PARTIAL: the nodriver
core looks up the exit IP through the proxied browser and rebuilds `Identity`
(`_match_identity_to_proxy`), but applies it with `Emulation.setTimezoneOverride`
/ `setLocaleOverride` (D6). The patchright core sets `TZ`/`LANG`/`LC_ALL` in
the child environment (clean). Country→locale and region→timezone tables are
small (`_COUNTRY_LOCALE` 12 entries, `_REGION_TZ` 10 US states).

**A8 — WebRTC ICE candidates. UNCOVERED, highest risk when proxied.**
Chrome's default policy (`kWebRTCIPHandlingDefault`) "has the right to
enumerate all interfaces and bind them to discover public interfaces"; only
`kWebRTCIPHandlingDisableNonProxiedUdp` restricts WebRTC to "TCP to contact
peers or servers unless the proxy server supports UDP" [S10]. RFC 8828 Mode 4
is the only mode where "WebRTC media traffic MUST also be proxied" [S11]. Chrome
proxies do not carry UDP [S12]. Consequence: a STUN request from a proxied
session leaves the container directly and the `srflx` candidate carries the
container host's public IP, while every HTTP request carries the proxy exit
IP. Code state (verified): the forced-policy edit was removed from `EDITS`
(comment block "WebRTC: default (mDNS-obfuscated) candidate gathering"), and
`profile.py` explicitly passes no `--force-webrtc-ip-handling-policy`. The
comment's premise ("srflx carries the WAN IP -- exactly what a real user behind
a proxy exposes") is true for a user whose WAN *is* the proxy; it is false for
this deployment, where WAN ≠ proxy exit. The mDNS obfuscation of host
candidates does hide LAN IPs; it does not touch srflx. Residual even without a
proxy: a Linux container's network shape (single interface, Docker bridge) is
not what the persona claims — low.

**A9 — DNS.** "When using an HTTP proxy in Chrome, name resolution is always
deferred to the proxy" and "when a proxy's scheme is set to SOCKSv5, name
resolution is always done proxy side" [S12]. BY-CONSTRUCTION for both schemes
`proxy.py` accepts. (SOCKS4 would resolve client-side; not offered.)

### B. Rendering / timing-content layer

**B1 — Canvas 2D hash.** Mowery & Shacham showed the rendered pixels of text
and WebGL scenes identify the GPU/driver/font stack [S13]. Castle's detector
fills `rgba(0,127,255,1)` and checks every pixel is `[0,127,255,255]`, then
checks `toDataURL.toString()` and the cyclic-`setPrototypeOf` trap [S14].
Coverage PARTIAL: `apex-canvas-getimagedata` (RGBA8 only) and
`apex-canvas-encode` (N32 only, the `paint_image.readPixels` branch of
`ImageDataBuffer`) apply the shared `_RGBA_NOISE_LOOP`, which skips alpha==0
pixels and uniform 3×3 neighbourhoods — so Castle's solid-fill probe passes,
and the toString/cyclic checks pass because nothing is patched in JS. Noise is
deterministic per `APEX_FP_SEED` (stable within a session). Residuals: (a) the
encode edit covers one constructor branch; an `ImageDataBuffer` built without
that readback path is not perturbed (inferred from the anchor; not traced
further); (b) the noise does not change *what* was rasterized — fingerprintjs
draws `"Cwm fjordbank gly 😃"` in Times New Roman/Arial precisely because
emoji glyphs and font rasterization differ by OS [S15]; on this stack the
emoji is Noto Color Emoji through FreeType, not Segoe UI Emoji/DirectWrite, so
the OS class is readable through ±1 noise.

**B2 — WebGL render hash.** Cao et al. render GPU-dependent scenes and hash
them to fingerprint across browsers [S16]. Coverage PARTIAL:
`apex-webgl-readpixels` perturbs `GL_RGBA`/`GL_UNSIGNED_BYTE` readbacks with
default pack state; other format/type pairs, PBO readbacks, and canvas
`toDataURL` of a WebGL canvas (goes through B1's encode path) are not all
covered. The rendered content itself is llvmpipe/ANGLE output (B3).

**B3 — WebGL parameters vs strings. UNCOVERED.** Only `UNMASKED_VENDOR` /
`UNMASKED_RENDERER` are overridden (`apex-webgl-vendor/renderer`). CreepJS
compares the main-thread renderer with the worker's (`hasBadWebGL`) — both are
patched, so that passes — but its GPU-parameter-vs-model check and Castle's
Hidemium analysis [S18] compare `MAX_TEXTURE_SIZE`, `MAX_*_UNIFORM_*`,
extension lists, `getShaderPrecisionFormat` and `ALIASED_*_RANGE` against the
claimed model. In the container: `detect_host_gpu_class()` runs `lspci`, which
is not installed (verified in the image: `command -v lspci` → none), the
`FileNotFoundError` is caught and the function returns `"intel"`, so
`pick_profile()` always selects "Windows laptop, Intel Iris Xe". The real
backend is ANGLE-on-GL over Mesa llvmpipe: Mesa's DRI package is a hard
dependency chain of `xvfb` (`xvfb → libgl1`, `libgl1 → libglx0`,
`libglx0 → libglx-mesa0`, `libglx-mesa0 → libgl1-mesa-dri`) [S40], and the
local image lists `libgl1-mesa-dri 25.0.7` installed. So every parameter and
every rendered pixel says llvmpipe while the string says Iris Xe D3D11.

**B4 — WebGPU adapter.** `apex-webgpu-identity` overrides `vendor_` and
`architecture_` after Dawn fills them. Upstream exposes
`is_fallback_adapter = adapter_type_ == wgpu::AdapterType::CPU` to every page,
and hides `device/description/driver` unless developer features are on [S19].
WebGPU on Linux shipped in Chrome 144 [S20], so on 157 `navigator.gpu` is live.
In a GPU-less container the adapter is either null or a CPU (SwiftShader
Vulkan) adapter with `isFallbackAdapter: true`, next to `vendor: "intel"`,
`architecture: "gen-12lp"`; `limits` and `features` are the real adapter's.
Status PARTIAL; container behaviour not run here (the local image predates the
patched binary).

**B5 — AudioContext hash. UNCOVERED.** Audio fingerprinting hashes an
`OfflineAudioContext` render; it varies by DSP implementation and
architecture [S16]. The `apex-audio-noise` edit was removed ("moved the audio
hash into a rare cluster; stock output is already common" — `EDITS` tail
comment). `apex_audio_noise.h` is still copied by `apply.sh` but nothing
includes it. The README's "WebAudio getChannelData" row is stale. Risk is low
*if* Linux x64 Chrome's hash equals Windows x64 Chrome's for the persona's
build (same clang/float path — inferred, not measured).

**B6 — Font set via width measurement. UNCOVERED.** Fifield & Egelman
fingerprint users through glyph bounding boxes across fonts [S21]. The
`apex_font_policy.h` header states the residual plainly: the bundle resolves
only Arial/Times New Roman/Courier New (metric aliases to Liberation), the
Liberation families, Arimo/Tinos/Cousine and Noto Color Emoji; "Segoe UI" on
a Windows persona and "Menlo"/"Helvetica" on a macOS persona are absent, and
"the bundle's Liberation*/Noto Color Emoji families still report present on
Win/Mac personas through the real lookup". A detector measuring 50–100 common
family names gets a Debian-minimal font set under a Windows UA.

**B7 — `document.fonts.check()` / `local()`.** `FontFaceSet::check` skips a
family when `font_selector->IsPlatformFamilyMatchAvailable(...)` is true [S22];
`apex-font-allow` short-circuits that call for the persona allowlist. PARTIAL:
it can only *add* availability for names the bundle already renders, so it
keeps B6 and B7 consistent rather than making either look like Windows.

**B8 — `measureText` farbling. UNCOVERED.** `apex-measuretext-farbling` was
removed because its anchor no longer compiles on main (`EDITS` tail comment).
`apex_text_metrics_noise.h` is orphaned. README row is stale. TextMetrics are
therefore exact Liberation metrics (B6 again).

**B9 — CSS-visible OS state. UNCOVERED.** CreepJS `likeHeadless` includes
`hasKnownBgColor` (ActiveText renders `rgb(255, 0, 0)` — the Linux default)
and `prefersLightColor` [S17]. Nothing in the stack sets `ui::NativeTheme`
colours, `system-ui` resolution, or a dark/light scheme per persona.

**B10 — Screen geometry.** `fp_env()` intentionally never sets
`APEX_FP_SCREEN_*` ("The screen is NOT spoofed"), so `screen.*` is the Xvfb
`1920x1080x24` display. CreepJS flags `noTaskbar`
(`screen.height === screen.availHeight && screen.width === screen.availWidth`)
and `hasVvpScreenRes` [S17]; Xvfb has no taskbar, so both fire. On a Mac host
(nodriver, native) the Apple personas run on the real Retina display and are
coherent. PARTIAL.

**B11 — Timing.** Guri & Fibert distinguish Chromium builds through
"subtle differences in the WebAssembly JavaScript API implementation … even
when identifiers such as the User-Agent are completely spoofed" with <1% FPR
[S23]. Not addressable by string patches; inherent residual. UNCOVERED.

### C. Browser API layer

**C1–C4, C6, C7 — covered identity surfaces.** `navigator.platform`
(`apex-platform`), `userAgentData.platform` (`apex-uadata-platform`),
`hardwareConcurrency` (overlay, clamped 2–64, plus `apex-hw-concurrency-coherent`
so the shared `NavigatorBase` path returns before the per-context DevTools
override — reaches workers), `deviceMemory` (overlay, snapped to
{0.25,…,8}), battery (`charging`, `level` to whole percent, `chargingTime` 0 /
∞, `dischargingTime` minute-rounded), `enumerateDevices` (one entry per kind
with empty `deviceId`/`label`/`groupId` when the real list lacks the kind),
`getVoices()` (OS-specific lists plus the 19 Google network voices, default at
index 0). All verified in `apply_edits.py` / overlays. The `apex-devices`
shape claim ("exactly what unpermissioned real Chrome reports") was not
re-verified against a stock binary in this audit.

**C5 — Window geometry.** `no_viewport: True` (patchright) and
`--window-size=<Xvfb size>` keep `outer ≥ inner == screen` coherent; no
`Emulation.setDeviceMetricsOverride`. BY-CONSTRUCTION.

**C8 — Permissions vs Notification.** `hasPermissionsBug` = notifications
`prompt` while `Notification.permission` is `denied` [S17]. Headful Xvfb Chrome
reports `default`/`prompt` consistently; no grants are pushed
(`browser.py` comment, `core_patchright.py` comment). BY-CONSTRUCTION.

**C9 — Plugins / PDF viewer.** Chromium builds ship the PDF viewer, so
`navigator.plugins.length > 0` and `pdfViewerEnabled === true`; `checks.py`
asserts the former. Inferred from the default `pdf_enable`; not read from the
build output.

**C10 — Storage partitioning.** `profile.py` keeps
`ThirdPartyStoragePartitioning` enabled and passes only `--disable-features=Translate`;
rebrowser's `storagePartitioning` test (A-B-A iframe) is the detector [S24].
BY-CONSTRUCTION, subject to the last-`--disable-features`-wins assumption (D7).

**C11 — Storage quota. UNCOVERED.** "An origin can use up to 60% of the total
disk space … Chrome … will always report 60% of the actual disk size" [S27]. A
small container volume therefore reports a quota no consumer laptop would.

**C12 — WebAssembly features.** Same V8 as Chrome 157, so the
wasm-feature-detect matrix [S28] matches; only timing (B11) leaks.

**C13 — Network Information.** `rtt`/`downlink`/`effectiveType` are collected
by BotD (`rtt` source) [S30]; the spec itself lists them as fingerprinting
vectors [S29]. HANDOFF round-4 verified the stack's values equal real Chrome
156 on the Mac host. BY-CONSTRUCTION (container values not measured).

**C14 — Input events.** `isTrusted` is true because the events enter through
`Input.dispatchMouseEvent`/`dispatchKeyEvent` (nodriver `human.py`) or
Playwright's mouse/keyboard (also CDP Input). The `screenX == clientX` leak is
fixed upstream in Chromium 142 (CL 6917162) [S31] and 157 includes it. The
project's own measurement (`input-stream-realism.md`): `getCoalescedEvents()`
length 1, `pointerdown.pressure` 0, `wheelDeltaY` always ±120, 1.2 ms click
holds. The Bezier/dwell model in `human.py` fixes trajectory shape, not stream
structure. PARTIAL.

**C15 — Codecs / MediaCapabilities. UNCOVERED.** "Chrome support HEVC for
devices with hardware support on Windows 8+, Linux and ChromeOS, for all
devices on macOS Big Sur 11+ and Android 5.0+" (Chrome 107+) [S32]. A macOS
persona on llvmpipe therefore answers `false` to an `hvc1` query where every
real Mac answers `true`; `decodingInfo().powerEfficient` likewise reflects the
real host. The spec's privacy section expects capability to correlate with
device class [S33] — which is exactly the cross-check a detector runs.
`proprietary_codecs=true` / `ffmpeg_branding="Chrome"` cover H.264/AAC only.

**C16 — OS-gated API presence. UNCOVERED.** Web Share on desktop arrived in
Chrome 89 for "ChromeOS and Windows" [S34] (macOS later; Linux never); CreepJS
`noWebShare` fires when `CSS.supports('accent-color: initial')` is true but
`navigator.share`/`canShare` are missing [S17] — i.e. on this Linux build under
a Windows UA. "Barcode detection is available on macOS, ChromeOS, and Android"
[S35], so a macOS persona must expose `BarcodeDetector` and this build does
not. `ContactsManager` and `connection.downlinkMax` are the other CreepJS
siblings.

**C17 — Intl / timezone.** See A7/D6.

**C18 — Local Font Access.** README lists `queryLocalFonts` as patched; no
`EDITS` entry targets `modules/font_access` and `apply.sh` only drops
`apex_fingerprint.h` into that directory. Permission-gated, so low.

**C19 — `chrome.*` shape.** `apex-chrome-app-gone` was removed after probing
real Chrome 156 ("stock Chrome 157 still exposes chrome.app on web pages");
`csi`/`loadTimes` shape verified equal in HANDOFF round 4. BY-CONSTRUCTION.

**C20 — Chrome-vs-Chromium residue.** Fingerprint (2026-09-03): "requests from
Chromium-based browsers … return `browserName: "Chromium-Based Browser"`"
while "Genuine Chrome still returns `Chrome` and its real version"; the method
is not disclosed [S36]. Covered: brand triple (A6), proprietary codecs,
`enable_widevine=true` (the CDM itself arrives via the component updater at
runtime — presence in a fresh container profile not verified). Uncovered:
(a) `fieldtrial_testing_config.json` "applies specifically to Chromium
developer and Chrome for Testing branded builds. Chrome branded builds do not
use these definitions by default"; non-developer Chromium builds "should
disable the testing config by … `disable_fieldtrial_testing_config=true`" or
`--disable-field-trial-config` [S37]. `args.gn` sets neither and the patchright
core removes `--disable-field-trial-config` from Playwright's defaults
(`_PLAYWRIGHT_NONSTOCK_SWITCHES`), so the binary runs with the testing config's
experiment arms — feature state that stable Chrome's population mostly lacks.
(b) version currency (A6 residual).

**C21 — Population. UNCOVERED.** Fingerprint's Browser Tampering uses
"statistical anomaly detection, which identifies browser signatures that are
unusually rare compared to the overall population" plus Device Rarity and
Velocity signals [S9]. The pool is 7 personas; in the container it collapses
to one (B3). Every container session therefore shares cores=8, memory=8,
Iris Xe, Win32, 1920×1080@1, Liberation fonts, `157.0.8103.27` — a tuple with
no real-world mass, repeated across every exit IP.

**C22 — Profile state.** nodriver sessions draw from a 4-dir persistent
persona pool (`personas.py`); patchright sessions are ephemeral unless
`persistent` is requested. PARTIAL.

### D. CDP / DevTools residue

**D1 — `Runtime.enable` serialization.** The classic `Error.stack` getter trap
died with V8's May 2025 commits ("V8 no longer triggers side effects when
inspecting error objects or custom getters") [S38]; Chromium 157 includes
them. `apex-cdp-nopreview` additionally forces `generatePreview = false` in
`V8ConsoleMessage::wrapArguments`. nodriver 0.50.99 never sends
`Runtime.enable` (grep of `nodriver/core/*.py`: only `page.enable` and
`target.set_auto_attach`); patchright removed it (project driver analysis).
COVERED. Castle's post says detectors moved to other CDP leaks plus
"client-side behavior, red pills, proxy/network detection" — i.e. rows A8,
B9, C14.

**D2 — `userGesture` on evaluate. UNCOVERED.** nodriver's `Tab.evaluate` passes
`user_gesture=True` on every `Runtime.evaluate` (verified in `tab.py`), and
`core_patchright._eval_js_cdp` passes `"userGesture": True` (line 272). Each
evaluation grants user activation, so `navigator.userActivation.isActive /
hasBeenActive` flip without any trusted pointer or key event — the probe the
project's own driver analysis lists (row 3). Affects every `/eval` and the
MCP tooling path.

**D3 — Stack residue.** Raw `Runtime.evaluate` (not `callFunctionOn`) keeps
`at <anonymous>:1:1`; `checks.py stackClean` asserts no `pptr:` / `eval at`
frames. COVERED.

**D4 — Document interception.** No init scripts are used, so patchright's
inject route is not installed; `checks.py nextHopOk` asserts
`nextHopProtocol !== ''` [S24]. Residual: with proxy auth the nodriver core
enables `Fetch` with `handle_auth_requests=True` and no patterns, so every
request pauses and is `continueRequest`-ed (`browser.py:187–194`) — no
re-serving, but added latency on every resource and a Fetch domain that is
on. Low.

**D5 — Globals and bindings.** `checks.py pwGlobals` asserts no `__pw*`.
patchright's `__playwright_mark_target__` CustomEvents remain per the project
driver analysis (not re-verified here). PARTIAL.

**D6 — Emulation overrides.** The nodriver core applies
`Emulation.setTimezoneOverride` and `setLocaleOverride` per tab
(`browser.py:227–229`). rebrowser's `workerConsistency` test exists because
"some CDP overrides (e.g. Playwright `locale`) don't reach Web Workers" [S24];
`Intl.DateTimeFormat().resolvedOptions().timeZone` in a dedicated worker vs
the page is the probe. The patchright core avoids this with `TZ`/`LANG` env.
PARTIAL (core-dependent).

**D7 — Launch flags.** Passed: `--disable-blink-features=AutomationControlled`
(needed; not page-visible beyond `webdriver=false`), `--no-first-run`,
`--no-default-browser-check`, `--password-store=basic`, `--use-mock-keychain`,
`--disable-features=Translate`, `--lang`, container: `--no-sandbox`,
`--disable-dev-shm-usage`, `--window-size`, `--use-gl=angle`, `--use-angle=gl`,
`--ignore-gpu-blocklist`, `--enable-webgl`, `--enable-unsafe-swiftshader`;
patchright core: `--remote-debugging-port=<random>`. Not passed:
`--disable-popup-blocking`, `--disable-ipc-flooding-protection`, `--headless`
(good — rebrowser `popupBlocking`, `ipcFloodingProtection`, `headless` [S24]).
Residual: nodriver appends `--disable-features=IsolateOrigins,site-per-process`
before ours (`nodriver/core/config.py:182–185`); `profile.py` relies on Chrome
keeping the last `--disable-features` — plausible, not verified by reading
`chrome://version` on a launched instance. PARTIAL.

### E. Behavioural

**E1 — Interaction telemetry.** Out of the passive-surface scope but adjacent:
the project's theory doc cites arXiv 2607.26935's two-feature detector
(`mouse_event_rate`, `teleport_click_ratio`) at 100% agent recall and Akamai's
"63.2% of agentic requests have zero mouse events". `human.py` provides
trajectories and dwell; stream structure is C14. PARTIAL.

---

## 4. Documentation drift found while auditing (not fixed; FYI)

- `README.md` "What's already patched" lists **WebAudio getChannelData**,
  **Canvas measureText**, **Local Font Access**, and **WebRTC ICE
  (no-non-proxied-UDP)** as patched. None has an `EDITS` entry today
  (audio and measureText explicitly removed; font_access and peerconnection
  only receive a copied header). `apex_fingerprint.h`'s header comment also
  still says "non-proxied UDP is force-disabled".
- `apply.sh`'s step-3 comment says it applies `.patch` files; the README
  already notes this is wrong (`patches/series` is documentation-only).
- `chromium_src/.../apex_devices.h` (seeded 32-hex device IDs) is copied but
  unused; the live `apex-devices` edit inlines empty-string entries instead.
- The local `stealth-browser:0.1.1` image is Debian 13 (trixie) packages and
  has no `/opt/stealth-chromium`; it predates the current Dockerfile
  (bookworm + patched binary). Container-specific claims above are from the
  Dockerfile + Debian dependency data, not from running the current image.

---

## 5. Method notes

- Coverage was judged only from `EDITS` markers, the two overlays, the GN
  args, and the launcher code paths actually executed (`fp_env`,
  `chrome_launch_flags`, both cores). README tables were treated as claims.
- Chromium facts were read at tag `157.0.8103.27` where the file exists at
  that tag (`user_agent_utils.cc`, `gpu_adapter.cc`, `font_cache.cc`,
  `font_face_set.cc`, `chrome/VERSION`); `webrtc_ip_handling_policy.h`,
  `net/docs/proxy.md`, and `testing/variations/README.md` were read at `main`.
- Not executed: the patched binary (no local copy), the container, any
  detector site. Rows marked inferred were not measured.

---

## 6. Sources

- [S1] p0f v3 README (TCP signature format; `bad_sw`, `us_vs_os`): https://github.com/p0f/p0f/blob/master/docs/README
- [S2] JA4+ technical details (JA4 TLS incl. `q`/`t` transport prefix, JA4H, JA4T, JA4X): https://github.com/FoxIO-LLC/ja4/blob/main/technical_details/README.md
- [S3] Cloudflare, "JA4 Signals" (hourly population ratios; "15 million unique JA4 fingerprints" per day): https://blog.cloudflare.com/ja4-signals/
- [S4] Akamai / E. Shuster, "Passive Fingerprinting of HTTP/2 Clients", Black Hat EU 2017 (briefing page; the whitepaper PDF URL did not resolve during this audit): https://www.blackhat.com/eu-17/briefings.html
- [S5] Cloudflare Bot Management, Detection IDs (header-order example): https://developers.cloudflare.com/bots/concepts/detection-ids/
- [S6] WICG User-Agent Client Hints: https://wicg.github.io/ua-client-hints/
- [S7] Chromium `components/embedder_support/user_agent_utils.cc` @157.0.8103.27 (`GetPlatformVersion`, brand list): https://chromium.googlesource.com/chromium/src/+/refs/tags/157.0.8103.27/components/embedder_support/user_agent_utils.cc
- [S8] chromiumdash Stable releases, Linux (`157.0.8103.38`, previous `156.0.8078.79`): https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Linux&num=3
- [S9] Fingerprint Smart Signals reference (VPN detection `timezone_mismatch`/`os_mismatch`, Browser Tampering, Device Rarity, Velocity): https://docs.fingerprint.com/docs/smart-signals-reference
- [S10] Chromium `third_party/blink/public/common/peerconnection/webrtc_ip_handling_policy.h`: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/public/common/peerconnection/webrtc_ip_handling_policy.h
- [S11] RFC 8828, "WebRTC IP Address Handling Requirements", §5.2 Modes 1–4: https://www.rfc-editor.org/rfc/rfc8828.html
- [S12] Chromium `net/docs/proxy.md` (proxy-side DNS for HTTP/SOCKS5; "SOCKSv5 … cannot be used to relay UDP traffic"): https://chromium.googlesource.com/chromium/src/+/main/net/docs/proxy.md
- [S13] Mowery & Shacham, "Pixel Perfect: Fingerprinting Canvas in HTML5", W2SP 2012: https://hovav.net/ucsd/dist/canvas.pdf
- [S14] Castle, "Detecting noise in canvas fingerprinting" (solid-fill check, cyclic `setPrototypeOf`): https://blog.castle.io/detecting-noise-in-canvas-fingerprinting/
- [S15] fingerprintjs `src/sources/canvas.ts` ("Cwm fjordbank gly 😃", explicit built-in fonts): https://github.com/fingerprintjs/fingerprintjs/blob/master/src/sources/canvas.ts
- [S16] Cao, Li, Wijmans, "(Cross-)Browser Fingerprinting via OS and Hardware Level Features", NDSS 2017: https://www.ndss-symposium.org/ndss2017/ndss-2017-programme/cross-browser-fingerprinting-os-and-hardware-level-features/
- [S17] CreepJS `src/headless/index.ts` (`likeHeadless`/`headless`/`stealth` checks): https://github.com/abrahamjuliot/creepjs/blob/master/src/headless/index.ts
- [S18] Castle, "Detecting Hidemium: fingerprinting inconsistencies in anti-detect browsers": https://blog.castle.io/detecting-hidemium-fingerprinting-inconsistencies-in-anti-detect-browsers/
- [S19] Chromium `third_party/blink/renderer/modules/webgpu/gpu_adapter.cc` @157.0.8103.27 (`is_fallback_adapter`, developer-features gating): https://chromium.googlesource.com/chromium/src/+/refs/tags/157.0.8103.27/third_party/blink/renderer/modules/webgpu/gpu_adapter.cc
- [S20] Chrome Developers, "WebGPU 113" changelog (Linux in Chrome 144, Linux NVIDIA 147–148): https://developer.chrome.com/blog/new-in-webgpu-113
- [S21] Fifield & Egelman, "Fingerprinting Web Users Through Font Metrics", FC 2015: https://doi.org/10.1007/978-3-662-47854-7_7
- [S22] Chromium `third_party/blink/renderer/core/css/font_face_set.cc` @157.0.8103.27 (`check()` → `IsPlatformFamilyMatchAvailable`): https://chromium.googlesource.com/chromium/src/+/refs/tags/157.0.8103.27/third_party/blink/renderer/core/css/font_face_set.cc
- [S23] Guri & Fibert, "Browser Fingerprinting Using WebAssembly", arXiv 2506.00719: https://arxiv.org/abs/2506.00719
- [S24] rebrowser-bot-detector README (20 tests): https://github.com/rebrowser/rebrowser-bot-detector
- [S25] Olejnik, Acar, Castelluccia, Diaz, "The leaking battery", 2015: https://eprint.iacr.org/2015/616
- [S26] Vastel, "Detecting Chrome headless, new techniques" (2018; URL currently redirects to the author's homepage — the permissions/Notification check is implemented verbatim in [S17]): https://antoinevastel.com/bot%20detection/2018/01/17/detect-chrome-headless-v2.html
- [S27] web.dev, "Storage for the web" ("An origin can use up to 60% of the total disk space"): https://web.dev/articles/storage-for-the-web
- [S28] GoogleChromeLabs/wasm-feature-detect: https://github.com/GoogleChromeLabs/wasm-feature-detect
- [S29] WICG Network Information API, Privacy Considerations: https://wicg.github.io/netinfo/
- [S30] fingerprintjs/BotD `src/sources/index.ts` (23 sources incl. `rtt`, `notificationPermissions`, `errorTrace`): https://github.com/fingerprintjs/BotD/blob/main/src/sources/index.ts
- [S31] Chromium CL 6917162 (CDP input screen-coordinate fix, M142): https://chromium-review.googlesource.com/c/chromium/src/+/6917162
- [S32] MDN, Web video codec guide, HEVC support note for Chrome: https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs
- [S33] W3C Media Capabilities, §Security and Privacy Considerations: https://www.w3.org/TR/media-capabilities/
- [S34] Chrome Developers, "New in Chrome 89" (Web Share "now supported on ChromeOS and Windows"): https://developer.chrome.com/blog/new-in-chrome-89
- [S35] Chrome Developers, Shape Detection API ("Barcode detection is available on macOS, ChromeOS, and Android"): https://developer.chrome.com/docs/capabilities/shape-detection
- [S36] Fingerprint, product roundup 2026-09-03 ("Chromium-Based Browser"): https://fingerprint.com/blog/product-roundup-active-call-chromium-detection/
- [S37] Chromium `testing/variations/README.md` (testing config applies to Chromium builds; `disable_fieldtrial_testing_config`): https://chromium.googlesource.com/chromium/src/+/main/testing/variations/README.md
- [S38] Castle, "Why a classic CDP bot detection signal suddenly stopped working": https://blog.castle.io/why-a-classic-cdp-bot-detection-signal-suddenly-stopped-working-and-nobody-noticed/
- [S39] Chromium `chrome/VERSION` @157.0.8103.27 (`MAJOR=157 MINOR=0 BUILD=8103 PATCH=27`): https://chromium.googlesource.com/chromium/src/+/refs/tags/157.0.8103.27/chrome/VERSION
- [S40] Debian bookworm package dependencies: xvfb → libgl1 (https://packages.debian.org/bookworm/xvfb); libglx0 → libglx-mesa0 (https://packages.debian.org/bookworm/libglx0); libglx-mesa0 → libgl1-mesa-dri (https://packages.debian.org/bookworm/libglx-mesa0)

Project documents cross-referenced (same package, `docs/`): `detection-gaps.md`,
`network-layer-fingerprinting.md`, `tcp-ip-fingerprinting.md`,
`input-stream-realism.md`, `patchright-driver-analysis.md`,
`technique-catalog.md`, `first-principles-detection-theory.md`,
`persona-generation-research.md`; `../stealth-browser/HANDOFF.md` (round-4
ground truth).
