// apex_audio_noise.h -- deterministic per-session AudioContext perturbation.
//
// Audio fingerprinting renders a known waveform through an OfflineAudioContext
// and hashes the resulting samples; tiny DSP differences between machines make
// the hash a stable identifier. apex adds an imperceptible, deterministic
// per-session offset to the rendered samples so the hash differs per session.
//
//   * DETERMINISTIC within a session  -- seeded by APEX_FP_SEED.
//   * IMPERCEPTIBLE                   -- offset magnitude ~1e-7, far below
//     audible and far below normal float rounding error, but enough to move a
//     hash that sums/quantizes the samples.
//   * NATIVE                          -- applied in the C++ audio buffer path,
//     no patched JS getChannelData getter.
//
// Applied once, when an AudioBuffer's channel data is finalized -- NOT on every
// getChannelData() call (that would be non-deterministic and could be heard).

#ifndef APEX_CHROMIUM_AUDIO_NOISE_H_
#define APEX_CHROMIUM_AUDIO_NOISE_H_

#include <cstddef>
#include <cstddef>
#include <cstdint>

#include "base/containers/span.h"
#include "apex_fingerprint.h"

namespace apex_fp {

// Perturb a single channel of 32-bit float PCM in place.
//   samples : channel sample buffer (bounds-checked span)
//   channel : channel index -- mixed into the seed so L/R differ
//
// Every Nth sample receives a tiny signed offset. Sparse + tiny: inaudible,
// but a fingerprint that sums or reduces the buffer will shift deterministically.
// Takes a base::span so it compiles clean under -Wunsafe-buffer-usage; the
// Blink audio call site already has a span (DOMFloat32Array::AsSpan()).
inline void PerturbAudioChannel(base::span<float> samples, unsigned channel) {
  if (!Active() || samples.empty()) {
    return;
  }
  const uint32_t seed = Seed();
  if (seed == 0) {
    return;
  }
  // Mix the channel index into the seed so stereo channels get distinct,
  // still-deterministic noise.
  Mulberry32 rng(seed ^ (0x9E3779B9u * (channel + 1u)));
  const double kMagnitude = 1e-7;
  // Touch roughly every 100th sample.
  for (size_t i = 0; i < samples.size(); ++i) {
    if (rng.NextDouble() >= 0.01) {
      continue;
    }
    samples[i] += static_cast<float>(rng.NextSigned(kMagnitude));
  }
}

}  // namespace apex_fp

#endif  // APEX_CHROMIUM_AUDIO_NOISE_H_
