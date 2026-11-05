# Patchright driver analysis — leaks we inherit and required driver patches

Patchright v2 (HEAD f14e043, 2026-11-02) is our driver layer (APEX_CORE=patchright).
This is the source-level map of what it does, what it leaks, and what our stack
must patch on top of it.

## What we inherit FOR FREE (verified in source)

- **No `Runtime.enable`** on any session (main, worker, service worker,
  devtools) — the classic CDP console-serialization tell is gone. Upstream's
  only remaining Runtime.enable is Android-WebView-gated.
- **Lazy context discovery** instead of context lifecycle events.
- **Isolated-world evaluation by default** (`isolated_context=true`), so page
  JS can't tamper with evaluation globals.
- **No `sourceURL` comments** — no file paths in stacks.
- **`navigator.webdriver=false` via `--disable-blink-features=AutomationControlled`**.
- Playwright's `__playwright__*` globals and bindings renamed/removed.
- Closed-shadow-root support (via DOM agent with pierce).
- `Network.setCacheDisabled` no longer blanket-on (only with real interceptors).

## Leaks that REMAIN (our driver must patch these)

| # | Leak | Mechanism | Fix for our stack |
|---|---|---|---|
| 1 | **`__playwright_mark_target__` / `__playwright_reset_targets__` CustomEvents** on `document`, bubbles+composed — cross-world visible to any main-world listener; dispatched by every locator action/waitForSelector | injected script `markTargetElements` | Patch `markTargetElements` to a no-op in our driver, or never resolve through it. VERIFY in the loop: `document.addEventListener('__playwright_mark_target__', h, true)` |
| 2 | **`__playwright_global_listeners_check__`** MutationObserver event on window (documentElement replacement) | injected script, unpatched upstream | Remove/rename in driver |
| 3 | **`userGesture:true` on EVERY `Runtime.callFunctionOn`** — grants user activation with no real input; `navigator.userActivation.isActive` flips without pointerdown/keydown | driver eval path | Drop `userGesture:true` in our driver patch; or drive OS-level input for actions |
| 4 | **Main-world `waitForFunction`** — runs `globalThis.eval` in the main world | default `world='main'` | Use main-world sparingly; page sees eval source |
| 5 | **Document re-fulfillment when init scripts/exposeFunction/clock/tracing used** — every HTML request is buffered and re-served via Fetch; Navigation Timing artifacts (`responseStart≈responseEnd`, possible `nextHopProtocol` changes) | client `install_inject_route` | Prefer C++ fingerprint changes over init scripts; avoid triggering the route, or strip it from the client |
| 6 | **Main-world init-script artifacts** — binding wrappers are non-native arrows with own props (`callbacks`/`lastSeq`/`handles`); `__pwClock`, `__pwWebAuthn*` globals; non-native `ServiceWorkerContainer.register` | driver | Only use bindings if needed; the wrapper is non-native |
| 7 | **DOM-agent load/timing** — `DOM.getDocument` on every load + full-tree `describeNode(pierce)` per selector; `Runtime.queryObjects` heap scans (GC observable via WeakRef) | selector resolution | Acceptable cost; keep selector counts low |
| 8 | **`Runtime.enable` discipline** — if ANY of our raw CDP sessions enables Runtime/Console/Debugger, console serialization returns and the stack-getter tell comes back | driver layer | Never send those in our raw sessions; use `Page.createIsolatedWorld` (innocuous name) / `Runtime.evaluate("globalThis", idOnly)` for contexts |
| 9 | **Input realism** — patchright does NOT patch input: mouse jumps to targets, `fill` uses `Input.insertText` (no key events); CDP screenX/clientX equality is a known tell (fixed in Chromium 142+, but our driver should drive OS-level input for real actions) | README + CDP-Patches | Our human.py middleware already drives human-shaped input — VERIFY it's OS-level or CDP-with-chromium-142-fix, not dispatch-with-flags |

## Verification additions for the adversarial harness

- Probe: `document.addEventListener('__playwright_mark_target__', h, true)` and
  `__playwright_global_listeners_check__` on window — must never fire.
- Probe: `navigator.userActivation.hasBeenActive/isActive` before/after an
  evaluate — must not flip without real input.
- Probe: no `__pw*`/`__playwright*` in `Object.getOwnPropertyNames(globalThis)`.
- Probe: `performance.getEntriesByType('navigation')[0].nextHopProtocol` — must
  be non-empty and match a real fetch when the driver is attached.
- Probe: stack traces of page-raised errors must contain no
  `eval at <anonymous>` / `pptr:` frames.

## Portability notes (raw CDP + C++ patches)

- We get patchright's anti-detection for free by USING patchright as the
  driver — but only the parts above; the leaks require OUR driver patches.
- C++ alternative that would make `Runtime.enable` harmless entirely: make V8
  inspector error descriptions not call JS `stack` accessors (then
  `prepareStackTrace`/`name` re-reads also die) — candidate engine patch.
- Launch-flag hygiene: if we launch Chrome ourselves (not via patchright
  launch), pass `--disable-blink-features=AutomationControlled` ourselves and
  DROP the Playwright default switches patchright keeps (throttling,
  field-trial config, sandbox, `force-color-profile=srgb`, background
  networking, infobars) — see the switch list in the source analysis.

Source: patchright clone `/var/tmp/stealth-research/Kaliiiiiiiiii-Vinyzu_patchright`
(f14e043) + patchright-python patcher; upstream playwright main fetched
2026-11-04. All [V] = read in source; impact assessments marked [I]. Nothing
executed; our working tree unchanged except this file.
