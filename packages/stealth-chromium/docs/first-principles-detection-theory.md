# First-principles detection theory — what an undetectable browser must guarantee

Synthesis from the primary literature (Eckersley 2010, FP-Scanner 2018,
FP-Inconsistent 2024, browser-agent multi-layer detection 2026, Wasm timing
2025, DrawnApart 2022, Gummy Browsers 2021, and the detector vendors' own
docs). This is the model the adversarial loop optimizes against. arXiv IDs and
full citations at the bottom.

## The two tests (how detectors actually score)

1. **Rarity**: is the core tuple (OS+version, browser major, GPU class,
   screen/DPR, cores, memory, locale/tz) in the high-mass region of the
   detector's 14-day population? Fingerprint's buckets: `not_seen` (worst),
   `p99.9+`, `<p95` (Common). Budget: keep core-tuple surprisal under ~10-15
   bits; ≥20 bits is the tail.
2. **Consistency**: do all channels and all visits agree with ONE real device?
   Cross-channel (JS↔HTTP↔TLS↔render↔timing) and temporal (repeat-visit)
   agreement. One impossible pair is infinite evidence (FP-Inconsistent:
   raising 96 consistency rules lifted DataDome detection 55.4→76.9% with
   96.8% true-negative rate on real users).

## The optimal persona (the key derived result)

**Deterministic copy of a real, COMMON device that ages like a real device.**

- Not randomization: FP-Scanner's pixel tests detect canvas noise with
  accuracy 1.0 (vs 0.0 for the un-noised baseline); FP-Inconsistent's temporal
  rules flag Brave's randomized values when any other identifier links visits;
  Castle (2025-11): "randomization becomes suspicious… or when the randomization
  pattern does not match the claimed browser."
- Not perfect stability: FP-STALKER (S&P 2018) measured 50% of browser
  fingerprints change within 5 days (UA median 39.7 days; canvas ~290 days).
  A persona frozen for months is itself an outlier — so hardware-tied
  coordinates (canvas, WebGL, fonts, screen, cores, memory, tz) stay FIXED per
  persona, and software-tied coordinates (UA, features, TLS/H2) ADVANCE on the
  real two-week release train.
- Not rare hardware: deviceMemory outside {0.25..8}+16/32 was flagged by
  Castle; cores >90 flagged.

**Fleet-level (mass scraping):** if M personas are drawn from Q instead of the
real population P, a detector accumulates ≈ n·KL(Q‖P) over n requests from one
vantage point. One over-concentrated tuple gives ~6.6 bits of evidence per
request; dozens of requests are overwhelming. **Undetectable at fleet scale
requires sampling personas from the real joint distribution** (including its
version/hardware mix) and spreading them across IPs/ASNs — Fingerprint's
Velocity signals (distinct IPs per visitor_id at 5min/1h/24h) are this test.
This is the mass-scraping product's core requirement.

## Layer independence — the patch principle

In stock Chrome every observable is a function of one latent state L
(OS+version, CPU, RAM class, GPU, display geometry, locale/tz/IP, Chrome
version, fonts, input). Inconsistency arises iff a patch sets an observable
DIRECTLY instead of changing the latent it derives from, or two channels
depend on the same latent and only one was patched.

- **Patch latent SOURCES, never consumers** — then main thread, workers,
  iframes, headers, client hints and media queries all agree (maps to our
  C++ patch design and the worker-scope verification requirement).
- **Claimed version == actual build version** — TLS/H2/feature-set all key
  off the build.
- **Cross-OS personas are the documented failure mode** (Castle's Undetectable
  analysis: fake Safari exposed by hardcoded "Apple GPU" strings; Hidemium's
  UA-chosen behaviour). Personas whose OS != host OS are the residual the
  rendering channels expose.

## Build residuals of a rebuilt binary (our check)

