# Stealth Browser — Comprehensive Test Suite Plan ("hardest of the hardest")

Goal: a maximally broad, tiered detector/scenario matrix to find **every leak** and
honestly measure how the browser fares — from trivial consumer scanners up to the
enterprise anti-bot vendors that real operations must beat. Grounded via web research
(June 2026); every entry notes what it tests, difficulty, whether a **public page** or a
**live protected target** is needed, and whether our current fingerprint-only work covers it.

> **Methodology rule:** each detector is tested across the **scenario matrix** (Tier 0),
> not once. And the **harness must capture verdicts reliably** — the current panel can't
> read image/DOM-rendered verdicts (iphey/pixelscan) or recover from flaky pages; fixing
> that is prerequisite #1 (see "Build order").

---

## Tier 0 — Scenario matrix (test EACH detector across these)

| Dimension | Values |
| --- | --- |
| **IP type** | datacenter · static-residential · rotating-residential · **mobile (4G/5G carrier)** · ISP |
| **Persona GPU class** | nvidia · amd · intel · apple · llvmpipe · adreno/mali (mobile) |
| **Render backend** | software (llvmpipe, prod) vs real-GPU (vulkan) |
| **OS claim** | Windows · macOS · Android (vs the real Linux host) |
| **Profile state** | cold (zero cookies/history) vs **warmed** (aged cookies/history) |
| **Concurrency** | single profile vs **multiple profiles same machine/IP** (linkability) |
| **Geo-consistency** | IP geo ↔ timezone ↔ locale ↔ WebRTC ↔ Accept-Language |
| **Mode** | headful/Xvfb desktop vs CDP mobile-emulation |

---

## Tier 1 — Consumer fingerprint scanners (easy–medium · public pages)

| Detector | URL | Tests | Our coverage |
| --- | --- | --- | --- |
| **CreepJS** | abrahamjuliot.github.io/creepjs | 180+ props, stack-trace lie detection, trig/float engine probes, WebGL software-renderer, headless traces | ✅ strong (0% headless/stealth) |
| **BrowserLeaks** | browserleaks.com/{javascript,canvas,webgl,webgpu,fonts,client-hints,features,css,rects,geo,ip,donottrack} | per-surface raw values; `/javascript` exposes `navigator.webdriver`; `/webgl` exposes SwiftShader/llvmpipe | ✅ mostly |
| **AmIUnique** | amiunique.org/fingerprint | uniqueness ratio vs global DB (too-unique = a tell) | ⚠️ not measured |
| **iphey** | iphey.com | Trustworthy/Suspicious/Disguised verdict; OS↔screen↔fonts↔canvas↔WebGL consistency | ✅ "Trustworthy" on residential (verify capture) |
| **Pixelscan** | pixelscan.net/bot-check | 73+ params, headless/automation traces, IP↔TZ↔geo↔fingerprint contradictions | ⚠️ verdict not captured cleanly |
| **BrowserScan** | browserscan.net | bot-detection verdict + per-surface "exception" (=farbling) flags | ✅ NoDetection |
| **deviceandbrowserinfo** | deviceandbrowserinfo.com | ground-truth real `webGLRenderer` lookup table; CDP tests | ⚠️ use as reference data |
| **CoverYourTracks (EFF)** | coveryourtracks.eff.org | tracking/uniqueness | ⚠️ not measured |
| **WebGPU Report** | webgpureport.org | WebGPU adapter coherence | ✅ vendor coherent |

---

## Tier 2 — Automation / headless detectors (medium–hard · public pages)

| Detector | URL | Tests | Our coverage |
| --- | --- | --- | --- |
| **sannysoft** | bot.sannysoft.com | webdriver, chrome obj, plugins, WebGL | ✅ passed |
| **areyouheadless** | arh.antoinevastel.com/bots/areyouheadless | headless Chrome tells | ✅ not headless |
| **rebrowser** | bot-detector.rebrowser.net | runtimeEnableLeak, navigatorWebdriver, pwInitScripts, viewport, bypassCsp, useragent, dummyFn, sourceUrlLeak | ✅ all green |
| **fpscanner / fp-collect** | github.com/antoinevastel/fpscanner | webdriver, Selenium `$cdc_`, CDP, Playwright markers, **cross-context (main vs iframe vs worker) consistency** | ⚠️ cross-context not tested |
| **FingerprintJS BotD** | github.com/fingerprintjs/BotD | free client-side automation/framework detection | ⚠️ not run |
| **bot.incolumitas.com** | bot.incolumitas.com | **behavioral** (mouse/timing) + fp; flaky | ❌ behavioral not covered |

