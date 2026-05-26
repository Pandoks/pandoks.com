// apex_devices.h -- synthetic media-device list for enumerateDevices().
//
// An empty navigator.mediaDevices.enumerateDevices() result is a headless/VM
// tell. This helper, called from the patched MediaDevices::DevicesEnumerated,
// guarantees a realistic device set: one audio input, one audio output, one
// video input -- the shape of an ordinary laptop.
//
// Labels stay empty unless a getUserMedia permission was granted (matching real
// Chrome: un-permissioned pages see counts + kinds but blank labels). deviceId
// / groupId are derived from the session seed so repeat calls within a session
// agree, and differ across sessions.

#ifndef APEX_CHROMIUM_DEVICES_H_
#define APEX_CHROMIUM_DEVICES_H_

#include <string_view>
#include "apex_fingerprint.h"
#include "third_party/blink/renderer/modules/mediastream/media_device_info.h"
#include "third_party/blink/renderer/platform/heap/garbage_collected.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"
#include "third_party/blink/public/mojom/mediastream/media_devices.mojom-blink.h"

namespace apex_fp {

// A stable, opaque, hex device id derived from the session seed + a salt.
// Built with std::string (no C arrays / raw indexing) for -Wunsafe-buffer-usage.
inline blink::String SeededDeviceId(const char* salt) {
  uint32_t s = Seed() ? Seed() : 0x1234567u;
  // Mix the salt's first character into the seed (salt is a short literal).
  const char salt0 = (salt != nullptr && salt[0] != '\0') ? salt[0] : 'x';
  Mulberry32 rng(s ^ (0x9E3779B9u * static_cast<uint32_t>(
                          static_cast<unsigned char>(salt0))));
  const std::string kHex = "0123456789abcdef";
  std::string out;
  out.reserve(32);
  for (int i = 0; i < 32; ++i) {
    size_t nyb = static_cast<size_t>(rng.NextDouble() * 16.0) & 0xFu;
    out.push_back(kHex.at(nyb));  // .at() is bounds-checked
  }
  return blink::String::FromUtf8(std::string_view(out));
}

// Ensure `devices` holds a realistic set. If the real enumeration already
// returned audio+video devices, leave it; only fill in what is missing so a
// machine with a genuine webcam keeps its genuine list.
template <typename DeviceVector, typename ExecContext>
void EnsureRealisticDevices(DeviceVector* devices, ExecContext* /*context*/) {
  if (!Active() || devices == nullptr) {
    return;
  }
  using blink::MediaDeviceInfo;
  using Kind = blink::mojom::blink::MediaDeviceType;

  bool has_audio_in = false, has_audio_out = false, has_video_in = false;
  for (const auto& d : *devices) {
    switch (d->DeviceType()) {
      case Kind::kMediaAudioInput:  has_audio_in = true;  break;
      case Kind::kMediaAudioOutput: has_audio_out = true; break;
      case Kind::kMediaVideoInput:  has_video_in = true;  break;
      default: break;
    }
  }

  const blink::String group = SeededDeviceId("group");
  // Labels intentionally empty: real Chrome blanks them until a getUserMedia
  // grant. The presence + kind + count is what defeats the empty-list tell.
  const blink::String kEmpty = blink::String();

  if (!has_audio_in) {
    devices->push_back(blink::MakeGarbageCollected<MediaDeviceInfo>(
        SeededDeviceId("ain"), kEmpty, group, Kind::kMediaAudioInput));
  }
  if (!has_audio_out) {
    devices->push_back(blink::MakeGarbageCollected<MediaDeviceInfo>(
        SeededDeviceId("aout"), kEmpty, group, Kind::kMediaAudioOutput));
  }
  if (!has_video_in) {
    devices->push_back(blink::MakeGarbageCollected<MediaDeviceInfo>(
        SeededDeviceId("vin"), kEmpty, SeededDeviceId("vgroup"),
        Kind::kMediaVideoInput));
  }
}

}  // namespace apex_fp

#endif  // APEX_CHROMIUM_DEVICES_H_
