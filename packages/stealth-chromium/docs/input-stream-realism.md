# Input-stream realism research (measured, 2026-11-04)

Measured against Chrome for Testing 157.0.8103.38. Finding: **CDP input is
structurally fingerprintable** — the detectors (arXiv 2607.26935, Cloudflare
Precursor) catch the stream STRUCTURE, not just trajectory shape.

## Measured CDP structural tells (all verified by probe)

| Property | CDP behavior | Real behavior |
|---|---|---|
| `getCoalescedEvents().length` | always 1 on awaited dispatch (60 Hz ack cap); ≤2 on 1 ms bursts; up to 11 with explicit timestamps | real 125-1000 Hz mouse = 2-16 coalesced per 60 Hz frame |
| `pointerdown.pressure` | 0 (CDP sets force=0; Blink returns 0.5 only when force is NaN) | 0.5 for pressed button |
| `wheelDeltaY` vs `deltaY` | always ±120 regardless of deltaY (kScrollByPrecisePixel) | platform-notched: Win 100px=120, X11 120px, mac 40px |
| scroll on wheel | instant jump (precise pixels don't animate) | animated, momentum |
| `synthesizeScrollGesture` | fractional deltas 6.3-20.8 = trackpad-shaped, not notched wheel | notched wheel bursts |
| click hold 0 ms | mousedown→mouseup 1.2 ms | human N(110,30) ms |
| backdating | explicit timestamps surface in coalesced list but `now − timeStamp` = 181-436 ms (visible) | ≤ frame latency |

Screen-coordinate leak (pageX==screenX) is FIXED in Chromium 142 (CL 6917162)
— verified: `screen_eq_client: false` on 157.

## The fix architecture (3 layers)

**Layer 0 — transport (structure):**
- Linux: XTest (CDP-Patches `linux.py` pattern; drop its fixed 10ms key hold);
  Windows: `SendInput` (not PostMessage — skips raw input); macOS: Quartz
  CGEventPost. Headless fallback: non-awaited CDP bursts with explicit
  timestamps ≤1 frame in the past, `force: 0.5` while a button is down, wheel
  ONLY in whole platform notches.
- Never use `element.click()`, `scrollIntoView()`, `focus()`,
  `synthesizeScrollGesture` (each leaves a signature gap).

**Layer 1 — content:**
- Mouse shape/timing: port Cursory (2,356 real recordings; select top-5 by
  direction+length, morph, AR(1) lateral jitter ≤1%, 5 center-biased knots,
  recorded interval sequence time-warped) + synthesize inner 125/1000Hz
  samples from CaptchaSolve30k (30k sessions, 1kHz raw stream) tremor
  residuals.
- Inter-stroke planner: CloakBrowser's model (Fitts' law `160+75·log2(1+d/8)ms`
  log-normal σ0.3; 35% miss + corrective stroke; aim 60-200ms; hold N(110,30)
  clipped; idle drift 3px/300-1000ms).
- Keyboard: CloakBrowser `_Typist` retuned to Aalto 136M-keystroke stats
  (hold 116.2ms SD 23.9; IKI 238.7ms SD 111.6; rollover 25%; typos+Backspace
  4%; Shift lead/release offsets).
- Scroll: platform-notched wheel bursts (2-5 notches 30-80ms apart, 80-200ms
  between bursts, 10% overshoot), cursor over the scroller first.
- Persona pinning: one platform/notch size/polling rate/typist cluster per
  session — Precursor accumulates across pages.

**Layer 2 — verification (the gates):**
1. Structural: coalesced-length histogram (reject 100%-ones under a 125Hz
   persona), pressure=0.5 on pointerdown, wheelDelta/deltaY consistency,
   >1 scroll event per wheel under notch personas, `now − timeStamp` ≤ 20ms,
   `isTrusted` all true.
2. Behavioral (arXiv 2607.26935 five features): mouse_event_rate in N(15,7)±1σ
   by session, teleport_click_ratio 0.02-0.10, click_duration mean 90-130ms
   σ≥20ms, typing_speed_std ≥40ms, scroll_speed_variance >0.
3. Train the paper's GBM on CaptchaSolve30k humans vs our output; require
   recall-as-agent < 5%.

## Sources

Cursory (github.com/Vinyzu/cursory) · Camoufox juggler input (daijro/camoufox)
· CDP-Patches input (Kaliiiiiiiiii-Vinyzu/CDP-Patches) · CloakBrowser human/
{mouse,engine,keyboard,config}.py (CloakHQ/CloakBrowser) · ghost-cursor ·
Chromium: input_handler.cc, main_thread_event_queue.cc, web_mouse_event.cc,
pointer_event_factory.cc, wheel_event.cc, cc/input/input_handler.cc ·
arXiv 2607.26935 (two-feature detector), 2005.00890 (BeCAPTCHA-Mouse),
2410.18233 (DMTG), 2510.02374 (weak) · Aalto 136M keystrokes (CHI 2018) ·
CaptchaSolve30k (Capycap-AI/HF) · Cloudflare Precursor (2026-07-13).
Probe script left at /var/tmp/inputgen-research/ (48 KB).
