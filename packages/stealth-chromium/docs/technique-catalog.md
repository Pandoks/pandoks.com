# Stealth-repo technique mine — source-level catalog (Nov 2026)

From reading 13 stealth/anti-detect projects' source (patchright f14e043,
rebrowser-patches 1.1.3, rebrowser-bot-detector, brotector, CDP-Patches,
nodriver, undetected-chromedriver, Selenium-Driverless, browserforge,
DrissionPage, fingerprint-chromium's 18 C++ patches, CloakBrowser wrapper,
Camoufox) plus V8/Chromium source. This is the technique catalog for our
stack (real Chrome + C++ patches + patchright + raw CDP). The key strategic
finding: **the Runtime.enable arms race is now a C++ problem, not a driver
problem** — the V8 inspector's console-argument serializer is the only
page-visible side effect, and driver-level evasions all pay for avoiding it.

## The 8 priority items for OUR stack (ordered)

1. **C++: side-effect-free `Runtime.enable`.** fingerprint-chromium's
   `001-disable-runtime.enable.patch` makes `V8RuntimeAgentImpl::enabled()`
   return false and no-ops `messageAdded`/`addBindings` — but that breaks
   `exposeFunction` for future documents and kills console events. The
   narrower design: keep `enabled()` semantics, make
   `descriptionForError`/preview generation side-effect-free (skip inherited
   accessors; format stacks without invoking `prepareStackTrace`), leave
   `captureStackTrace` depth at 1 for console calls. Then the driver can use
   Runtime.enable and EVERY driver workaround above disappears (rebrowser's
   maintainer agrees — issue #93). **ENGINE PATCH for our tree.**
2. **Stop re-serving documents.** patchright's inject route re-serves every
   HTML document through `Fetch.fulfillRequest` once any init
   script/exposeFunction/clock/tracing is used — rebrowser-bot-detector's
   `documentInterception` test catches it (`nextHopProtocol===''` with
   `transferSize>0`). Our driver must never trigger `installInjectRoute`, and
   our harness must check `nextHopProtocol` non-empty.
3. **Launch-arg audit.** Drop `ThirdPartyStoragePartitioning` from
   `--disable-features` (patchright still passes it; rebrowser removed it at
   1.1.2 — the `storagePartitioning` aba-iframe test catches it), and audit
   the leftover Playwright switches (throttling, field-trial config, sandbox,
   sRGB, background networking). Keep
   `--disable-blink-features=AutomationControlled`.
4. **Driver patches patchright lacks:** no-op `markTargetElements`, rename
   `__playwright_global_listeners_check__`, drop `userGesture:true` from
   `Runtime.callFunctionOn` (page-visible userActivation flips), and prefer
   the utility world for `waitForFunction`.
5. **Input realism on Chrome ≥142** (the screenX/clientX leak is fixed
   upstream in M142 — CL 6917162; CDP-Patches archived for this reason):
   Fitts/Bézier trajectories with overshoot, wheel-notch scrolling with
   OS-realistic notches, paired keyDown/char/keyUp (never char-only or
   insertText), `buttons=0` on hover. Verify `getCoalescedEvents()` on our
   build. Our human.py middleware must emit realistic stream STRUCTURE (the
   content generative model is the hard part — recorded trajectories >
   synthetic).
6. **Persona in C++** (browserforge-derived): UA/UA-CH in all three code
   paths (`user_agent_utils.cc` + `client_hints.cc` +
   `frame_fetch_context.cc`), `platform`/`ActiveText` system colour
   (light-scheme ActiveText is `rgb(255,0,0)` on Linux but hotlight
   `rgb(0,102,204)` on Windows — the `platformMismatch` sub-check),
   `hardwareConcurrency`/`deviceMemory` (reaches workers and service
   workers — CDP `Emulation.setHardwareConcurrencyOverride` does NOT reach
   service workers, patchright #168), timezone (`--timezone` in
   `TimeZoneController`), WebGL as whole-device parameter TABLES (not just
   strings — `011`'s 2068-line per-device getParameter/precision tables) with
   16µs busy-wait on UNMASKED_* so timing matches a GPU-process round trip,
   real fonts (install the persona-OS fonts + FontCache allowlist — CloakBrowser:
   "fonts were the whole story", #471).
7. **Avoid noise-style spoofing**: no audio sample-rate noise
   (`ctx.sampleRate !== 44100` is trivially detectable), prefer no ClientRects
   constant offsets, prefer host-GPU-consistent personas over canvas noise
   (Camoufox and CloakBrowser both ship `--fingerprint-noise=false` options).
8. **Profile hygiene**: Widevine CDM registration on persistent profiles
   (FingerprintJS Pro classifies "nodriver" via storage-quota + Widevine EME
   check — hint file registers on 2nd launch), `profile.exit_type` reset,
   storage-quota sanity (Chrome = 60% of disk).

## The technique catalog (30 items, mechanisms verified)

See the source analysis for the full table (§2 of the agent transcript): the
items above cover the stack-impacting ones. Notable "don't copy" list:
undetected-chromedriver's cdc blanking (chromedriver-only), nodriver's
site-per-process disable (detectable) and red-dot `flash_point` DOM artifact,
DrissionPage's `--test-type` defaults, browserforge's utils.js Proxy injector
(author-deprecated), any `Function.prototype.toString` patching (rebrowser's
`nativeTampering` catches Proxies via the cyclic `__proto__` test).

## Detection surface (rebrowser-bot-detector = the reference)

20 tests: `runtimeEnableLeak`, `documentInterception`, `storagePartitioning`,
`popupBlocking`, `ipcFloodingProtection`, `navigatorWebdriver`,
`mainWorldExecution`, `pwInitScripts`, `exposeFunctionLeak`, `sourceUrlLeak`,
`cdpBindingGlobals`, `bypassCsp`, `viewport`, `useragent`, `mobileEmulation`,
`nativeTampering` (19 natives: toString regex, own prototype, Proxy cycle,
stack frames), `pageXScreenXLeak` (M142), `canvasMouseVisualizer`, `pdfStyle`.
brotector adds 12 (archived, pre-137). Neither tests mouse trajectory or
timing — those are vendor-layer (Akamai 2026: 63.2% of agentic requests have
zero mouse events, ROC-AUC 0.981).

## Sources

patchright https://github.com/Kaliiiiiiiiii-Vinyzu/patchright (issues
#30, #168, #238, #255) · rebrowser-patches
https://github.com/rebrowser/rebrowser-patches · rebrowser-bot-detector
https://github.com/rebrowser/rebrowser-bot-detector · brotector
https://github.com/ttlns/brotector · CDP-Patches
https://github.com/Kaliiiiiiiiii-Vinyzu/CDP-Patches · Chromium CL
https://chromium-review.googlesource.com/c/chromium/src/+/6917162 · V8
inspector https://github.com/v8/v8 (value-mirror.cc, v8-debugger.cc,
v8-inspector-impl.cc) · fingerprint-chromium
https://github.com/adryfish/fingerprint-chromium (branch 148.0.7778.215,
issues #55, #78, #88, #95, #105) · CloakBrowser https://github.com/CloakHQ/CloakBrowser
(issues #96, #320, #471, #541, #553) · Camoufox https://github.com/daijro/camoufox
· Cursory https://github.com/Vinyzu/cursory · rebrowser write-up
https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries-61740
· cloned repos left at /var/tmp/stealth-research/ for cite-checking (76 MB;
delete when done).
