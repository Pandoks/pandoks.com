// apex_font_policy.h -- consistent font-availability policy.
//
// Font fingerprinting has two attack paths:
//   1. The direct query -- code asks "is font X installed?" via the font APIs
//      (document.fonts.check(), @font-face local()).
//      FontCache::IsPlatformFamilyMatchAvailable is the chokepoint for this.
//   2. Width measurement -- render text in font X, measure the box; a non-
//      fallback width means X is installed. This has NO single chokepoint and
//      is answered by the *actual installed font set* in the container
//      (see packages/stealth-chromium/Dockerfile's apt font layer).
//
// This header covers path 1, and its one job is to make path 1 agree with
// path 2 for the persona's OS. The allowlist is therefore the INTERSECTION of
//   (a) families the persona's OS genuinely ships, and
//   (b) families the Docker bundle actually resolves.
// A family in (a) but not (b) -- "Segoe UI" on a Windows persona, "Menlo" on
// a macOS persona -- must NOT be listed: the width path would say absent while
// check() says present, and that disagreement is itself a detector signal. For
// those families this function returns false and the caller falls through to
// the real fontconfig lookup, which (correctly) also says absent.
//
// (b) was measured on the bundle (python:3.12-slim-bookworm + fonts-liberation
// 1:1.07.4-11 + fonts-noto-color-emoji 2.042) by replaying Skia's
// SkFontConfigInterfaceDirect::isAcceptableMatch rule over fc-pattern/fc-match:
// only Arial / Times New Roman / Courier New (via Skia's kFontEquivMap metric
// classes), the four Liberation families, Arimo/Tinos/Cousine and Noto Color
// Emoji resolve. Helvetica, Times, Courier, Verdana, Georgia, DejaVu, Noto Sans
// etc. do NOT (fontconfig's alias for them is weak, so Skia rejects the match).
//
// Persona OS comes from APEX_FP_UA_PLATFORM ("Windows" / "macOS"; anything
// else is treated as Linux), the same switch apex_voices.h uses.
//
// Known residual (needs a deny hook in the edit, not this list): the bundle's
// Liberation*/Noto Color Emoji families still report present on Win/Mac
// personas through the real lookup, because this policy only ever adds.

#ifndef APEX_CHROMIUM_FONT_POLICY_H_
#define APEX_CHROMIUM_FONT_POLICY_H_

#include "apex_fingerprint.h"
#include "third_party/blink/renderer/platform/wtf/text/atomic_string.h"

namespace apex_fp {

// Windows 11 ships Arial, Times New Roman and Courier New (Microsoft
// "Windows 11 font list"); the bundle resolves all three to the
// metric-compatible Liberation faces, so widths agree with real Windows.
// Segoe UI, Calibri, Consolas, Verdana, Georgia, Tahoma... are shipped by
// Windows but NOT by the bundle -> deliberately absent.
inline bool IsWindowsAllowlistedFont(const std::string& f) {
  static const char* kWin[] = {
    "arial", "times new roman", "courier new",
  };
  for (const char* a : kWin) {
    if (f == a) {
      return true;
    }
  }
  return false;
}

// macOS ships Arial, Times New Roman and Courier New (Apple "Fonts included
// with macOS"); same bundle intersection as Windows. Helvetica, Times,
// Courier, Menlo, Monaco, Geneva, Lucida Grande, Avenir, Helvetica Neue...
// are shipped by macOS but do NOT resolve in the bundle -> deliberately absent.
inline bool IsMacAllowlistedFont(const std::string& f) {
  static const char* kMac[] = {
    "arial", "times new roman", "courier new",
  };
  for (const char* a : kMac) {
    if (f == a) {
      return true;
    }
  }
  return false;
}

// Linux: exactly what the bundle installs (Debian fonts-liberation +
// fonts-noto-color-emoji) plus the metric aliases fontconfig/Skia accept for
// them. DejaVu is NOT in the bundle, so it is not listed.
inline bool IsLinuxAllowlistedFont(const std::string& f) {
  static const char* kLinux[] = {
    "arial", "times new roman", "courier new",
    "liberation sans", "liberation serif", "liberation mono",
    "liberation sans narrow",
    "arimo", "tinos", "cousine",
    "noto color emoji",
  };
  for (const char* a : kLinux) {
    if (f == a) {
      return true;
    }
  }
  return false;
}

// Returns true if `family` is on the persona-OS allowlist, i.e. a family the
// claimed OS ships AND the bundle really resolves. Used by the FontCache
// overlay (apex-font-allow edit) to short-circuit the availability query;
// anything not listed falls through to the real fontconfig answer.
inline bool IsAllowlistedFont(const blink::AtomicString& family) {
  if (!Active()) {
    return false;  // policy off -> caller uses real availability
  }
  // Lowercase the family name using Blink's own AtomicString API -- no manual
  // char indexing, so this is clean under -Wunsafe-buffer-usage.
  const std::string f = family.ToAsciiLower().Utf8();
  const std::string os = EnvStr("APEX_FP_UA_PLATFORM");
  if (os == "Windows") {
    return IsWindowsAllowlistedFont(f);
  }
  if (os == "macOS") {
    return IsMacAllowlistedFont(f);
  }
  return IsLinuxAllowlistedFont(f);
}

}  // namespace apex_fp

#endif  // APEX_CHROMIUM_FONT_POLICY_H_
