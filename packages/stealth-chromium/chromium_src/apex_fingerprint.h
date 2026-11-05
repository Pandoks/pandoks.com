// apex_fingerprint.h -- per-session fingerprint config, read from the environment.
//
// The C++ patches below cannot take a per-session argument the way a JS shim
// can. So the patched getters read their values from environment variables that
// the apex launcher (apex-browser/apex/core_nodriver.py) sets *before* it spawns
// Chrome. One generic patched binary therefore serves infinitely many coherent
// per-session identities -- the launcher picks the profile, the binary presents
// it natively (no JS, no toString leak).
//
// Env vars (all optional -- unset means "use the real Chromium value"):
//   APEX_FP_ACTIVE           "1" to enable any spoofing at all (master switch)
//   APEX_FP_SEED             uint32, drives deterministic canvas/audio noise
//   APEX_FP_PLATFORM         e.g. "MacIntel", "Win32", "Linux x86_64"
//   APEX_FP_UA_PLATFORM      navigator.userAgentData platform, e.g. "macOS"
//   APEX_FP_HW_CONCURRENCY   uint, navigator.hardwareConcurrency
//   APEX_FP_DEVICE_MEMORY    float, navigator.deviceMemory (0.25..8)
//   APEX_FP_WEBGL_VENDOR     UNMASKED_VENDOR_WEBGL string
//   APEX_FP_WEBGL_RENDERER   UNMASKED_RENDERER_WEBGL string
//   APEX_FP_SCREEN_W         int, screen.width
//   APEX_FP_SCREEN_H         int, screen.height
//   APEX_FP_SCREEN_AVAIL_W   int, screen.availWidth
//   APEX_FP_SCREEN_AVAIL_H   int, screen.availHeight
//   APEX_FP_COLOR_DEPTH      int, screen.colorDepth (typically 24/30)
//   APEX_FP_BATTERY_LEVEL    float 0..1, navigator.getBattery() level
//   APEX_FP_BATTERY_CHARGING "1"/"0", battery charging state
//   APEX_FP_DEVICELABELS     ";"-joined synthetic media-device labels
//   APEX_FP_VOICES           "name|lang|default,..." speechSynthesis voices
//   (WebRTC: when APEX_FP_ACTIVE=1, non-proxied UDP is force-disabled so the
//    real IP cannot leak past a proxy -- no separate env var, always on.)
//
// This file is NOT an upstream Chromium file. It lives only in the apex overlay
// and is pulled in by the overlay .cc files. It deliberately has no Chromium
// dependencies beyond <cstdlib>/<cstdint>/<string> so it is safe to include
// from any Blink translation unit.

#ifndef APEX_CHROMIUM_FINGERPRINT_H_
#define APEX_CHROMIUM_FINGERPRINT_H_

#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <string>

