#!/usr/bin/env python3
"""Offline equivalence + latency test for apply_edits._RGBA_NOISE_LOOP.

The canvas farbling loop is spliced verbatim into three Blink call sites, so
it can't be unit-tested inside Chromium without a full build. This script
compiles it twice into one translation unit: the shipped loop
(apply_edits._RGBA_NOISE_LOOP) and the frozen v2.1 reference below (the last
implementation the adversarial review measured). It then checks that both
produce byte-identical buffers, padding included, on uniform, gradient, random,
glyph-on-transparent, grayscale, extremal and hi7-uniform inputs across sizes,
strides, byte orders and keys. It also checks that a re-read is a fixpoint,
that a zero key is a no-op and that two keys diverge, and it times both loops
on the battery's two readback probes.

base::span is shimmed with a hardened std::span (libc++ hardening or
_GLIBCXX_ASSERTIONS), so every subspan() and operator[] is bounds-checked the
way base::span CHECKs. Under clang, UNSAFE_BUFFERS maps to the same pragma pair
//base uses and the TU is built with -Wunsafe-buffer-usage -Werror, so stray
raw-pointer arithmetic outside the scoped suppression fails the test the way it
would fail the Blink build (g++ runs the equivalence checks without that lint).

Usage:  python3 test_canvas_noise.py      (C++20 compiler; CXX overrides c++)
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from apply_edits import _RGBA_NOISE_LOOP

# Frozen copy of the v2.1 loop (git 23981a05). Do not edit: it is the oracle
# the shipped loop must match byte for byte.
_REFERENCE_V21 = (
    "      const uint64_t apex_key = apex_fp::CanvasKey();\n"
    "      if (apex_key != 0 && apex_w >= 3u && apex_h >= 3u &&\n"
    "          apex_stride >= apex_w * 4u) {\n"
    "        // SAFETY: caller-validated 8-bit RGBA/BGRA buffer of apex_h\n"
    "        // rows apex_stride bytes apart; last row >= apex_w * 4 bytes.\n"
    "        base::span<uint8_t> apex_buf = UNSAFE_BUFFERS(base::span<uint8_t>(\n"
    "            apex_px, apex_stride * (apex_h - 1u) + apex_w * 4u));\n"
    "        auto apex_at = [&](size_t ax, size_t ay) {\n"
    "          return apex_buf.subspan(ay * apex_stride + ax * 4u, 4u);\n"
    "        };\n"
    "        // Channel order canonicalised to R,G,B so getImageData (RGBA) and\n"
    "        // the encode path (N32 may be BGRA) lock the SAME logical bits.\n"
    "        // apex_bgra is bound by the inject (false for getImageData /\n"
    "        // readPixels -- the gates already guarantee RGBA order there).\n"
    "        const size_t apex_c0 = apex_bgra ? 2u : 0u;\n"
    "        const size_t apex_c2 = apex_bgra ? 0u : 2u;\n"
    "        const size_t apex_ord[3] = {apex_c0, 1u, apex_c2};\n"
    "        // SAFETY: apex_ord/apex_ch_flat/apex_writable/apex_grp are fixed\n"
    "        // 3-element stack arrays indexed by li/lj in [0, 3); apex_at()\n"
    "        // clamps every pixel access to the apex_buf span. UNSAFE_BUFFERS\n"
    "        // scopes the suppression the blink unsafe-buffers enforcement\n"
    "        // list requires for the residual raw indexing (apex_ord etc.).\n"
    "        UNSAFE_BUFFERS({\n"
    "        for (size_t ay = 1; ay + 1 < apex_h; ++ay) {\n"
    "          for (size_t ax = 1; ax + 1 < apex_w; ++ax) {\n"
    "            base::span<uint8_t> apex_p = apex_at(ax, ay);\n"
    "            if (apex_p[3] == 0) continue;  // transparent: untouched\n"
    "            // Uniform/flatness tests on the HIGH 7 bits only. A solid\n"
    "            // fill is uniform in full bytes, hence in hi7; testing hi7\n"
    "            // (not full bytes) makes every decision invariant under the\n"
    "            // mask itself, which is what makes re-reads a fixpoint.\n"
    "            // Alpha is compared in hi7 too: the mask writes alpha's LSB,\n"
    "            // so the decision must not read it.\n"
    "            bool apex_uniform = true;\n"
    "            bool apex_ch_flat[3] = {true, true, true};  // R1, per channel\n"
    "            bool apex_a_flat = true;                    // R1, alpha\n"
    "            uint64_t apex_hv = 0xcbf29ce484222325ull;   // FNV-1a basis\n"
    "            for (size_t ady = 0; ady < 3u; ++ady) {\n"
    "              for (size_t adx = 0; adx < 3u; ++adx) {\n"
    "                base::span<uint8_t> apex_n =\n"
    "                    apex_at(ax + adx - 1u, ay + ady - 1u);\n"
    "                for (size_t li = 0; li < 3u; ++li) {\n"
    "                  const size_t ac = apex_ord[li];\n"
    "                  const uint8_t apex_hi = apex_n[ac] & 0xFEu;\n"
    "                  if (apex_hi != (apex_p[ac] & 0xFEu)) {\n"
    "                    apex_uniform = false;\n"
    "                    apex_ch_flat[li] = false;\n"
    "                  }\n"
    "                  apex_hv = (apex_hv ^ apex_hi) * 0x100000001b3ull;\n"
    "                }\n"
    "                if ((apex_n[3] & 0xFEu) != (apex_p[3] & 0xFEu)) {\n"
    "                  apex_uniform = false;\n"
    "                  apex_a_flat = false;\n"
    "                }\n"
    "                apex_hv =\n"
    "                    (apex_hv ^ (apex_n[3] & 0xFEu)) * 0x100000001b3ull;\n"
    "              }\n"
    "            }\n"
    "            if (apex_uniform) continue;  // solid fill: untouched\n"
    "            const uint64_t apex_bits = apex_fp::Mix64(apex_key ^ apex_hv) >> 32;\n"
    "            // +A: alpha-LSB write where alpha itself carries entropy\n"
    "            // (its window is not flat) and is not extremal. This is the\n"
    "            // only farbling left on black-glyph-on-transparent, where R1\n"
    "            // correctly leaves structurally-flat RGB alone.\n"
    "            {\n"
    "              const uint8_t apex_ahi = apex_p[3] & 0xFEu;\n"
    "              if (!apex_a_flat && apex_ahi != 0x00u && apex_ahi != 0xFEu)\n"
    "                apex_p[3] = static_cast<uint8_t>(\n"
    "                    apex_ahi | uint8_t((apex_bits >> 3) & 1u));\n"
    "            }\n"
    "            // R1 + R2': a channel is writable only if its own 3x3 window\n"
    "            // is not flat in hi7, and this pixel's own hi7 is not 0x00/0xFE.\n"
    "            bool apex_writable[3];\n"
    "            for (size_t li = 0; li < 3u; ++li) {\n"
    "              apex_writable[li] = !apex_ch_flat[li];\n"
    "              const uint8_t apex_hi = apex_p[apex_ord[li]] & 0xFEu;\n"
    "              if (apex_hi == 0x00u || apex_hi == 0xFEu) apex_writable[li] = false;\n"
    "            }\n"
    "            // R3: channels with equal hi7 at this pixel share ONE lock bit\n"
    "            // (grays stay grays). Group index = number of distinct writable\n"
    "            // hi7 values seen before this channel in canonical order -- no\n"
    "            // allocation, deterministic. Group bits come from stream 0..2;\n"
    "            // alpha's write used stream bit 3, so they cannot collide.\n"
    "            size_t apex_grp[3];\n"
    "            size_t apex_nb = 0;\n"
    "            for (size_t li = 0; li < 3u; ++li) {\n"
    "              if (!apex_writable[li]) continue;\n"
    "              const uint8_t apex_hi = apex_p[apex_ord[li]] & 0xFEu;\n"
    "              bool apex_found = false;\n"
    "              for (size_t lj = 0; lj < li; ++lj) {\n"
    "                if (!apex_writable[lj]) continue;\n"
    "                if ((apex_p[apex_ord[lj]] & 0xFEu) == apex_hi) {\n"
    "                  apex_grp[li] = apex_grp[lj];\n"
    "                  apex_found = true;\n"
    "                  break;\n"
    "                }\n"
    "              }\n"
    "              if (!apex_found) apex_grp[li] = apex_nb++;\n"
    "            }\n"
    "            for (size_t li = 0; li < 3u; ++li) {\n"
    "              if (!apex_writable[li]) continue;\n"
    "              apex_p[apex_ord[li]] = static_cast<uint8_t>(\n"
    "                  (apex_p[apex_ord[li]] & 0xFEu) |\n"
    "                  uint8_t((apex_bits >> apex_grp[li]) & 1u));\n"
    "            }\n"
    "          }\n"
    "        }\n"
    "        });\n"
    "      }\n"
)

_PRELUDE = r"""
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <span>
#include <string>
#include <vector>

