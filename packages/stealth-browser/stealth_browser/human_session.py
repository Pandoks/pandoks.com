"""Human session simulation -- realistic visits for PostHog session replays.

A single page that passes a fingerprint test is not the same as a session that
looks human in PostHog. PostHog (via rrweb) records DOM mutations, mouse moves,
scroll, clicks and timing, and groups them into a $session_id. A replay looks
human when the *session shape* is human:

  * arrives with a referrer (search / social / direct mix), not always direct
  * lands on a page, then visits a few more (depth 3-8 is typical)
  * dwells a realistic, variable time per page (reading, not 0.2s)
  * scrolls in human bursts, hovers things, clicks links with curved approach
  * sometimes uses the back button
  * leaves -- the session ends, a new one starts fresh

PostHog will only record us at all if we pass its bot filter -- it checks
navigator.webdriver (we are false) and a UA blocklist that contains
'headlesschrome' (we run headful real Chrome, UA is clean). Both verified.

`HumanSession.visit()` runs one such visit. `run_traffic()` runs many, with
optional concurrency -- each visitor is an independent browser + identity.
"""

from __future__ import annotations

import asyncio
import random
import urllib.parse

from .browser import StealthBrowser
from .human import Human
from .profile import Identity


# Realistic referrer mix -- roughly how real web traffic breaks down. Each
# visit picks one; "direct" means no referrer. The browser is told to send
# this as the Referer header / document.referrer for the landing page.
REFERRERS = [
    ("https://www.google.com/", 0.50),     # organic search -- the bulk
    ("https://www.bing.com/", 0.06),
    ("https://duckduckgo.com/", 0.04),
    ("https://www.reddit.com/", 0.06),
    ("https://news.ycombinator.com/", 0.04),
    ("https://www.linkedin.com/", 0.03),
    (None, 0.27),                          # direct traffic
]


def _pick_referrer() -> str | None:
    r = random.random()
    cum = 0.0
    for ref, weight in REFERRERS:
        cum += weight
        if r <= cum:
            return ref
    return None


