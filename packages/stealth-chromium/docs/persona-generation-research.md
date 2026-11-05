# Persona-generation research: browserforge / Apify fingerprint-suite (2026-11-04)

Findings from reading browserforge v1.2.4 source + Apify's upstream
fingerprint-suite. Verdict for our stack: the NETWORKS are portable; the
Python port's sampler and the JS injector are not. If we adopt persona
generation from real distributions, adopt the model data with fixes below —
do not use the injector layer (JS Proxy, same class as puppeteer-stealth,
which our gap research shows is deterministically caught).

## Data provenance (verified)

- Networks are prebuilt Bayesian networks from `apify_fingerprint_datapoints`
  (unpinned dep), rebuilt monthly from the newest 30,000 records of a private
  Apify dataset via a workflow that opens a PR (human merge gate).
- 0.14.0 (2026-08-01) shipped a REGRESSED model (newest Chrome 143 vs world
  at 150); 0.15.0 (2026-08-05) reverted. No PyPI release since.
- Header order data collected separately from Playwright against echo servers.

## Data quality problems (computed from the shipped tables)

- **Skewed population**: desktop 90.4%, mobile 9.6%; Windows 65.6% of desktop,
  macOS 31.8%, Linux 2.5%; mobile iOS 75.7%. Looks like developer-site
  visitors, not global traffic.
- **Brave contamination**: 12.8% of Mac Chrome-147 `pluginsData` has random
  plugin names; `"Brave";v="147"` sec-ch-ua values; `globalPrivacyControl: true`
  (13.9%) — GPC is itself a Brave marker; personas carrying it are rare but
  also *branded*.
- **VM renderers**: Basic Render/SwiftShader/llvmpipe = 4.3% of Windows
  Chrome-147 videoCard values.
- **Stale**: Chrome 147 = 66.6% of UA mass, newest 149 at 0.1% — about 6
  majors behind at collection time. Staleness is itself a rarity signal.
- **Artifacts**: `innerWidth/innerHeight` = 0 in 100% of Windows Chrome
  screens (collected in a hidden iframe); battery `chargingTime` = null in
  100% (real browsers report Infinity); `platform` `Linux x86_64` on 0.2% of
  Mac Chrome UAs.

## Engine problems (verified against upstream)

- The fingerprint network is a naive-Bayes STAR: every field conditioned only
  on `userAgent`. So GPU, cores, screen, fonts are independent given the UA:
  ~19% of Mac Chrome-147 personas pair an architecture with a GPU family Macs
  essentially never combine; ~15% pair Apple-Silicon GPUs with <8 cores.
- Header brands (`sec-ch-ua`) and JS brands (`userAgentData.brands`) are
  sampled SEPARATELY from identical tables — they mismatch ~20% of the time.
- **The Python port's restricted sampler does not renormalize** (upstream
  scales the anchor by the valid mass). Narrow constraints hand 93-99.7% of
  samples to ONE value (e.g., Screen(max_width=1280) → 1280x720@1.5 at 92.8%
  vs 41.7% in the data).
- Port bugs: `'os'` vs `'operatingSystems'` key (OS never relaxed), Sec-Fetch
  values mis-ported (site=?1, mode=same-site), Accept-Language formatted as
  `en-US;q=1.0, en;q=0.9` (real browsers: `en-US,en;q=0.9`), `languages`
  values get leading spaces, headers not in the order list are dropped,
  Edge gets Chrome's order, `strict` not forwarded to the header generator.

## The injector (why we should not use it)

utils.js overrides via prototype-getter Proxies + toString redirection — the
same JS-Proxy pattern our gap research shows CreepJS catches deterministically
(cycle lies, stack frames). Worse: `fonts`, `pluginsData`, `multimediaDevices`
are GENERATED but NEVER INJECTED; headless fixes are gated on `/headless/i` in
the UA (dead for persona UAs); `Intl.DateTimeFormat !== Intl.DateTimeFormat`
(new Proxy per property access); `SharedArrayBuffer` set to undefined.
No canvas/audio/timezone/font hooks exist anywhere in utils.js.
No tests in the repo; upstream's compat test calls generate() 10k times with
no assertions (crash smoke test only).

## What to adopt for our stack

1. **Port the network data (not the code as-is)** into a persona sampler with
   upstream's renormalized sampling (or fix `bayesian_network.py:46-53`).
2. **Add cross-field rejection rules**: architecture vs GPU family, cores vs
   GPU and memory, header brands == JS brands (single persona record driving
   BOTH the C++ UA-metadata surface and the header set — gap #4 in
   detection-gaps.md).
3. **Filter the data**: drop Brave-contaminated and VM-renderer records,
   remap stale Chrome majors to the current release, drop GPC markers.
4. **Derive fields from real C++ surfaces** (the mapping for our patches):
   UA/userAgentData → `blink::UserAgentMetadata` (include wow64/formFactors);
   platform → `NavigatorBase::platform()`; languages →
   `RendererPreferences::accept_languages`; hardwareConcurrency →
   `NavigatorConcurrentHardware` (covers workers); deviceMemory →
   `ApproximatedDeviceMemory`; screen/DPR/HDR → `display::ScreenInfo`;
   videoCard → `WebGLRenderingContextBase::getParameter` (0x9245/0x9246) +
   `gpu::GPUInfo` for WebGPU; codecs → `media::MimeUtil` (needs
   `proprietary_codecs=true`); plugins/pdfViewerEnabled → `DOMPluginArray`;
   battery → `BatteryMonitor` (null→Infinity); mediaDevices →
   `MediaDevicesManager`; fonts → `FontCache` allowlist + real fonts; DNT/GPC
   → `RendererPreferences`; timezone → `--tz` matched to proxy exit country;
   color scheme → `preferred_color_scheme` (sampled, not always dark).
5. **Match GPU to the host**: personas must use the real GPU family —
   string spoofing without parameter coherence is gap #7.
6. **Rules**: fix Sec-Fetch values, Accept-Language format, languages
   trimming, relaxation keys if we port any of the Python side.

Source: browserforge clone at `/var/tmp/stealth-research/daijro_browserforge`
(commit a38c328), upstream apify/fingerprint-suite master + PyPI (fetched
2026-11-04). Numbers computed from the shipped probability tables; code not
executed. Nothing written to our working tree except this file.
