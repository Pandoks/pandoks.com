// apex_voices.h -- synthetic speechSynthesis voice list.
//
// speechSynthesis.getVoices() returning an EMPTY list is a strong headless tell
// -- every real desktop OS ships TTS voices, and the voice list is itself an
// OS fingerprint. A containerized Chrome with no speech engine returns nothing,
// and "0 Google TTS voices" is a CreepJS likeHeadless red pill.
//
// The whole voice list reaches Blink as a Vector of mojom SpeechSynthesisVoice
// pointers, processed by SpeechSynthesis::OnSetVoiceList. The cleanest hook is
// to fill that mojom vector when it arrives empty -- so this helper builds
// mojom::blink::SpeechSynthesisVoicePtr entries, OS-consistent with the spoofed
// identity (APEX_FP_UA_PLATFORM: "macOS" / "Windows" / anything else = Linux,
// the same switch apex_font_policy.h uses).
//
// How real Chrome builds the list (content/browser/speech, Chromium 157):
//   * TtsControllerImpl::GetVoices: platform (native) voices FIRST, then the
//     "Google Network Speech" component extension voices (remote).
//   * SpeechSynthesisImpl::SendVoiceListToObserver: voice_uri = name for EVERY
//     voice, is_local_service = !remote, is_default = (index == 0). There is
//     no per-OS URI scheme ("com.apple.voice..." never reaches the page).
//   * macOS (tts_mac.mm): AVSpeechSynthesisVoice.speechVoices sorted by name
//     (NSString compare:), system default voice hoisted to index 0, duplicate
//     names disambiguated as "Name (Localized language)" in the user locale.
//     Data below: stock compact voices, en-US locale, default voice Samantha.
//   * Windows (tts_win.cc): OneCore voice tokens, description + LCID locale.
//     Stock en-US Windows 11 ships David, Mark, Zira.
//   * Linux (tts_linux.cc): speech-dispatcher modules x synthesis voices,
//     keyed "<voice name> <module>" in a std::map (byte order). Ubuntu 24.04
//     desktop ships speech-dispatcher 0.12.0~rc2 + espeak-ng 1.51: the espeak
//     module lists every language voice plus "<voice>+<variant>" for each
//     variant, so the real list is (languages x (1 + variants)) entries.
//   * Google network voices: chrome/browser/resources/network_speech_synthesis/
//     manifest.json (19 voices, remote=true, manifest order), appended last.

#ifndef APEX_CHROMIUM_VOICES_H_
#define APEX_CHROMIUM_VOICES_H_

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

#include "apex_fingerprint.h"
#include "base/containers/span.h"
#include "third_party/blink/public/mojom/speech/speech_synthesis.mojom-blink.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"
#include "third_party/blink/renderer/platform/wtf/vector.h"

