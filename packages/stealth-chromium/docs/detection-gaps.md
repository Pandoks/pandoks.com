# Detection-gap matrix (2025-26) — what the detection model can still see

Ranked list of detection surfaces our 27 C++ patches + 11 local detectors do
NOT cover, from 2025-26 primary sources (Fingerprint/Castle/rebrowser/Cloudflare
docs + academic work). This drives the adversarial detection/avoidance loop:
every row is a testable gap; close rows until the model can't detect anything.

Verified = cited in the source column; the ranking itself is inferred.

## The gaps, ranked by 2025-26 detector weight

| # | Surface | How detectors read it | Local test | Patch layer | Status |
|---|---|---|---|---|---|
| 1 | **Post-Chrome-137 CDP residue** | The old Error.stack-getter trap died with V8 commits (May 7/9 2025); current signal: `Runtime.enable` still triggers `Error.prepareStackTrace` + `error.name` re-reads, `//# sourceURL=pptr:` stamps, bare `at app.js:4:14` frames, `Runtime.addBinding` empty-name fns, hooked `querySelector`, `Fetch.fulfillRequest` → `nextHopProtocol === ""`. Fingerprint BotD explicitly flags "controlled via an active CDP session". | bot-detector.rebrowser.net (20 tests); brotector; BotD (offline npm) | Driver-side (rebrowser-style patches on our patchright layer) | OPEN |
| 2 | **CDP input geometry** | `screenX == clientX && screenY == clientY` outside fullscreen = `Input.dispatchMouseEvent` (crbug 1477537); no `getCoalescedEvents()` on CDP input. Fixed upstream in Chromium 6917162 (merged 2025-09-15, Chrome 142+) — our 157 base includes it, but the driver must not re-introduce it, and `isTrusted` checks remain. | brotector; CDP-Patches snippet | Driver (verify our human.py drives real X11 input, not CDP input) | VERIFY |
| 3 | **Network identity vs persona** | JA4T TCP OS (Win11 = `64240_2-1-3-1-1-4_1460_8`), p0f, Cloudflare JA4 + hourly signals, Akamai h2 print (`1:65536;2:0;4:6291456;6:262144\|15663105\|0\|m,a,s,p`), header ordering. Real Chrome passes TLS/h2 UNLESS a TLS-terminating proxy or QUIC-disabled path shifts it. | tls.peet.ws; browserleaks /tcp /tls /http2 /quic; bot.incolumitas.com | Network layer (not JS-patchable); persona OS == proxy exit OS | OPEN |
| 4 | **HTTP ↔ JS client-hint coherence** | `Sec-CH-UA-Platform-Version` ≥13 = Win11 vs UA `Windows NT 10.0`; `Sec-CH-UA-Form-Factors` headful-only; `Accept-Language` vs `navigator.languages`; `setUserAgent` empties `userAgentData.brands`. Our JS patch of userAgentData.platform doesn't touch the header set. | browserleaks /client-hints; deviceandbrowserinfo /api/http_headers | C++ (embedder UA metadata — headers and getHighEntropyValues must derive from ONE persona record) | PARTIAL 2026-11-10: the C++ item (one persona record driving UA + Sec-CH-UA-*) is implemented (`apex-ua-brand`, `apex-ua-latent-*`); platform-version verified coherent (Win personas report 15.0.0 = Win11, matching the `NT 10.0` UA; a Win10 persona pins 1.0.0 via `APEX_FP_UA_PLATFORM_VERSION`, now a per-profile persona field). Remaining sub-items: `Sec-CH-UA-Form-Factors` headful-only, `Accept-Language` vs `navigator.languages`. |
| 5 | **Self-betraying canvas noise** | Castle: fill `rgba(0,127,255,1)` → every pixel must stay `[0,127,255,255]`; `Object.setPrototypeOf(toDataURL, toDataURL)` must throw "Cyclic". Farbling v2.1 (`_RGBA_NOISE_LOOP` in scripts/apply_edits.py) skips any pixel whose 3x3 hi7 window is uniform (solid fills pass byte-identical; decisions read only hi7 so re-reads are a fixpoint) and never touches transparent pixels; noise is confined to textured content. Verified by sim (2026-11): uniform [0,127,255,255]/[0,127,255,1] identical, gradient 300x150 still farbled. | Castle pixel snippet; CreepJS canvas lies; reload browserleaks /canvas | C++ farbling (already implemented; verify on the live build) | CLOSED in code (af45e30b) — VERIFY on build |
| 6 | **Worker / nested-iframe coherence** | fpscanner `hasMismatchPlatformWorker`/`hasMismatchWebGLInWorker`; CreepJS `hasBadWebGL`; Castle repeats all signals in a Worker. | CreepJS; fpscanner (npm) | Verify our Blink patches propagate to WorkerNavigator/OffscreenCanvas | CLOSED 2026-11-13 — now exercised by the adversarial arena (worker + nested-iframe re-probes of the patched surfaces); passes |
| 7 | **GPU parameters behind spoofed strings** | Under Xvfb the real backend is SwiftShader/llvmpipe: spoofed unmasked strings contradict `MAX_TEXTURE_SIZE`, extension list, shader precision (CreepJS "GPU Params vs GPU Model" — top-8 check). | browserleaks /webgl + /webgpu vs a real persona-GPU dump | C++ per-persona parameter table, or real/VirGL GPU — LARGE | OPEN |
| 8 | **Headful-under-Xvfb red pills** | CreepJS `likeHeadless`: `noTaskbar` (screen==avail), `hasKnownBgColor` (ActiveText `rgb(255,0,0)` Linux vs `rgb(0,102,204)` Windows), `prefersLightColor`, `pdfIsDisabled`, `Notification.permission` vs `permissions.query`, 0 "Google" TTS voices. | CreepJS headless/stealth ratings; browserleaks /css /features | Mixed: ui::NativeTheme C++ or persona OS = Linux | OPEN |
| 9 | **OS-gated API surface** | Mac Chrome ≥88 must have `BarcodeDetector`, `navigator.share/canShare`; version-gated features via caniuse (Castle Hidemium/UAP sequence). | browserleaks /features | C++ feature flags per persona OS — deep; cheapest: persona OS == host OS | CLOSED 2026-11-10 (see detector-sources row 2) |
| 10 | **Chrome-vs-Chromium build integrity** | Fingerprint (Sep 2026): Chromium builds now classify as "Chromium-Based Browser"; genuine branded Chrome keeps name/version. Tells: proprietary codecs, Widevine, Google TTS voices, field trials. Our rebuilt binary must be the branded build. | demo.fingerprint.com; `MediaSource.isTypeSupported('video/mp4; codecs="avc1…"')` | Build config (proprietary_codecs, branding) | VERIFY at build config |
| 11 | **Population rarity** | Fingerprint Device Rarity (p99.9+/not_seen in 14-day window); `deviceMemory` only {0.25..8}+16/32; cores >90 flagged. | amiunique.org; CreepJS trust | Persona generation from real distributions, not a patch | OPEN (persona layer) |
| 12 | **Storage quota / navigator.connection** | Chrome quota = 60% of disk (small VM disk = tiny quota = tell); BotD collects `connection.rtt`. | navigator.storage.estimate(); browserleaks /javascript | Disk sizing or C++ QuotaSettings | CLOSED 2026-11-10 (see detector-sources row 8) |
| 13 | **Timezone/locale/IP triangle** | Fingerprint `timezone_mismatch`; Castle Intl-vs-offset-vs-Accept-Language-vs-IP. | browserscan.net; iphey.com | Per-profile TZ/locale tied to proxy exit country | OPEN (persona layer) |
| 14 | **Launch-flag side effects** | rebrowser: `--disable-popup-blocking` (window.open without gesture), `--disable-ipc-flooding-protection` (300 replaceState in 10s), `--remote-debugging-port` visible in chrome://gpu. | bot-detector.rebrowser.net | Launch args | VERIFY our flag set |
| 15 | **DoH bypasses the proxy** | Chrome's Secure DNS (default `kAutomatic`) issues DoH with `LOAD_BYPASS_PROXY`: if DoH activates, DNS leaves from the host's datacenter IP (or 1.1.1.1) while HTTP leaves from the proxy's residential IP. Any site running its own authoritative DNS correlates "queried from IP X, connected from IP Y" — a textbook proxy tell; the same-country check also fails. 2026-11-14: automatic mode stays plaintext when the resolver is 127.0.0.1/127.0.0.53, but a private-IP VPS resolver can activate it. | chrome://net-internals/#dns (verify the active mode); DNS-query log on a probe domain | Host config (disable Secure DNS for proxied sessions, or pin DoH to a persona-region provider) | OPEN (highest-value fix: one flag) |
| 16 | **QUIC / HTTP-3 absence** | A TCP-only CONNECT/SOCKS5 path forces h2 on every request; a real Windows desktop on residential broadband speaks h3 to Cloudflare and other ALT-SVC-h3 origins. Cloudflare scores `h2h3_ratio_1h` per JA4; a never-h3 desktop persona is a population anomaly at h3-capable origins. | browserleaks /quic; TrackMe H3 fingerprint | Host config (UDP-capable/h3 egress for targets that matter) or accept the residual; never force-disable QUIC globally | OPEN (decision: h3-capable egress vs accept) |
| 17 | **IP-pool reputation (sharing, recency, rDNS)** | 2025-26 IP scoring is observation-based: MaxMind `user_count` > 5 in 30 days = proxy/CGNAT, `is_residential_proxy`, `percent_days_seen`; IPQS `shared_connection`/`recent_abuse`; WhoisXML `confidence_decay`; and Cloudflare bot verification requires a bot-UA IP's PTR to resolve into the owner's domain suffix. A residential pool IP shared by many identities or recently seen as an anonymizer fails the ASN/datacenter test our docs rely on. | `dig -x <ip>` + MaxMind/IPQS lookups in the pool-vetting script | Host config (pool policy: one persona per exit IP, low `user_count`, not-recently-anonymizer, ISP-shaped PTR) | OPEN (no vetting exists) |
| 18 | **TLS composition assertions (sigalgs/PQ, ALPS, ECH, resumption, JA4H, JA4S)** | Chrome 157 ClientHello leads with 3 ML-DSA sigalgs (0x0904 first) + X25519MLKEM768 first key share; ALPS uses the NEW codepoint 0x44CD; ECH is RFC 9849 opportunistic + GREASE; on resumption `pre_shared_key` replaces `key_share` (JA4_c shifts, Cloudflare skips fingerprinting); JA4H hashes header names + cookie names/values; JA4S (ServerHello) is per-(server, client-fingerprint). A stale BoringSSL, a TLS-impersonation library, or a MITM all move these and nothing in the battery notices. | tls.peet.ws JA4/JA4_r/JA4S/JA4H fields vs the canonical 157 values; tcpdump JA4TS self-test vs Cloudflare | Build (keep stock BoringSSL; verify 0x0904-first + 0x44CD after any bump) + battery assertions; resumption = don't force-disable | OPEN (all DOCUMENTED, none asserted) |
| 19 | **Font depth (width-probe, TextMetrics, FontFaceSet, queryLocalFonts)** | The Debian font bundle (Liberation + Noto Color Emoji) under a Windows/macOS persona leaks through: width-measurement enumeration of 50-100 families (only ~4-5 resolve), `measureText`/`TextMetrics` exact Liberation metrics (farbling edit removed), `document.fonts.size`/`check()` state, and `queryLocalFonts()`. The local `fontsCoherent` check only requires ONE family present — weak. | browserleaks /fonts (family count); FingerprintJS `fonts.ts` metric hash; `document.fonts` probes | C++ (persona allowlist for `IsPlatformFamilyMatchAvailable` + width measurement + re-add TextMetrics farbling) + host config (install metric-compatible persona-OS fonts) | CLOSED in code 2026-11-14 (uncommitted) — the host half is done and build-gated: `packages/stealth-chromium/Dockerfile` installs the Windows 10/11 core font set (mscorefonts + OFL/LGPL metric clones + Selawik, licensing documented in the Dockerfile comment) and `scripts/remap_persona_fonts.py` name-clones them onto the persona family names, with `scripts/verify_persona_fonts.sh` failing the image build if any name stops resolving (replayed the exact `isAcceptableMatch` rule; 63/64 names resolve — `MingLiU-ExtB` excluded because fontconfig cannot match hyphenated family names). The C++ half is in code: the Windows allowlist in `apex_font_policy.h` is now the full 63-name core list (build-gate note applies). The battery's section 18 now enumerates the same catalog per persona OS and asserts ALL of it present (not one-of). VERIFY: C++ half on the next patched build + one live battery run on a Windows persona. |
| 20 | **CSS media queries (scheme, contrast, gamut, input)** | `prefers-color-scheme`, `forced-colors`, `inverted-colors`, `monochrome`, `color-gamut`, `dynamic-range`, `any-hover/pointer/hover/pointer`, `display-mode`, `scripting`, `prefers-contrast/-reduced-motion/-reduced-transparency/-reduced-data` — FingerprintJS OSS reads 5+ of these directly; CreepJS `prefersLightColor` (Xvfb reports light). Zero CSS probes exist in the battery. | browserleaks /css; `matchMedia` matrix in a probe | C++ (persona-OS `ui::NativeTheme` for the OS-driven ones) + battery `matchMedia` matrix | OPEN (zero coverage) |
| 21 | **Keyboard layout (XKB vs persona)** | `navigator.keyboard.getLayoutMap()` reports the container's Xvfb XKB layout, not the persona's. A layout probe (KeyQ → 'a' on AZERTY) cross-checks locale claims; the battery checks only the US-QWERTY `KeyW` → 'w' mapping. | `getLayoutMap()` full map vs persona locale | Host config (per-persona XKB layout) or C++ (patch the Keyboard Map API) | OPEN (matters for non-US personas) |
| 22 | **Intl deep probes (resolvedOptions, Segmenter, WeekInfo, DurationFormat)** | `Intl.DateTimeFormat().resolvedOptions().timeZone` is the exact value Fingerprint (`timezone_mismatch`) and Castle (`timezone_area_mismatch`) cross-check against IP geo — and the battery never reads it. `formatToParts`, `Intl.Segmenter`, `Locale.getWeekInfo()`, `DurationFormat` are cheap ICU-version/depth probes. | browserscan.net; `resolvedOptions().timeZone` == persona TZ assertion | Persona layer (TZ already set) + battery assertion | OPEN (high signal, trivial probe) |
| 23 | **Client-hints peripheral matrix** | `Sec-CH-Form-Factors` (headful-only; a laptop persona must not report Mobile), plus the opt-in peripheral set `Sec-CH-DPR/Viewport-Width/Height/Width/Device-Memory/Save-Data/RTT/ECT/Downlink` — cross-checkable against JS (devicePixelRatio, screen, deviceMemory). DataDome consumes the full Sec-CH + Sec-Fetch set server-side. | browserleaks /client-hints; header-echo endpoint comparison vs JS values | C++/persona (Form-Factors) + battery (request all via the header-echo endpoint) | OPEN (Form-Factors is the row-4 sub-item) |
| 24 | **Sec-Fetch-\* request headers** | `Sec-Fetch-Site/Mode/Dest/User/Storage-Access` classify browser-initiated vs script traffic server-side; `Sec-Fetch-User: ?1` only on real user-initiated navigations. Real Chrome sends the full correct set — but our battery observes UA and Accept-Language only, never fetch metadata. | browserleaks; header-observing endpoint (tls.peet.ws) | Battery assertion (values are real Chrome by construction — assert they stay that way) | OPEN (cheap assertion) |
| 25 | **WebAuthn capability matrix** | `PublicKeyCredential.getClientCapabilities()` (shipped 133) returns a 9-key boolean map (`conditionalCreate/Get`, `hybridTransport`, `passkeyPlatformAuthenticator`, `relatedOrigins`, `signal*`) that varies with platform (hybridTransport true on Windows); `isConditionalMediationAvailable()` likewise. A 2026 detector surface we never touch. | Direct JS probe | Battery probe (values are real; assert presence + key set) | OPEN (easy, high-signal) |
| 26 | **Media/codec depth (HDR, 4K/8K, AudioEncoder, MediaRecorder, getSupportedConstraints)** | `mediaCapabilities.decodingInfo/encodingInfo` across HDR (HDR10, Dolby Vision) + 4K/8K + framerates — `powerEfficient: false` = no real GPU; `AudioEncoder/Decoder.isConfigSupported` (aac/opus/flac); MediaRecorder `isTypeSupported` full matrix (MP4 containers since 126, hvc1/vp9-in-mp4 since 136 — version-distinguishing); `mediaDevices.getSupportedConstraints()` key set. Our probes cover one 1080p H.264 config and one webm container. | browserleaks /codecs; W3C Media Capabilities matrix | Battery probes (capability already persona-gated in C++; this is assertion depth) | OPEN |
| 27 | **Sensor + misc API presence/coherence** | `Accelerometer`/`Gyroscope`/`Magnetometer`/`DeviceOrientationEvent` (constructors exist, events must NOT fire on a desktop), `navigator.xr` (present, both immersive modes false), `navigator.presentation`, `BroadcastChannel`, `ImageCapture`, `navigator.vendor`/`productSub`/`vendorFlavors` (must be `Google Inc.`/`20030107`), `Notification.maxActions` (2), `navigator.domBlockers` (0), `serviceWorker` presence. Bot suites enumerate these as a set; our battery covers only part. | bot.sannysoft.com class probes; direct JS | Battery (real behavior; assert coherence) | OPEN (cheap presence set) |
| 28 | **Speech voice names + localService pattern** | `getVoices()` count is checked, but the **name list** (`Microsoft (name) Desktop` pattern), `voice.default`, and `voice.localService` distribution are the OS fingerprint — CreepJS counts "Google" voices for `likeHeadless`. | CreepJS headless; direct name-list dump | C++ (exists); battery: assert the persona-OS name pattern | OPEN (names unasserted) |
| 29 | **GPU/timing fingerprints (Wasm, canvas readback)** | WebAssembly call-boundary timing ratios and canvas/WebGL readback latency classify the Chromium build AND the software rasterizer at <1% FPR (arXiv 2506.00719) — regardless of every spoofed string/parameter. The battery only *records* the distributions (`gpuReadbackTimingOk`). | arXiv 2506.00719 classifier; recorded timing distributions | Inherent — not string-patchable. Real GPU/hardware, or accept as residual + monitor | OPEN (inherent residual) |
| 30 | **WebGPU cross-origin pipeline-compile state** | Compiling the same WGSL shader on origin A then timing the first compile on origin B: a cache-fast second compile proves persistent pipeline-compile state crossed the origin boundary and fingerprints the browser/adapter. 2026 measurement study signal. | `scripts/webgpu_probe.py` phase 2 (exists, no detector coverage) | Dawn-side cache scoping (C++) — verify the leak first | OPEN (probe, then decide) |
| 31 | **AudioContext/AnalyserNode hash + AudioWorklet** | The `apex-audio-noise` edit was removed (stock hash already common); `checks.py` uses only the OfflineAudioContext compressor-sum route — an `AnalyserNode` FFT sum reaches the same fingerprint by a second route, and `AudioWorklet` presence is unprobed. | FingerprintJS `audio.ts` (both routes) | C++ (re-add `apex-audio-noise` only if clusters prove distinguishing) + battery (AnalyserNode route) | OPEN (low, verify cluster membership first) |
| 32 | **Wasm feature matrix** | `WebAssembly.validate`/compile across SIMD, threads, bulk-memory, reference-types, exceptions, relaxed-simd, GC, memory64, tail-call — same V8 as Chrome 157 means the matrix matches by construction, but nothing asserts it. | wasm-feature-detect | Battery (assert the 157 feature set) | OPEN (weak — by-construction) |