namespace base {
template <typename T>
using span = std::span<T>;
}  // namespace base
#if defined(__clang__)
#define UNSAFE_BUFFERS(...)                  \
  _Pragma("clang unsafe_buffer_usage begin") \
  __VA_ARGS__                                \
  _Pragma("clang unsafe_buffer_usage end")
#else
#define UNSAFE_BUFFERS(...) __VA_ARGS__
#endif

#include "apex_fingerprint.h"

static void RefLoop(uint8_t* const apex_px, const size_t apex_w,
                    const size_t apex_h, const size_t apex_stride,
                    const bool apex_bgra) {
@REF@
}

static void NewLoop(uint8_t* const apex_px, const size_t apex_w,
                    const size_t apex_h, const size_t apex_stride,
                    const bool apex_bgra) {
@NEW@
}
"""

_MAIN = r"""
using Buf = std::vector<uint8_t>;

static uint64_t g_rng = 0;
static uint32_t Rand() {
  g_rng += 0x9E3779B97F4A7C15ull;
  uint64_t z = g_rng;
  z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
  z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
  return static_cast<uint32_t>((z ^ (z >> 31)) >> 32);
}

struct Img {
  size_t w, h, stride;
  Buf px;
  void Set(size_t x, size_t y, uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
    const size_t o = y * stride + x * 4u;
    px.at(o) = r; px.at(o + 1) = g; px.at(o + 2) = b; px.at(o + 3) = a;
  }
};

