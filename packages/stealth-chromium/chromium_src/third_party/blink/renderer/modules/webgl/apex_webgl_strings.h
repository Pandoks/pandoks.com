// apex_webgl_strings.h -- Blink-String wrappers for the WebGL fingerprint patch.
//
// webgl-unmasked-strings.patch needs to return a WTF::String. apex_fingerprint.h
// deliberately has no Blink dependency (so it is safe to include anywhere), so
// the Blink-typed wrappers live here, in the modules/webgl overlay directory.
//
// Returns an empty String when no override is set -> the patch falls through to
// the real GL_VENDOR / GL_RENDERER strings.

#ifndef APEX_CHROMIUM_WEBGL_STRINGS_H_
#define APEX_CHROMIUM_WEBGL_STRINGS_H_

#include <string_view>
#include "apex_fingerprint.h"
#include "third_party/blink/renderer/platform/wtf/text/wtf_string.h"

namespace apex_fp {

// Fully-qualified blink::String -- this header's helpers live in namespace
// apex_fp, where the bare name `String` is not in scope.
inline blink::String WebGLVendorOverride() {
  if (HasOverride("APEX_FP_WEBGL_VENDOR")) {
    return blink::String::FromUtf8(
        std::string_view(EnvStr("APEX_FP_WEBGL_VENDOR")));
  }
  return blink::String();
}

inline blink::String WebGLRendererOverride() {
  if (HasOverride("APEX_FP_WEBGL_RENDERER")) {
    return blink::String::FromUtf8(
        std::string_view(EnvStr("APEX_FP_WEBGL_RENDERER")));
  }
  return blink::String();
}

}  // namespace apex_fp

#endif  // APEX_CHROMIUM_WEBGL_STRINGS_H_