---

## Tier 3 — Network / protocol fingerprinting (medium–hard)

| Tool | URL | Tests | Our coverage |
| --- | --- | --- | --- |
| TLS JA3/JA4 | browserleaks.com/tls · tls.peet.ws · tlsfingerprint.io · scrapfly TLS tool | ClientHello cipher/extension/curve order → JA3/JA4 | ✅ *should* be authentic (real Chrome) — **verify the proxy forwarder preserves Chrome's TLS** (CONNECT byte-passthrough, designed to) |
| HTTP/2 fingerprint | browserleaks.com/http2 | Akamai-format h2 frame/settings/priority fingerprint | ⚠️ verify matches real Chrome |
| QUIC / HTTP3 | browserleaks.com/quic | h3 fingerprint | ⚠️ not tested |
| TCP/IP stack | browserleaks.com/tcp | TTL/window/MTU OS fingerprint vs claimed OS | ❌ **leaks the Linux host OS** (TCP stack is the real kernel, not the Windows persona) — a real, hard-to-fix tell |

> **Key network finding:** because we drive **real Chrome**, JA3/JA4 + h2 should be
> genuinely Chrome (a big advantage over HTTP-client scrapers). But the **TCP/IP stack
> fingerprint is the real Linux kernel** — a Windows persona over a Linux TCP stack is a
> mismatch some enterprise vendors check. Mitigation is OS-level (proxy/NAT rewrites), not
> in-browser.

---

## Tier 4 — CAPTCHA / challenge systems (hard · mostly need behavior, not just fingerprint)

| System | Public test? | Signals | Notes |
| --- | --- | --- | --- |
| **reCAPTCHA v2** (checkbox/invisible) | ✅ google.com/recaptcha/api2/demo + recaptcha-demo.appspot.com | fingerprint + Google cookies + mouse + IP; escalates to image grid | **always-pass test keys** exist (`6LeIxAcT…`) for happy-path; point headless/datacenter at demo to force the grid |
| **reCAPTCHA v3** | ✅ recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php | score 0.0(bot)–1.0(human), threshold 0.5; behavioral+fp+IP | **scoring oracle** — measure our score; no always-pass key |
| **reCAPTCHA Enterprise** | ❌ needs your own GCP project | 11 score levels (4 without billing) + reason codes (AUTOMATION, etc.) | not testable vs a public Google endpoint |
| **Cloudflare Turnstile** | ✅ demo page | proof-of-work + behavioral + device | PoW is the differentiator |
| **hCaptcha / Enterprise** | ✅ demo | behavioral + fp risk score | |
| **Arkose Labs / FunCaptcha** | ✅ demo | interactive PoW + device + behavior | hardest interactive |
| **GeeTest / AWS WAF CAPTCHA / Friendly Captcha** | partial | behavioral / PoW | |

> **Reality:** CAPTCHAs are **behavioral + risk-score**, not fingerprint puzzles. Fingerprint
> coherence raises the score but cannot "pass" them alone — needs human-like behavior
> and/or a solver. **We have neither.**

---

## Tier 5 — Enterprise anti-bot vendors (HARDEST · need live protected targets)

Ranked by Scrapfly's 2026 bypass-success (lower % = harder):

| Vendor | Difficulty | Primary weighting | How to test (live targets / tools) |
| --- | --- | --- | --- |
| **Kasada** | 94% (hardest) | **proof-of-work + JS integrity** (anti-RE) | live PoW sites; no public demo |
| **PerimeterX / HUMAN** | 95% | **behavioral + 29k-site network** (flag-once → blocked-everywhere) | live retail/sneaker sites |
| **F5 / Shape Security** | 95% | client sensor + signal mesh | financial/airline sites |
| **Imperva ABP (Incapsula, ex-Distil)** | 96% | **Hi-Def fingerprint + Known Violators DB + `reese84` morphing JS + JA3/HTTP2 + datacenter-IP** | **Glassdoor, Zillow, Udemy, Wix, giffgaff**; cookies `incap_ses_/visid_incap_/nlbi_/reese84` |
| **DataDome** | 96% | **per-customer ML + behavior + IP** (model per site) | live e-comm; datadome.co bot test |
| **AWS WAF Bot Control** | 96% | rules + ML + IP reputation | AWS-fronted sites |
| **Akamai Bot Manager** | 97% | **`sensor.js` client telemetry + TLS at edge** | airline/retail/banking; `_abck`/`bm_sz` cookies |
| **Cloudflare Bot Management** | 98% | **TLS + global ML + Turnstile/managed-challenge** | huge footprint; "Just a moment…" interstitial |
| Radware / Netacea / Castle.io / Fingerprint Pro (Smart Signals) | — | behavioral / server-side fp | various |

