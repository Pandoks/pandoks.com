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
#include "third_party/blink/renderer/modules/webgl/apex_webgl_limits.h"

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

  {
    // Canvas-farbling helpers (Mix64 / EnvU64 / CanvasKey): the v2 canvas
    // lock keys off these, so their behaviour is part of the contract.
    const uint64_t m1 = apex_fp::Mix64(1), m2 = apex_fp::Mix64(1);
    const uint64_t m3 = apex_fp::Mix64(2);
    CHECK(m1 == m2, "Mix64 is deterministic");
    CHECK(m1 != m3, "Mix64 avalanche: different input -> different output");
    setenv("APEX_FP_U64TEST", "18446744073709551616", 1);  // 2^64: overflows
    CHECK(apex_fp::EnvU64("APEX_FP_U64TEST", 0) == 0,  // > u64 max -> fallback
          "EnvU64 overflow guard: > 2^64-1 parses to fallback");
    setenv("APEX_FP_U64TEST", "18446744073709551615", 1);  // 2^64-1: fits
    CHECK(apex_fp::EnvU64("APEX_FP_U64TEST", 0) == 18446744073709551615ull,
          "EnvU64 parses u64 max exactly");
    setenv("APEX_FP_U64TEST", "bad1x", 1);
    CHECK(apex_fp::EnvU64("APEX_FP_U64TEST", 7) == 7,
          "EnvU64 non-numeric -> fallback");
    // CanvasKey: with an explicit key env it returns it; without, the fallback
    // is Mix64(seed) and must be non-zero for a non-zero seed (the mask gate
    // keys on key != 0).
    setenv("APEX_FP_CANVAS_KEY", "12345678901234567890", 1);
    setenv("APEX_FP_SEED", "0", 1);
    CHECK(apex_fp::CanvasKey() == 12345678901234567890ull,
          "CanvasKey returns the explicit APEX_FP_CANVAS_KEY");
    unsetenv("APEX_FP_CANVAS_KEY");
    setenv("APEX_FP_SEED", "4242", 1);
    CHECK(apex_fp::CanvasKey() == 0,
          "CanvasKey unset -> 0 (fail closed: no 32-bit fallback)");
    unsetenv("APEX_FP_U64TEST");
  }

  // --- persona OS predicates: PersonaIsDesktop (device-sensor suppression) ---
  // The device-sensor suppression (device_single_window_event_controller.cc)
  // keys on this: desktop personas get no deviceorientation/devicemotion
  // events, mobile personas (Android / iOS) keep the stock behavior.
  unsetenv("APEX_FP_ACTIVE");
  unsetenv("APEX_FP_UA_PLATFORM");
  CHECK(!apex_fp::PersonaIsDesktop(),
        "PersonaIsDesktop false while the master switch is off");
  setenv("APEX_FP_ACTIVE", "1", 1);
  CHECK(!apex_fp::PersonaIsDesktop(),
        "PersonaIsDesktop false when APEX_FP_UA_PLATFORM is unset");
  setenv("APEX_FP_UA_PLATFORM", "Windows", 1);
  CHECK(apex_fp::PersonaIsDesktop(), "PersonaIsDesktop true for Windows");
  setenv("APEX_FP_UA_PLATFORM", "macOS", 1);
  CHECK(apex_fp::PersonaIsDesktop(), "PersonaIsDesktop true for macOS");
  setenv("APEX_FP_UA_PLATFORM", "Android", 1);
  CHECK(!apex_fp::PersonaIsDesktop(), "PersonaIsDesktop false for Android");
  setenv("APEX_FP_UA_PLATFORM", "iOS", 1);
  CHECK(!apex_fp::PersonaIsDesktop(), "PersonaIsDesktop false for iOS");
  unsetenv("APEX_FP_UA_PLATFORM");

  // --- WebGL limits (apex_webgl_limits.h): backend gating + table lookup ---
  {
    using apex_webgl::Backend;
    auto persona = [](const char* os, const char* vendor, const char* renderer) {
      setenv("APEX_FP_ACTIVE", "1", 1);
      setenv("APEX_FP_UA_PLATFORM", os, 1);
      setenv("APEX_FP_WEBGL_VENDOR", vendor, 1);
      setenv("APEX_FP_WEBGL_RENDERER", renderer, 1);
    };
    auto lim = [](Backend b, uint32_t pname) {
      int64_t v = -12345;
      return apex_webgl::IntLimit(b, pname, &v) ? v : -12345;
    };
    // Persona rows as fp_profiles.py emits them.
    persona("Windows", "Google Inc. (Intel)",
            "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x000046A6) "
            "Direct3D11 vs_5_0 ps_5_0, D3D11)");
    const Backend d3d = apex_webgl::ClaimedBackend();
    CHECK(d3d == Backend::kD3D11, "Windows D3D11 persona -> D3D11 table");
    CHECK(lim(d3d, 0x8DFB) == 4096 && lim(d3d, 0x8DFC) == 30,
          "D3D11: MAX_VERTEX_UNIFORM_VECTORS 4096, MAX_VARYING_VECTORS 30");
    CHECK(lim(d3d, 0x8DFD) == 1024 && lim(d3d, 0x0D33) == 16384,
          "D3D11: MAX_FRAGMENT_UNIFORM_VECTORS 1024, MAX_TEXTURE_SIZE 16384");
    CHECK(lim(d3d, 0x8D6B) == 4294967294LL && lim(d3d, 0x9111) == 0,
          "D3D11: MAX_ELEMENT_INDEX 2^32-2, MAX_SERVER_WAIT_TIMEOUT 0");
    CHECK(lim(d3d, 0x8D57) == -12345,
          "MAX_SAMPLES is not in the table (device-derived; stays real)");
    float lo = 0, hi = 0;
    CHECK(apex_webgl::FloatRange(d3d, 0x846E, &lo, &hi) && lo == 1 && hi == 1,
          "D3D11: ALIASED_LINE_WIDTH_RANGE [1,1]");
    CHECK(apex_webgl::FloatRange(d3d, 0x846D, &lo, &hi) && hi == 1024,
          "D3D11: ALIASED_POINT_SIZE_RANGE [1,1024]");
    int32_t w = 0, h = 0;
    CHECK(apex_webgl::ViewportDims(d3d, &w, &h) && w == 32767 && h == 32767,
          "D3D11: MAX_VIEWPORT_DIMS [32767,32767]");

    persona("Windows", "Google Inc. (NVIDIA)",
            "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) "
            "Direct3D11 vs_5_0 ps_5_0, D3D11)");
    const Backend nv = apex_webgl::ClaimedBackend();
    CHECK(lim(nv, 0x8DFB) == 4095 && lim(nv, 0x8B4A) == 16380 &&
              lim(nv, 0x8A31) == 212988,
          "D3D11 NVIDIA: skipVSConstantRegisterZero costs one vertex vector");

    persona("macOS", "Google Inc. (Apple)",
            "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)");
    const Backend mtl = apex_webgl::ClaimedBackend();
    CHECK(mtl == Backend::kMetal, "macOS Metal persona -> Metal table");
    CHECK(lim(mtl, 0x8DFB) == 1024 && lim(mtl, 0x8A30) == 16384 &&
              lim(mtl, 0x8A2F) == 32,
          "Metal: 1024 vertex vectors, 16 KiB UBOs, 32 UBO bindings");
    CHECK(apex_webgl::FloatRange(mtl, 0x846D, &lo, &hi) && hi == 511,
          "Metal: ALIASED_POINT_SIZE_RANGE [1,511]");
    CHECK(apex_webgl::ViewportDims(mtl, &w, &h) && w == 16384,
          "Metal: MAX_VIEWPORT_DIMS [16384,16384]");

    // Fail closed: wrong OS for the string, non-D3D11 string, switch off.
    persona("macOS", "Google Inc. (Intel)",
            "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 "
            "ps_5_0, D3D11)");
    CHECK(apex_webgl::ClaimedBackend() == Backend::kNone,
          "D3D11 string on a macOS persona -> no table");
    persona("Windows", "Google Inc. (Intel)",
            "ANGLE (Intel, Intel(R) HD Graphics Direct3D9Ex vs_3_0 ps_3_0, "
            "d3d9)");
    CHECK(apex_webgl::ClaimedBackend() == Backend::kNone,
          "D3D9 string -> no table (never the wrong backend's values)");
    setenv("APEX_FP_ACTIVE", "0", 1);
    CHECK(apex_webgl::ClaimedBackend() == Backend::kNone,
          "master switch off -> no table");
    CHECK(!apex_webgl::IntLimit(Backend::kNone, 0x0D33, nullptr),
          "kNone answers nothing");

    // The real context already on the claimed backend keeps its own values.
    CHECK(apex_webgl::EffectiveBackend(
              Backend::kMetal,
              "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified "
              "Version)") == Backend::kNone,
          "Metal persona on a real Metal context -> real values");
    CHECK(apex_webgl::EffectiveBackend(
              Backend::kD3D11,
              "ANGLE (Mesa, llvmpipe (LLVM 19.1.7 256 bits), OpenGL 4.5)") ==
              Backend::kD3D11,
          "D3D11 persona on llvmpipe -> spoofed");

    // viewport(0,0,30000,40000): llvmpipe stored [0,0,16384,16384]; D3D11
    // would hold [0,0,30000,32767].
    apex_webgl::Viewport out;
    CHECK(apex_webgl::ReportedViewport(Backend::kD3D11, {0, 0, 30000, 40000},
                                       {0, 0, 16384, 16384}, 16384, 16384,
                                       &out) &&
              out.w == 30000 && out.h == 32767,
          "VIEWPORT reports the claimed backend's clamp of the request");
    CHECK(!apex_webgl::ReportedViewport(Backend::kD3D11, {0, 0, 30000, 40000},
                                        {0, 0, 640, 480}, 16384, 16384, &out),
          "VIEWPORT moved by something else -> real value kept");

    int32_t rmin = 0, rmax = 0, prec = -1;
    CHECK(apex_webgl::Precision(d3d, 0x8DF1, &rmin, &rmax, &prec) &&
              rmin == 127 && rmax == 127 && prec == 23,
          "MEDIUM_FLOAT precision {127,127,23}");
    CHECK(apex_webgl::Precision(mtl, 0x8DF3, &rmin, &rmax, &prec) &&
              rmin == 31 && rmax == 30 && prec == 0,
          "LOW_INT precision {31,30,0}");
    unsetenv("APEX_FP_UA_PLATFORM");
    unsetenv("APEX_FP_WEBGL_VENDOR");
    unsetenv("APEX_FP_WEBGL_RENDERER");
  }

  std::printf("\n%s (%d failure%s)\n",
              failures == 0 ? "ALL PASS" : "FAILURES",
              failures, failures == 1 ? "" : "s");
  return failures == 0 ? 0 : 1;
}