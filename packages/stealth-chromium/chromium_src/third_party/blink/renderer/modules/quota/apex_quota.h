// apex_quota.h -- persona storage-quota override for StorageManager.
//
// StorageManager::estimate() reports the per-origin quota the browser derives
// from the HOST disk: storage/browser/quota/quota_settings.cc computes
// pool = total_disk * kPoolSizeRatio (0.8), per_key = pool * 0.75 -- i.e. 60%
// of the total disk capacity -- so the reported quota is the CONTAINER's disk
// size, not the persona's claimed machine (the round-2 probe caught the
// baseline at exactly 10 GiB). fp_profiles.py computes the persona quota with
// the same stock formula from the persona's claimed disk size and emits it in
// APEX_FP_STORAGE_QUOTA_BYTES; StorageManager applies it here, after the
// browser's answer, so the reported number is byte-identical to what stock
// Chrome would report on a disk of the claimed size.
//
// usageDetails is NOT overridden: the empty object is the real Chrome shape
// for a profile with no stored data (the field is populated only for non-zero
// usage breakdowns), which matches a fresh profile.
//
// Env: APEX_FP_STORAGE_QUOTA_BYTES = decimal byte count. Unset or 0 = no
// override (the real browser quota is reported).
#ifndef THIRD_PARTY_BLINK_RENDERER_MODULES_QUOTA_APEX_QUOTA_H_
#define THIRD_PARTY_BLINK_RENDERER_MODULES_QUOTA_APEX_QUOTA_H_

#include <cstdint>

#include "third_party/blink/renderer/modules/quota/apex_fingerprint.h"

namespace apex_quota {

// The persona quota in bytes, or 0 when no override is configured. The
// generic env helpers parse only int, so the 64-bit byte count is parsed here.
inline int64_t QuotaBytes() {
  if (!apex_fp::Active()) {
    return 0;
  }
  const std::string v = apex_fp::EnvStr("APEX_FP_STORAGE_QUOTA_BYTES");
  if (v.empty()) {
    return 0;
  }
  int64_t acc = 0;
  for (char c : v) {
    if (c < '0' || c > '9') {
      return 0;
    }
    acc = acc * 10 + (c - '0');
  }
  return acc;
}

}  // namespace apex_quota

#endif  // THIRD_PARTY_BLINK_RENDERER_MODULES_QUOTA_APEX_QUOTA_H_