**To identify which vendor protects a site:** Scrapfly **Antibot-Detector** (github.com/scrapfly/Antibot-Detector) + the cookie/interstitial signatures above.

> **Two network-effect vendors are uniquely dangerous to a fleet:** Imperva's
> **Known-Violators DB** (fingerprint-keyed) and HUMAN's **behavioral network** — a flag on
> *one* protected site blocks your identity across *all* of them. This makes
> **fresh-fingerprint-per-session + never-reuse-a-flagged-one** a hard requirement we don't
> yet enforce (we have per-account *stable* fps, but no rotate-on-flag).

---

## Tier 6 — IP / network reputation (parallel axis · gates every enterprise vendor)

| Tool | URL | What |
| --- | --- | --- |
| IPQualityScore | ipqualityscore.com | fraud score, proxy/VPN, device dup |
| Spur.us | spur.us | residential-proxy / anonymizer detection (very good at catching proxy pools) |
| IPinfo Privacy | ipinfo.io | VPN/proxy/hosting flags |
| MaxMind | minfraud / GeoIP2 anonymizer | proxy/anonymizer DB |
| Scamalytics | scamalytics.com | IP fraud score |

> Datacenter IP = high-risk pre-filter on **every** enterprise vendor. Residential (Oxylabs)
> is decent; **mobile-carrier IP is the top trust tier**. Spur.us specifically catches many
> residential-proxy pools — worth testing our exits against it.

---

## Tier 7 — Behavioral detection ❌ (NOT covered — biggest enterprise gap)

The hardest layer, because it's *continuous and live* — fixing TLS/fingerprint does nothing for
it. Used by reCAPTCHA, DataDome, HUMAN, Akamai, Kasada, Imperva, Arkose, F5/Shape.
**We have zero behavioral humanization** — the single biggest reason the browser isn't
"enterprise-ready" regardless of fingerprint quality.

What they measure (grounded):
- **Mouse:** event density (humans fire *hundreds* of `mousemove`/gesture; a teleporting bot
  fires ~4), bell-shaped velocity, **near-zero acceleration on straight segments = bot**,
  ballistic **overshoot+correction**, physiological **tremor** synthetic paths omit.
- **Keystroke:** dwell + flight times; programmatic fill with no keydown/keyup or zero flight = tell.
- **Scroll:** trackpad **inertial scroll decays geometrically** (`lethargy`) — a "MacBook"
  emitting uniform wheel steps is inconsistent.
- **Mobile:** **live accelerometer/gyro jitter** (real hand is never still; emulator = flat/zero).
- **Timing:** faster-than-human submit, fixed cadence; regularity itself is the tell.

