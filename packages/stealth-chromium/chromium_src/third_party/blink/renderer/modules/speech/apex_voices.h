// apex_voices.h -- synthetic speechSynthesis voice list.
//
// speechSynthesis.getVoices() returning an EMPTY list is a strong headless tell
// -- every real desktop OS ships TTS voices, and the voice list is itself an
// OS fingerprint (macOS has "Samantha"/"Alex", Windows has "Microsoft David"/
// "Zira"). A containerized Chrome with no speech engine returns nothing.
//
// The whole voice list reaches Blink as a Vector of mojom SpeechSynthesisVoice
// pointers, processed by SpeechSynthesis::OnSetVoiceList. The cleanest hook is
// to fill that mojom vector when it arrives empty -- so this helper builds
// mojom::blink::SpeechSynthesisVoicePtr entries, OS-consistent with the spoofed
// identity (APEX_FP_UA_PLATFORM).

#ifndef APEX_CHROMIUM_VOICES_H_
#define APEX_CHROMIUM_VOICES_H_

#include "apex_fingerprint.h"
#include "base/containers/span.h"
#include "third_party/blink/public/mojom/speech/speech_synthesis.mojom-blink.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"
#include "third_party/blink/renderer/platform/wtf/vector.h"

namespace apex_fp {

struct ApexVoiceSpec {
  const char* name;
  const char* lang;
  const char* uri;
  bool is_default;
};

// Voice specs returned as base::span (bounds-checked) -- range-for over a span
// is clean under -Wunsafe-buffer-usage.
inline base::span<const ApexVoiceSpec> MacVoiceSpecs() {
  static const ApexVoiceSpec kMac[] = {
    {"Samantha", "en-US", "com.apple.voice.compact.en-US.Samantha", true},
    {"Alex", "en-US", "com.apple.speech.synthesis.voice.Alex", false},
    {"Daniel", "en-GB", "com.apple.voice.compact.en-GB.Daniel", false},
    {"Karen", "en-AU", "com.apple.voice.compact.en-AU.Karen", false},
    {"Thomas", "fr-FR", "com.apple.voice.compact.fr-FR.Thomas", false},
  };
  return base::span<const ApexVoiceSpec>(kMac);
}

inline base::span<const ApexVoiceSpec> WinVoiceSpecs() {
  static const ApexVoiceSpec kWin[] = {
    {"Microsoft David - English (United States)", "en-US",
     "Microsoft David - English (United States)", true},
    {"Microsoft Zira - English (United States)", "en-US",
     "Microsoft Zira - English (United States)", false},
    {"Microsoft Mark - English (United States)", "en-US",
     "Microsoft Mark - English (United States)", false},
  };
  return base::span<const ApexVoiceSpec>(kWin);
}

// Fill `mojom_voices` with a realistic OS-consistent list if it arrived empty.
// VoiceVector is Vector<mojom::blink::SpeechSynthesisVoicePtr>.
template <typename VoiceVector>
void EnsureRealisticVoiceList(VoiceVector* mojom_voices) {
  if (!Active() || mojom_voices == nullptr || !mojom_voices->empty()) {
    return;
  }
  const std::string os = EnvStr("APEX_FP_UA_PLATFORM");
  base::span<const ApexVoiceSpec> specs =
      (os == "Windows") ? WinVoiceSpecs() : MacVoiceSpecs();
  for (const ApexVoiceSpec& spec : specs) {
    mojom_voices->push_back(blink::mojom::blink::SpeechSynthesisVoice::New(
        blink::String::FromUtf8(spec.uri),
        blink::String::FromUtf8(spec.name),
        blink::String::FromUtf8(spec.lang),
        /*is_local_service=*/true,
        /*is_default=*/spec.is_default));
  }
}

}  // namespace apex_fp

#endif  // APEX_CHROMIUM_VOICES_H_
