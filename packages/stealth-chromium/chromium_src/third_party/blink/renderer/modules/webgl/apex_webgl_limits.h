// apex_webgl_limits.h -- persona WebGL numeric limits (detector-sources B3).
//
// The container renders through ANGLE-on-GL over Mesa llvmpipe, so without
// this every getParameter limit is llvmpipe's while UNMASKED_RENDERER claims a
// D3D11 or Metal GPU. The tables are what ANGLE itself reports for the claimed
// backend at the ANGLE revision Chromium 157.0.8103.80 pins
// (c56e2a4a9b8cb0040920c995a268be559ba53f1c), after Context::initCaps():
//   D3D11 (feature level >= 11_0): d3d11/renderer11_utils.cpp GenerateCaps()
//   Metal (macOS):                 metal/DisplayMtl.mm ensureCapsInitialized()
// FULL spoof by decision: values above llvmpipe's are reported as-is, so a
// shader using that headroom fails here where it would work on the claimed
// GPU. MAX_SAMPLES is not in the tables: both backends derive it from
// per-device format sample counts, so no source-derived value exists.
//
// No Chromium dependencies (offline-tested by scripts/test_fingerprint_h.cc),
// so GL enums are their Khronos values (checked against ANGLE's
// include/GLES3/gl3.h + GLES2/gl2ext.h at the same revision).

#ifndef APEX_CHROMIUM_WEBGL_LIMITS_H_
#define APEX_CHROMIUM_WEBGL_LIMITS_H_

#include <cstdint>
#include <string>

#include "apex_fingerprint.h"