class HumanSession:
    """One simulated human visit to a site, recorded cleanly by PostHog."""

    def __init__(self, base_url: str, *,
                 identity: Identity | None = None,
                 min_pages: int = 3, max_pages: int = 8,
                 journey: list[str] | None = None):
        # Split the given URL into a clean ORIGIN (scheme://host[:port]) used
        # for same-site checks, and the ENTRY URL (the actual landing page).
        # The given URL may be a bare origin or include a page path; both work.
        parsed = urllib.parse.urlparse(base_url)
        self.origin = f"{parsed.scheme}://{parsed.netloc}"
        self.host = parsed.netloc
        self.entry_url = base_url if (parsed.path and parsed.path != "/") \
            else self.origin + "/"
        self.identity = identity or Identity()
        self.min_pages = min_pages
        self.max_pages = max_pages
        # journey: explicit list of paths to follow in order. If None, the
        # session auto-crawls links it discovers on the site.
        self.journey = journey

    async def visit(self) -> dict:
        """Run one full human visit. Returns a summary dict."""
        referrer = _pick_referrer()
        depth = random.randint(self.min_pages, self.max_pages)
        visited: list[str] = []

        async with StealthBrowser(self.identity) as sb:
            # land on the entry page, carrying the referrer
            entry = (self.entry_url if not self.journey
                     else self.origin + self._norm(self.journey[0]))
            tab = await self._open_with_referrer(sb, entry, referrer)
            human = await sb.human_for(tab)
            visited.append(await self._url(tab))
            await self._browse_page(human, tab)

            if self.journey:
                await self._run_journey(sb, tab, human, visited)
            else:
                await self._auto_crawl(sb, tab, human, visited, depth)

            # natural exit: a short final dwell, then the session ends
            await human.dwell(0.8, 2.5)

        return {
            "referrer": referrer or "(direct)",
            "pages": len(visited),
            "path": visited,
        }

    # --- entry -------------------------------------------------------------
    async def _open_with_referrer(self, sb, url, referrer):
        """Open `url` so `document.referrer` reflects `referrer`.

        PostHog reads `document.referrer` (not the Referer header) for its
        $referrer / $referring_domain properties. The robust, no-spoofing way
        to set it: actually land on the referrer site first, then navigate
        in-page to the target -- the browser then populates document.referrer
        *natively*. A real Google/social referral genuinely came from there;
        nothing is faked, so there is no inconsistency to detect.

        For "direct" visits (referrer is None) we just open the target.
        """
        from nodriver import cdp
        tab = await sb._browser.get("about:blank")
        await sb._apply_identity(tab)

        if referrer:
            try:
                # land on the real referrer site first
                await tab.get(referrer)
                await self._wait_ready(tab, timeout=10.0)
                # a brief, human pause as if glancing at the referrer page
                await tab.sleep(random.uniform(0.8, 2.0))
                # in-page navigation to the target -> referrer set natively
                await tab.evaluate(
                    "window.location.href = %r" % url)
            except Exception:  # noqa: BLE001 - referrer site failed; go direct
                await tab.get(url)
        else:
            await tab.get(url)

        await sb._safe(tab, cdp.page.bring_to_front())
        await self._wait_ready(tab)
        await tab.sleep(random.uniform(1.0, 2.2))
        return tab

    @staticmethod
    async def _wait_ready(tab, timeout: float = 12.0) -> None:
        """Poll until document.readyState is 'complete' (or timeout)."""
        elapsed = 0.0
        while elapsed < timeout:
            try:
                rs = await tab.evaluate("document.readyState",
                                        return_by_value=True)
                val = rs if isinstance(rs, str) else getattr(
                    getattr(rs, "deep_serialized_value", None), "value", None)
                if val == "complete":
                    return
            except Exception:  # noqa: BLE001
                pass
            await tab.sleep(0.5)
            elapsed += 0.5

    # --- per-page human behaviour -----------------------------------------
    async def _browse_page(self, human: Human, tab) -> None:
        """Spend a human amount of time on the current page.

        CRITICAL for realistic PostHog replays: the cursor must MOVE on every
        page, continuously -- not just dart in to click. A real human's cursor
        drifts while reading and while scrolling. So here we interleave cursor
        motion with every scroll burst and always do an orientation move when
        the page loads. No page is ever left mouse-silent.
        """
        # 1. orientation: a real visitor moves the cursor onto the new page
        #    content right after it loads (the cursor does not teleport-freeze)
        await human.move_to(
            random.uniform(human.vw * 0.25, human.vw * 0.7),
            random.uniform(human.vh * 0.2, human.vh * 0.5))
        await human.dwell(0.5, 1.6)

        # 2. read the page in 2-4 scroll bursts, with cursor motion BETWEEN
        #    every burst -- this is what fills the replay with activity
        bursts = random.randint(2, 4)
        for _ in range(bursts):
            await human.read_scroll(screens=random.uniform(0.5, 1.2))
            # drift the cursor while "reading" the newly scrolled content
            await human.move_to(
                random.uniform(human.vw * 0.15, human.vw * 0.85),
                random.uniform(human.vh * 0.25, human.vh * 0.75))
            await human.dwell(0.7, 2.4)
            # sometimes hover a link in view, as if considering it
            if random.random() < 0.6:
                await self._hover_visible_link(human, tab)

        # 3. a couple more deliberate hovers over links, scanning the page
        await self._hover_visible_link(human, tab)
        if random.random() < 0.5:
            await self._hover_visible_link(human, tab)

        # 4. sometimes scroll back up a bit (re-reading) with cursor motion
        if random.random() < 0.45:
            await human.scroll(random.randint(150, 450), direction="up")
            await human.move_to(
                random.uniform(human.vw * 0.2, human.vw * 0.7),
                random.uniform(human.vh * 0.3, human.vh * 0.7))
            await human.dwell(0.4, 1.4)

    async def _hover_visible_link(self, human: Human, tab) -> None:
        """Move the cursor onto a link/button that is currently in view."""
        try:
            els = await tab.select_all("a, button")
        except Exception:  # noqa: BLE001
            return
        random.shuffle(els)
        for el in els:
            box = await human._center_of(el)
            # only hover things actually inside the viewport right now
            if box and 0 <= box[1] <= human.vh and 0 <= box[0] <= human.vw:
                await human.move_to(*box)
                await human.dwell(0.25, 1.1)
                return

        # sometimes scroll back up a bit
        if random.random() < 0.4:
            await human.scroll(random.randint(150, 500), direction="up")
            await human.dwell(0.4, 1.5)

    # --- auto-crawl mode ---------------------------------------------------
    async def _auto_crawl(self, sb, tab, human, visited, depth) -> None:
        """Discover same-site links and click through `depth` pages."""
        for _ in range(depth - 1):
            link = await self._pick_internal_link(tab, visited)
            if link is None:
                break
            try:
                # occasionally use the back button instead of a new link
                if len(visited) > 1 and random.random() < 0.15:
                    await tab.evaluate("history.back()")
                    await tab.sleep(random.uniform(1.0, 2.0))
                    human = await sb.human_for(tab)
                    await self._browse_page(human, tab)
                    continue
                await human.click(link)
                await tab.sleep(random.uniform(1.2, 2.8))
                human = await sb.human_for(tab)
                visited.append(await self._url(tab))
                await self._browse_page(human, tab)
            except Exception:  # noqa: BLE001 - dead link / nav race, move on
                break

    async def _pick_internal_link(self, tab, visited):
        """Pick a random same-origin link not yet visited.

        Relative hrefs are resolved against the CURRENT page URL (the correct
        base for relative links), and kept only if same-host and unvisited.
        """
        try:
            els = await tab.select_all("a[href]")
        except Exception:  # noqa: BLE001
            return None
        current = await self._url(tab)
        seen = {v.split("#")[0].rstrip("/") for v in visited}
        candidates = []
        for el in els:
            href = el.attrs.get("href") if hasattr(el, "attrs") else None
            if not href or href.startswith(("#", "javascript:", "mailto:",
                                            "tel:")):
                continue
            full = urllib.parse.urljoin(current, href)
            if urllib.parse.urlparse(full).netloc != self.host:
                continue
            if full.split("#")[0].rstrip("/") in seen:
                continue
            candidates.append(el)
        return random.choice(candidates) if candidates else None

    # --- scripted journey mode --------------------------------------------
    async def _run_journey(self, sb, tab, human, visited) -> None:
        """Navigate the explicit list of paths in order, human-style."""
        for path in self.journey[1:]:
            target = self.origin + self._norm(path)
            # try to find a link to it and click; else navigate directly
            link = await self._find_link_to(tab, path)
            try:
                if link is not None:
                    await human.click(link)
                else:
                    await tab.get(target)
                await tab.sleep(random.uniform(1.2, 2.8))
                human = await sb.human_for(tab)
                visited.append(await self._url(tab))
                await self._browse_page(human, tab)
            except Exception:  # noqa: BLE001
                break

    async def _find_link_to(self, tab, path):
        try:
            els = await tab.select_all("a[href]")
        except Exception:  # noqa: BLE001
            return None
        want = self._norm(path)
        for el in els:
            href = el.attrs.get("href") if hasattr(el, "attrs") else None
            if href and (href == want or href.rstrip("/") == want.rstrip("/")):
                return el
        return None

    # --- helpers -----------------------------------------------------------
    @staticmethod
    def _norm(path: str) -> str:
        return path if path.startswith("/") else "/" + path

    @staticmethod
    async def _url(tab) -> str:
        r = await tab.evaluate("location.href", return_by_value=True)
        return r if isinstance(r, str) else getattr(
            getattr(r, "deep_serialized_value", None), "value", "?")


