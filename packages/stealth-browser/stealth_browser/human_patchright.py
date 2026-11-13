"""Human-like input driver for the patchright (Playwright) core.

Ports the synthetic-human generator's motion models (behavior-capture
humanizer): minimum-jerk (Flash & Hogan quintic) pointer paths with a
distance-adaptive duration, small perpendicular bow, per-sample micro-jitter
and overshoot + corrective return on long moves; press-hold-release clicks
with a settle dwell; wheel ticks whose delta size decays across the gesture
with reading pauses; typing with an explicit keydown/dwell/keyup/flight
sequence (hold time under our control, unlike keyboard.type) and occasional
backspace corrections.

Each session draws ONE randomized parameter regime (typist wpm cluster, move
speed factor, click timing ranges, scroll notch/decay/pause profile, typo
rate, tremor scale) from the session seed and holds it for the whole session:
between-session distributions differ, within-session they are stable. The
same seed reproduces the same behavior.
"""

from __future__ import annotations

import asyncio
import math
import random


def _min_jerk(t: float) -> float:
    """Flash & Hogan minimum-jerk scalar profile, s(t) in [0, 1]."""
    return 10 * t**3 - 15 * t**4 + 6 * t**5


def _draw_regime(rng: random.Random) -> dict:
    """One parameter regime per session -- the humanization persona."""
    return {
        # typist cluster: flight mean = 60/(wpm*5) seconds per char
        "wpm": rng.uniform(42, 78),
        "flight_sigma": rng.uniform(0.40, 0.55),
        "dwell": (rng.uniform(0.045, 0.060), rng.uniform(0.120, 0.135)),
        "typo_rate": rng.uniform(0.025, 0.035),
        # pointer persona
        "move_speed": rng.uniform(0.85, 1.25),
        "bow_scale": rng.uniform(0.08, 0.16),
        "overshoot_rate": rng.uniform(0.50, 0.70),
        "jitter": rng.uniform(0.4, 0.65),
        # click timing (seconds); hold is log-normal around a per-session
        # median -- within-session sigma must clear the 20ms gate
        # (docs/input-stream-realism.md Layer 2: click_duration mean 90-130ms
        # sigma>=20ms) and a narrow uniform cannot (sigma ~4-14ms)
        "settle": (rng.uniform(0.045, 0.065), rng.uniform(0.140, 0.170)),
        "hold": (rng.uniform(0.100, 0.110), rng.uniform(0.27, 0.33)),
        "release": (rng.uniform(0.050, 0.080), rng.uniform(0.150, 0.180)),
        # pointer event rate (events/s) -- the doc's gate is
        # mouse_event_rate in N(15,7) by session; emit inside its +-1sigma
        "move_rate": rng.uniform(12.0, 21.0),
        # scroll persona
        "wheel_base": (rng.uniform(75, 95), rng.uniform(225, 255)),
        "wheel_decay": rng.uniform(0.40, 0.60),
        "pause_prob": rng.uniform(0.18, 0.26),
    }


