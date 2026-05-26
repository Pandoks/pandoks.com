// apex_canvas_noise.h -- deterministic per-session canvas perturbation.
//
// Canvas fingerprinting hashes the exact RGBA bytes a <canvas> produces. Two
// machines with the same GPU/driver/fonts produce byte-identical output -> a
// stable cross-machine identifier. apex perturbs a tiny fraction of pixels so
// the hash differs per session, while staying:
//
//   * DETERMINISTIC within a session  -- seeded by APEX_FP_SEED, so a page
//     hashing the same canvas twice gets the same bytes (a fluctuating hash is
//     itself a detection signal).
//   * IMPERCEPTIBLE                   -- +/-1 on a sparse ~0.3% of pixels;
//     invisible to a human, but it moves the hash.
//   * NATIVE                          -- applied in the C++ pixel path, so
//     there is no patched JS getImageData/toDataURL getter for CreepJS's
//     stealth detector to catch.
//
// Buffers are taken as base::span (Chromium's bounds-checked view) so this
// header compiles clean under -Wunsafe-buffer-usage.

#ifndef APEX_CHROMIUM_CANVAS_NOISE_H_
#define APEX_CHROMIUM_CANVAS_NOISE_H_

#include <cstdint>
#include <cstddef>

#include "base/compiler_specific.h"  // UNSAFE_BUFFERS
#include "base/containers/span.h"
#include "apex_fingerprint.h"

namespace apex_fp {

// Perturb an RGBA8 pixel buffer in place. `pixels` is a bounds-checked span of
// tightly-packed RGBA bytes (4 per pixel). Each pixel is independently,
// deterministically considered for a +/-1 nudge on its R/G/B channels (alpha
// left untouched). The seed makes the pattern reproducible for a given session.
inline void PerturbRGBASpan(base::span<uint8_t> pixels) {
  if (!Active() || pixels.empty()) {
    return;
  }
  const uint32_t seed = Seed();
  if (seed == 0) {
    return;  // no seed -> no noise
  }
  const size_t count = pixels.size() / 4u;

  // ~0.3% of pixels get touched. Sparse enough to be invisible, dense enough
  // to reliably move a hash over any non-trivial canvas.
  Mulberry32 rng(seed);
  for (size_t i = 0; i < count; ++i) {
    // Per-pixel decision, deterministic in (seed, i).
    if (rng.NextDouble() >= 0.003) {
      continue;
    }
    base::span<uint8_t> px = pixels.subspan(i * 4u, 4u);
    for (size_t c = 0; c < 3u; ++c) {  // R, G, B -- skip A
      int delta = (rng.NextDouble() < 0.5) ? -1 : 1;
      int v = static_cast<int>(px[c]) + delta;
      if (v < 0) v = 0;
      if (v > 255) v = 255;
      px[c] = static_cast<uint8_t>(v);
    }
  }
}

// Raw-pointer convenience overload for call sites that only have a void*/
// uint8_t* (e.g. SkPixmap::writable_addr()). The single pointer->span
// conversion is the one unavoidable unsafe step and is wrapped accordingly.
inline void PerturbRGBA(uint8_t* pixels, size_t pixel_count) {
  if (pixels == nullptr || pixel_count == 0) {
    return;
  }
  PerturbRGBASpan(
      // SAFETY: the caller guarantees `pixels` points to at least
      // pixel_count*4 valid RGBA bytes (a real SkPixmap of that size).
      UNSAFE_BUFFERS(base::span<uint8_t>(pixels, pixel_count * 4u)));
}

}  // namespace apex_fp

#endif  // APEX_CHROMIUM_CANVAS_NOISE_H_
