// apex_canvas_noise.h -- include target for the canvas farbling sites.
//
// The canvas perturbation itself lives in scripts/apply_edits.py's
// _RGBA_NOISE_LOOP (inlined at each call site by the patcher) so that it can
// close over the caller's local bindings (buffer pointer, width, height,
// stride, and the byte-order flag). This header now only forwards
// apex_fingerprint.h, which provides the key and mixing helpers the loop
// uses (CanvasKey, Mix64).
//
// v2 design (content-keyed LSB lock, replaced the sparse +/-1 mask):
//   * DETERMINISTIC within a persona -- keyed on APEX_FP_CANVAS_KEY (64-bit),
//     so a page hashing the same canvas twice gets identical bytes.
//   * IRREVERSIBLE -- the low bit of each textured R/G/B byte is OVERWRITTEN
//     with a function of the key and the block's high bits; subtraction and
//     majority-vote attacks cannot recover the originals.
//   * NATIVE -- applied in the C++ pixel path (getImageData / readPixels /
//     encode), so there is no patched JS getter to catch.
//
// Buffers are taken as base::span (Chromium's bounds-checked view) so this
// header compiles clean under -Wunsafe-buffer-usage.

#ifndef APEX_CHROMIUM_CANVAS_NOISE_H_
#define APEX_CHROMIUM_CANVAS_NOISE_H_

#include <cstddef>
#include <cstdint>

#include "base/compiler_specific.h"  // UNSAFE_BUFFERS
#include "base/containers/span.h"
#include "apex_fingerprint.h"

#endif  // APEX_CHROMIUM_CANVAS_NOISE_H_