namespace apex_fp {

// --- raw env access --------------------------------------------------------

// Returns the env var value, or an empty string if unset/empty.
inline std::string EnvStr(const char* name) {
  const char* v = std::getenv(name);
  return (v && *v) ? std::string(v) : std::string();
}

// True only when APEX_FP_ACTIVE is exactly "1". The master switch: if a binary
// is launched without it, every patch below falls through to Chromium's real
// behavior, so the patched binary behaves identically to stock Chrome.
//
// Uses std::string comparison (not strcmp) to satisfy Chromium's
// -Wunsafe-buffer-usage-in-libc-call policy: no raw libc string functions.
inline bool Active() {
  return EnvStr("APEX_FP_ACTIVE") == "1";
}

inline bool HasOverride(const char* name) {
  return Active() && !EnvStr(name).empty();
}

// Hand-rolled numeric parsers. This header is included by BOTH Blink and V8's
// inspector -- V8 has no Chromium //base -- so the parsers must stay dependency
// free: no //base, no libc string functions (-Wunsafe-buffer-usage-in-libc),
// no exceptions (-fno-exceptions). They iterate the std::string by index
// (bounds-safe) and on any malformed char fall back, so a bad env value can
// never crash or produce garbage.
inline uint32_t EnvU32(const char* name, uint32_t fallback) {
  std::string s = EnvStr(name);
  if (s.empty()) return fallback;
  uint64_t acc = 0;
  for (char c : s) {
    if (c < '0' || c > '9') return fallback;
    acc = acc * 10u + static_cast<uint64_t>(c - '0');
    if (acc > 0xFFFFFFFFull) return fallback;  // overflow guard
  }
  return static_cast<uint32_t>(acc);
}

inline int EnvInt(const char* name, int fallback) {
  std::string s = EnvStr(name);
  if (s.empty()) return fallback;
  bool neg = false;
  size_t i = 0;
  if (s[0] == '-') { neg = true; i = 1; }
  if (i >= s.size()) return fallback;
  long long acc = 0;
  for (; i < s.size(); ++i) {
    char c = s[i];
    if (c < '0' || c > '9') return fallback;
    acc = acc * 10 + (c - '0');
    if (acc > 2147483647LL) return fallback;  // int range guard
  }
  return static_cast<int>(neg ? -acc : acc);
}

inline double EnvDouble(const char* name, double fallback) {
  std::string s = EnvStr(name);
  if (s.empty()) return fallback;
  bool neg = false;
  size_t i = 0;
  if (s[0] == '-') { neg = true; i = 1; }
  double whole = 0.0, frac = 0.0, scale = 1.0;
  bool seen_digit = false, seen_dot = false;
  for (; i < s.size(); ++i) {
    char c = s[i];
    if (c == '.') {
      if (seen_dot) return fallback;
      seen_dot = true;
      continue;
    }
    if (c < '0' || c > '9') return fallback;
    seen_digit = true;
    if (seen_dot) {
      scale *= 10.0;
      frac += static_cast<double>(c - '0') / scale;
    } else {
      whole = whole * 10.0 + static_cast<double>(c - '0');
    }
  }
  if (!seen_digit) return fallback;
  double v = whole + frac;
  return neg ? -v : v;
}

// --- deterministic per-session PRNG ---------------------------------------
//
// mulberry32: tiny, fast, deterministic. Seeded once from APEX_FP_SEED so that
// canvas/audio perturbations are STABLE within a session (a page hashing the
// same canvas twice gets the same hash -- a fluctuating hash is itself a tell)
// but DIFFER across sessions (each session a fresh seed -> fresh fingerprint).

class Mulberry32 {
 public:
  explicit Mulberry32(uint32_t seed) : state_(seed) {}

  // Next value in [0, 1).
  double NextDouble() {
    state_ += 0x6D2B79F5u;
    uint32_t z = state_;
    z = (z ^ (z >> 15)) * (z | 1u);
    z ^= z + (z ^ (z >> 7)) * (z | 61u);
    return static_cast<double>((z ^ (z >> 14)) & 0xFFFFFFFFu) / 4294967296.0;
  }

  // Signed perturbation in [-magnitude, +magnitude].
  double NextSigned(double magnitude) {
    return (NextDouble() * 2.0 - 1.0) * magnitude;
  }

