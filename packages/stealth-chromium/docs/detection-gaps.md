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
| 6 | **Worker / nested-iframe coherence** | fpscanner `hasMismatchPlatformWorker`/`hasMismatchWebGLInWorker`; CreepJS `hasBadWebGL`; Castle repeats all signals in a Worker. | CreepJS; fpscanner (npm) | Verify our Blink patches propagate to WorkerNavigator/OffscreenCanvas | VERIFY |
| 7 | **GPU parameters behind spoofed strings** | Under Xvfb the real backend is SwiftShader/llvmpipe: spoofed unmasked strings contradict `MAX_TEXTURE_SIZE`, extension list, shader precision (CreepJS "GPU Params vs GPU Model" — top-8 check). | browserleaks /webgl + /webgpu vs a real persona-GPU dump | C++ per-persona parameter table, or real/VirGL GPU — LARGE | OPEN |
| 8 | **Headful-under-Xvfb red pills** | CreepJS `likeHeadless`: `noTaskbar` (screen==avail), `hasKnownBgColor` (ActiveText `rgb(255,0,0)` Linux vs `rgb(0,102,204)` Windows), `prefersLightColor`, `pdfIsDisabled`, `Notification.permission` vs `permissions.query`, 0 "Google" TTS voices. | CreepJS headless/stealth ratings; browserleaks /css /features | Mixed: ui::NativeTheme C++ or persona OS = Linux | OPEN |
| 9 | **OS-gated API surface** | Mac Chrome ≥88 must have `BarcodeDetector`, `navigator.share/canShare`; version-gated features via caniuse (Castle Hidemium/UAP sequence). | browserleaks /features | C++ feature flags per persona OS — deep; cheapest: persona OS == host OS | CLOSED 2026-11-10 (see detector-sources row 2) |
| 10 | **Chrome-vs-Chromium build integrity** | Fingerprint (Sep 2026): Chromium builds now classify as "Chromium-Based Browser"; genuine branded Chrome keeps name/version. Tells: proprietary codecs, Widevine, Google TTS voices, field trials. Our rebuilt binary must be the branded build. | demo.fingerprint.com; `MediaSource.isTypeSupported('video/mp4; codecs="avc1…"')` | Build config (proprietary_codecs, branding) | VERIFY at build config |
| 11 | **Population rarity** | Fingerprint Device Rarity (p99.9+/not_seen in 14-day window); `deviceMemory` only {0.25..8}+16/32; cores >90 flagged. | amiunique.org; CreepJS trust | Persona generation from real distributions, not a patch | OPEN (persona layer) |
| 12 | **Storage quota / navigator.connection** | Chrome quota = 60% of disk (small VM disk = tiny quota = tell); BotD collects `connection.rtt`. | navigator.storage.estimate(); browserleaks /javascript | Disk sizing or C++ QuotaSettings | CLOSED 2026-11-10 (see detector-sources row 8) |
| 13 | **Timezone/locale/IP triangle** | Fingerprint `timezone_mismatch`; Castle Intl-vs-offset-vs-Accept-Language-vs-IP. | browserscan.net; iphey.com | Per-profile TZ/locale tied to proxy exit country | OPEN (persona layer) |
| 14 | **Launch-flag side effects** | rebrowser: `--disable-popup-blocking` (window.open without gesture), `--disable-ipc-flooding-protection` (300 replaceState in 10s), `--remote-debugging-port` visible in chrome://gpu. | bot-detector.rebrowser.net | Launch args | VERIFY our flag set |

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
