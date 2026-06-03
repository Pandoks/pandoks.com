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
//   APEX_FP_NET_RTT          uint ms, navigator.connection.rtt (rounded /50)
//   APEX_FP_NET_DOWNLINK     float Mbps, navigator.connection.downlink
//   APEX_FP_NET_EFFECTIVE_TYPE  navigator.connection.effectiveType
//                            ("slow-2g"|"2g"|"3g"|"4g")
//   APEX_FP_STORAGE_QUOTA    uint64 bytes, navigator.storage.estimate().quota
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

inline uint64_t EnvU64(const char* name, uint64_t fallback) {
  std::string s = EnvStr(name);
  if (s.empty()) return fallback;
  uint64_t acc = 0;
  for (char c : s) {
    if (c < '0' || c > '9') return fallback;
    // Overflow guard: reject anything that would wrap past UINT64_MAX.
    if (acc > (0xFFFFFFFFFFFFFFFFull - static_cast<uint64_t>(c - '0')) / 10u) {
      return fallback;
    }
    acc = acc * 10u + static_cast<uint64_t>(c - '0');
  }
  return acc;
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

}  // namespace apex_fp

#endif  // APEX_CHROMIUM_FINGERPRINT_H_
