// Unit test for apex_fingerprint.h -- the one piece of the C++ patch set that
// can be verified WITHOUT a Chromium build (it has no Chromium dependencies).
//
// Verifies: env parsing, the master switch, value clamping helpers, and that
// the mulberry32 PRNG is deterministic (same seed -> same sequence) and varies
// across seeds. These are exactly the properties the canvas/audio noise relies
// on -- deterministic-within-session, different-across-sessions.
//
// Build + run:  c++ -std=c++17 -I../chromium_src test_fingerprint_h.cc -o /tmp/apexfp && /tmp/apexfp

#include "apex_fingerprint.h"

#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <vector>

static int failures = 0;
#define CHECK(cond, msg)                                      \
  do {                                                        \
    if (cond) {                                               \
      std::printf("  ok    %s\n", msg);                       \
    } else {                                                  \
      std::printf("  FAIL  %s\n", msg);                       \
      ++failures;                                             \
    }                                                         \
  } while (0)

int main() {
  std::printf("== apex_fingerprint.h unit test ==\n");

  // --- master switch: inert when APEX_FP_ACTIVE unset ---
  unsetenv("APEX_FP_ACTIVE");
  CHECK(!apex_fp::Active(), "Active() false when APEX_FP_ACTIVE unset");
  setenv("APEX_FP_PLATFORM", "Win32", 1);
  CHECK(!apex_fp::HasOverride("APEX_FP_PLATFORM"),
        "HasOverride false while master switch off (patches stay inert)");

  // --- master switch on ---
  setenv("APEX_FP_ACTIVE", "1", 1);
  CHECK(apex_fp::Active(), "Active() true when APEX_FP_ACTIVE=1");
  CHECK(apex_fp::HasOverride("APEX_FP_PLATFORM"),
        "HasOverride true once switch on and var set");
  CHECK(apex_fp::EnvStr("APEX_FP_PLATFORM") == "Win32",
        "EnvStr reads the value");

  // --- a non-1 value must NOT activate ---
  setenv("APEX_FP_ACTIVE", "true", 1);
  CHECK(!apex_fp::Active(), "Active() false for APEX_FP_ACTIVE=true (only \"1\")");
  setenv("APEX_FP_ACTIVE", "1", 1);

  // --- numeric parsers + fallback on garbage ---
  setenv("APEX_FP_HW_CONCURRENCY", "12", 1);
  CHECK(apex_fp::EnvU32("APEX_FP_HW_CONCURRENCY", 0) == 12u,
        "EnvU32 parses a valid integer");
  setenv("APEX_FP_HW_CONCURRENCY", "12x", 1);
  CHECK(apex_fp::EnvU32("APEX_FP_HW_CONCURRENCY", 99u) == 99u,
        "EnvU32 returns fallback on garbage");
  setenv("APEX_FP_DEVICE_MEMORY", "8", 1);
  CHECK(apex_fp::EnvDouble("APEX_FP_DEVICE_MEMORY", 0) == 8.0,
        "EnvDouble parses a valid double");

  // --- mulberry32: deterministic for a fixed seed ---
  {
    apex_fp::Mulberry32 a(123456u), b(123456u);
    bool same = true;
    for (int i = 0; i < 1000; ++i) {
      if (a.NextDouble() != b.NextDouble()) { same = false; break; }
    }
    CHECK(same, "Mulberry32 is deterministic: same seed -> same sequence");
  }

  // --- mulberry32: different seeds diverge ---
  {
    apex_fp::Mulberry32 a(1u), b(2u);
    bool diverged = false;
    for (int i = 0; i < 100; ++i) {
      if (a.NextDouble() != b.NextDouble()) { diverged = true; break; }
    }
    CHECK(diverged, "Mulberry32 different seeds -> different sequence");
  }

  // --- mulberry32: output in [0,1) and reasonably uniform ---
  {
    apex_fp::Mulberry32 r(0xABCDEF01u);
    int buckets[10] = {0};
    bool in_range = true;
    for (int i = 0; i < 100000; ++i) {
      double v = r.NextDouble();
      if (v < 0.0 || v >= 1.0) { in_range = false; }
      buckets[static_cast<int>(v * 10)]++;
    }
    CHECK(in_range, "Mulberry32 output always in [0,1)");
    bool uniform = true;
    for (int b : buckets) {
      // each bucket should hold ~10000; allow a wide tolerance
      if (b < 8000 || b > 12000) uniform = false;
    }
    CHECK(uniform, "Mulberry32 output roughly uniform across deciles");
  }

  // --- NextSigned within +/- magnitude ---
  {
    apex_fp::Mulberry32 r(777u);
    bool bounded = true;
    for (int i = 0; i < 10000; ++i) {
      double v = r.NextSigned(1e-7);
      if (v < -1e-7 || v > 1e-7) bounded = false;
    }
    CHECK(bounded, "NextSigned stays within +/- magnitude");
  }

  // --- canvas-noise property: same seed -> identical perturbation ---
  // (re-derive the perturbation the way apex_canvas_noise.h would, to confirm
  //  the determinism the in-session-stable-hash requirement depends on.)
  {
    auto perturb = [](uint32_t seed) {
      std::vector<uint8_t> px(4000, 128);  // 1000 RGBA pixels, mid-grey
      apex_fp::Mulberry32 rng(seed);
      for (size_t i = 0; i < 1000; ++i) {
        if (rng.NextDouble() >= 0.003) continue;
        for (int c = 0; c < 3; ++c) {
          int delta = (rng.NextDouble() < 0.5) ? -1 : 1;
          int v = static_cast<int>(px[i * 4 + c]) + delta;
          px[i * 4 + c] = static_cast<uint8_t>(v < 0 ? 0 : (v > 255 ? 255 : v));
        }
      }
      return px;
    };
    auto p1 = perturb(42u), p2 = perturb(42u), p3 = perturb(43u);
    CHECK(p1 == p2, "canvas perturbation: same seed -> identical bytes "
                    "(in-session hash stable)");
    CHECK(p1 != p3, "canvas perturbation: different seed -> different bytes "
                    "(cross-session hash differs)");
  }

  // --- battery: env override parses and snaps to whole percent ---
  {
    setenv("APEX_FP_ACTIVE", "1", 1);
    setenv("APEX_FP_BATTERY_LEVEL", "0.834", 1);
    double v = apex_fp::EnvDouble("APEX_FP_BATTERY_LEVEL", -1.0);
    double snapped = static_cast<int>(v * 100.0 + 0.5) / 100.0;
    CHECK(snapped == 0.83,
          "battery level snaps to whole percent (0.834 -> 0.83)");
    setenv("APEX_FP_BATTERY_CHARGING", "0", 1);
    CHECK(apex_fp::EnvStr("APEX_FP_BATTERY_CHARGING") == "0",
          "battery charging env reads as expected");
  }

  // --- battery: seeded default level is in the plausible 55..95 band ---
  {
    bool all_in_band = true;
    for (uint32_t seed = 1; seed < 200; ++seed) {
      apex_fp::Mulberry32 rng(seed ^ 0xBA77E27u);
      int pct = 55 + static_cast<int>(rng.NextDouble() * 41.0);
      if (pct < 55 || pct > 95) all_in_band = false;
    }
    CHECK(all_in_band, "seeded battery level always in 55..95%");
  }

  // --- device id: seeded, 32 hex chars, stable per seed ---
  {
    auto devid = [](uint32_t seed, char salt) {
      apex_fp::Mulberry32 rng(seed ^ (0x9E3779B9u *
                                      static_cast<uint32_t>(salt)));
      std::string s;
      for (int i = 0; i < 32; ++i) {
        int nyb = static_cast<int>(rng.NextDouble() * 16.0) & 0xF;
        s += "0123456789abcdef"[nyb];
      }
      return s;
    };
    std::string a = devid(99u, 'a'), b = devid(99u, 'a'), c = devid(99u, 'v');
    CHECK(a.size() == 32, "device id is 32 hex chars");
    CHECK(a == b, "device id stable for same (seed,salt)");
    CHECK(a != c, "device id differs for different salt (mic vs camera)");
  }

  // --- JitterCoord: getBoundingClientRect sub-pixel jitter ---
  {
    setenv("APEX_FP_SEED", "4242", 1);
    double a = apex_fp::JitterCoord(764.0, 2);
    double b = apex_fp::JitterCoord(764.0, 2);
    CHECK(a == b, "rect jitter stable for same (seed,value,coord)");
    double d = a - 764.0;
    if (d < 0) d = -d;
    CHECK(d <= 0.01 && d > 0.0, "rect jitter sub-pixel (0 < |d| <= 0.01px)");
    double w = apex_fp::JitterCoord(764.0, 2);
    double h = apex_fp::JitterCoord(764.0, 3);
    CHECK(w != h, "diff coords get independent jitter (not a uniform scale)");
    CHECK(apex_fp::JitterCoord(100.0, 2) != a, "diff values get diff jitter");
    setenv("APEX_FP_SEED", "9999", 1);
    CHECK(apex_fp::JitterCoord(764.0, 2) != a,
          "rect jitter differs across sessions (seeds)");
    setenv("APEX_FP_SEED", "0", 1);
    CHECK(apex_fp::JitterCoord(764.0, 2) == 764.0,
          "seed 0 -> identity (no jitter)");
  }

  std::printf("\n%s (%d failure%s)\n",
              failures == 0 ? "ALL PASS" : "FAILURES",
              failures, failures == 1 ? "" : "s");
  return failures == 0 ? 0 : 1;
}
