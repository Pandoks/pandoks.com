// apex chromium_src overlay: navigator_device_memory.cc
//
// Spoofs navigator.deviceMemory natively. COMPLETE replacement of the upstream
// file (a single trivial function) -- simpler and more robust than
// redefine-then-include.
//
// deviceMemory is web-exposed only as a quantized power of two in [0.25, 8]:
// {0.25, 0.5, 1, 2, 4, 8}. We snap the env value to that set so the spoofed
// value is indistinguishable from a real one. Stock behavior is preserved when
// APEX_FP_DEVICE_MEMORY is unset.

#include "third_party/blink/renderer/core/frame/navigator_device_memory.h"

#include "third_party/blink/public/common/device_memory/approximated_device_memory.h"

#include "apex_fingerprint.h"

namespace blink {

namespace {

// Snap to the nearest value web pages can legitimately observe.
float ApexSnapDeviceMemory(double requested) {
  const float kBuckets[] = {0.25f, 0.5f, 1.0f, 2.0f, 4.0f, 8.0f};
  float best = kBuckets[0];
  double best_dist = 1e9;
  for (float b : kBuckets) {
    double d = requested > b ? requested - b : b - requested;
    if (d < best_dist) {
      best_dist = d;
      best = b;
    }
  }
  return best;
}

}  // namespace

float NavigatorDeviceMemory::deviceMemory() const {
  if (apex_fp::HasOverride("APEX_FP_DEVICE_MEMORY")) {
    double v = apex_fp::EnvDouble("APEX_FP_DEVICE_MEMORY", 0.0);
    if (v > 0.0) {
      return ApexSnapDeviceMemory(v);
    }
  }
  return ApproximatedDeviceMemory::GetApproximatedDeviceMemory();
}

}  // namespace blink