The stock-Chrome-vs-Chromium residual: branding (`proprietary_codecs`, H.264/
AAC in canPlayType), Widevine bundling, ThinLTO/PGO (official builds), version
drift. **VERIFIED our args.gn already sets `is_official_build=true` +
`proprietary_codecs=true` + `ffmpeg_branding="Chrome"`** — the residual to
check: Widevine CDM presence and version-train tracking. The patch delta
contributes negligible codegen difference when the build is otherwise official.

## Timing & input: the fundamentally-hard residual

- **Timing**: Wasm call-boundary ratios classify Chromium 99.3% (2506.00719);
  DrawnApart separates IDENTICAL GPU models at 93-96% by execution-unit
  timing; Chrome's timer clamping (100µs coarse / 5µs fine, keyed jitter) does
  not stop engine-level ratios. Hardware identity leaks through timing
  regardless of string spoofing — either run on hardware matching the claim or
  accept a residual. (Mitigation: personas that match the host GPU, per gap #7.)
- **Input stream**: two behavioral features (`mouse_event_rate` + 
  `teleport_click_ratio`/`click_duration_std`) give 100% agent recall at every
  evasion level INCLUDING human replay (arXiv 2607.26935) because Playwright/
  CDP "do not emit the raw pointer-move and wheel-delta streams a physical
  input device produces" — the stream STRUCTURE survives trajectory
  manipulation. CDP `Input.dispatchMouseEvent` produces real trusted Blink
  events but structurally cannot supply coalesced sample streams or hardware
  timestamps (a 125-1000Hz mouse yields several samples per frame; CDP yields
  one). 63.2% of agentic requests have ZERO mouse events (Akamai).
  **Implication: our human.py must emit OS-level input with realistic stream
  structure — this is the personal product's hardest component, already
  partially solved by our human-input middleware; verify with the loop.**

## Quantified channel weights (browser-agent paper 2606.30119)

Random forest over agents+humans: IP alone 0.596 acc, TLS alone 0.454,
browser fingerprint alone 0.931, IP+TLS 0.806, all layers 0.993. Local agents
(OpenClaw, Claude-for-Chrome) share human JA4 — separable ONLY at the browser
layer. Cloud agents fall at TLS/IP. Conclusion quote: "stealth modes… can even
increase detectability by introducing fingerprint inconsistencies."

## What the loop must verify (mapped to our stack)

1. Consistency across ALL channels for one persona (browser + headers +
   client hints + workers + iframes).
2. Repeat-visit stability: two sessions of the same persona must agree
   (deterministic, not noisy) — and differ correctly across sessions.
3. Population plausibility: persona core tuples must be common (sampled from
   real distributions, not random).
4. Version currency: persona Chrome version tracks the release train.
5. Input-stream realism: mouse event rate, teleport ratio, click-duration
   variance present and human-like.
6. No automation-protocol artifacts (Runtime.enable, sourceURL, bindings) —
   the driver analysis (patchright-driver-analysis.md) covers this.

## Sources

arXiv 2406.07647 (FP-Inconsistent) · 2606.30119 (browser-agent multi-layer) ·
2506.00719 (Wasm timing) · 2607.26935 (agent input-stream) · 2605.01247
(FP-Agent) · 2201.09956 (DrawnApart) · 2006.09511 (Andriamilanto stability) ·
2410.06954 (Berke) · 2403.15607 (Bacis scale) · 2110.10129 (Gummy Browsers) ·
2005.00890 (BeCAPTCHA-Mouse) · Eckersley PETS 2010 · Vastel FP-Scanner USENIX
Sec 2018 · JS Template Attacks NDSS 2019 · Pugliese PETS 2020.
Vendor: Fingerprint Smart Signals + 2026 report; Cloudflare JA4 signals +
per-customer defenses + Precursor (2026-07); Akamai HTTP/2 fingerprinting
(Black Hat EU 2017) + agentic behavioral telemetry (2026-08); Castle posts
(2025-2026). Chromium: time_clamper.h, input_handler.cc, features.gni,
compiler.gni, release_cycle.md. Full links in the agent transcripts; the IDs
above are sufficient for retrieval.
