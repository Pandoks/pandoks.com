// apex_netinfo.h -- persona connection-quality overrides for navigator
// .connection (NetworkInformation), applied in NetworkStateNotifier::
// SetNetworkQuality, the single choke point where the browser's pushed
// network-quality values enter Blink (both the not-observing getters and the
// ConnectionChange observer cache read that state).
//
// The container tell: the container's NetworkChangeNotifier classifies the
// NIC as ETHERNET and NetworkQualityEstimator's platform default observation
// for ETHERNET is 90ms HTTP RTT / 1456 kbps (net/nqe/
// network_quality_estimator_params.cc), which the report rounding turns into
// rtt 100 / downlink 1.5 -- not what a desktop persona's machine reports
// (round-2 probe: stock {4g, downlink 10, rtt 50}).
//
// The override values are chosen to be REACHABLE by the real reporting path,
// so the reported numbers are still produced by RoundRtt/RoundMbps:
//   rtt 50ms    -> min(50 * mult, 3s) rounds to exactly 50 (the 50ms report
//                  granularity) for the whole 0.90..1.10 multiplier band.
//   10000 kbps  -> min(10000 * mult, kMaxDownlinkKbps) clamps to exactly
//                  10000 = the 10.0 Mbps report maximum for any multiplier.
// saveData is not overridden (stock is false).
//
// Env (all optional -- unset means "use the real Chromium value"):
//   APEX_FP_NETINFO_EFFECTIVE_TYPE   "slow-2g"|"2g"|"3g"|"4g"|"offline"
//                                    (NetworkInformation.idl enum names)
//   APEX_FP_NETINFO_RTT_MS           HTTP RTT in ms (-1/absent = keep real)
//   APEX_FP_NETINFO_DOWNLINK_KBPS    downlink kbps (-1/absent = keep real)
#ifndef THIRD_PARTY_BLINK_RENDERER_PLATFORM_NETWORK_APEX_NETINFO_H_
#define THIRD_PARTY_BLINK_RENDERER_PLATFORM_NETWORK_APEX_NETINFO_H_

#include <optional>
#include <string>

#include "third_party/blink/public/platform/web_effective_connection_type.h"
#include "third_party/blink/renderer/platform/network/apex_fingerprint.h"

namespace apex_netinfo {

// HTTP RTT override in ms, or -1 when unset.
inline int RttMsOverride() {
  return apex_fp::EnvInt("APEX_FP_NETINFO_RTT_MS", -1);
}

// Downlink override in kbps, or -1 when unset.
inline int DownlinkKbpsOverride() {
  return apex_fp::EnvInt("APEX_FP_NETINFO_DOWNLINK_KBPS", -1);
}

// Effective-connection-type override, or nullopt when unset/unrecognized.
// Values are the NetworkInformation.idl EffectiveConnectionType names.
inline std::optional<WebEffectiveConnectionType> EffectiveTypeOverride() {
  if (!apex_fp::Active()) {
    return std::nullopt;
  }
  const std::string v = apex_fp::EnvStr("APEX_FP_NETINFO_EFFECTIVE_TYPE");
  if (v == "slow-2g") {
    return WebEffectiveConnectionType::kTypeSlow2G;
  }
  if (v == "2g") {
    return WebEffectiveConnectionType::kType2G;
  }
  if (v == "3g") {
    return WebEffectiveConnectionType::kType3G;
  }
  if (v == "4g") {
    return WebEffectiveConnectionType::kType4G;
  }
  if (v == "offline") {
    return WebEffectiveConnectionType::kTypeOffline;
  }
  return std::nullopt;
}

}  // namespace apex_netinfo

#endif  // THIRD_PARTY_BLINK_RENDERER_PLATFORM_NETWORK_APEX_NETINFO_H_
