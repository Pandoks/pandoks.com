"""Read the live CreepJS verdict off the rendered page.

CreepJS (https://abrahamjuliot.github.io/creepjs/) is the strictest public
fingerprint auditor. The *modern* CreepJS does NOT print a single "trust score"
line -- that older format is gone. What it computes and renders is a set of
bot/automation verdicts:

  * "N% headless"       -> probability the browser is actually headless
  * "N% like headless"  -> heuristic similarity to a headless browser
  * "N% stealth"        -> probability stealth/anti-detect tampering is present

For a clean, undetected real browser we want: headless 0%, stealth 0%, and
"like headless" as low as possible. `stealth 0%` is the modern equivalent of
"0 lies" -- it means CreepJS found no inconsistencies / no tampering.

We also independently re-derive the timezone CreepJS observed, to catch the
case where our identity override silently failed (timezone leaking the host
machine instead of the configured value).
"""

from __future__ import annotations

CREEPJS_URL = "https://abrahamjuliot.github.io/creepjs/"

# Runs in the CreepJS page after it has computed. Pure DOM scraping.
EXTRACT_JS = r"""
() => {
  const txt = (document.body && document.body.innerText) || "";
  const out = { ready: false, raw: {} };

  const pct = re => { const m = txt.match(re); return m ? parseInt(m[1], 10) : null; };

  out.headless      = pct(/(\d+)%\s*headless/i);
  out.likeHeadless  = pct(/(\d+)%\s*like\s*headless/i);
  out.stealth       = pct(/(\d+)%\s*stealth/i);

  // CreepJS prints the timezone it observed, e.g. "America/New_York (240)".
  const tzM = txt.match(/(America\/[A-Za-z_]+|Europe\/[A-Za-z_]+|Asia\/[A-Za-z_]+|[A-Za-z]+\/[A-Za-z_]+)\s*\(-?\d+\)/);
  out.observedTimezone = tzM ? tzM[1] : null;

  // observed locale / currency line, e.g. "en-US (1 US dollar)"
  const locM = txt.match(/([a-z]{2}-[A-Z]{2})\s*\(/);
  out.observedLocale = locM ? locM[1] : null;

  // the FP id only appears once the page has finished computing
  out.raw.hasFP = /FP ID:/i.test(txt) || /Fuzzy:/i.test(txt);
  out.raw.bodyLen = txt.length;

  // "ready" = CreepJS finished AND we got the decisive headless/stealth numbers
  out.ready = out.raw.hasFP &&
              out.headless !== null &&
              out.stealth  !== null;
  return out;
}
"""


def summarize(creep: dict) -> str:
    def p(k):
        v = creep.get(k)
        return "?" if v is None else f"{v}%"
    tz = creep.get("observedTimezone") or "?"
    return (f"headless={p('headless')} like_headless={p('likeHeadless')} "
            f"stealth={p('stealth')} tz={tz}")


def creep_passes(creep: dict, *, expected_timezone: str | None = None) -> bool:
    """Acceptance bar for the CreepJS verdict.

    Hard requirements for "looks like a real human, not fingerprinted":
      * headless == 0   -> CreepJS sees no headless behavior
      * stealth  == 0   -> CreepJS finds no tampering / no "lies"
      * if an expected timezone is given, the observed timezone must match it
        (a timezone mismatch is the classic coherence "lie")

    "like headless" is a soft heuristic; we report it but do not hard-fail on
    it, since a clean real headful Chrome can still score low-but-nonzero here.
    """
    if creep.get("headless") != 0:
        return False
    if creep.get("stealth") != 0:
        return False
    if expected_timezone is not None:
        obs = creep.get("observedTimezone")
        if obs is not None and obs != expected_timezone:
            return False
    return True