static Img Make(size_t w, size_t h, size_t pad) {
  Img im{w, h, w * 4u + pad, {}};
  im.px.assign(im.stride * h, 0xA5);  // padding sentinel
  for (size_t y = 0; y < h; ++y)
    for (size_t x = 0; x < w; ++x) im.Set(x, y, 0, 0, 0, 0);
  return im;
}

static uint8_t B(unsigned v) { return static_cast<uint8_t>(v & 0xFFu); }

// Glyph-like blobs: opaque cores with an anti-aliased (partial alpha) rim.
static void Glyphs(Img& im, uint8_t r, uint8_t g, uint8_t b, bool premul) {
  for (int n = 0; n < 40; ++n) {
    const size_t x0 = Rand() % im.w, y0 = Rand() % im.h;
    const size_t bw = 1 + Rand() % 6, bh = 2 + Rand() % 12;
    for (size_t y = y0; y < std::min(im.h, y0 + bh); ++y)
      for (size_t x = x0; x < std::min(im.w, x0 + bw); ++x) {
        const bool rim = (x == x0 || y == y0 || x + 1 == x0 + bw || y + 1 == y0 + bh);
        const uint8_t a = rim ? B(40 + Rand() % 200) : 255;
        const auto m = [&](uint8_t c) { return premul ? B(c * a / 255u) : c; };
        im.Set(x, y, m(r), m(g), m(b), a);
      }
  }
}