namespace apex_webgl {

enum class Backend : int8_t { kNone = 0, kD3D11 = 1, kMetal = 2 };

inline bool Contains(const std::string& s, const char* needle) {
  return s.find(needle) != std::string::npos;
}

// The backend the persona claims. A renderer string naming some other backend
// gets no table rather than the wrong one.
inline Backend ClaimedBackend() {
  if (!apex_fp::HasOverride("APEX_FP_WEBGL_RENDERER")) {
    return Backend::kNone;
  }
  const std::string r = apex_fp::EnvStr("APEX_FP_WEBGL_RENDERER");
  if (apex_fp::PersonaIsWindows() && Contains(r, ", D3D11)")) {
    return Backend::kD3D11;
  }
  if (apex_fp::PersonaIsMacOS() && Contains(r, "ANGLE Metal Renderer")) {
    return Backend::kMetal;
  }
  return Backend::kNone;
}

// A context already running the claimed backend (a Mac host serving an Apple
// persona) reports its own values, which are the truth.
inline Backend EffectiveBackend(Backend claimed,
                                const std::string& real_renderer) {
  if (claimed == Backend::kD3D11 && Contains(real_renderer, "Direct3D11")) {
    return Backend::kNone;
  }
  if (claimed == Backend::kMetal && Contains(real_renderer, "Metal")) {
    return Backend::kNone;
  }
  return claimed;
}

// ANGLE's skipVSConstantRegisterZero (on for NVIDIA in
// renderer11_utils.cpp InitializeFeatures) costs one vertex uniform vector.
inline bool PersonaIsNvidia() {
  return Contains(apex_fp::EnvStr("APEX_FP_WEBGL_VENDOR"), "(NVIDIA)");
}

// getParameter integer limits (GetIntParameter and GetInt64Parameter).
inline bool IntLimit(Backend b, uint32_t pname, int64_t* out) {
  if (b == Backend::kNone) {
    return false;
  }
  const bool d3d = b == Backend::kD3D11;
  const int64_t vs_vectors = d3d ? (PersonaIsNvidia() ? 4095 : 4096) : 1024;
  int64_t v = 0;
  switch (pname) {
    case 0x0D33:  // MAX_TEXTURE_SIZE
    case 0x851C:  // MAX_CUBE_MAP_TEXTURE_SIZE
    case 0x84E8:  // MAX_RENDERBUFFER_SIZE
      v = 16384;
      break;
    case 0x8073:  // MAX_3D_TEXTURE_SIZE
    case 0x88FF:  // MAX_ARRAY_TEXTURE_LAYERS
      v = 2048;
      break;
    case 0x8869:  // MAX_VERTEX_ATTRIBS
    case 0x8B4C:  // MAX_VERTEX_TEXTURE_IMAGE_UNITS
    case 0x8872:  // MAX_TEXTURE_IMAGE_UNITS
      v = 16;
      break;
    case 0x8B4D:  // MAX_COMBINED_TEXTURE_IMAGE_UNITS
      v = 32;
      break;
    case 0x8DFB:  // MAX_VERTEX_UNIFORM_VECTORS
      v = vs_vectors;
      break;
    case 0x8B4A:  // MAX_VERTEX_UNIFORM_COMPONENTS
      v = vs_vectors * 4;
      break;
    case 0x8DFD:  // MAX_FRAGMENT_UNIFORM_VECTORS
      v = 1024;
      break;
    case 0x8B49:  // MAX_FRAGMENT_UNIFORM_COMPONENTS
      v = 4096;
      break;
    case 0x8DFC:  // MAX_VARYING_VECTORS
      v = 30;
      break;
    case 0x8B4B:  // MAX_VARYING_COMPONENTS
    case 0x9122:  // MAX_VERTEX_OUTPUT_COMPONENTS
    case 0x9125:  // MAX_FRAGMENT_INPUT_COMPONENTS
      v = 120;
      break;
    case 0x8824:  // MAX_DRAW_BUFFERS
    case 0x8CDF:  // MAX_COLOR_ATTACHMENTS
      v = 8;
      break;
    case 0x8A2B:  // MAX_VERTEX_UNIFORM_BLOCKS
    case 0x8A2D:  // MAX_FRAGMENT_UNIFORM_BLOCKS
      v = d3d ? 12 : 16;
      break;
    case 0x8A2E:  // MAX_COMBINED_UNIFORM_BLOCKS
    case 0x8A2F:  // MAX_UNIFORM_BUFFER_BINDINGS
      v = d3d ? 24 : 32;
      break;
    case 0x8A34:  // UNIFORM_BUFFER_OFFSET_ALIGNMENT
      v = d3d ? 256 : 16;
      break;
    case 0x8A30:  // MAX_UNIFORM_BLOCK_SIZE
      v = d3d ? 65536 : 16384;
      break;
    case 0x8A31:  // MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS
      v = d3d ? 12 * (65536 / 4) + vs_vectors * 4 : 4096 + 16 * (16384 / 4);
      break;
    case 0x8A33:  // MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS
      v = d3d ? 12 * (65536 / 4) + 4096 : 4096 + 16 * (16384 / 4);
      break;
    case 0x80E9:  // MAX_ELEMENTS_INDICES
    case 0x80E8:  // MAX_ELEMENTS_VERTICES
      v = 2147483647;
      break;
    case 0x8D6B:  // MAX_ELEMENT_INDEX
      v = 4294967294LL;
      break;
    case 0x9111:  // MAX_SERVER_WAIT_TIMEOUT
      v = 0;
      break;
    case 0x8904:  // MIN_PROGRAM_TEXEL_OFFSET
      v = -8;
      break;
    case 0x8905:  // MAX_PROGRAM_TEXEL_OFFSET
      v = 7;
      break;
    case 0x8C8A:  // MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS
      v = d3d ? 120 : 128;
      break;
    case 0x8C8B:  // MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS
    case 0x8C80:  // MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS
      v = 4;
      break;
    default:
      return false;
  }
  *out = v;
  return true;
}

// Scalar float limits (GetFloatParameter).
inline bool FloatLimit(Backend b, uint32_t pname, float* out) {
  if (b == Backend::kNone) {
    return false;
  }
  switch (pname) {
    case 0x84FD:  // MAX_TEXTURE_LOD_BIAS (Metal: log2(16384) + 1)
      *out = b == Backend::kD3D11 ? 2.0f : 15.0f;
      return true;
    case 0x84FF:  // MAX_TEXTURE_MAX_ANISOTROPY_EXT
      *out = 16.0f;
      return true;
    default:
      return false;
  }
}

// ALIASED_*_RANGE (GetWebGLFloatArrayParameter).
inline bool FloatRange(Backend b, uint32_t pname, float* lo, float* hi) {
  if (b == Backend::kNone) {
    return false;
  }
  switch (pname) {
    case 0x846E:  // ALIASED_LINE_WIDTH_RANGE
      *lo = 1.0f;
      *hi = 1.0f;
      return true;
    case 0x846D:  // ALIASED_POINT_SIZE_RANGE
      *lo = 1.0f;
      *hi = b == Backend::kD3D11 ? 1024.0f : 511.0f;
      return true;
    default:
      return false;
  }
}

// MAX_VIEWPORT_DIMS (D3D11_VIEWPORT_BOUNDS_MAX / Metal max2DTextureSize).
inline bool ViewportDims(Backend b, int32_t* w, int32_t* h) {
  if (b == Backend::kNone) {
    return false;
  }
  *w = *h = b == Backend::kD3D11 ? 32767 : 16384;
  return true;
}

struct Viewport {
  int32_t x = 0;
  int32_t y = 0;
  int32_t w = 0;
  int32_t h = 0;
};

// viewport() coherence. Both the real and the claimed ANGLE clamp a
// viewport() request to their own MAX_VIEWPORT_DIMS when it is specified
// (State::setViewportParams). When the real VIEWPORT is exactly the real
// clamp of the page's last request -- nothing else has moved it since --
// report the claimed backend's clamp of that request instead.
inline bool ReportedViewport(Backend b,
                             const Viewport& request,
                             const Viewport& real,
                             int32_t real_max_w,
                             int32_t real_max_h,
                             Viewport* out) {
  int32_t max_w = 0;
  int32_t max_h = 0;
  if (!ViewportDims(b, &max_w, &max_h)) {
    return false;
  }
  if (real.x != request.x || real.y != request.y ||
      real.w != (request.w < real_max_w ? request.w : real_max_w) ||
      real.h != (request.h < real_max_h ? request.h : real_max_h)) {
    return false;
  }
  out->x = request.x;
  out->y = request.y;
  out->w = request.w < max_w ? request.w : max_w;
  out->h = request.h < max_h ? request.h : max_h;
  return true;
}

// getShaderPrecisionFormat: both backends call setIEEEFloat() for every float
// precision and setTwosComplementInt(32) for every int precision.
inline bool Precision(Backend b,
                      uint32_t precision_type,
                      int32_t* range_min,
                      int32_t* range_max,
                      int32_t* precision) {
  if (b == Backend::kNone) {
    return false;
  }
  switch (precision_type) {
    case 0x8DF0:  // LOW_FLOAT
    case 0x8DF1:  // MEDIUM_FLOAT
    case 0x8DF2:  // HIGH_FLOAT
      *range_min = 127;
      *range_max = 127;
      *precision = 23;
      return true;
    case 0x8DF3:  // LOW_INT
    case 0x8DF4:  // MEDIUM_INT
    case 0x8DF5:  // HIGH_INT
      *range_min = 31;
      *range_max = 30;
      *precision = 0;
      return true;
    default:
      return false;
  }
}

}  // namespace apex_webgl

#endif  // APEX_CHROMIUM_WEBGL_LIMITS_H_
