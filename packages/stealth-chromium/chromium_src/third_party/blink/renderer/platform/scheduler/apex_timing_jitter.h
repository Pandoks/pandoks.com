// apex_timing_jitter.h -- deterministic micro-jitter for animation
// frame and audio render timing.
//
// Why: a JS attacker can call performance.now() in a tight loop or sample
// requestAnimationFrame timestamps and compute the variance. A
// scheduler-pinned headless browser shows variance that's either too low
// (perfectly periodic = synthetic) or with a recognisable pattern
// (containers, VMs, software-clocked GL). Real browsers on real OS show
// scheduler-typical jitter in the ~10-100us range.
//
// This helper returns a deterministic, tiny offset in microseconds:
//
//   * deterministic per (session-seed, integer tick) so the jitter
//     pattern is reproducible within a session (a fluctuating pattern
//     between identical inputs is itself a detection signal).
//   * <= 50us magnitude -- imperceptible for animation/audio quality.
//   * NATIVE: applied in the scheduler dispatch path; the JS-facing
//     `performance.now()` API and its toString stay pristine.

#ifndef APEX_CHROMIUM_TIMING_JITTER_H_
#define APEX_CHROMIUM_TIMING_JITTER_H_

#include <cstdint>

#include "apex_fingerprint.h"

namespace apex_fp {

// Returns a per-tick jitter in microseconds in [-50, +50]. tick is any
// monotonically-increasing integer that identifies the frame/quantum
// (typically the cumulative frame count or a hash of the timestamp).
inline double JitterMicros(uint64_t tick) {
  if (!Active()) {
    return 0.0;
  }
  uint32_t seed = Seed();
  if (seed == 0) {
    return 0.0;
  }
  // Mix seed and tick deterministically.
  uint32_t mixed = seed ^ static_cast<uint32_t>(tick) ^
                   static_cast<uint32_t>(tick >> 32);
  if (mixed == 0) {
    mixed = 1u;
  }
  Mulberry32 rng(mixed);
  double u = rng.NextDouble();  // [0, 1)
  double centred = (u - 0.5) * 2.0;  // [-1, +1)
  return centred * 50.0;  // microseconds
}

}  // namespace apex_fp

#endif  // APEX_CHROMIUM_TIMING_JITTER_H_