 private:
  uint32_t state_;
};

// The session seed (0 means "no seed set" -> callers should skip noise).
inline uint32_t Seed() { return EnvU32("APEX_FP_SEED", 0); }

// 64-bit avalanche mix (the splitmix64 finalizer). Used to derive the canvas
// mask key and the per-block lock bits. Pure integer math -- no //base, no
// libc, so this header stays includable from V8-includable code.
inline uint64_t Mix64(uint64_t x) {
  x += 0x9E3779B97F4A7C15ull;
  x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ull;
  x = (x ^ (x >> 27)) * 0x94D049BB133111EBull;
  return x ^ (x >> 31);
}

// 64-bit variant of EnvU32 (the u32 parse overflows past 4G, so this parses
// the decimal text with its own guard).
inline uint64_t EnvU64(const char* name, uint64_t fallback) {
  std::string s = EnvStr(name);
  if (s.empty()) return fallback;
  uint64_t acc = 0;
  for (char c : s) {
    if (c < '0' || c > '9') return fallback;
    const uint64_t before = acc;
    acc = acc * 10u + static_cast<uint64_t>(c - '0');
    if (acc < before) return fallback;  // overflow guard
  }
  return acc;
}

// Canvas farbling key: stable per persona (real canvas hashes are stable for
// hundreds of days, so a persona whose canvas hash changes between sessions
// is itself a signal). APEX_FP_CANVAS_KEY supplies 64 bits. Fallback is the
// 32-bit session seed -- still content-keyed and irreversible per byte, but
// brute-forceable from one attacker-drawn canvas in ~13 core-hours, so the
// persona layer should always set the 64-bit key.
inline uint64_t CanvasKey() {
  uint64_t k = EnvU64("APEX_FP_CANVAS_KEY", 0);
  if (k == 0) k = Mix64(static_cast<uint64_t>(Seed()));
  return k;
}

// Per-eTLD+1 (top-level site) seed derived from the session seed and the
// site's registrable domain. Brave's farbling model -- so the same apex
// session presents a DIFFERENT canvas/audio/WebGL noise pattern on each
// distinct top-level site, preventing cross-site correlation of the noise
// signature itself. Returns 0 iff the base seed is 0 (no noise).
//
// `host` should be the registrable domain (eTLD+1); callers that have only
// the full hostname should pass it as-is -- the FNV mix below is stable
// either way and the security goal (per-site diversity) is achieved.
inline uint32_t EtldSeed(const std::string& host) {
  uint32_t base = Seed();
  if (base == 0 || host.empty()) {
    return base;
  }
  // Index-based FNV-1a -- avoids `-Wunsafe-buffer-usage` flagging raw
  // pointer arithmetic (we never bare-iterate const char*).
  uint32_t h = base ^ 0x811c9dc5u;
  for (size_t i = 0; i < host.size(); ++i) {
    h ^= static_cast<uint8_t>(host[i]);
    h *= 0x01000193u;
  }
  return h ? h : 1u;
}

// --- UA / UA-CH persona record ------------------------------------------
// ONE record drives the UA string, Sec-CH-UA-* (navigation + subresource),
// navigator.userAgentData (page/iframe/worker) and navigator.platform.
// Keyed by APEX_FP_UA_PLATFORM; APEX_FP_UA_ARCH / APEX_FP_UA_PLATFORM_VERSION
// optionally pin the two high-entropy fields a persona varies.
struct UAPersona {
  bool active = false;
  std::string ua_os_segment;
  std::string platform;
  std::string platform_version;
  std::string architecture;
  std::string bitness;
  bool wow64 = false;
  std::string model;
  std::string navigator_platform;
};

inline UAPersona GetUAPersona() {
  UAPersona p;
  const std::string key = EnvStr("APEX_FP_UA_PLATFORM");
  if (!Active() || key.empty()) return p;
  std::string arch = EnvStr("APEX_FP_UA_ARCH");
  const std::string ver = EnvStr("APEX_FP_UA_PLATFORM_VERSION");
  if (key == "Windows") {
    p.ua_os_segment = "Windows NT 10.0; Win64; x64";
    p.platform = "Windows";
    p.platform_version = ver.empty() ? "15.0.0" : ver;
    if (arch.empty()) arch = "x86";
    p.navigator_platform = "Win32";
  } else if (key == "macOS") {
    p.ua_os_segment = "Macintosh; Intel Mac OS X 10_15_7";
    p.platform = "macOS";
    p.platform_version = ver.empty() ? "26.7.2" : ver;
    if (arch.empty()) arch = "arm";
    p.navigator_platform = "MacIntel";
  } else if (key == "Linux") {
    p.ua_os_segment = "X11; Linux x86_64";
    p.platform = "Linux";
    p.platform_version = "";
    if (arch.empty()) arch = "x86";
    p.navigator_platform = "Linux x86_64";
  } else {
    return p;
  }
  p.architecture = (arch == "arm") ? "arm" : "x86";
  p.bitness = "64";
  p.wow64 = false;
  p.model = "";
  p.active = true;
  return p;
}

}  // namespace apex_fp

#endif  // APEX_CHROMIUM_FINGERPRINT_H_