namespace apex_fp {

struct ApexVoiceSpec {
  const char* name;
  const char* lang;
};

// One entry of the final list. voice_uri == name (Chrome does the same).
struct ApexVoice {
  std::string name;
  std::string lang;
  bool is_local_service;
};

// --- Google Network Speech component extension (remote voices) -------------
// Source: chrome/browser/resources/network_speech_synthesis/manifest.json
// (Chromium 157.0.8103.27). Same order as the manifest.
inline base::span<const ApexVoiceSpec> GoogleNetworkVoiceSpecs() {
  static const ApexVoiceSpec kGoogle[] = {
    {"Google Deutsch", "de-DE"},
    {"Google US English", "en-US"},
    {"Google UK English Female", "en-GB"},
    {"Google UK English Male", "en-GB"},
    {"Google español", "es-ES"},
    {"Google español de Estados Unidos", "es-US"},
    {"Google français", "fr-FR"},
    {"Google हिन्दी", "hi-IN"},
    {"Google Bahasa Indonesia", "id-ID"},
    {"Google italiano", "it-IT"},
    {"Google 日本語", "ja-JP"},
    {"Google 한국의", "ko-KR"},
    {"Google Nederlands", "nl-NL"},
    {"Google polski", "pl-PL"},
    {"Google português do Brasil", "pt-BR"},
    {"Google русский", "ru-RU"},
    {"Google 普通话（中国大陆）", "zh-CN"},
    {"Google 粤語（香港）", "zh-HK"},
    {"Google 國語（臺灣）", "zh-TW"},
  };
  return base::span<const ApexVoiceSpec>(kGoogle);
}

// --- macOS -----------------------------------------------------------------
// Captured with AVSpeechSynthesisVoice.speechVoices on a stock macOS install
// (all .default-quality voices, none downloaded), replicating tts_mac.mm's
// ordering and disambiguation. Index 0 is the system default voice.
inline base::span<const ApexVoiceSpec> MacVoiceSpecs() {
  static const ApexVoiceSpec kMac[] = {
    {"Samantha", "en-US"},
    {"Albert", "en-US"},
    {"Alice", "it-IT"},
    {"Alva", "sv-SE"},
    {"Amélie", "fr-CA"},
    {"Amira", "ms-MY"},
    {"Anna", "de-DE"},
    {"Bad News", "en-US"},
    {"Bahh", "en-US"},
    {"Bells", "en-US"},
    {"Boing", "en-US"},
    {"Bubbles", "en-US"},
    {"Carmit", "he-IL"},
    {"Cellos", "en-US"},
    {"Damayanti", "id-ID"},
    {"Daniel", "en-GB"},
    {"Daria", "bg-BG"},
    {"Eddy (English (United States))", "en-US"},
    {"Eddy (English (United Kingdom))", "en-GB"},
    {"Eddy (Chinese (China mainland))", "zh-CN"},
    {"Eddy (Chinese (Taiwan))", "zh-TW"},
    {"Eddy (German (Germany))", "de-DE"},
    {"Eddy (Spanish (Spain))", "es-ES"},
    {"Eddy (Spanish (Mexico))", "es-MX"},
    {"Eddy (Finnish (Finland))", "fi-FI"},
    {"Eddy (French (Canada))", "fr-CA"},
    {"Eddy (French (France))", "fr-FR"},
    {"Eddy (Italian (Italy))", "it-IT"},
    {"Eddy (Japanese (Japan))", "ja-JP"},
    {"Eddy (Korean (South Korea))", "ko-KR"},
    {"Eddy (Portuguese (Brazil))", "pt-BR"},
    {"Ellen", "nl-BE"},
    {"Flo (English (United States))", "en-US"},
    {"Flo (English (United Kingdom))", "en-GB"},
    {"Flo (Chinese (China mainland))", "zh-CN"},
    {"Flo (Chinese (Taiwan))", "zh-TW"},
    {"Flo (German (Germany))", "de-DE"},
    {"Flo (Spanish (Spain))", "es-ES"},
    {"Flo (Spanish (Mexico))", "es-MX"},
    {"Flo (Finnish (Finland))", "fi-FI"},
    {"Flo (French (Canada))", "fr-CA"},
    {"Flo (French (France))", "fr-FR"},
    {"Flo (Italian (Italy))", "it-IT"},
    {"Flo (Japanese (Japan))", "ja-JP"},
    {"Flo (Korean (South Korea))", "ko-KR"},
    {"Flo (Portuguese (Brazil))", "pt-BR"},
    {"Fred", "en-US"},
    {"Geeta", "te-IN"},
    {"Good News", "en-US"},
    {"Grandma (English (United States))", "en-US"},
    {"Grandma (English (United Kingdom))", "en-GB"},
    {"Grandma (Chinese (China mainland))", "zh-CN"},
    {"Grandma (Chinese (Taiwan))", "zh-TW"},
    {"Grandma (German (Germany))", "de-DE"},
    {"Grandma (Spanish (Spain))", "es-ES"},
    {"Grandma (Spanish (Mexico))", "es-MX"},
    {"Grandma (Finnish (Finland))", "fi-FI"},
    {"Grandma (French (Canada))", "fr-CA"},
    {"Grandma (French (France))", "fr-FR"},
    {"Grandma (Italian (Italy))", "it-IT"},
    {"Grandma (Japanese (Japan))", "ja-JP"},
    {"Grandma (Korean (South Korea))", "ko-KR"},
    {"Grandma (Portuguese (Brazil))", "pt-BR"},
    {"Grandpa (English (United States))", "en-US"},
    {"Grandpa (English (United Kingdom))", "en-GB"},
    {"Grandpa (Chinese (China mainland))", "zh-CN"},
    {"Grandpa (Chinese (Taiwan))", "zh-TW"},
    {"Grandpa (German (Germany))", "de-DE"},
    {"Grandpa (Spanish (Spain))", "es-ES"},
    {"Grandpa (Spanish (Mexico))", "es-MX"},
    {"Grandpa (Finnish (Finland))", "fi-FI"},
    {"Grandpa (French (Canada))", "fr-CA"},
    {"Grandpa (French (France))", "fr-FR"},
    {"Grandpa (Italian (Italy))", "it-IT"},
    {"Grandpa (Japanese (Japan))", "ja-JP"},
    {"Grandpa (Korean (South Korea))", "ko-KR"},
    {"Grandpa (Portuguese (Brazil))", "pt-BR"},
    {"Ioana", "ro-RO"},
    {"Jacques", "fr-FR"},
    {"Jester", "en-US"},
    {"Joana", "pt-PT"},
    {"Junior", "en-US"},
    {"Kanya", "th-TH"},
    {"Karen", "en-AU"},
    {"Kathy", "en-US"},
    {"Kyoko", "ja-JP"},
    {"Lana", "hr-HR"},
    {"Laura", "sk-SK"},
    {"Lekha", "hi-IN"},
    {"Lesya", "uk-UA"},
    {"Linh", "vi-VN"},
    {"Luciana", "pt-BR"},
    {"Majed", "ar-001"},
    {"Meijia", "zh-TW"},
    {"Melina", "el-GR"},
    {"Milena", "ru-RU"},
    {"Moira", "en-IE"},
    {"Montse", "ca-ES"},
    {"Mónica", "es-ES"},
    {"Nora", "nb-NO"},
    {"Organ", "en-US"},
    {"Paulina", "es-MX"},
    {"Piya", "bn-IN"},
    {"Ralph", "en-US"},
    {"Reed (English (United States))", "en-US"},
    {"Reed (English (United Kingdom))", "en-GB"},
    {"Reed (Chinese (China mainland))", "zh-CN"},
    {"Reed (Chinese (Taiwan))", "zh-TW"},
    {"Reed (German (Germany))", "de-DE"},
    {"Reed (Spanish (Spain))", "es-ES"},
    {"Reed (Spanish (Mexico))", "es-MX"},
    {"Reed (Finnish (Finland))", "fi-FI"},
    {"Reed (French (Canada))", "fr-CA"},
    {"Reed (Italian (Italy))", "it-IT"},
    {"Reed (Japanese (Japan))", "ja-JP"},
    {"Reed (Korean (South Korea))", "ko-KR"},
    {"Reed (Portuguese (Brazil))", "pt-BR"},
    {"Rishi", "en-IN"},
    {"Rocko (English (United States))", "en-US"},
    {"Rocko (English (United Kingdom))", "en-GB"},
    {"Rocko (Chinese (China mainland))", "zh-CN"},
    {"Rocko (Chinese (Taiwan))", "zh-TW"},
    {"Rocko (German (Germany))", "de-DE"},
    {"Rocko (Spanish (Spain))", "es-ES"},
    {"Rocko (Spanish (Mexico))", "es-MX"},
    {"Rocko (Finnish (Finland))", "fi-FI"},
    {"Rocko (French (Canada))", "fr-CA"},
    {"Rocko (French (France))", "fr-FR"},
    {"Rocko (Italian (Italy))", "it-IT"},
    {"Rocko (Japanese (Japan))", "ja-JP"},
    {"Rocko (Korean (South Korea))", "ko-KR"},
    {"Rocko (Portuguese (Brazil))", "pt-BR"},
    {"Sandy (English (United States))", "en-US"},
    {"Sandy (English (United Kingdom))", "en-GB"},
    {"Sandy (Chinese (China mainland))", "zh-CN"},
    {"Sandy (Chinese (Taiwan))", "zh-TW"},
    {"Sandy (German (Germany))", "de-DE"},
    {"Sandy (Spanish (Spain))", "es-ES"},
    {"Sandy (Spanish (Mexico))", "es-MX"},
    {"Sandy (Finnish (Finland))", "fi-FI"},
    {"Sandy (French (Canada))", "fr-CA"},
    {"Sandy (French (France))", "fr-FR"},
    {"Sandy (Italian (Italy))", "it-IT"},
    {"Sandy (Japanese (Japan))", "ja-JP"},
    {"Sandy (Korean (South Korea))", "ko-KR"},
    {"Sandy (Portuguese (Brazil))", "pt-BR"},
    {"Sara", "da-DK"},
    {"Satu", "fi-FI"},
    {"Shelley (English (United States))", "en-US"},
    {"Shelley (English (United Kingdom))", "en-GB"},
    {"Shelley (Chinese (China mainland))", "zh-CN"},
    {"Shelley (Chinese (Taiwan))", "zh-TW"},
    {"Shelley (German (Germany))", "de-DE"},
    {"Shelley (Spanish (Spain))", "es-ES"},
    {"Shelley (Spanish (Mexico))", "es-MX"},
    {"Shelley (Finnish (Finland))", "fi-FI"},
    {"Shelley (French (Canada))", "fr-CA"},
    {"Shelley (French (France))", "fr-FR"},
    {"Shelley (Italian (Italy))", "it-IT"},
    {"Shelley (Japanese (Japan))", "ja-JP"},
    {"Shelley (Korean (South Korea))", "ko-KR"},
    {"Shelley (Portuguese (Brazil))", "pt-BR"},
    {"Sinji", "yue-HK"},
    {"Soumya", "kn-IN"},
    {"Superstar", "en-US"},
    {"Tessa", "en-ZA"},
    {"Thomas", "fr-FR"},
    {"Tina", "sl-SI"},
    {"Tingting", "zh-CN"},
    {"Trinoids", "en-US"},
    {"Tünde", "hu-HU"},
    {"Vani", "ta-IN"},
    {"Whisper", "en-US"},
    {"Wobble", "en-US"},
    {"Xander", "nl-NL"},
    {"Yelda", "tr-TR"},
    {"Yuna", "ko-KR"},
    {"Zarvox", "en-US"},
    {"Zosia", "pl-PL"},
    {"Zuzana", "cs-CZ"},
  };
  return base::span<const ApexVoiceSpec>(kMac);
}

// --- Windows ---------------------------------------------------------------
// Stock en-US Windows 11 OneCore voices (HKLM\SOFTWARE\Microsoft\
// Speech_OneCore\Voices\Tokens: MSTTS_V110_enUS_DavidM / MarkM / ZiraM,
// enumerated in token order; David is the default).
inline base::span<const ApexVoiceSpec> WinVoiceSpecs() {
  static const ApexVoiceSpec kWin[] = {
    {"Microsoft David - English (United States)", "en-US"},
    {"Microsoft Mark - English (United States)", "en-US"},
    {"Microsoft Zira - English (United States)", "en-US"},
  };
  return base::span<const ApexVoiceSpec>(kWin);
}

// --- Linux (Ubuntu 24.04: speech-dispatcher 0.12.0~rc2 + espeak-ng 1.51) ---
// Base voices: espeak-ng-data/lang/** "name" + first "language" line, with
// everything after the first '-' upper-cased (speech-dispatcher's espeak
// module does that). Variants: espeak-ng-data/voices/!v/* "name" lines.
// speech-dispatcher emits "<name>" and "<name>+<variant>" for every base
// voice; Chrome keys each as "<name> espeak-ng" and sorts by byte order.
inline const char* LinuxSpeechdModule() { return "espeak-ng"; }

inline base::span<const ApexVoiceSpec> LinuxEspeakBaseSpecs() {
  static const ApexVoiceSpec kBase[] = {
    {"Afrikaans", "af"},
    {"Albanian", "sq"},
    {"Amharic", "am"},
    {"Arabic", "ar"},
    {"Aragonese", "an"},
    {"Armenian (East Armenia)", "hy"},
    {"Armenian (West Armenia)", "hyw"},
    {"Assamese", "as"},
    {"Azerbaijani", "az"},
    {"Bashkir", "ba"},
    {"Basque", "eu"},
    {"Belarusian", "be"},
    {"Bengali", "bn"},
    {"Bishnupriya Manipuri", "bpy"},
    {"Bosnian", "bs"},
    {"Bulgarian", "bg"},
    {"Catalan", "ca"},
    {"Cherokee ", "chr-US-QAAA-X-WEST"},
    {"Chinese (Cantonese)", "yue"},
    {"Chinese (Cantonese, latin as Jyutping)", "yue"},
    {"Chinese (Mandarin, latin as English)", "cmn"},
    {"Chinese (Mandarin, latin as Pinyin)", "cmn-LATN-PINYIN"},
    {"Chuvash", "cv"},
    {"Croatian", "hr"},
    {"Czech", "cs"},
    {"Danish", "da"},
    {"Dutch", "nl"},
    {"English (America)", "en-US"},
    {"English (America, New York City)", "en-US-NYC"},
    {"English (Caribbean)", "en-029"},
    {"English (Great Britain)", "en-GB"},
    {"English (Lancaster)", "en-GB-X-GBCLAN"},
    {"English (Received Pronunciation)", "en-GB-X-RP"},
    {"English (Scotland)", "en-GB-SCOTLAND"},
    {"English (West Midlands)", "en-GB-X-GBCWMD"},
    {"Esperanto", "eo"},
    {"Estonian", "et"},
    {"Finnish", "fi"},
    {"French (Belgium)", "fr-BE"},
    {"French (France)", "fr-FR"},
    {"French (Switzerland)", "fr-CH"},
    {"Gaelic (Irish)", "ga"},
    {"Gaelic (Scottish)", "gd"},
    {"Georgian", "ka"},
    {"German", "de"},
    {"Greek", "el"},
    {"Greek (Ancient)", "grc"},
    {"Greenlandic", "kl"},
    {"Guarani", "gn"},
    {"Gujarati", "gu"},
    {"Haitian Creole", "ht"},
    {"Hakka Chinese", "hak"},
    {"Hawaiian", "haw"},
    {"Hebrew", "he"},
    {"Hindi", "hi"},
    {"Hungarian", "hu"},
    {"Icelandic", "is"},
    {"Ido", "io"},
    {"Indonesian", "id"},
    {"Interlingua", "ia"},
    {"Italian", "it"},
    {"Japanese", "ja"},
    {"K'iche'", "quc"},
    {"Kannada", "kn"},
    {"Kazakh", "kk"},
    {"Klingon", "piqd"},
    {"Konkani", "kok"},
    {"Korean", "ko"},
    {"Kurdish", "ku"},
    {"Kyrgyz", "ky"},
    {"Lang_Belta", "qdb"},
    {"Latgalian", "ltg"},
    {"Latin", "la"},
    {"Latvian", "lv"},
    {"Lingua Franca Nova", "lfn"},
    {"Lithuanian", "lt"},
    {"Lojban", "jbo"},
    {"Lule Saami", "smj"},
    {"Luxembourgish", "lb"},
    {"Macedonian", "mk"},
    {"Malay", "ms"},
    {"Malayalam", "ml"},
    {"Maltese", "mt"},
    {"Marathi", "mr"},
    {"Myanmar (Burmese)", "my"},
    {"Māori", "mi"},
    {"Nahuatl (Classical)", "nci"},
    {"Nepali", "ne"},
    {"Nogai", "nog"},
    {"Norwegian Bokmål", "nb"},
    {"Oriya", "or"},
    {"Oromo", "om"},
    {"Papiamento", "pap"},
    {"Persian", "fa"},
    {"Persian (Pinglish)", "fa-LATN"},
    {"Polish", "pl"},
    {"Portuguese (Brazil)", "pt-BR"},
    {"Portuguese (Portugal)", "pt"},
    {"Punjabi", "pa"},
    {"Pyash", "py"},
    {"Quechua", "qu"},
    {"Quenya", "qya"},
    {"Romanian", "ro"},
    {"Russian", "ru"},
    {"Russian (Latvia)", "ru-LV"},
    {"Serbian", "sr"},
    {"Setswana", "tn"},
    {"Shan (Tai Yai)", "shn"},
    {"Sindarin", "sjn"},
    {"Sindhi", "sd"},
    {"Sinhala", "si"},
    {"Slovak", "sk"},
    {"Slovenian", "sl"},
    {"Spanish (Latin America)", "es-419"},
    {"Spanish (Spain)", "es"},
    {"Swahili", "sw"},
    {"Swedish", "sv"},
    {"Tamil", "ta"},
    {"Tatar", "tt"},
    {"Telugu", "te"},
    {"Thai", "th"},
    {"Turkish", "tr"},
    {"Turkmen", "tk"},
    {"Ukrainian", "uk"},
    {"Urdu", "ur"},
    {"Uyghur", "ug"},
    {"Uzbek", "uz"},
    {"Vietnamese (Central)", "vi-VN-X-CENTRAL"},
    {"Vietnamese (Northern)", "vi"},
    {"Vietnamese (Southern)", "vi-VN-X-SOUTH"},
    {"Welsh", "cy"},
  };
  return base::span<const ApexVoiceSpec>(kBase);
}

inline base::span<const char* const> LinuxEspeakVariantNames() {
  static const char* const kVariants[] = {
    "Adam",
    "Alex",
    "Alicia",
    "Andrea",
    "Andy",
    "Annie",
    "Antonio",
    "Auntie",
    "Belinda",
    "Benjamin",
    "Boris",
    "Caleb",
    "David",
    "Demonic",
    "Denis",
    "Diogo",
    "Ed",
    "Edward",
    "Edward2",
    "Gene",
    "Gene2",
    "Gustave",
    "Half-LifeAnnouncementSystem",
    "Henrique",
    "Hugo",
    "Iven",
    "Iven2",
    "Iven3",
    "Iven4",
    "Jacky",
    "John",
    "Kaukovalta",
    "Lee",
    "Linda",
    "Marcelo",
    "Marco",
    "Mario",
    "Max",
    "Michael",
    "Michel",
    "Miguel",
    "Mike",
    "Mr_Serious",
    "Nguyen",
    "Pablo",
    "Paul",
    "Pedro",
    "Quincy",
    "RicishayMax",
    "RicishayMax2",
    "RicishayMax3",
    "Rob",
    "Robert",
    "Robosoft",
    "Robosoft2",
    "Robosoft3",
    "Robosoft4",
    "Robosoft5",
    "Robosoft6",
    "Robosoft7",
    "Robosoft8",
    "Steph",
    "Steph2",
    "Steph3",
    "Storm",
    "Tweaky",
    "UniversalRobot",
    "Zac",
    "anika",
    "anikaRobot",
    "anxiousAndy",
    "croak",
    "fast_test",
    "female1",
    "female2",
    "female3",
    "female4",
    "female5",
    "female_whisper",
    "grandma",
    "grandpa",
    "klatt",
    "klatt2",
    "klatt3",
    "klatt4",
    "klatt5",
    "klatt6",
    "male1",
    "male2",
    "male3",
    "male4",
    "male5",
    "male6",
    "male7",
    "male8",
    "norbert",
    "sandro",
    "shelby",
    "travis",
    "victor",
    "whisper",
  };
  return base::span<const char* const>(kVariants);
}

inline void AppendSpecs(base::span<const ApexVoiceSpec> specs,
                        bool is_local_service,
                        std::vector<ApexVoice>* out) {
  for (const ApexVoiceSpec& spec : specs) {
    out->push_back(ApexVoice{spec.name, spec.lang, is_local_service});
  }
}

inline void AppendLinuxPlatformVoices(std::vector<ApexVoice>* out) {
  // Build "<name> <module>" / "<name>+<variant> <module>" keys exactly like
  // TtsPlatformImplBackgroundWorker::InitializeVoices, then sort by the key
  // (std::map<std::string> order == std::string operator<, byte order).
  const std::string module = std::string(" ") + LinuxSpeechdModule();
  std::vector<std::pair<std::string, const char*>> keyed;
  base::span<const char* const> variants = LinuxEspeakVariantNames();
  for (const ApexVoiceSpec& spec : LinuxEspeakBaseSpecs()) {
    keyed.emplace_back(std::string(spec.name) + module, spec.lang);
    for (const char* variant : variants) {
      keyed.emplace_back(std::string(spec.name) + "+" + variant + module,
                         spec.lang);
    }
  }
  std::sort(keyed.begin(), keyed.end(),
            [](const auto& a, const auto& b) { return a.first < b.first; });
  for (auto& entry : keyed) {
    out->push_back(ApexVoice{std::move(entry.first), entry.second, true});
  }
}

// The complete list a real Chrome on `os` would expose, in order.
inline std::vector<ApexVoice> BuildVoiceList(const std::string& os) {
  std::vector<ApexVoice> voices;
  if (os == "Windows") {
    AppendSpecs(WinVoiceSpecs(), /*is_local_service=*/true, &voices);
  } else if (os == "macOS") {
    AppendSpecs(MacVoiceSpecs(), /*is_local_service=*/true, &voices);
  } else {
    AppendLinuxPlatformVoices(&voices);
  }
  AppendSpecs(GoogleNetworkVoiceSpecs(), /*is_local_service=*/false, &voices);
  return voices;
}

// Fill `mojom_voices` with a realistic OS-consistent list if it arrived empty.
// VoiceVector is Vector<mojom::blink::SpeechSynthesisVoicePtr>.
template <typename VoiceVector>
void EnsureRealisticVoiceList(VoiceVector* mojom_voices) {
  if (!Active() || mojom_voices == nullptr || !mojom_voices->empty()) {
    return;
  }
  const std::vector<ApexVoice> voices =
      BuildVoiceList(EnvStr("APEX_FP_UA_PLATFORM"));
  bool first = true;
  for (const ApexVoice& voice : voices) {
    // Mirrors content SpeechSynthesisImpl: voice_uri = name, default = index 0.
    mojom_voices->push_back(blink::mojom::blink::SpeechSynthesisVoice::New(
        blink::String::FromUtf8(voice.name),
        blink::String::FromUtf8(voice.name),
        blink::String::FromUtf8(voice.lang),
        /*is_local_service=*/voice.is_local_service,
        /*is_default=*/first));
    first = false;
  }
}

}  // namespace apex_fp

#endif  // APEX_CHROMIUM_VOICES_H_