Why naive humanization fails (don't waste effort):
- **Bézier cursors (Ghost Cursor) help only marginally** — too smooth (no tremor); ML scores the
  *distribution*, not one path.
- **Replaying a recorded human session is detectable** (ReMouse; Akamai detects telemetry replay).
- **Per-customer models** (DataDome runs **85k+**) defeat "tune once, run everywhere."
- Test surface: `bot.incolumitas.com` (0–1 score over 15s), HUMAN "Press & Hold", reCAPTCHA v3.
  **Building this is a separate workstream** (human-motion gen + CAPTCHA handling), not a patch.

---

## Tier 8 — Linkability / isolation / warming (partially covered)

| Surface | Risk | Our state |
| --- | --- | --- |
| Storage isolation: cookies, localStorage, IndexedDB, ServiceWorkers, CacheStorage, **HTTP cache, TLS session IDs, DNS** | cross-profile join keys (evercookie/supercookie respawn) | ⚠️ per-persona dir, **not verified at every layer** |
| **Cookie-age clustering** (Anti-Fraud CG) | a fleet with near-zero cookie-age = botnet pattern | ❌ |
| Account/email age | new identity = low trust | ❌ |
| Device graphs (Sumsub, Incognia, IPQS) | clusters accounts by shared device/IP/fp | ❌ |
| FingerprintJS **visitorId** persistence | survives incognito + data purge | ⚠️ per-account-stable fp helps, but server-side Smart Signals are harder |
| **Profile warming** (Cookie Robot) | cold profile is anomalous | ❌ not implemented |

---

## Tier 9 — Mobile emulation realism (CDP emulation = weaker tier)

Hardware tells JS **cannot** patch under desktop emulation: real-GPU renderer (Adreno/Mali
vs desktop ANGLE), **IMU sensor streams** (DeviceMotion/Orientation noisy gravity vector),
`maxTouchPoints`/`pointerType`, fractional DPR, **codec/MediaCapabilities** (HEVC level),
**UA-CH `Sec-CH-UA-Mobile`/`-Platform`** tri-way consistency (JS UA ↔ userAgentData ↔ HTTP
CH), and CPU-benchmark timing (runs on desktop silicon). **Real-device / mobile-proxy is a
strictly higher trust tier** — our Android personas are CDP emulation only.

---

## Coverage scorecard (today)

| Area | Status |
| --- | --- |
| Fingerprint surfaces (WebGL/canvas/audio/UA/fonts/UA-CH/caps) | ✅ strong |
| Headless/automation tells (webdriver/CDP/runtime/pw) | ✅ strong |
| TLS JA3/JA4 (real Chrome) | ✅ likely (verify forwarder) |
| HTTP/2 fingerprint | ⚠️ verify |
| **TCP/IP stack OS** | ❌ leaks Linux host |
| IP reputation | ⚠️ proxy-pool dependent (test vs Spur.us) |
| **Behavioral humanization** | ❌ none |
| **CAPTCHA solving** | ❌ none |
| **Known-violator resilience** (rotate-on-flag) | ❌ none |
| **Profile warming** | ❌ none |
| **Real mobile** (vs emulation) | ❌ emulation only |
| **Cross-profile storage isolation** | ⚠️ unverified |

---

## Build order for the suite

1. **Fix the harness first** — verdict capture (screenshot the verdict element + parse
   per-detector DOM + retry flaky pages). Without this the suite lies (see proxied-sweep:
   iphey/pixelscan/webrtc uncaptured).
2. **Tier 1–3 automated** (public pages) — run on every build as regression; assert raw
   verdicts, not the summary parser.
3. **Tier 4–5 scenario runs** (live targets) across the Tier-0 matrix; identify vendor via
   Antibot-Detector; record pass/challenge/block.
4. **Tier 6** — run our proxy exits through Spur.us/IPQS to grade the pool.
5. **Separate workstreams** (not fingerprint): behavioral humanization (Tier 7), warming
   (Tier 8), real-mobile (Tier 9) — these are where "enterprise-ready" actually lives.

> Honest framing: Tiers 1–3 we largely pass. Tiers 4–9 are mostly **untested and/or
> unbuilt** — and that's where the hardest detectors live. The suite's first job is to make
> that measurable, not to assume.

---

## Appendix A — Network acceptance gate (THE most actionable check for our browser)

Because we drive **real Chrome**, our JA3/JA4/peetprint + Akamai-HTTP/2 fingerprints are
*natively authentic* — a big edge over HTTP-client scrapers. But that authenticity can die at
the **proxy hop**, and the TCP/IP layer leaks the host OS regardless. Two concrete risks:

1. **TLS + HTTP/2 integrity** — only survives a **transparent `CONNECT` tunnel** (byte
   passthrough, which our `ProxyForwarder` is designed to be). A TLS-terminating/re-framing
   proxy makes the origin fingerprint *the proxy's* stack → "UA says Chrome, TLS says
   OpenSSL/Go" = instant tell.
   **Gate:** fetch `https://tls.peet.ws/api/all` **through the forwarder** and assert
   `ja3_hash` / `ja4` / `peetprint_hash` / `akamai_fingerprint(_hash)` **equal a native Chrome
   run without the proxy.** Cross-check `browserleaks.com/http2`. Chrome's current Akamai h2 =
   `1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p`.
2. **TCP/IP OS leak (unavoidable at app layer)** — the SYN comes from the **egress host
   kernel**, so a Windows/macOS persona behind a Linux egress shows TTL=64 + Linux TCP option
   order = mismatch (`browserleaks.com/ip`, `tcpip.incolumitas.com/classify`, p0f/zardaxt).
   **Mitigation:** make the persona's claimed OS **match the egress OS** (Linux personas on our
   Linux egress), or run egress on a kernel matching the persona. This is a real reason to keep
   **Linux personas** in the pool, not just cosmetic.

> Verified tools (2026): `tls.peet.ws/api/all` (live, all three layers), `browserleaks.com/{tls,http2,ip}`,
> `scrapfly.io/web-scraping-tools/{ja3,http2}-fingerprint` (+ JSON APIs, normalized digests good
> for CI). **Dead/excluded:** `ja3er.com` (503), `tlsfingerprint.io` (suspended).

