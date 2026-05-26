// apex_text_metrics_noise.h -- deterministic per-session farbling of
// CanvasRenderingContext2D::measureText() output.
//
// Why patch TextMetrics: a JS attacker calls ctx.measureText() across many
// font names ("Arial", "Helvetica", ...) and hashes the resulting widths.
// On an unpatched browser the hash is stable per machine -> a stable
// cross-session identifier (font fingerprinting). With this patch each
// metric is multiplied by 1 + epsilon, where epsilon is a tiny
// deterministic perturbation seeded by (session, font, text). Concretely:
//
//   * +/- 0.0003% deviation (Brave-level). Imperceptible to humans / layout.
//   * STABLE within a session (a fluctuating hash is itself a detection
//     signal, so we seed deterministically and avoid per-call randomness).
//   * DIFFERENT across sessions (APEX_FP_SEED changes per session).
//   * NATIVE: applied in the C++ TextMetrics::Update path, so neither
//     measureText nor any TextMetrics getter has its toString tampered.

#ifndef APEX_CHROMIUM_TEXT_METRICS_NOISE_H_
#define APEX_CHROMIUM_TEXT_METRICS_NOISE_H_

#include <cstdint>
#include <string>

#include "apex_fingerprint.h"

namespace apex_fp {

// Deterministic per-(seed, font_id, text) scale factor close to 1.0.
// font_id is any stable identifier for the requested font (the canonicalised
// family name works); text is the string passed to measureText.
inline double TextMetricNoiseFactor(const std::string& font_id,
                                    const std::string& text) {
  if (!Active()) {
    return 1.0;
  }
  uint32_t seed = Seed();
  if (seed == 0) {
    return 1.0;
  }
  // Mix font_id + text into the seed with FNV-1a (32-bit, cheap, stable).
  uint32_t h = seed ^ 0x811c9dc5u;
  for (char c : font_id) {
    h ^= static_cast<uint8_t>(c);
    h *= 0x01000193u;
  }
  // delimiter so "ab"+"c" != "a"+"bc"
  h ^= 0xffu;
  h *= 0x01000193u;
  for (char c : text) {
    h ^= static_cast<uint8_t>(c);
    h *= 0x01000193u;
  }
  // Map h to a centred [-1, +1] double, then scale to a tiny epsilon.
  Mulberry32 rng(h ? h : 1u);
  double u = rng.NextDouble();  // [0, 1)
  double centred = (u - 0.5) * 2.0;  // [-1, +1)
  // 6e-6 = +/- 0.0003%, matching Brave's measureText farbling level.
  return 1.0 + centred * 6e-6;
}

}  // namespace apex_fp

#endif  // APEX_CHROMIUM_TEXT_METRICS_NOISE_H_