static Img Gen(int kind, size_t w, size_t h, size_t pad) {
  Img im = Make(w, h, pad);
  for (size_t y = 0; y < h; ++y)
    for (size_t x = 0; x < w; ++x) {
      switch (kind) {
        case 0: im.Set(x, y, 0, 127, 255, 255); break;                  // Castle solid fill
        case 1: im.Set(x, y, 10, 20, 30, 128); break;                   // translucent fill
        case 2: break;                                                  // transparent
        case 3: im.Set(x, y, B(76 | (Rand() & 1)), B(128 | (Rand() & 1)),
                       B(178 | (Rand() & 1)), B(254 | (Rand() & 1)));   // hi7-uniform
          break;
        case 4: im.Set(x, y, B(x * 255 / w), 40, 200, 255); break;      // h-gradient
        case 5: im.Set(x, y, 90, B(y * 255 / h), 17, 255); break;       // v-gradient
        case 6: im.Set(x, y, B(x + y), B(2 * x + y), B(x * y), B(200 + x % 50)); break;
        case 7: { const uint32_t v = Rand();
                  im.Set(x, y, B(v), B(v >> 8), B(v >> 16), B(v >> 24)); } break;
        case 8: if (Rand() % 3 == 0) { const uint32_t v = Rand();
                  im.Set(x, y, B(v), B(v >> 8), B(v >> 16), B(1 + v % 255)); } break;
        case 9: case 10: case 11: break;                                // glyphs below
        case 12: { const uint8_t g = B(Rand()); im.Set(x, y, g, g, g, 255); } break;
        case 13: { const uint8_t c = ((x ^ y) & 1) ? 255 : 0; im.Set(x, y, c, c, c, 255); } break;
        case 14: { const uint8_t c = (((x >> 1) ^ (y >> 1)) & 1) ? 200 : 30;
                   im.Set(x, y, c, B(255 - c), c, 255); } break;
        case 15: { static const std::array<uint8_t, 6> ext = {0x00, 0x01, 0xFE, 0xFF, 0x7F, 0x80};
                   im.Set(x, y, ext.at(Rand() % 6), ext.at(Rand() % 6), ext.at(Rand() % 6),
                          ext.at(Rand() % 6)); } break;
        case 16: { const size_t dx = x > w / 2 ? x - w / 2 : w / 2 - x;
                   const size_t dy = y > h / 2 ? y - h / 2 : h / 2 - y;
                   im.Set(x, y, B(dx * dx + dy * dy), B(dx * 3), B(dy * 5), 255); } break;
        case 17: { const uint8_t g = B(60 + (x / 7) * 13);                // gray text on white
                   im.Set(x, y, 255, 255, 255, 255);
                   if ((x * 7 + y * 3) % 11 < 3) im.Set(x, y, g, g, g, 255); } break;
      }
    }
  if (kind == 9) Glyphs(im, 255, 102, 0, true);   // #f60 text, premultiplied (encode)
  if (kind == 10) Glyphs(im, 255, 102, 0, false); // #f60 text, unpremultiplied (getImageData)
  if (kind == 11) Glyphs(im, 0, 0, 0, false);     // black glyph on transparent
  return im;
}

static const std::array<const char*, 18> kKinds = {
    "solid", "translucent", "transparent", "hi7-uniform", "h-gradient", "v-gradient",
    "xy-gradient", "random", "sparse-random", "orange-glyph-premul", "orange-glyph",
    "black-glyph", "grayscale", "checker1", "checker2", "extremal", "radial", "gray-text"};

static int g_fail = 0, g_cases = 0;
static long g_changed_textured = 0;

static void Run(int kind, size_t w, size_t h, size_t pad, bool bgra, const char* key) {
  setenv("APEX_FP_CANVAS_KEY", key, 1);
  g_rng = (static_cast<uint64_t>(kind) << 40) ^ (w << 20) ^ (h << 8) ^ pad;
  const Img in = Gen(kind, w, h, pad);
  Buf ref = in.px, nw = in.px;
  RefLoop(ref.data(), w, h, in.stride, bgra);
  NewLoop(nw.data(), w, h, in.stride, bgra);
  ++g_cases;
  if (ref != nw) {
    size_t i = 0;
    while (ref.at(i) == nw.at(i)) ++i;
    std::printf("  FAIL  %s %zux%zu pad=%zu bgra=%d key=%s: first diff at byte %zu "
                "(ref %u new %u)\n", kKinds.at(static_cast<size_t>(kind)), w, h, pad, bgra, key, i, ref.at(i), nw.at(i));
    ++g_fail;
    return;
  }
  Buf again = nw;
  NewLoop(again.data(), w, h, in.stride, bgra);
  if (again != nw) {
    std::printf("  FAIL  %s %zux%zu: re-read is not a fixpoint\n", kKinds.at(static_cast<size_t>(kind)), w, h);
    ++g_fail;
  }
  long changed = 0;
  for (size_t i = 0; i < nw.size(); ++i) changed += nw.at(i) != in.px.at(i);
  const bool must_be_stock = kind <= 3 || std::string(key) == "0" || w < 3 || h < 3;
  if (must_be_stock && changed != 0) {
    std::printf("  FAIL  %s %zux%zu key=%s: %ld bytes changed, expected stock bytes\n",
                kKinds.at(static_cast<size_t>(kind)), w, h, key, changed);
    ++g_fail;
  }
  if (!must_be_stock) g_changed_textured += changed;
}