## Appendix B — CAPTCHA test keys (deterministic, for the harness)

| System | Key | Effect |
| --- | --- | --- |
| Cloudflare Turnstile | sitekey `3x00000000000000000000FF` | **forces interactive challenge** (exercise solver path) |
| Cloudflare Turnstile | sitekey `1x00000000000000000000AA` / `2x…AB` | always-pass / always-fail |
| reCAPTCHA v2 | `6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI` (+secret `…GG-vFI1…`) | always-pass |
| reCAPTCHA v3 | public demo at `recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php` | **scoring oracle** (measure our score; threshold 0.5) |
| hCaptcha | sitekey `10000000-ffff-ffff-ffff-000000000001` | always-pass |
| Arkose/FunCaptcha | `demo.arkoselabs.com/?key=DF9C4D87-CB7B-4062-9FEB-BADB6ADA61E6` | live challenge |
| GeeTest v4 | `geetest.com/en/demo` (5 modes) | live slide/icon |

> reCAPTCHA Enterprise / hCaptcha Enterprise / AWS WAF CAPTCHA have **no public endpoint** —
> need your own project/WebACL. All CAPTCHAs are **behavioral/risk-score**, not fingerprint
> puzzles → fingerprint coherence raises the score but **can't pass alone** (Tier 7 gap).

## Appendix C — CDP / automation-leak nuances (we use nodriver, not Selenium/Playwright)

- **The classic `Runtime.enable` Error.stack-getter detection DIED on Chrome stable ~mid-2025**
  (two V8 commits guard user-defined getters during error preview). So a green
  `runtimeEnableLeak` ≠ undetectable — the **prototype-chain getter variant still fires**; test
  both. Also note that test **false-positives on a real user with DevTools open**.
- **Highest-yield check across CreepJS / incolumitas / deviceandbrowserinfo / fpscanner:**
  **cross-context consistency** (main window vs **iframe** vs **Web Worker** vs **Service
  Worker**). A main-context-only spoof fails these — verify our native patches apply in workers
  + iframes, not just the top document.
- **Framework artifacts to confirm we DON'T leak** (we use nodriver/CDP-direct, so these should
  be absent — but assert it): Selenium `document.$cdc_…`/`$wdc_`, Playwright `__pwInitScripts` /
  `__playwright__binding__`, Puppeteer `pptr:` sourceURL, `--enable-automation`, default
  viewports (800×600 / 1280×720), `navigator.webdriver` (must be false-but-present, not
  deleted — deleting it is itself a tell per rebrowser).

## Appendix D — Enterprise vendor live targets + key cookies (for Tier-5 scenario runs)

| Vendor | Confirm-it's-them (cookies/markers) | Live target sites |
| --- | --- | --- |
| Imperva/Incapsula | `incap_ses_*`, `visid_incap_*`, `nlbi_*`, `reese84`; "Request unsuccessful. Incapsula incident ID" | Glassdoor, Zillow, Udemy, Wix, giffgaff |
| HUMAN/PerimeterX | `_px3` (~60s expiry!), `_px2`, `_pxvid`, `_pxhd`, `X-PX-Authorization`; "Press & Hold" | Zillow, StockX, Fiverr, AutoZone, Walmart, Wayfair |
| Akamai Bot Manager | `_abck`, `bm_sz`, `ak_bmsc`; `sensor.js` | airline/retail/banking |
| Cloudflare | `cf_clearance`; "Just a moment…" / Turnstile | huge footprint |
| DataDome | `datadome` cookie; per-customer ML | e-commerce |

> Network-effect danger: Imperva (Known-Violators DB) + HUMAN (20T interactions/wk, ~3B
> devices) **share a flagged identity across all their protected sites** — argues for
> **fresh-fingerprint-per-session + never-reuse-a-flagged-one** (we have per-account *stable*
> fps but no rotate-on-flag). Vendor difficulty (hardest→): **Kasada > Cloudflare > Akamai >
> Imperva ≈ DataDome ≈ AWS WAF > PerimeterX ≈ F5**. All gate on **datacenter-IP reputation** as
> a fast pre-filter (Spur.us/IPQS catch many residential-proxy pools — test our exits).

> **Tooling to build the suite on:** `github.com/scrapfly/Antibot-Detector` (ID which WAF
> guards a site), `github.com/techinz/browsers-benchmark` (bypass-rate harness vs
> CF/DataDome/Kasada/Akamai/PX), `bot-detector.rebrowser.net` + `ttlns.github.io/brotector`
> (CDP/automation), self-hosted **zardaxt**/p0f on egress (TCP-OS truth).
