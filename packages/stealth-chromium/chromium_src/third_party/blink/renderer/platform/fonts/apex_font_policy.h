// apex_font_policy.h -- consistent font-availability policy.
//
// Font fingerprinting has two attack paths:
//   1. The direct query -- code asks "is font X installed?" via the font APIs.
//      FontCache::IsPlatformFamilyMatchAvailable is the chokepoint for this.
//   2. Width measurement -- render text in font X, measure the box; a non-
//      fallback width means X is installed. This has NO single chokepoint and
//      is defeated by the *actual installed font set* matching the persona
//      (see apex-browser/Dockerfile's font bundle).
//
// This header covers path 1: when APEX_FP_ACTIVE is set, font availability is
// answered from a fixed allowlist of fonts that a real machine of the persona's
// OS genuinely ships -- so the direct query agrees with the width-measurement
// result from the installed bundle. The two paths therefore tell the same
// story, which is what defeats consistency-checking detectors.
//
// The allowlist is intentionally broad (the common cross-platform web-safe set
// plus the OS's bundled families); apex never *removes* a genuinely-installed
// font, it only ensures the common set reads as present.

#ifndef APEX_CHROMIUM_FONT_POLICY_H_
#define APEX_CHROMIUM_FONT_POLICY_H_

#include "apex_fingerprint.h"
#include "third_party/blink/renderer/platform/wtf/text/atomic_string.h"

namespace apex_fp {

// Returns true if `family` (lowercased ascii) is on the always-present
// allowlist. Used by the FontCache overlay so the direct font query agrees
// with the persona's OS.
//
// COHERENCE: the allowlist is OS-SCOPED. A real machine ships its OS's system
// fonts, NOT another OS's -- so a macOS persona must NOT report Windows-only
// families (Segoe UI, Calibri, Consolas) present, and vice-versa. The earlier
// version returned true for the UNION of both sets for every persona, i.e. it
// claimed an impossible Windows+macOS font combo -- itself an instant tell.
// We now gate the OS-specific lists on APEX_FP_UA_PLATFORM ("macOS"/"Windows";
// anything else -> common set only). The web-safe core (shipped by both) is
// always allowed.
//
// NOTE: this is path 1 (direct query). Full coherence also needs path 2 (width
// measurement) to agree, which is the DEPLOYMENT's job -- the container's
// installed font bundle must match the persona's OS. Linux-only families
// (DejaVu, Liberation) are deliberately NOT listed: a macOS/Windows persona
// reporting them present is a headless-Linux tell.
inline bool IsAllowlistedFont(const blink::AtomicString& family) {
  if (!Active()) {
    return false;  // policy off -> caller uses real availability
  }
  // Web-safe core shipped by BOTH Windows and macOS -> always allowed.
  static const char* kCommon[] = {
    "arial", "arial black", "comic sans ms", "courier new", "georgia",
    "impact", "times new roman", "trebuchet ms", "verdana",
    // cross-platform web fonts a real user plausibly has (Office / Chrome /
    // websites install these on Win+Mac alike) -- NOT the Linux-only ones.
    "roboto", "open sans", "lato", "noto sans", "noto serif",
  };
  // Windows-only system/Office families.
  static const char* kWindows[] = {
    "calibri", "cambria", "candara", "consolas", "constantia", "corbel",
    "segoe ui", "tahoma", "lucida console", "lucida sans unicode",
    "microsoft sans serif", "ms sans serif", "palatino linotype", "sylfaen",
    "franklin gothic medium", "gadugi", "ebrima",
  };
  // macOS-only system families. (San Francisco / "SF Pro" are intentionally
  // omitted: the system font is not accessible to the web by name on a real
  // Mac, so claiming it present would itself be wrong.)
  static const char* kMac[] = {
    "helvetica", "helvetica neue", "menlo", "monaco", "geneva",
    "lucida grande", "avenir", "avenir next", "gill sans", "optima",
    "futura", "baskerville", "american typewriter", "times", "courier",
    "palatino", "hoefler text", "andale mono", "apple chancery",
    "marker felt", "papyrus", "charter", "cochin", "didot", "copperplate",
  };
  // Lowercase the family name using Blink's own AtomicString API -- no manual
  // char indexing, so this is clean under -Wunsafe-buffer-usage.
  const std::string f = family.ToAsciiLower().Utf8();
  for (const char* a : kCommon) {
    if (f == a) {
      return true;
    }
  }
  // APEX_FP_UA_PLATFORM is the persona OS label ("macOS" / "Windows"), the
  // same value driving navigator.userAgentData.platform -- so fonts stay
  // coherent with the rest of the identity.
  const std::string os = EnvStr("APEX_FP_UA_PLATFORM");
  if (os == "Windows") {
    for (const char* a : kWindows) {
      if (f == a) {
        return true;
      }
    }
  } else if (os == "macOS") {
    for (const char* a : kMac) {
      if (f == a) {
        return true;
      }
    }
  }
  return false;
}

}  // namespace apex_fp

#endif  // APEX_CHROMIUM_FONT_POLICY_H_
