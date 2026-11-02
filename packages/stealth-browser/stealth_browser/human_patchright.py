"""Human-like input driver for the patchright (Playwright) core.

Mirrors `stealth_browser.human.Human` (the nodriver variant) but dispatches
through Playwright's low-level mouse/keyboard primitives, which send the same
raw CDP Input.* events. Same motion model: eased Bezier paths with tremor and
overshoot, press-dwell clicks, variable wheel ticks, gaussian-timed typing.
"""

from __future__ import annotations

import asyncio
import json
import math
import random


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


class PatchrightHuman:
    """Human-like input driver for a patchright page.

    Holds the last known cursor position so motion is continuous across calls
    (a real cursor never jumps). Construct one per page and reuse it.
    """

    def __init__(self, page, *, viewport=(1512, 859)):
        self.page = page
        self.vw, self.vh = viewport
        # start the cursor somewhere plausible, not (0,0)
        self.x = random.uniform(self.vw * 0.3, self.vw * 0.6)
        self.y = random.uniform(self.vh * 0.3, self.vh * 0.6)

    # --- mouse motion ------------------------------------------------------
    async def move_to(self, x, y, *, duration=None):
        """Glide the cursor to (x, y) along an eased Bezier curve."""
        x, y = float(x), float(y)
        sx, sy = self.x, self.y
        dist = math.hypot(x - sx, y - sy)
        if dist < 1:
            return

        if duration is None:
            duration = min(1.4, 0.18 + dist / 1600) * random.uniform(0.8, 1.3)

        mx, my = (sx + x) / 2, (sy + y) / 2
        if dist > 0:
            px, py = -(y - sy) / dist, (x - sx) / dist
        else:
            px, py = 0, 0
        bow = random.uniform(-0.18, 0.18) * dist
        c1 = (sx + (mx - sx) * 0.4 + px * bow * random.uniform(0.4, 1.0),
              sy + (my - sy) * 0.4 + py * bow * random.uniform(0.4, 1.0))
        c2 = (x + (mx - x) * 0.4 + px * bow * random.uniform(0.4, 1.0),
              y + (my - y) * 0.4 + py * bow * random.uniform(0.4, 1.0))

        overshoot = dist > 220 and random.random() < 0.65
        end = (x + px * random.uniform(-6, 6) + random.uniform(-4, 4),
               y + py * random.uniform(-6, 6) + random.uniform(-4, 4)) \
            if overshoot else (x, y)

        steps = max(12, int(dist / 8))
        for i in range(1, steps + 1):
            t = _ease(i / steps)
            cx, cy = _bezier((sx, sy), c1, c2, end, t)
            cx += random.uniform(-0.6, 0.6)
            cy += random.uniform(-0.6, 0.6)
            await self.page.mouse.move(cx, cy)
            self.x, self.y = cx, cy
            await asyncio.sleep(duration / steps)

        if overshoot:
            await self.move_to(x, y, duration=random.uniform(0.06, 0.13))
        else:
            self.x, self.y = x, y

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
        await asyncio.sleep(random.uniform(0.04, 0.16))  # settle before press
        await self.page.mouse.down(button=button)
        await asyncio.sleep(random.uniform(0.05, 0.13))  # press dwell
        await self.page.mouse.up(button=button)
        await asyncio.sleep(random.uniform(0.05, 0.2))

    async def click(self, selector: str, *, button="left"):
        """Human-click the first element matching `selector`."""
        loc = self.page.locator(selector).first
        await loc.scroll_into_view_if_needed()
        await asyncio.sleep(random.uniform(0.15, 0.4))
        box = await loc.bounding_box()
        if box is None:
            await loc.click(button=button)
            return
        cx = box["x"] + box["width"] / 2 + random.uniform(-6, 6)
        cy = box["y"] + box["height"] / 2 + random.uniform(-4, 4)
        await self.click_xy(cx, cy, button=button)

    # --- scrolling ---------------------------------------------------------
    async def scroll(self, total, *, direction="down"):
        """Scroll `total` px in several variable wheel ticks with pauses."""
        sign = 1 if direction == "down" else -1
        remaining = abs(total)
        while remaining > 0:
            tick = min(remaining, random.uniform(90, 240))
            remaining -= tick
            await self.page.mouse.wheel(0, sign * tick)
            if random.random() < 0.2:
                await asyncio.sleep(random.uniform(0.6, 1.8))
            else:
                await asyncio.sleep(random.uniform(0.05, 0.22))

    # --- typing ------------------------------------------------------------
    async def type_text(self, text, *, wpm=None):
        """Type into the focused element with human inter-key timing."""
        wpm = wpm or random.uniform(45, 85)
        mean = 60.0 / (wpm * 5)
        for ch in text:
            await self.page.keyboard.type(ch, delay=random.uniform(8, 24))
            delay = random.gauss(mean, mean * 0.5)
            delay = max(0.02, delay)
            if ch == " ":
                delay += random.uniform(0.0, 0.12)
            if random.random() < 0.03:  # occasional thinking pause
                delay += random.uniform(0.3, 1.1)
            await asyncio.sleep(delay)

    async def type_into(self, selector: str, text, *, wpm=None):
        """Click an input element, then type into it like a human."""
        await self.click(selector)
        await asyncio.sleep(random.uniform(0.1, 0.35))
        await self.type_text(text, wpm=wpm)
        return await self.page.locator(selector).first.input_value()

    # --- idle behaviour ----------------------------------------------------
    async def dwell(self, lo=0.4, hi=2.5):
        """Pause as if reading, with a small chance of an idle cursor move."""
        await asyncio.sleep(random.uniform(lo, hi))
        if random.random() < 0.35:
            await self.wander(1)
