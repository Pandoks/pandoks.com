"""Human-like input: mouse motion, clicking, scrolling, typing.

Why this exists: a detector does not only fingerprint the *browser*, it also
watches *how it is driven*. Automation tells:
  * the cursor jumps in a straight line (or teleports) to a target
  * clicks land with zero approach and zero dwell
  * scrolling is one instant jump
  * typing has perfectly uniform inter-key timing

`Human` replaces all of that with motion a behavioural model accepts:
  * mouse paths follow a Bezier curve with eased (slow-fast-slow) speed and a
    little overshoot + correction, like a hand on a trackpad
  * a click is move -> settle -> press -> short hold -> release
  * scrolling is several variable wheel ticks with pauses, not one jump
  * typing has variable per-key delays, occasional longer "thinking" pauses

Everything is dispatched as raw CDP Input events (Input.dispatchMouseEvent /
dispatchKeyEvent) so there is no Playwright/automation layer in the path -- the
events are indistinguishable from a real device's at the protocol level. The
browser tracks the cursor position internally so consecutive moves are
continuous (a real cursor does not teleport between actions).
"""

from __future__ import annotations

import asyncio
import math
import random

from nodriver import cdp


def _bezier(p0, p1, p2, p3, t):
    """Cubic Bezier point at parameter t in [0, 1]."""
    u = 1 - t
    x = (u * u * u * p0[0] + 3 * u * u * t * p1[0]
         + 3 * u * t * t * p2[0] + t * t * t * p3[0])
    y = (u * u * u * p0[1] + 3 * u * u * t * p1[1]
         + 3 * u * t * t * p2[1] + t * t * t * p3[1])
    return x, y


def _ease(t):
    """Ease-in-out: real pointer motion accelerates then decelerates."""
    return 3 * t * t - 2 * t * t * t


