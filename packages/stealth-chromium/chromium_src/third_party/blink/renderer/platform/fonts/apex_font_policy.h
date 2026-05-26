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
// allowlist. Used by the FontCache overlay to ensure the common web-safe set
// reports as installed regardless of the container's exact fontconfig state.
inline bool IsAllowlistedFont(const blink::AtomicString& family) {
  if (!Active()) {
    return false;  // policy off -> caller uses real availability
  }
  // common web-safe + OS-bundled families. Lowercased compare.
  static const char* kAllow[] = {
    "arial", "helvetica", "times new roman", "times", "courier new",
    "courier", "verdana", "georgia", "palatino", "garamond", "bookman",
    "tahoma", "trebuchet ms", "arial black", "impact", "comic sans ms",
    "lucida console", "lucida sans unicode", "segoe ui", "calibri",
    "cambria", "consolas", "candara", "constantia", "corbel",
    // macOS-bundled
    "san francisco", "sf pro", "helvetica neue", "menlo", "monaco",
    "geneva", "lucida grande", "avenir", "avenir next", "gill sans",
    "optima", "futura", "baskerville", "american typewriter",
    // cross-platform web fonts the bundle installs
    "roboto", "open sans", "lato", "noto sans", "noto serif",
    "dejavu sans", "dejavu serif", "liberation sans", "liberation serif",
  };
  // Lowercase the family name using Blink's own AtomicString API -- no manual
  // char indexing, so this is clean under -Wunsafe-buffer-usage.
  const std::string f = family.ToAsciiLower().Utf8();
  for (const char* a : kAllow) {
    if (f == a) {
      return true;
    }
  }
  return false;
}

}  // namespace apex_fp

#endif  // APEX_CHROMIUM_FONT_POLICY_H_