## 2025-26 anti-anti-detect trends (why old tricks die)

- **Getter-guarded error previews (Chrome 137)** killed the classic CDP trap;
  detectors moved to `prepareStackTrace`/`name` re-reads.
- **Side-effect diffing** (Castle Jan 2026): diff DOM/globals/wrapped APIs
  against stock Chrome; CastleJS uniquely identifies Puppeteer-stealth by side
  effects. => every JS shim is a liability; prefer C++ (ours already is).
- **toString/descriptor integrity**: native toString, TypeErrors on
  new/call/apply, cyclic __proto__, Reflect.ownKeys — C++ patches pass; JS
  shims fail.
- **WebAssembly timing fingerprints** distinguish Chromium builds despite
  spoofed UA (arXiv 2506.00719).
- **arXiv 2606.30119** (Jun 2026): browser layer alone classifies agents at
  0.931; "stealth … often increase detectability by introducing fingerprint
  inconsistencies". FP-Inconsistent: consistency rules cut evasion ~48%.
  => coherence is worth more than cloaking.

## Adversarial-loop benchmark ordering (this is the loop's battery order)

1. **Offline, deterministic** (seconds, no IP burn): BotD (npm), fpscanner
   (npm), brotector (static), CDP-Patches coord snippet, Castle canvas
   pixel/cyclic snippet, worker/iframe/header-vs-JS diff.