class PatchrightHuman:
    """Human-like input driver for a patchright page.

    Holds the last known cursor position so motion is continuous across calls
    (a real cursor never jumps). Construct one per page and reuse it.
    """

    def __init__(self, page, *, viewport=(1512, 859), session_seed=None):
        self.page = page
        self.vw, self.vh = viewport
        self.seed = session_seed if session_seed is not None \
            else random.getrandbits(64)
        self.rng = random.Random(self.seed)
        self.regime = _draw_regime(self.rng)
        # start the cursor somewhere plausible, not (0,0) -- varies per session
        self.x = self.rng.uniform(self.vw * 0.3, self.vw * 0.6)
        self.y = self.rng.uniform(self.vh * 0.3, self.vh * 0.6)

    # --- mouse motion ------------------------------------------------------
    async def _sync_viewport(self):
        """Read the live window size so clamping matches the real screen."""
        try:
            size = await self.page.evaluate(
                "({w: window.innerWidth, h: window.innerHeight})")
        except Exception:
            return
        if isinstance(size, dict) and size.get("w") and size.get("h"):
            self.vw, self.vh = int(size["w"]), int(size["h"])

    def _clamp(self, x, y):
        """Keep every dispatched coordinate inside the viewport (+2px margin)."""
        m = 2
        return (min(max(x, m), self.vw - 1 - m),
                min(max(y, m), self.vh - 1 - m))

    async def move_to(self, x, y, *, duration=None):
        """Glide the cursor to (x, y) on a min-jerk path (bell velocity)."""
        x, y = float(x), float(y)
        await self._sync_viewport()
        x, y = self._clamp(x, y)
        sx, sy = self.x, self.y
        dist = math.hypot(x - sx, y - sy)
        if dist < 1:
            return

        if duration is None:
            duration = min(1.3, 0.15 + dist / 1700) \
                * self.rng.uniform(0.85, 1.25) * self.regime["move_speed"]

        # small perpendicular bow: no straight-line teleports
        ux, uy = (x - sx) / dist, (y - sy) / dist
        bow = self.regime["bow_scale"] * dist \
            * (1 if self.rng.random() < 0.5 else -1)
        j = self.regime["jitter"]
        # emit at the per-session event rate: points, not per-frame spam
        steps = max(2, round(duration * self.regime["move_rate"]))
        for i in range(1, steps + 1):
            t = i / steps
            s = _min_jerk(t)
            off = bow * math.sin(math.pi * t)
            cx = sx + (x - sx) * s - uy * off + self.rng.uniform(-j, j)
            cy = sy + (y - sy) * s + ux * off + self.rng.uniform(-j, j)
            cx, cy = self._clamp(cx, cy)
            await self.page.mouse.move(cx, cy)
            self.x, self.y = cx, cy
            await asyncio.sleep(duration / steps)

        # overshoot slightly on long moves, then correct back
        if dist > 240 and self.rng.random() < self.regime["overshoot_rate"]:
            ox = x + ux * self.rng.uniform(4, 11) + self.rng.uniform(-3, 3)
            oy = y + uy * self.rng.uniform(4, 11) + self.rng.uniform(-3, 3)
            await self.move_to(ox, oy, duration=self.rng.uniform(0.05, 0.10))
            await self.move_to(x, y, duration=self.rng.uniform(0.07, 0.16))
        else:
            self.x, self.y = x, y

    async def wander(self, n=None):
        """A few idle cursor moves -- humans rarely hold the mouse still."""
        for _ in range(n or self.rng.randint(1, 3)):
            await self.move_to(
                self.rng.uniform(self.vw * 0.15, self.vw * 0.85),
                self.rng.uniform(self.vh * 0.15, self.vh * 0.8))
            await asyncio.sleep(self.rng.uniform(0.15, 0.6))

    # --- clicking ----------------------------------------------------------
    async def _hold(self):
        """Log-normal press hold around the per-session median."""
        median, sigma = self.regime["hold"]
        hold = median * math.exp(self.rng.gauss(0.0, sigma))
        return min(max(hold, 0.030), 0.250)

    async def click_xy(self, x, y, *, button="left"):
        """Move to (x, y), settle, then press-hold-release like a finger."""
        await self.move_to(x, y)
        await asyncio.sleep(self.rng.uniform(*self.regime["settle"]))
        await self.page.mouse.down(button=button)
        await asyncio.sleep(await self._hold())
        await self.page.mouse.up(button=button)
        await asyncio.sleep(self.rng.uniform(*self.regime["release"]))

    async def click_at(self, x, y, *, button="left"):
        """Human-click at viewport coordinates (e.g. inside an iframe box)."""
        await self.click_xy(x, y, button=button)

    async def click(self, selector: str, *, button="left"):
        """Human-click the first element matching `selector`."""
        loc = self.page.locator(selector).first
        await loc.scroll_into_view_if_needed()
        await asyncio.sleep(self.rng.uniform(0.15, 0.4))
        box = await loc.bounding_box()
        if box is None:
            await loc.click(button=button)
            return
        cx = box["x"] + box["width"] / 2 + self.rng.uniform(-6, 6)
        cy = box["y"] + box["height"] / 2 + self.rng.uniform(-4, 4)
        await self.click_xy(cx, cy, button=button)

    # --- scrolling ---------------------------------------------------------
    async def scroll(self, total, *, direction="down"):
        """Scroll `total` px as wheel ticks whose delta size DECAYS to zero."""
        sign = 1 if direction == "down" else -1
        remaining = float(abs(total))
        total = float(abs(total)) or 1.0
        while remaining > 0:
            # deceleration: ticks shrink as the gesture winds down
            consumed = 1.0 - remaining / total
            base = self.rng.uniform(*self.regime["wheel_base"])
            tick = min(remaining, base * (1.0 - self.regime["wheel_decay"]
                                          * consumed))
            remaining -= tick
            await self.page.mouse.wheel(0, sign * tick)
            if remaining <= 0:
                await asyncio.sleep(self.rng.uniform(0.12, 0.30))
            elif self.rng.random() < self.regime["pause_prob"]:
                await asyncio.sleep(self.rng.uniform(0.5, 1.6))
            else:
                await asyncio.sleep(self.rng.uniform(0.04, 0.20))

    # --- typing ------------------------------------------------------------
    async def _type_char(self, ch):
        """One keypress: keydown -> variable hold -> keyup."""
        await self.page.keyboard.down(ch)
        await asyncio.sleep(self.rng.uniform(*self.regime["dwell"]))
        await self.page.keyboard.up(ch)

    async def type_text(self, text, *, wpm=None, correct=True):
        """Type with human dwell (hold) + flight (inter-key gap) timing.

        The backspace correction assumes the field started empty; pass
        `correct=False` for streams typing into a field with existing content
        (Backspace would otherwise eat a pre-existing char, not the typo).
        """
        wpm = wpm or self.regime["wpm"]
        mean_flight = 60.0 / (wpm * 5)          # seconds per char
        for idx, ch in enumerate(text):
            await self._type_char(ch)
            # flight: gap to the NEXT key -- gaussian, slower at word starts
            flight = max(0.025, self.rng.gauss(
                mean_flight, mean_flight * self.regime["flight_sigma"]))
            if ch == " ":
                flight += self.rng.uniform(0.0, 0.11)
            if self.rng.random() < 0.03:        # thinking pause
                flight += self.rng.uniform(0.35, 1.0)
            if (correct and self.rng.random() < self.regime["typo_rate"]
                    and idx > 0):
                # typo + correction: delete the last char, retype it right
                await asyncio.sleep(self.rng.uniform(0.1, 0.25))
                await self.page.keyboard.down("Backspace")
                await asyncio.sleep(self.rng.uniform(0.05, 0.10))
                await self.page.keyboard.up("Backspace")
                await self._type_char(ch)
                flight = self.rng.uniform(0.25, 0.6)
            await asyncio.sleep(flight)

    async def type_into(self, selector: str, text, *, wpm=None):
        """Click an input element, then type into it like a human."""
        existing = await self.page.locator(selector).first.input_value()
        await self.click(selector)
        await asyncio.sleep(self.rng.uniform(0.1, 0.35))
        # corrections only when the field started empty (see type_text)
        await self.type_text(text, wpm=wpm, correct=not existing)
        return await self.page.locator(selector).first.input_value()

    # --- idle behaviour ----------------------------------------------------
    async def dwell(self, lo=0.4, hi=2.5):
        """Pause as if reading, with a small chance of an idle cursor move."""
        await asyncio.sleep(self.rng.uniform(lo, hi))
        if self.rng.random() < 0.35:
            await self.wander(1)