async def run_traffic(base_url: str, *, visits: int = 5, concurrency: int = 1,
                      journey: list[str] | None = None,
                      min_pages: int = 3, max_pages: int = 8) -> list[dict]:
    """Run `visits` human sessions against `base_url`.

    `concurrency` independent visitors run at once; each gets its own browser
    and a fresh identity, so PostHog sees them as distinct people. A small
    random gap is inserted between visit starts so they do not begin in
    lockstep (real traffic arrives irregularly).
    """
    results: list[dict] = []
    sem = asyncio.Semaphore(max(1, concurrency))

    async def _one(i: int) -> None:
        async with sem:
            # stagger starts so visits don't begin simultaneously
            await asyncio.sleep(random.uniform(0, 2.5 * concurrency))
            session = HumanSession(
                base_url, identity=Identity(),
                min_pages=min_pages, max_pages=max_pages, journey=journey)
            try:
                summary = await session.visit()
                summary["visit"] = i
                results.append(summary)
                print(f"  [visit {i}] {summary['pages']} pages  "
                      f"referrer={summary['referrer']}")
            except Exception as e:  # noqa: BLE001
                print(f"  [visit {i}] FAILED: {type(e).__name__}: {e}")

    await asyncio.gather(*(_one(i + 1) for i in range(visits)))
    return results