2. **Public JS-only**: bot-detector.rebrowser.net → CreepJS (lies +
   headless/stealth %) → bot.sannysoft.com → deviceandbrowserinfo.
3. **Network layer, once per persona/proxy**: tls.peet.ws, browserleaks (/tls
   /http2 /tcp /quic /client-hints /css /webgl), bot.incolumitas.com.
4. **Consistency/rarity verdicts**: browserscan.net, pixelscan.net, iphey.com,
   amiunique.org.
5. **Vendor demos (no account)**: demo.fingerprint.com → Cloudflare-protected
   pages → the hard-target matrix in scripts/adversarial.py.
6. **Behavioral**: bot.incolumitas.com 15s score.

Castle's caveat: these sites miss stability-over-time and cross-layer
coherence — repeated runs on ONE profile + the cross-layer checks are the real
gate.

## Immediate actions for the loop (from this research)

1. Extend `scripts/adversarial.py` with tiers 1-3 (offline npm suites +
   network-layer probes) — today.
2. Check our driver layer for CDP residue (patchright's Runtime.enable,
   sourceURL stamps) — rebrowser-style patches may be required (gap #1).
3. Verify gap #5 on the live build: the solid-fill skip is in the farbling
   code; confirm the built binary passes the Castle pixel + cyclic probes.
4. Verify persona defaults: OS == host OS, locale/TZ == proxy exit country
   (gaps #3, #9, #13 mostly dissolve if the persona matches the host).

## Evasion-approach comparison (from puppeteer-stealth source analysis)

Read the full source of puppeteer-extra-plugin-stealth v2.11.2 (the JS-shim
approach) and cross-referenced every evasion against CreepJS, fpscanner, BotD
and brotector source. Result: the JS-Proxy approach is deterministically
caught — CreepJS's prototype-cycle probes (setPrototypeOf/recursion tricks)
fire on every Proxy-wrapped API, brotector catches the eval'd trap frame in
live stacks (`at newHandler.<computed> [as apply] (eval at <anonymous>…)`),
and spoofed values leak through worker scopes (WorkerNavigator
hardwareConcurrency, OffscreenCanvas WebGL). BotD catches none of the 17
evasions (its checks are weaker).

**Implication for our stack (validated):** C++ patches (native code, no JS
Proxy wrappers) pass the prototype-lie and toString checks that catch every
JS-shim stealth. Our remaining risks are exactly the same categories that
catch JS-shim tools when they apply to us: (a) worker-scope propagation of
every patched value (WorkerNavigator, OffscreenCanvas, shared workers) —
gap #6, (b) driver-layer CDP residue (Runtime.enable, sourceURL) — gap #1,
(c) value coherence with workers/nested frames — gap #6. Every patch must be
verified against the worker scope, not just the main frame.

Analysis detail: run analysis was done against the live repos; the repo-local
copy of this comparison lives in the agent transcripts. The actionable
cross-reference (evasion → detector → catch mechanism) is what matters for
the loop.

## Sources

Fingerprint Smart Signals: https://docs.fingerprint.com/docs/smart-signals-reference
Fingerprint anti-detect post: https://fingerprint.com/blog/anti-detect-browser-detection/
Fingerprint Sep 2026 roundup: https://fingerprint.com/blog/product-roundup-active-call-chromium-detection/
Castle CDP signal: https://blog.castle.io/why-a-classic-cdp-bot-detection-signal-suddenly-stopped-working-and-nobody-noticed/
Castle canvas noise: https://blog.castle.io/detecting-noise-in-canvas-fingerprinting/
Castle Hidemium: https://blog.castle.io/detecting-hidemium-fingerprinting-inconsistencies-in-anti-detect-browsers/
rebrowser-bot-detector: https://github.com/rebrowser/rebrowser-bot-detector
CDP-Patches: https://github.com/Kaliiiiiiiiii-Vinyzu/CDP-Patches
Chromium input-coords fix: https://chromium-review.googlesource.com/c/chromium/src/+/6917162
CreepJS lies: https://github.com/abrahamjuliot/creepjs/blob/master/src/lies/index.ts
BotD: https://github.com/fingerprintjs/BotD
fpscanner: https://github.com/antoinevastel/fpscanner
Cloudflare JA4 Signals: https://blog.cloudflare.com/ja4-signals/
Cloudflare detection IDs: https://developers.cloudflare.com/bots/concepts/detection-ids/
JA4: https://github.com/FoxIO-LLC/ja4
TrackMe (tls.peet.ws): https://github.com/wwhtrbbtt/TrackMe
UA-CH spec: https://wicg.github.io/ua-client-hints/
bot.incolumitas.com: https://bot.incolumitas.com/
browserleaks: https://browserleaks.com/
FP-Inconsistent (arXiv 2406.07647): https://arxiv.org/abs/2406.07647
Wasm timing (arXiv 2506.00719): https://arxiv.org/abs/2506.00719
Browser-layer agent classification (arXiv 2606.30119): https://arxiv.org/abs/2606.30119

## 2026-11-13 synthesis sources (rows 15-32)

Rows 15-32 and the re-ranking come from the 2026-11-13 research-catalog
synthesis (merged into this doc; the catalogs are the detailed evidence, this
doc is the prioritized plan):

- `/var/tmp/research/network-layer.md` (network/transport: rows 15, 16, 17, 18)
- `/var/tmp/research/static-surfaces.md` (static JS surfaces: rows 19-32)
- `/var/tmp/research/environment-coherence.md` (host coherence: rows 19-21, 29, 30)
- `/var/tmp/research/commercial-detectors.md` (vendor decision models: coverage
  weighting for every row; the union table in section 10)
- `behavioral-automation.md` was missing at synthesis time — behavioral
  automation remains covered only by the pre-existing rows 1, 2, 14.