template <typename F>
static double MedianUs(F&& f, int iters) {
  std::vector<double> t;
  for (int i = 0; i < iters; ++i) {
    const auto s = std::chrono::steady_clock::now();
    f();
    t.push_back(std::chrono::duration<double, std::micro>(
                    std::chrono::steady_clock::now() - s).count());
  }
  std::sort(t.begin(), t.end());
  return t.at(t.size() / 2);
}

static void Bench(const char* label, int kind, size_t w, size_t h) {
  setenv("APEX_FP_CANVAS_KEY", "12345678901234567890", 1);
  g_rng = 7;
  const Img in = Gen(kind, w, h, 0);
  Buf a = in.px, b = in.px;
  const double r = MedianUs([&] { a = in.px; RefLoop(a.data(), w, h, in.stride, false); }, 201);
  const double n = MedianUs([&] { b = in.px; NewLoop(b.data(), w, h, in.stride, false); }, 201);
  const double c = MedianUs([&] { b = in.px; }, 201);  // the copy both timings include
  std::printf("  bench %-34s v2.1 %8.1f us   v2.2 %8.1f us   (copy %5.1f us)  %.1fx\n",
              label, r - c, n - c, c, (r - c) / std::max(0.01, n - c));
}

int main() {
  std::printf("== canvas farbling v2.2 vs frozen v2.1 ==\n");
  const char* keys[] = {"1", "12345678901234567890", "9223372036854775809", "0"};
  const size_t sizes[][2] = {{3, 3}, {4, 3}, {3, 4}, {5, 7}, {17, 9}, {64, 64},
                             {300, 150}, {256, 256}, {1, 8}, {8, 1}, {2, 2}, {1000, 3}};
  const size_t pads[] = {0, 3, 16};
  for (int kind = 0; kind < 18; ++kind)
    for (const auto& s : sizes)
      for (size_t pad : pads)
        for (int bgra = 0; bgra < 2; ++bgra)
          for (const char* key : keys) Run(kind, s[0], s[1], pad, bgra != 0, key);
  std::printf("  %d cases, %d failures, %ld bytes farbled on textured inputs\n",
              g_cases, g_fail, g_changed_textured);
  if (g_changed_textured == 0) {
    std::printf("  FAIL  textured inputs were never farbled\n");
    ++g_fail;
  }
  {  // two keys must diverge on textured content
    g_rng = 99;
    const Img in = Gen(7, 64, 64, 0);
    Buf k1 = in.px, k2 = in.px;
    setenv("APEX_FP_CANVAS_KEY", "1", 1);
    NewLoop(k1.data(), 64, 64, in.stride, false);
    setenv("APEX_FP_CANVAS_KEY", "2", 1);
    NewLoop(k2.data(), 64, 64, in.stride, false);
    if (k1 == k2) { std::printf("  FAIL  keys 1 and 2 produced identical noise\n"); ++g_fail; }
  }
  Bench("webgl readPixels 256x256 clear", 0, 256, 256);
  Bench("2d toDataURL 300x150 #f60 text", 9, 300, 150);
  Bench("2d getImageData 300x150 text", 10, 300, 150);
  Bench("worst case 256x256 random", 7, 256, 256);
  std::printf(g_fail ? "FAILED\n" : "all checks passed\n");
  return g_fail ? 1 : 0;
}
"""


def main() -> int:
    cxx = os.environ.get("CXX", "c++")
    version = subprocess.run([cxx, "--version"], capture_output=True,
                             text=True, check=False).stdout
    clang = ["-Wunsafe-buffer-usage",
             # the harness's own printf; the loops make no libc calls
             "-Wno-unsafe-buffer-usage-in-libc-call"] if "clang" in version else []
    src = (_PRELUDE.replace("@REF@", _REFERENCE_V21)
           .replace("@NEW@", _RGBA_NOISE_LOOP) + _MAIN)
    with tempfile.TemporaryDirectory(prefix="apex-canvas-noise-") as tmp:
        cc = Path(tmp) / "t.cc"
        exe = Path(tmp) / "t"
        cc.write_text(src)
        cmd = [cxx, "-std=c++20", "-O2", "-Wall", "-Wextra", "-Werror", *clang,
               "-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_EXTENSIVE",
               "-D_GLIBCXX_ASSERTIONS",
               f"-I{HERE.parent / 'chromium_src'}", str(cc), "-o", str(exe)]
        build = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if build.returncode != 0:
            print(build.stderr)
            print("FAIL: test TU did not compile")
            return 1
        return subprocess.run([str(exe)], check=False).returncode


if __name__ == "__main__":
    sys.exit(main())
