// apex chromium_src overlay: navigator_concurrent_hardware.cc
//
// Spoofs navigator.hardwareConcurrency natively. This is a COMPLETE
// replacement of the upstream file (which is a single trivial function) --
// simpler and more robust than the redefine-then-include trick, which breaks
// when the method name also appears in the included header.
//
// Stock behavior is preserved when APEX_FP_HW_CONCURRENCY is unset: it falls
// back to base::SysInfo::NumberOfProcessors(), exactly what upstream returns.

#include "third_party/blink/renderer/core/frame/navigator_concurrent_hardware.h"

#include "base/system/sys_info.h"

#include "apex_fingerprint.h"

namespace blink {

unsigned NavigatorConcurrentHardware::hardwareConcurrency() const {
  if (apex_fp::HasOverride("APEX_FP_HW_CONCURRENCY")) {
    // navigator.hardwareConcurrency is always a positive integer; clamp to a
    // plausible desktop range so a bad env value cannot produce an absurd one.
    uint32_t v = apex_fp::EnvU32("APEX_FP_HW_CONCURRENCY", 0);
    if (v >= 2 && v <= 64) {
      return static_cast<unsigned>(v);
    }
  }
  return static_cast<unsigned>(base::SysInfo::NumberOfProcessors());
}

}  // namespace blink