class Human:
    """Human-like input driver for a nodriver Tab.

    Holds the last known cursor position so motion is continuous across calls
    (a real cursor never jumps). Construct one per tab and reuse it.
    """

    def __init__(self, tab, *, viewport=(1512, 859)):
        self.tab = tab
        self.vw, self.vh = viewport
        # start the cursor somewhere plausible, not (0,0)
        self.x = random.uniform(self.vw * 0.3, self.vw * 0.6)
        self.y = random.uniform(self.vh * 0.3, self.vh * 0.6)

    # --- low-level CDP dispatch -------------------------------------------
    async def _mouse(self, type_, x, y, *, button=None, buttons=0,
                     click_count=0):
        await self.tab.send(cdp.input_.dispatch_mouse_event(
            type_=type_, x=float(x), y=float(y),
            button=button, buttons=buttons,
            click_count=click_count or None,
            # a real trackpad reports a pointer type + a little force
            pointer_type="mouse",
        ))

    # --- mouse motion ------------------------------------------------------
    async def move_to(self, x, y, *, duration=None):
        """Glide the cursor to (x, y) along an eased Bezier curve.

        The path bows off the straight line by a random amount and the speed
        eases in/out -- the shape and velocity profile a hand produces. A
        slight overshoot + correction is added for longer moves.
        """
        x, y = float(x), float(y)
        sx, sy = self.x, self.y
        dist = math.hypot(x - sx, y - sy)
        if dist < 1:
            return

        # duration scales with distance (Fitts's-law-ish), with jitter
        if duration is None:
            duration = min(1.4, 0.18 + dist / 1600) * random.uniform(0.8, 1.3)

        # two control points pushed perpendicular to the path -> a gentle bow
        mx, my = (sx + x) / 2, (sy + y) / 2
        # perpendicular unit vector
        if dist > 0:
            px, py = -(y - sy) / dist, (x - sx) / dist
        else:
            px, py = 0, 0
        bow = random.uniform(-0.18, 0.18) * dist
        c1 = (sx + (mx - sx) * 0.4 + px * bow * random.uniform(0.4, 1.0),
              sy + (my - sy) * 0.4 + py * bow * random.uniform(0.4, 1.0))
        c2 = (x + (mx - x) * 0.4 + px * bow * random.uniform(0.4, 1.0),
              y + (my - y) * 0.4 + py * bow * random.uniform(0.4, 1.0))

        # overshoot target slightly on longer moves, then correct back
        overshoot = dist > 220 and random.random() < 0.65
        end = (x + px * random.uniform(-6, 6) + random.uniform(-4, 4),
               y + py * random.uniform(-6, 6) + random.uniform(-4, 4)) \
            if overshoot else (x, y)

        steps = max(12, int(dist / 8))
        for i in range(1, steps + 1):
            t = _ease(i / steps)
            cx, cy = _bezier((sx, sy), c1, c2, end, t)
            # tiny per-sample tremor
            cx += random.uniform(-0.6, 0.6)
            cy += random.uniform(-0.6, 0.6)
            await self._mouse("mouseMoved", cx, cy, buttons=0)
            self.x, self.y = cx, cy
            await asyncio.sleep(duration / steps)

        if overshoot:
            # small corrective move back onto the real target
            await self.move_to(x, y, duration=random.uniform(0.06, 0.13))
        else:
            self.x, self.y = x, y

    async def move_by(self, dx, dy):
        await self.move_to(self.x + dx, self.y + dy)

    async def wander(self, n=None):
        """A few idle cursor moves -- humans rarely hold the mouse still."""
        for _ in range(n or random.randint(1, 3)):
            await self.move_to(
                random.uniform(self.vw * 0.15, self.vw * 0.85),
                random.uniform(self.vh * 0.15, self.vh * 0.8))
            await asyncio.sleep(random.uniform(0.15, 0.6))

    # --- clicking ----------------------------------------------------------
    async def click_xy(self, x, y, *, button="left"):
        """Move to (x, y), settle, then press-hold-release like a finger."""
        await self.move_to(x, y)
        await asyncio.sleep(random.uniform(0.04, 0.16))   # settle before press
        btn = cdp.input_.MouseButton(button)
        await self._mouse("mousePressed", self.x, self.y,
                          button=btn, buttons=1, click_count=1)
        await asyncio.sleep(random.uniform(0.05, 0.13))   # press dwell
        await self._mouse("mouseReleased", self.x, self.y,
                          button=btn, buttons=0, click_count=1)
        await asyncio.sleep(random.uniform(0.05, 0.2))

    async def click(self, element, *, button="left"):
        """Human-click a nodriver Element: scroll it in, aim, click its centre."""
        try:
            await element.scroll_into_view()
        except Exception:  # noqa: BLE001
            pass
        await asyncio.sleep(random.uniform(0.15, 0.4))
        box = await self._center_of(element)
        if box is None:
            # fall back to nodriver's own click if geometry is unavailable
            await element.mouse_click(button=button)
            return
        cx, cy = box
        # aim for a random point near the centre, not the exact pixel
        cx += random.uniform(-6, 6)
        cy += random.uniform(-4, 4)
        await self.click_xy(cx, cy, button=button)

    async def _center_of(self, element):
        """Viewport-relative centre (x, y) of an element, or None."""
        try:
            r = await element.apply(
                "(el) => { const b = el.getBoundingClientRect();"
                " return JSON.stringify("
                "  {x: b.x + b.width/2, y: b.y + b.height/2,"
                "   w: b.width, h: b.height}); }")
            import json
            box = json.loads(r if isinstance(r, str) else getattr(
                getattr(r, "deep_serialized_value", None), "value", "{}"))
            if box.get("w", 0) <= 0:
                return None
            return box["x"], box["y"]
        except Exception:  # noqa: BLE001
            return None

    # --- scrolling ---------------------------------------------------------
    async def scroll(self, total, *, direction="down"):
        """Scroll `total` px in several variable wheel ticks with pauses.

        A real wheel/trackpad emits many small deltas; one giant jump is a
        tell. Tick sizes and pauses vary, with an occasional reading pause.
        """
        sign = 1 if direction == "down" else -1
        remaining = abs(total)
        while remaining > 0:
            tick = min(remaining, random.uniform(90, 240))
            remaining -= tick
            await self.tab.send(cdp.input_.dispatch_mouse_event(
                type_="mouseWheel", x=float(self.x), y=float(self.y),
                delta_x=0.0, delta_y=float(sign * tick), pointer_type="mouse",
            ))
            # short pause between ticks; sometimes a longer "reading" pause
            if random.random() < 0.2:
                await asyncio.sleep(random.uniform(0.6, 1.8))
            else:
                await asyncio.sleep(random.uniform(0.05, 0.22))

    async def read_scroll(self, *, screens=2.0):
        """Scroll down ~`screens` viewport-heights as if reading a page."""
        await self.scroll(int(self.vh * screens), direction="down")

    # --- typing ------------------------------------------------------------
    async def type_text(self, text, *, wpm=None):
        """Type into the focused element with human inter-key timing.

        Per-key delay varies; spaces and punctuation get slightly longer
        pauses; occasionally a longer "thinking" pause between words.
        """
        # words-per-minute -> mean seconds per character
        wpm = wpm or random.uniform(45, 85)
        mean = 60.0 / (wpm * 5)
        for ch in text:
            await self.tab.send(cdp.input_.dispatch_key_event(
                type_="keyDown", text=ch, key=ch))
            await asyncio.sleep(random.uniform(0.012, 0.03))
            await self.tab.send(cdp.input_.dispatch_key_event(
                type_="keyUp", text=ch, key=ch))
            delay = random.gauss(mean, mean * 0.5)
            delay = max(0.02, delay)
            if ch == " ":
                delay += random.uniform(0.0, 0.12)
            if random.random() < 0.03:           # occasional thinking pause
                delay += random.uniform(0.3, 1.1)
            await asyncio.sleep(delay)

    async def type_into(self, element, text, *, wpm=None):
        """Click an input element, then type into it like a human."""
        await self.click(element)
        await asyncio.sleep(random.uniform(0.1, 0.35))
        await self.type_text(text, wpm=wpm)

    # --- idle behaviour ----------------------------------------------------
    async def dwell(self, lo=0.4, hi=2.5):
        """Pause as if reading, with a small chance of an idle cursor move."""
        await asyncio.sleep(random.uniform(lo, hi))
        if random.random() < 0.35:
            await self.wander(1)
