#!/usr/bin/env python3
"""apex-chromium: anchor-based source edits.

The raw `.patch` files in patches/ describe WHAT to change, but hand-written
unified-diff line numbers never apply cleanly across Chromium versions. This
script instead applies each mid-function edit by ANCHOR: it finds a unique,
stable substring in the real source file and inserts the apex code relative to
it. Anchor matching survives line-number drift -- it only breaks if Chromium
actually renames/removes the anchored code, which refresh_patches.sh detects.

Run by scripts/apply.sh after the chromium_src overlays are installed.
Idempotent: every edit is tagged with an `// apex-<name>` marker and skipped if
that marker is already present (whole-token match: `apex-battery-charging`
must not be satisfied by `apex-battery-chargingtime`).

Usage:  APEX_CHROMIUM_WORK=/path python3 apply_edits.py [--check] [--verify]
  --check  : verify every anchor is findable, change nothing (dry run).
  --verify : post-apply gate -- every marker must be present in the tree.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

WORK = Path(os.environ.get("APEX_CHROMIUM_WORK",
                           str(Path.home() / "apex-chromium-build")))
SRC = WORK / "chromium" / "src"

# Shared C++ body of the three pixel-noise injects (2D getImageData, 2D
# encode, WebGL readPixels). Each inject binds four locals, then splices this
# text in verbatim:
#   uint8_t* const apex_px      -- first byte of row 0
#   const size_t   apex_w, apex_h
#   const size_t   apex_stride  -- bytes per row (>= apex_w * 4)
# The inject must already have checked that the buffer is 8-bit 4-channel
# (RGBA8 or BGRA8: alpha is byte 3 either way).
#
# A deterministic (seed, pixel-index) ~0.3% of INTERIOR pixels get a +/-1
# nudge on bytes 0..2 -- except pixels that are transparent (alpha == 0) or
# whose 3x3 neighbourhood is uniform. Those two skips are what keep the noise
# undetectable by construction: stock Chrome returns exact bytes for a solid
# fill (Castle's solid-fill probe) and for transparent regions, so apex must
# too. Noise is confined to textured content, where a page has no reference
# value to diff against.
#
# Bounds: pixel access goes through base::span (apex_at()/apex_buf) so every
# buffer access is CHECKed; the pointer->span step carries the stated invariant.
# The four fixed-size stack tables (apex_ord/apex_ch_flat/apex_writable/apex_grp)
# are raw-indexed, so the whole computation is wrapped in UNSAFE_BUFFERS({...})
# -- the base/compiler_specific.h scoped suppression, required because all three
# call sites compile under the blink unsafe-buffers enforcement list.
# The span covers exactly the bytes GL / Skia wrote -- (apex_h - 1) full strides
# plus one unpadded final row -- which is the size the upstream validators
# already require.
# Canvas farbling v2.1: the content-keyed LSB lock plus the four repair rules
# the adversarial review proved necessary (measured in /var/tmp/apex-farble-sim
# sim4..sim7). v2.0 (dense lock) broke three renderer invariants: I1 88%
# impossible pixels on black-glyph-on-transparent (RGB is locally flat at 0 but
# the all-channel conjunction still unlocked writes), I2b 255->254 at flat-fill
# seams, I4 6.8% of grayscale pixels de-grayed. The repairs, all computed from
# the same hi7 view the key uses (so idempotence survives):
#   R1  per-channel hi7 flatness gate -- skip channel c if c's own 3x3 window
#       is flat in hi7 (fixes I1)
#   R2' extremal-value gate -- skip channel c when THIS pixel's own hi7 is
#       0x00 or 0xFE (fixes I2b; the window form of this rule zeroes farbling
#       entirely on black-glyph/gray-text, so it must be the pixel form)
#   R3  equality-group bit sharing -- channels with equal hi7 at this pixel
#       share one lock bit (fixes I4 de-graying; deterministic, no allocation)
#   +A  alpha-LSB write -- the only remaining entropy on black-on-transparent
#       (alpha coverage); alpha's uniform test and hash read alpha's HI7 so the
#       mask stays a fixpoint (it now writes alpha's LSB).
# Subtraction still recovers only 7/8 bits per byte; majority vote still buys
# the attacker nothing (it converges to the farbled value, which every session
# reproduces). Flat-fill canvases are deliberately near-stock: the page holds
# an exact reference there and carries no device entropy anyway.
_RGBA_NOISE_LOOP = (
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

# An Edit: in `file`, find `anchor` (must be unique) and splice `inject`
# either "before" or "after" it. `marker` makes the edit idempotent.
EDITS = [
    # --- WebGL UNMASKED strings ----------------------------------------
    {
        "file": "third_party/blink/renderer/modules/webgl/"
                "webgl_rendering_context_base.cc",
        "header": '#include "third_party/blink/renderer/modules/webgl/'
                  'apex_webgl_strings.h"',
        "marker": "apex-webgl-renderer",
        "anchor": "case WebGLDebugRendererInfo::kUnmaskedRendererWebgl:\n"
                  "      if (ExtensionEnabled(kWebGLDebugRendererInfoName)) {\n",
        "where": "after",
        "inject": "        {  // apex-webgl-renderer\n"
                  "          String apex_r = apex_fp::WebGLRendererOverride();\n"
                  "          if (!apex_r.empty())\n"
                  "            return WebGLAny(script_state, apex_r);\n"
                  "        }\n",
    },
    {
        "file": "third_party/blink/renderer/modules/webgl/"
                "webgl_rendering_context_base.cc",
        "marker": "apex-webgl-vendor",
        "anchor": "case WebGLDebugRendererInfo::kUnmaskedVendorWebgl:\n"
                  "      if (ExtensionEnabled(kWebGLDebugRendererInfoName)) {\n",
        "where": "after",
        "inject": "        {  // apex-webgl-vendor\n"
                  "          String apex_v = apex_fp::WebGLVendorOverride();\n"
                  "          if (!apex_v.empty())\n"
                  "            return WebGLAny(script_state, apex_v);\n"
                  "        }\n",
    },
    # --- UA-CH brand list: identify as Google Chrome -------------------
    # Without is_chrome_branded (needs src-internal) CHROMIUM_BRANDING is set,
    # `brand` stays nullopt, and GenerateBrandVersionList() emits only
    # {GREASE, "Chromium"} -- two entries. Real Chrome emits the triple
    # {GREASE, "Chromium", "Google Chrome"}; the missing third brand is what
    # classifies the binary as "Chromium-Based Browser". Forcing `brand` here
    # feeds both the low-entropy `brands` (major version) and the high-entropy
    # `fullVersionList` paths, plus the Sec-CH-UA* headers, because they all
    # go through GetUserAgentBrandList(). Runtime-gated: a launch without
    # APEX_FP_ACTIVE=1 keeps stock Chromium output. The UA string itself is
    # unaffected (version_info already reports "Chrome/<ver>" for Chromium).
    # Verified anchor (Chromium 157.0.8103.27,
    # components/embedder_support/user_agent_utils.cc).
    {
        "file": "components/embedder_support/user_agent_utils.cc",
        "header": '#include "apex_fingerprint.h"',
        "marker": "apex-ua-brand",
        "anchor": "#if !BUILDFLAG(CHROMIUM_BRANDING)\n"
                  "  brand = version_info::GetProductName();\n"
                  "#endif\n",
        "where": "after",
        "inject": "  // apex-ua-brand: present the greased Google Chrome triple\n"
                  "  if (apex_fp::Active()) brand = \"Google Chrome\";\n",
    },
    # --- UA + UA-CH from ONE persona record (gap #4) --------------------
    # Verified anchors (Chromium 157.0.8103.27). Every downstream surface --
    # navigation Sec-CH-UA-* (content/browser/client_hints), subresource
    # hints (frame_fetch_context.cc), navigator.userAgentData
    # (navigator_ua.cc) in page/iframe/worker, navigator.userAgent --
    # consumes GetUserAgent()/GetUserAgentMetadata() from this file, so
    # patching here makes every surface coherent by construction.
    {
        "file": "components/embedder_support/user_agent_utils.cc",
        "header": '#include "apex_fingerprint.h"',
        "marker": "apex-ua-latent-ua-string",
        "anchor": "std::string GetUserAgentInternal() {\n"
                  "  std::string product = GetProductAndVersion();\n",
        "where": "after",
        "inject": "  // apex-ua-latent-ua-string: the persona OS segment replaces\n"
                  "  // the compile-time platform.\n"
                  "  if (const apex_fp::UAPersona apex_p = apex_fp::GetUAPersona();\n"
                  "      apex_p.active) {\n"
                  "    return BuildUserAgentFromOSAndProduct(apex_p.ua_os_segment,\n"
                  "                                          product);\n"
                  "  }\n",
    },
    {
        "file": "components/embedder_support/user_agent_utils.cc",
        "marker": "apex-ua-latent-ch-low",
        "anchor": "  metadata.platform = GetPlatformForUAMetadata();\n",
        "where": "after",
        "inject": "  // apex-ua-latent-ch-low: low-entropy platform (Sec-CH-UA-Platform,\n"
                  "  // userAgentData.platform) from the persona record. Also taken\n"
                  "  // by the only_low_entropy_ch early return below.\n"
                  "  if (const apex_fp::UAPersona apex_p = apex_fp::GetUAPersona();\n"
                  "      apex_p.active) {\n"
                  "    metadata.platform = apex_p.platform;\n"
                  "    metadata.mobile = false;\n"
                  "  }\n",
    },
    {
        "file": "components/embedder_support/user_agent_utils.cc",
        "marker": "apex-ua-latent-ch-high",
        "anchor": "  metadata.platform_version = GetPlatformVersion();\n",
        "where": "after",
        "inject": "  // apex-ua-latent-ch-high: the rest of the persona record, so\n"
                  "  // Sec-CH-UA-{Platform-Version,Arch,Bitness,WoW64,Model} and\n"
                  "  // getHighEntropyValues() agree with the UA string by\n"
                  "  // construction.\n"
                  "  if (const apex_fp::UAPersona apex_p = apex_fp::GetUAPersona();\n"
                  "      apex_p.active) {\n"
                  "    metadata.platform_version = apex_p.platform_version;\n"
                  "    metadata.architecture = apex_p.architecture;\n"
                  "    metadata.bitness = apex_p.bitness;\n"
                  "    metadata.wow64 = apex_p.wow64;\n"
                  "    metadata.model = apex_p.model;\n"
                  "  }\n",
    },
    # --- navigator.userAgentData.platform ------------------------------
    {
        "file": "third_party/blink/renderer/core/frame/navigator_ua_data.cc",
        "header": '#include "apex_fingerprint.h"',
        "marker": "apex-uadata-platform",
        "anchor": "void NavigatorUAData::SetPlatform(String brand, "
                  "String version) {\n",
        "where": "after",
        "inject": "  // apex-uadata-platform\n"
                  "  if (apex_fp::HasOverride(\"APEX_FP_UA_PLATFORM\")) {\n"
                  "    platform_ = String::FromUtf8(std::string_view(\n"
                  "        apex_fp::EnvStr(\"APEX_FP_UA_PLATFORM\")));\n"
                  "    platform_version_ = version;\n"
                  "    return;\n"
                  "  }\n",
    },
    # --- WebRTC: no binary edit; the policy is a launcher flag ----------
    # History: an edit here once forced webrtc_ip_handling_policy =
    # kDisableNonProxiedUdp whenever apex was active. It was removed because
    # ICE then produced zero candidates (round-2 F12) and the removal note
    # argued that srflx "carries the WAN IP -- exactly what a real user
    # behind a proxy exposes". That premise is false for this deployment:
    # the WAN here is the container host, not the proxy exit, so the srflx
    # IP disagrees with every proxied HTTP request (detector-sources.md A8,
    # rank-1 uncovered risk). Zero candidates is simply what Chrome shows
    # under that policy (TCP ports bind the any-address and WebRTC's
    # candidate filter drops them) -- the same thing a real user with the
    # WebRtcIpHandling enterprise policy or uBlock's WebRTC-leak option
    # shows. It is also the right trade: an unproxied session keeps the
    # default policy (srflx == HTTP egress, WebRTC calls work).
    # The policy is therefore tied to the proxy, not to the binary:
    # stealth-browser passes --webrtc-ip-handling-policy=disable_non_proxied_udp
    # for proxied sessions (profile.WEBRTC_PROXIED_FLAG), which is Chrome's
    # own switch for the webrtc.ip_handling_policy pref and works on stock
    # Chrome as well as this build. Note the content-layer
    # --force-webrtc-ip-handling-policy is NOT honored by chrome/ (only by
    # content_shell and headless_shell) -- do not reintroduce it.
    # --- V8 inspector: suppress console preview prototype walk ----------
    {
        "file": "v8/src/inspector/v8-console-message.cc",
        "header": '#include "apex_fingerprint.h"',
        "marker": "apex-cdp-nopreview",
        "anchor": "V8ConsoleMessage::wrapArguments(V8InspectorSessionImpl* "
                  "session,\n"
                  "                                bool generatePreview) "
                  "const {\n",
        "where": "after",
        "inject": "  // apex-cdp-nopreview: skip the eager arg preview that\n"
                  "  // walks the prototype chain (a CDP detection vector).\n"
                  "  if (apex_fp::Active()) generatePreview = false;\n",
    },
    # --- canvas getImageData noise -------------------------------------
    # Verified anchor (Chromium 157.0.8103.27): after readPixels() fills
    # image_data's SkPixmap inside getImageDataInternal's `if (snapshot)`
    # block, perturb the pixels before the function returns.
    # Gates: 8-bit RGBA storage only (ImageData may be float16/float32 via
    # the pixelFormat option -- not an RGBA8 buffer), successful readback,
    # then the shared loop's alpha==0 / uniform-3x3 skips.
    {
        "file": "third_party/blink/renderer/modules/canvas/canvas2d/"
                "base_rendering_context_2d.cc",
        "header": '#include "third_party/blink/renderer/modules/canvas/'
                  'canvas2d/apex_canvas_noise.h"',
        "marker": "apex-canvas-getimagedata",
        "anchor": "    if (!read_pixels_successful) {\n",
        "where": "before",
        "inject": "    // apex-canvas-getimagedata: perturb the readback pixels.\n"
                  "    // Only 8-bit RGBA storage is touched; float16/float32\n"
                  "    // ImageData (pixelFormat option) is left alone.\n"
                  "    if (apex_fp::Active() && read_pixels_successful &&\n"
                  "        image_data_pixmap.colorType() == "
                  "kRGBA_8888_SkColorType) {\n"
                  "      uint8_t* const apex_px =\n"
                  "          static_cast<uint8_t*>("
                  "image_data_pixmap.writable_addr());\n"
                  "      const size_t apex_w =\n"
                  "          static_cast<size_t>(image_data_pixmap.width());\n"
                  "      const size_t apex_h =\n"
                  "          static_cast<size_t>(image_data_pixmap.height());\n"
                  "      const size_t apex_stride = image_data_pixmap.rowBytes();\n"
                  "      const bool apex_bgra = false;  // gate: kRGBA_8888 only\n"
                  + _RGBA_NOISE_LOOP +
                  "    }\n",
    },
    # --- canvas toDataURL / toBlob noise -------------------------------
    # Verified anchor (Chromium 157.0.8103.27): the
    # ImageDataBuffer(StaticBitmapImage) constructor's texture-backed /
    # colour-converted path reads pixels into a fresh writable buffer via
    # paint_image.readPixels(...). Perturbing there covers every encode path
    # (toDataURL, toBlob, convertToBlob) that takes this branch with one edit.
    # Gates: N32 only (RGBA8 or BGRA8 -- alpha is byte 3 in both; F16 HDR
    # targets are skipped), then the shared loop's alpha==0 / uniform-3x3
    # skips.
    {
        "file": "third_party/blink/renderer/platform/graphics/"
                "image_data_buffer.cc",
        "header": '#include "third_party/blink/renderer/modules/canvas/'
                  'canvas2d/apex_canvas_noise.h"',
        "marker": "apex-canvas-encode",
        "anchor": "    if (!paint_image.readPixels(info, pixmap_.writable_addr()"
                  ", row_bytes, 0,\n"
                  "                                0)) {\n"
                  "      pixmap_.reset();\n"
                  "      return;\n"
                  "    }\n",
        "where": "after",
        "inject": "    // apex-canvas-encode: perturb pixels before any encode.\n"
                  "    // N32 only (RGBA8/BGRA8: alpha is byte 3 in both); an\n"
                  "    // F16 encoder target is not an 8-bit buffer, skip it.\n"
                  "    if (apex_fp::Active() &&\n"
                  "        (pixmap_.colorType() == kRGBA_8888_SkColorType ||\n"
                  "         pixmap_.colorType() == kBGRA_8888_SkColorType)) {\n"
                  "      uint8_t* const apex_px =\n"
                  "          static_cast<uint8_t*>(pixmap_.writable_addr());\n"
                  "      const size_t apex_w = static_cast<size_t>(pixmap_.width());\n"
                  "      const size_t apex_h = "
                  "static_cast<size_t>(pixmap_.height());\n"
                  "      const size_t apex_stride = pixmap_.rowBytes();\n"
                  "      const bool apex_bgra =\n"
                  "          (pixmap_.colorType() == kBGRA_8888_SkColorType);\n"
                  + _RGBA_NOISE_LOOP +
                  "    }\n",
    },
    # --- speechSynthesis voices ---------------------------------------
    {
        "file": "third_party/blink/renderer/modules/speech/"
                "speech_synthesis.cc",
        "header": '#include "third_party/blink/renderer/modules/speech/'
                  'apex_voices.h"',
        "marker": "apex-voices",
        "anchor": "void SpeechSynthesis::OnSetVoiceList(\n"
                  "    Vector<mojom::blink::SpeechSynthesisVoicePtr> "
                  "mojom_voices) {\n",
        "where": "after",
        "inject": "  // apex-voices: fill a realistic list if empty\n"
                  "  apex_fp::EnsureRealisticVoiceList(&mojom_voices);\n",
    },
    # --- mediaDevices.enumerateDevices --------------------------------
    # Verified anchor (Chromium 157.0.8103.27): in DevicesEnumerated, the
    # MediaDeviceInfoVector `media_devices` is resolved via
    # result_tracker->Resolve(media_devices). Fill in missing kinds first.
    # Each synthesized entry has deviceId == label == groupId == "" -- what
    # unpermissioned real Chrome reports. (The previous helper fabricated a
    # 32-hex deviceId/groupId beside an empty label, a triple real Chrome
    # never emits.) Input kinds are InputDeviceInfo, as upstream builds them.
    {
        "file": "third_party/blink/renderer/modules/mediastream/"
                "media_devices.cc",
        "header": '#include "apex_fingerprint.h"',
        "marker": "apex-devices",
        "anchor": "  result_tracker->Resolve(media_devices);\n",
        "where": "before",
        "inject": "  // apex-devices: an empty enumerateDevices() is a headless/VM\n"
                  "  // tell. For each kind with no real entry add ONE entry whose\n"
                  "  // deviceId, label and groupId are all \"\" -- exactly what\n"
                  "  // unpermissioned real Chrome reports. Kinds stay in enum\n"
                  "  // order and input kinds are InputDeviceInfo, as upstream.\n"
                  "  if (apex_fp::Active()) {\n"
                  "    MediaDeviceInfoVector apex_devices;\n"
                  "    for (wtf_size_t apex_i = 0;\n"
                  "         apex_i < static_cast<wtf_size_t>(\n"
                  "                      mojom::blink::MediaDeviceType::"
                  "kNumMediaDeviceTypes);\n"
                  "         ++apex_i) {\n"
                  "      const auto apex_kind =\n"
                  "          static_cast<mojom::blink::MediaDeviceType>(apex_i);\n"
                  "      bool apex_seen = false;\n"
                  "      for (const auto& apex_d : media_devices) {\n"
                  "        if (apex_d->DeviceType() == apex_kind) {\n"
                  "          apex_devices.push_back(apex_d);\n"
                  "          apex_seen = true;\n"
                  "        }\n"
                  "      }\n"
                  "      if (apex_seen) continue;\n"
                  "      if (apex_kind == "
                  "mojom::blink::MediaDeviceType::kMediaAudioOutput) {\n"
                  "        apex_devices.push_back("
                  "MakeGarbageCollected<MediaDeviceInfo>(\n"
                  "            g_empty_string, g_empty_string, g_empty_string, "
                  "apex_kind));\n"
                  "      } else {\n"
                  "        apex_devices.push_back("
                  "MakeGarbageCollected<InputDeviceInfo>(\n"
                  "            g_empty_string, g_empty_string, g_empty_string, "
                  "apex_kind));\n"
                  "      }\n"
                  "    }\n"
                  "    media_devices = std::move(apex_devices);\n"
                  "  }\n",
    },
    # --- FontCache availability allowlist -----------------------------
    {
        "file": "third_party/blink/renderer/platform/fonts/font_cache.cc",
        "header": '#include "third_party/blink/renderer/platform/fonts/'
                  'apex_font_policy.h"',
        "marker": "apex-font-allow",
        "anchor": "bool FontCache::IsPlatformFamilyMatchAvailable(\n",
        "where": "after-block",   # insert after the function's opening brace
        "inject": "  // apex-font-allow\n"
                  "  if (apex_fp::IsAllowlistedFont(family)) return true;\n",
    },

    # --- navigator.platform -------------------------------------------
    # navigator_id.cc is a multi-function file; anchor-patch just platform().
    {
        "file": "third_party/blink/renderer/core/frame/navigator_id.cc",
        "header": '#include "apex_fingerprint.h"',
        "marker": "apex-platform",
        "anchor": "String NavigatorID::platform() const {\n",
        "where": "after",
        "inject": "  // apex-platform\n"
                  "  if (apex_fp::HasOverride(\"APEX_FP_PLATFORM\")) {\n"
                  "    return String::FromUtf8(std::string_view(\n"
                  "        apex_fp::EnvStr(\"APEX_FP_PLATFORM\")));\n"
                  "  }\n"
                  "  // navigator.platform must agree with the UA and UA-CH\n"
                  "  // surfaces, so it maps from the same persona record.\n"
                  "  const apex_fp::UAPersona persona = apex_fp::GetUAPersona();\n"
                  "  if (persona.active) {\n"
                  "    return String::FromUtf8(persona.navigator_platform);\n"
                  "  }\n",
    },

    # --- screen.{width,height,availWidth,availHeight,colorDepth} -------
    # Each getter is anchored on its unique signature line; the apex value
    # is returned first, the upstream body stays as the fallback.
    {
        "file": "third_party/blink/renderer/core/frame/screen.cc",
        "header": '#include "apex_fingerprint.h"',
        "marker": "apex-screen-width",
        "anchor": "int Screen::width() const {\n",
        "where": "after",
        "inject": "  // apex-screen-width\n"
                  "  if (apex_fp::HasOverride(\"APEX_FP_SCREEN_W\")) {\n"
                  "    int v = apex_fp::EnvInt(\"APEX_FP_SCREEN_W\", 0);\n"
                  "    if (v > 0) return v;\n"
                  "  }\n",
    },
    {
        "file": "third_party/blink/renderer/core/frame/screen.cc",
        "marker": "apex-screen-height",
        "anchor": "int Screen::height() const {\n",
        "where": "after",
        "inject": "  // apex-screen-height\n"
                  "  if (apex_fp::HasOverride(\"APEX_FP_SCREEN_H\")) {\n"
                  "    int v = apex_fp::EnvInt(\"APEX_FP_SCREEN_H\", 0);\n"
                  "    if (v > 0) return v;\n"
                  "  }\n",
    },
    {
        "file": "third_party/blink/renderer/core/frame/screen.cc",
        "marker": "apex-screen-availwidth",
        "anchor": "int Screen::availWidth() const {\n",
        "where": "after",
        "inject": "  // apex-screen-availwidth\n"
                  "  if (apex_fp::HasOverride(\"APEX_FP_SCREEN_AVAIL_W\")) {\n"
                  "    int v = apex_fp::EnvInt(\"APEX_FP_SCREEN_AVAIL_W\", 0);\n"
                  "    if (v > 0) return v;\n"
                  "  }\n",
    },
    {
        "file": "third_party/blink/renderer/core/frame/screen.cc",
        "marker": "apex-screen-availheight",
        "anchor": "int Screen::availHeight() const {\n",
        "where": "after",
        "inject": "  // apex-screen-availheight\n"
                  "  if (apex_fp::HasOverride(\"APEX_FP_SCREEN_AVAIL_H\")) {\n"
                  "    int v = apex_fp::EnvInt(\"APEX_FP_SCREEN_AVAIL_H\", 0);\n"
                  "    if (v > 0) return v;\n"
                  "  }\n",
    },
    {
        "file": "third_party/blink/renderer/core/frame/screen.cc",
        "marker": "apex-screen-colordepth",
        "anchor": "unsigned Screen::colorDepth() const {\n",
        "where": "after",
        "inject": "  // apex-screen-colordepth\n"
                  "  if (apex_fp::HasOverride(\"APEX_FP_COLOR_DEPTH\")) {\n"
                  "    int v = apex_fp::EnvInt(\"APEX_FP_COLOR_DEPTH\", 0);\n"
                  "    if (v == 24 || v == 30) return static_cast<unsigned>(v);\n"
                  "  }\n",
    },

    # --- hardwareConcurrency: worker + iframe coherence ----------------
    # NavigatorBase::hardwareConcurrency() is the SHARED implementation for
    # Navigator (page + iframes) and WorkerNavigator (all workers). Upstream
    # then lets probe::ApplyHardwareConcurrencyOverride (a DevTools
    # per-ExecutionContext override) mutate the result -- but that override
    # only applies to the probe sink it was set on, so a page-target-only CDP
    # override diverges the main frame from workers. With the apex spoof on,
    # the env value is authoritative on EVERY surface: return before the
    # probe override.
    {
        "file": "third_party/blink/renderer/core/execution_context/"
                "navigator_base.cc",
        "header": '#include "apex_fingerprint.h"',
        "marker": "apex-hw-concurrency-coherent",
        "anchor": "  probe::ApplyHardwareConcurrencyOverride(\n"
                  "      probe::ToCoreProbeSink(GetExecutionContext()), "
                  "hardware_concurrency);",
        "where": "before",
        "inject": "  // apex-hw-concurrency-coherent: with the apex spoof on,\n"
                  "  // the env value is authoritative on every surface (page,\n"
                  "  // iframe, worker). Skip the per-context DevTools override\n"
                  "  // so a page-target-only override cannot diverge workers.\n"
                  "  if (apex_fp::Active())\n"
                  "    return hardware_concurrency;\n",
    },

    # --- Battery API: charging / level / times ------------------------
    {
        "file": "third_party/blink/renderer/modules/battery/battery_manager.cc",
        "header": '#include <limits>\n\n#include "apex_fingerprint.h"',
        "marker": "apex-battery-charging",
        "anchor": "bool BatteryManager::charging() {\n",
        "where": "after",
        "inject": "  // apex-battery-charging\n"
                  "  if (apex_fp::Active()) {\n"
                  "    return apex_fp::EnvStr(\"APEX_FP_BATTERY_CHARGING\")"
                  " == \"1\";\n"
                  "  }\n",
    },
    {
        "file": "third_party/blink/renderer/modules/battery/battery_manager.cc",
        "marker": "apex-battery-level",
        "anchor": "double BatteryManager::level() {\n",
        "where": "after",
        "inject": "  // apex-battery-level\n"
                  "  if (apex_fp::Active()) {\n"
                  "    double v = apex_fp::EnvDouble(\"APEX_FP_BATTERY_LEVEL\","
                  " -1.0);\n"
                  "    if (v >= 0.0 && v <= 1.0) {\n"
                  "      return static_cast<int>(v * 100.0 + 0.5) / 100.0;\n"
                  "    }\n"
                  "  }\n",
    },
    {
        "file": "third_party/blink/renderer/modules/battery/battery_manager.cc",
        "marker": "apex-battery-chargingtime",
        "anchor": "double BatteryManager::chargingTime() {\n",
        "where": "after",
        "inject": "  // apex-battery-chargingtime: not charging -> +Infinity\n"
                  "  if (apex_fp::Active()) {\n"
                  "    return (apex_fp::EnvStr(\"APEX_FP_BATTERY_CHARGING\")"
                  " == \"1\")\n"
                  "               ? 0.0\n"
                  "               : std::numeric_limits<double>::infinity();\n"
                  "  }\n",
    },
    {
        "file": "third_party/blink/renderer/modules/battery/battery_manager.cc",
        "marker": "apex-battery-dischargingtime",
        "anchor": "double BatteryManager::dischargingTime() {\n",
        "where": "after",
        "inject": "  // apex-battery-dischargingtime\n"
                  "  if (apex_fp::Active()) {\n"
                  "    if (apex_fp::EnvStr(\"APEX_FP_BATTERY_CHARGING\")"
                  " == \"1\") {\n"
                  "      return std::numeric_limits<double>::infinity();\n"
                  "    }\n"
                  "    double lvl = apex_fp::EnvDouble("
                  "\"APEX_FP_BATTERY_LEVEL\", 0.8);\n"
                  "    double secs = lvl * 5.0 * 3600.0;\n"
                  "    return static_cast<int>(secs / 60.0) * 60.0;\n"
                  "  }\n",
    },

    # --- WebGL readPixels noise ---------------------------------------
    # Verified anchor (Chromium 157.0.8103.27): ReadPixelsHelper is the one
    # chokepoint for the ArrayBufferView form of readPixels (WebGL1 + 2);
    # every JS pixel readback funnels through ContextGL()->ReadPixels(...).
    # Perturb the returned buffer with the same sparse +/-1 noise used for
    # 2D canvas so a hashed WebGL scene differs per session, stable within
    # one.
    # Gates: GL_RGBA + GL_UNSIGNED_BYTE with default pack state ONLY. The
    # validator above also accepts GL_ALPHA / GL_RGB / 16-bit types whose
    # buffers are SMALLER than w*h*4 -- an unconditional RGBA8 pass over
    # them overran the heap -- and WebGL2 PACK_ROW_LENGTH / PACK_SKIP_*
    # change the row layout. Rows are padded to PACK_ALIGNMENT, so the
    # stride is computed the way the validator computes it.
    {
        "file": "third_party/blink/renderer/modules/webgl/"
                "webgl_rendering_context_base.cc",
        "header": '#include "third_party/blink/renderer/modules/canvas/'
                  'canvas2d/apex_canvas_noise.h"',
        "marker": "apex-webgl-readpixels",
        "anchor": "    ContextGL()->ReadPixels(x, y, width, height, "
                  "format, type, data);\n",
        "where": "after",
        "inject": "    // apex-webgl-readpixels: per-session pixel farbling.\n"
                  "    // RGBA8 + default pack state only: other format/type\n"
                  "    // pairs pass validation with buffers smaller than\n"
                  "    // w*h*4, and PACK_ROW_LENGTH/SKIP_* change the layout.\n"
                  "    if (apex_fp::Active() && data != nullptr && width > 0 &&\n"
                  "        height > 0 && format == GL_RGBA &&\n"
                  "        type == GL_UNSIGNED_BYTE) {\n"
                  "      const WebGLImageConversion::PixelStoreParams apex_pack =\n"
                  "          GetPackPixelStoreParams();\n"
                  "      uint8_t* const apex_px = data;\n"
                  "      const size_t apex_w = static_cast<size_t>(width);\n"
                  "      const size_t apex_h = static_cast<size_t>(height);\n"
                  "      // Rows are padded to PACK_ALIGNMENT (1/2/4/8, validated\n"
                  "      // by pixelStorei). A stride of 0 makes the loop a no-op.\n"
                  "      const size_t apex_stride =\n"
                  "          (apex_pack.row_length == 0 && "
                  "apex_pack.skip_pixels == 0 &&\n"
                  "           apex_pack.skip_rows == 0 && apex_pack.alignment > 0 &&\n"
                  "           apex_pack.alignment <= 8)\n"
                  "              ? (apex_w * 4u + "
                  "static_cast<size_t>(apex_pack.alignment) -\n"
                  "                 1u) /\n"
                  "                    static_cast<size_t>(apex_pack.alignment) *\n"
                  "                    static_cast<size_t>(apex_pack.alignment)\n"
                  "              : 0u;\n"
                  "      const bool apex_bgra = false;  // gate: GL_RGBA only\n"
                  + _RGBA_NOISE_LOOP +
                  "    }\n",
    },

    # WebGPU persona: the identity, limits, features and type surfaces are
    # spoofed to the persona GPU so navigator.gpu is identity-coherent with the
    # WebGL strings and the UA persona. The adapter/device handles stay real
    # (rendering behavior unchanged); only the reported fingerprint is
    # rewritten. Shared helper: chromium_src/.../apex_webgpu.h (installed by
    # apply.sh alongside apex_fingerprint.h).
    {
        "file": "third_party/blink/renderer/modules/webgpu/gpu_adapter.cc",
        "header": '#include "third_party/blink/renderer/modules/webgpu/'
                  'apex_webgpu.h"',
        "marker": "apex-webgpu-identity",
        "anchor": ("  description_ = String::FromUtf8(info.device);\n"
                   "  driver_ = String::FromUtf8(info.description);\n"),
        "where": "after",
        "inject": (
            '  // apex-webgpu-identity: the persona GPU replaces the host GPU\n'
            '  // so adapter.info agrees with the WebGL strings and the UA\n'
            '  // persona. The adapter handle stays real, so rendering behavior\n'
            '  // is unchanged; only the reported identity is rewritten.\n'
            '  apex_webgpu::ApplyStringOverride("APEX_FP_WEBGPU_VENDOR",\n'
            '                                   &vendor_);\n'
            '  apex_webgpu::ApplyStringOverride("APEX_FP_WEBGPU_ARCH",\n'
            '                                   &architecture_);\n'
            '  apex_webgpu::ApplyStringOverride("APEX_FP_WEBGPU_DEVICE_ID",\n'
            '                                   &device_);\n'
            '  apex_webgpu::ApplyStringOverride("APEX_FP_WEBGPU_DESCRIPTION",\n'
            '                                   &description_);\n'
            '  apex_webgpu::ApplyStringOverride("APEX_FP_WEBGPU_DRIVER",\n'
            '                                   &driver_);\n'
            '  apex_webgpu::ApplyAdapterTypeOverride(&adapter_type_);\n'
            '  apex_webgpu::ApplyBackendTypeOverride(&backend_type_);\n'
        ),
    },
    {
        "file": "third_party/blink/renderer/modules/webgpu/gpu_adapter.cc",
        "header": '#include "third_party/blink/renderer/modules/webgpu/'
                  'apex_webgpu.h"',
        "marker": "apex-webgpu-limits",
        "anchor": "  limits_ = MakeGarbageCollected<GPUSupportedLimits>(limits);\n",
        "where": "before",
        "inject": (
            '  // apex-webgpu-limits: persona-claimed hardware limits replace\n'
            '  // the real adapter\'s (a software adapter otherwise reports\n'
            '  // spec-typical limits that contradict the claimed GPU class).\n'
            '  apex_webgpu::ApplyLimitOverrides(&limits);\n'
        ),
    },
    {
        "file": "third_party/blink/renderer/modules/webgpu/gpu_adapter.cc",
        "header": '#include "third_party/blink/renderer/modules/webgpu/'
                  'apex_webgpu.h"',
        "marker": "apex-webgpu-features",
        "anchor": "  features_ = MakeFeatureNameSet(GetHandle());\n",
        "where": "after",
        "inject": (
            '  // apex-webgpu-features: keep only the allowlisted subset when\n'
            '  // configured. Subset-only: a claimed feature the real adapter\n'
            '  // lacks would fail requestDevice validation.\n'
            '  features_ = apex_webgpu::FilterFeaturesByAllowlist(features_);\n'
        ),
    },
    # The device surfaces must agree with the adapter spoof (a probe reads
    # device.limits / device.features after requestDevice; divergence between
    # adapter and device is itself a tell). GPUDevice::Initialize builds both
    # from the device handle, so the same helpers apply there.
    {
        "file": "third_party/blink/renderer/modules/webgpu/gpu_device.cc",
        "header": '#include "third_party/blink/renderer/modules/webgpu/'
                  'apex_webgpu.h"',
        "marker": "apex-webgpu-device-limits",
        "anchor": "  limits_ = MakeGarbageCollected<GPUSupportedLimits>(limits);\n",
        "where": "before",
        "inject": (
            '  // apex-webgpu-device-limits: keep device.limits coherent with\n'
            '  // the spoofed adapter.limits (same override table).\n'
            '  apex_webgpu::ApplyLimitOverrides(&limits);\n'
        ),
    },
    {
        "file": "third_party/blink/renderer/modules/webgpu/gpu_device.cc",
        "header": '#include "third_party/blink/renderer/modules/webgpu/'
                  'apex_webgpu.h"',
        "marker": "apex-webgpu-device-features",
        "anchor": "  features_ = MakeGarbageCollected<GPUSupportedFeatures>(features);\n",
        "where": "after",
        "inject": (
            '  // apex-webgpu-device-features: keep device.features coherent\n'
            '  // with the spoofed adapter.features (same allowlist).\n'
            '  features_ = apex_webgpu::FilterFeaturesByAllowlist(features_);\n'
        ),
    },
    # --- Font deny hook: rendering agrees with document.fonts.check ------
    # Denies at FontCache::CreateFontPlatformData (font_cache_skia.cc:344) --
    # the one function every family lookup reaches after the cache miss and
    # before a FontPlatformData is built, so one edit covers CSS font-family,
    # canvas ctx.font, fonts.check() (IsPlatformFamilyMatchAvailable),
    # @font-face src:local() (kLocalUniqueFace), the bold/italic substitute
    # lookup and the Arial<->Helvetica alternate retry. It sits BELOW the
    # alternate-name retry on purpose: a denied "Helvetica" still falls to
    # "Arial" exactly as real Windows Chrome does. Exempt: per-character
    # fallback (kCreateFontByFciIdAndTtcIndex, never a page-named family) and
    # the last-resort chain (kLastResort), which must always produce a font.
    {
        "file": "third_party/blink/renderer/platform/fonts/skia/"
                "font_cache_skia.cc",
        "header": '#include "third_party/blink/renderer/platform/fonts/'
                  'apex_font_policy.h"',
        "marker": "apex-font-deny",
        "anchor": "  if (!typeface)\n"
                  "    return nullptr;\n",
        "where": "after",
        "inject": "  // apex-font-deny: a face the persona OS does not ship must\n"
                  "  // not render either, or width probes contradict\n"
                  "  // document.fonts.check(). Only page-nameable lookups are\n"
                  "  // policed; fontconfig per-character fallback and the\n"
                  "  // last-resort chain pass through.\n"
                  "  if (apex_fp::Active() &&\n"
                  "      creation_params.CreationType() == kCreateFontByFamily &&\n"
                  "      alternate_name != AlternateFontName::kLastResort) {\n"
                  "    bool apex_allowed;\n"
                  "    if (alternate_name == AlternateFontName::kLocalUniqueFace) {\n"
                  "      SkString apex_sk_family;\n"
                  "      typeface->getFamilyName(&apex_sk_family);\n"
                  "      apex_allowed =\n"
                  "          apex_fp::IsAllowlistedFont(ToAtomicString(apex_sk_family));\n"
                  "    } else {\n"
                  "      apex_allowed = apex_fp::IsAllowlistedFont(creation_params.Family());\n"
                  "    }\n"
                  "    if (!apex_allowed)\n"
                  "      return nullptr;\n"
                  "  }\n",
    },
    # system-ui bypasses the generic-settings path and resolves the host's UI
    # font (a bundle face, not a persona font); keep it a sans by substituting
    # the nearest allowed family instead of letting it fall to the serif font.
    {
        "file": "third_party/blink/renderer/platform/fonts/font_cache.cc",
        "header": '#include "third_party/blink/renderer/platform/fonts/'
                  'apex_font_policy.h"',
        "marker": "apex-font-system-ui",
        "anchor": "  return GetFontPlatformData(font_description, "
                  "FontFaceCreationParams(family),\n"
                  "                             AlternateFontName::kNoAlternate);\n",
        "where": "before",
        "inject": "  // apex-font-system-ui: a host UI font the persona OS does not\n"
                  "  // ship is refused by apex-font-deny; keep system-ui a sans by\n"
                  "  // resolving the nearest allowed family instead.\n"
                  "  if (apex_fp::Active() && !apex_fp::IsAllowlistedFont(family)) {\n"
                  "    return GetFontPlatformData(\n"
                  "        font_description, FontFaceCreationParams(font_family_names::kArial),\n"
                  "        AlternateFontName::kNoAlternate);\n"
                  "  }\n",
    },
    # Generic `monospace`: Chrome's Linux fixed-family default is the literal
    # "Monospace" (locale_settings_linux.grd IDS_FIXED_FONT_FAMILY), which is
    # not a persona font; map it to the nearest allowed monospace so <pre>/
    # <code> keeps its class. Document + OffscreenCanvas worker variants.
    {
        "file": "third_party/blink/renderer/core/css/css_font_selector.cc",
        "header": '#include "third_party/blink/renderer/platform/font_family_names.h"\n'
                  '#include "third_party/blink/renderer/platform/fonts/'
                  'apex_font_policy.h"',
        "marker": "apex-font-generic-mono",
        "anchor": "  AtomicString settings_family_name =\n"
                  "      FamilyNameFromSettings(request_description, font_family);\n"
                  "  if (settings_family_name.empty()) {\n"
                  "    return nullptr;\n"
                  "  }\n",
        "where": "after",
        "inject": "  // apex-font-generic-mono: the Linux fixed-family default\n"
                  "  // (\"Monospace\") is not a persona font; use the nearest allowed\n"
                  "  // monospace so the keyword keeps its class under apex-font-deny.\n"
                  "  if (apex_fp::Active() &&\n"
                  "      font_family.FamilyName() == font_family_names::kMonospace &&\n"
                  "      !apex_fp::IsAllowlistedFont(settings_family_name)) {\n"
                  "    settings_family_name = font_family_names::kCourierNew;\n"
                  "  }\n",
    },
    {
        "file": "third_party/blink/renderer/core/css/offscreen_font_selector.cc",
        "header": '#include "third_party/blink/renderer/platform/font_family_names.h"\n'
                  '#include "third_party/blink/renderer/platform/fonts/'
                  'apex_font_policy.h"',
        "marker": "apex-font-generic-mono-worker",
        "anchor": "  AtomicString settings_family_name =\n"
                  "      FamilyNameFromSettings(font_description, font_family);\n"
                  "  if (settings_family_name.empty()) {\n"
                  "    return nullptr;\n"
                  "  }\n",
        "where": "after",
        "inject": "  // apex-font-generic-mono-worker: same as apex-font-generic-mono\n"
                  "  // for OffscreenCanvas in workers.\n"
                  "  if (apex_fp::Active() &&\n"
                  "      font_family.FamilyName() == font_family_names::kMonospace &&\n"
                  "      !apex_fp::IsAllowlistedFont(settings_family_name)) {\n"
                  "    settings_family_name = font_family_names::kCourierNew;\n"
                  "  }\n",
    },
    # --- WebCodecs video decode hw-support override --------------------
    # Without a GPU process the GpuVideoAcceleratorFactories are null, and
    # DecoderSupport_OnKnown (video_decoder.cc, the one funnel for
    # isConfigSupported with hardwareAcceleration:'prefer-hardware') resolves
    # supported=false for EVERY codec -- a GPU-class persona is detected as
    # software-only. When the persona claims hardware decode, report it here
    # (before the null check, which is what runs on the host). Runtime-gated:
    # a launch without APEX_FP_MEDIA_HW_DECODE keeps stock output.
    # Verified anchor (Chromium 157.0.8103.38).
    {
        "file": "third_party/blink/renderer/modules/webcodecs/"
                "video_decoder.cc",
        "header": '#include "third_party/blink/renderer/modules/webcodecs/'
                  'apex_fingerprint.h"',
        "marker": "apex-webcodecs-decoder-hw",
        "anchor": "media::GpuVideoAcceleratorFactories* gpu_factories) {\n"
                  "  if (!gpu_factories) {\n",
        "where": "after",
        "inject": "  // apex-webcodecs-decoder-hw: persona hw-decode override\n"
                  "  if (apex_fp::MediaHwDecode()) {\n"
                  "    support->setSupported(true);\n"
                  "    resolver->Resolve(support);\n"
                  "    return;\n"
                  "  }\n",
    },
    # --- WebCodecs video encoder hw-support override -------------------
    # Same class as the decoder: isConfigSupportedWithHardwareOnly is the
    # hardware-encoder funnel for isConfigSupported({hw:'prefer-hardware'}).
    # Without GPU factories it falls through to
    # IsAcceleratedConfigurationSupported(nullptr) -> supported=false.
    # Verified anchor (Chromium 157.0.8103.38).
    {
        "file": "third_party/blink/renderer/modules/webcodecs/"
                "video_encoder.cc",
        "header": '#include "third_party/blink/renderer/modules/webcodecs/'
                  'apex_fingerprint.h"',
        "marker": "apex-webcodecs-encoder-hw",
        "anchor": "  auto required_encoder_type =\n"
                  "      GetRequiredEncoderType(config->profile, "
                  "config->hw_pref);\n",
        "where": "before",
        "inject": "  // apex-webcodecs-encoder-hw: persona hw-encode override\n"
                  "  if (apex_fp::MediaHwEncode()) {\n"
                  "    support->setSupported(true);\n"
                  "    std::move(callback).Run(support);\n"
                  "    return;\n"
                  "  }\n",
    },
    # --- mediaCapabilities powerEfficient override ---------------------
    # decodingInfo().powerEfficient comes from MediaCapabilities::
    # GetGpuFactoriesSupport: with no GPU factories the host answers
    # OnGpuFactoriesSupport(false) and every query reports
    # powerEfficient=false -- the exact GPU-truth tell for h264 1080p on a
    # desktop persona. When the persona claims hardware decode, answer the
    # GPU factories query with true (before the real GetGpuFactories call).
    # Verified anchor (Chromium 157.0.8103.38).
    {
        "file": "third_party/blink/renderer/modules/media_capabilities/"
                "media_capabilities.cc",
        "header": '#include "third_party/blink/renderer/modules/'
                  'media_capabilities/apex_fingerprint.h"',
        "marker": "apex-media-power",
        "anchor": "  media::GpuVideoAcceleratorFactories* gpu_factories =\n"
                  "      Platform::Current()->GetGpuFactories();\n",
        "where": "before",
        "inject": "  // apex-media-power: persona hw-decode => powerEfficient=true\n"
                  "  if (apex_fp::MediaHwDecode()) {\n"
                  "    OnGpuFactoriesSupport(callback_id, true, video_codec);\n"
                  "    return;\n"
                  "  }\n",
    },
    # --- media/base codec support overrides (HEVC / Dolby Vision) ------
    # process, and calls IsProfileSupported (which needs the supplemental cache
    # filled by the GPU process -- empty on this container). When the persona
    # claims HEVC decode, answer for the mainstream Main/Main10 profiles
    # (what essentially every desktop GPU decodes). DV likewise, only when the
    # persona claims it AND HEVC. Verified anchors (Chromium 157.0.8103.38;
    # the #else/return-true tail makes the HEVC anchor unique -- the DV
    # function has the same return statement but different surrounding text).
    # HEVC inserts inside the #if ENABLE_PLATFORM_HEVC branch (before the
    # real return). DV anchors on the LAST line of the multi-line #if
    # condition and inserts AFTER it: inserting before/at the condition or
    # spanning the backslash continuations puts the inject inside the
    # preprocessor expression and breaks compilation ("expected value in
    # expression" -- the first v38 build failure class).
    {
        "file": "media/base/supported_types.cc",
        "header": '#include "apex_fingerprint.h"',
        "marker": "apex-media-hevc",
        "anchor": "  return GetSupplementalDecoderVideoProfileCache()->"
                  "IsProfileSupported(\n"
                  "      type.profile);\n"
                  "#else\n"
                  "  return true;\n"
                  "#endif  // BUIDFLAG(PLATFORM_HAS_OPTIONAL_HEVC_DECODE_"
                  "SUPPORT)\n",
        "where": "before",
        "inject": "  // apex-media-hevc: persona HEVC claim (Main/Main10)\n"
                  "  if (apex_fp::MediaHevc() &&\n"
                  "      (type.profile == media::HEVCPROFILE_MAIN ||\n"
                  "       type.profile == media::HEVCPROFILE_MAIN10)) {\n"
                  "    return true;\n"
                  "  }\n",
    },
    {
        "file": "media/base/supported_types.cc",
        "header": '#include "apex_fingerprint.h"',
        "marker": "apex-media-dv",
        "anchor": "    BUILDFLAG(ENABLE_PLATFORM_DOLBY_VISION)\n",
        "where": "after",
        "inject": "  // apex-media-dv: persona Dolby Vision claim\n"
                  "  if (apex_fp::MediaDolbyVision()) {\n"
                  "    return true;\n"
                  "  }\n",
    },
    # --- WebAuthn platform authenticator -------------------------------
    # IsUvpaaAvailableInternal is the single funnel for BOTH
    # PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() and
    # GetClientCapabilities' userVerifyingPlatformAuthenticator bit. The real
    # answer is resolved per-OS: Windows (WinWebAuthnApi) / macOS (TouchId) /
    # ChromeOS (ChromeOSAuthenticator) -- Linux has NO implementation of
    # content::IsUVPlatformAuthenticatorAvailable in is_uvpaa.cc at all, so a
    # Linux build always answers false: the platformAuth=false tell. A desktop
    # persona reports a platform authenticator (Windows Hello / Touch ID).
    # Verified anchor (Chromium 157.0.8103.38).
    {
        "file": "content/browser/webauth/authenticator_common_impl.cc",
        "header": '#include "apex_fingerprint.h"',
        "marker": "apex-webauthn-platform",
        "anchor": "void AuthenticatorCommonImpl::IsUvpaaAvailableInternal(\n"
                  "    url::Origin caller_origin,\n"
                  "    blink::mojom::Authenticator::\n"
                  "        "
                  "IsUserVerifyingPlatformAuthenticatorAvailableCallback "
                  "callback,\n"
                  "    bool is_get_client_capabilities_call) {\n",
        "where": "after",
        "inject": "  // apex-webauthn-platform: persona platform-authenticator\n"
                  "  if (apex_fp::PlatformAuthenticator()) {\n"
                  "    std::move(callback).Run(true);\n"
                  "    return;\n"
                  "  }\n",
    },
    # --- navigator.storage.estimate() persona quota ---------------------
    # The quota the browser answers with is derived from the HOST disk
    # (storage/browser/quota/quota_settings.cc: pool = total_disk * 0.8,
    # per_key = pool * 0.75), so a container reports the container's disk
    # size -- the round-2 probe caught the baseline at exactly 10 GiB.
    # QueryStorageUsageAndQuotaCallback is the last hop before the
    # script-visible StorageEstimate object, so overriding the quota there
    # catches every upstream derivation path. usage/usageDetails are left
    # real: 0 and {} are the genuine fresh-profile shape (the field is
    # populated only for non-zero usage breakdowns).
    # Verified anchor (Chromium 157.0.8103.38).
    {
        "file": "third_party/blink/renderer/modules/quota/"
                "storage_manager.cc",
        "header": '#include "third_party/blink/renderer/modules/quota/'
                  'apex_quota.h"',
        "marker": "apex-storage-quota",
        "anchor": "  estimate->setUsage(usage_in_bytes);\n"
                  "  estimate->setQuota(quota_in_bytes);\n",
        "where": "after",
        "inject": "  // apex-storage-quota: persona quota replaces the\n"
                  "  // host-disk-derived one (the container disk is not the\n"
                  "  // persona machine).\n"
                  "  if (apex_quota::QuotaBytes() > 0) {\n"
                  "    estimate->setQuota(apex_quota::QuotaBytes());\n"
                  "  }\n",
    },
    # --- navigator.connection persona quality override ------------------
    # The container's NetworkChangeNotifier classifies the NIC as ETHERNET
    # and NQE's platform default observation for it is 90ms HTTP RTT /
    # 1456 kbps (net/nqe/network_quality_estimator_params.cc
    # ObtainDefaultObservations), which report rounding turns into
    # {4g, downlink 1.5, rtt 100} -- not what a desktop persona machine
    # reports (round-2 probe: stock {4g, 10, 50}). SetNetworkQuality is the
    # single choke point where the browser's pushed values enter Blink (both
    # the not-observing getters and the ConnectionChange observer cache read
    # that state), so overriding the parameters there covers both. The
    # override values (rtt 50ms, 10000 kbps) are REACHABLE by the real
    # reporting path -- RoundRtt rounds 50ms to exactly 50 for the whole
    # 0.90..1.10 multiplier band and RoundMbps clamps 10000 kbps to exactly
    # the 10.0 Mbps kMaxDownlinkKbps -- so the reported numbers are still
    # produced by the real rounding code, not by us. transport_rtt and
    # saveData are left real (saveData false is stock).
    # Verified anchor (Chromium 157.0.8103.38).
    {
        "file": "third_party/blink/renderer/platform/network/"
                "network_state_notifier.cc",
        "header": '#include "third_party/blink/renderer/platform/network/'
                  'apex_netinfo.h"',
        "marker": "apex-netinfo-quality",
        "anchor": "void NetworkStateNotifier::SetNetworkQuality("
                  "WebEffectiveConnectionType type,\n"
                  "                                             "
                  "base::TimeDelta http_rtt,\n"
                  "                                             "
                  "base::TimeDelta transport_rtt,\n"
                  "                                             "
                  "int downlink_throughput_kbps) {\n",
        "where": "after",
        "inject": "  // apex-netinfo-quality: persona connection-quality\n"
                  "  // overrides replace the host/container-derived estimates\n"
                  "  // (a Linux container classifies as ETHERNET and reports\n"
                  "  // the Ethernet NQE defaults, which is the tell).\n"
                  "  const int apex_rtt = apex_netinfo::RttMsOverride();\n"
                  "  if (apex_rtt >= 0) {\n"
                  "    http_rtt = base::Milliseconds(apex_rtt);\n"
                  "  }\n"
                  "  const int apex_kbps = apex_netinfo::DownlinkKbpsOverride();\n"
                  "  if (apex_kbps >= 0) {\n"
                  "    downlink_throughput_kbps = apex_kbps;\n"
                  "  }\n"
                  "  const std::optional<WebEffectiveConnectionType> apex_ect =\n"
                  "      apex_netinfo::EffectiveTypeOverride();\n"
                  "  if (apex_ect) {\n"
                  "    type = *apex_ect;\n"
                  "  }\n",
    },
    # --- removed edits (do not re-add without new evidence) ------------
    # apex-chrome-app-gone: stock Chrome 157 still exposes chrome.app on web
    #   pages; removing it created a distinguisher instead of closing one.
    # apex-measuretext-farbling: its anchor relied on TextMetrics::font_ /
    #   `text`, which are gone on main -- it would fail to compile on the
    #   next major.
    # apex-audio-noise: +/-1e-7 on OfflineAudioContext output moved the
    #   audio hash into a rare cluster; stock output is already common.
]


def _ensure_header(text: str, header: str | None) -> str:
    """Add the apex #include just after the file's license block."""
    if not header or header in text:
        return text
    lines = text.splitlines(keepends=True)
    # insert after the first run of comment lines (the license header)
    i = 0
    while i < len(lines) and (lines[i].startswith("//")
                              or lines[i].strip() == ""):
        i += 1
    lines.insert(i, header + "\n\n")
    return "".join(lines)


def _marker_present(text: str, marker: str) -> bool:
    """True iff `// <marker>` occurs in `text` as a whole token.

    A bare substring test is wrong: `apex-battery-charging` is a prefix of
    `apex-battery-chargingtime`, so once the latter was applied the former
    was reported as already applied and silently skipped.
    """
    return re.search(rf"// {re.escape(marker)}(?![\w-])", text) is not None


def apply_one(edit: dict, check: bool) -> tuple[bool, str]:
    """Apply (or check) a single edit. Returns (ok, message)."""
    path = SRC / edit["file"]
    if not path.exists():
        return (edit.get("optional", False),
                f"file not found: {edit['file']}"
                + (" (optional, skipped)" if edit.get("optional") else ""))
    text = path.read_text()

    if _marker_present(text, edit["marker"]):
        return True, f"already applied: {edit['marker']}"

    anchor = edit["anchor"]
    if anchor not in text:
        msg = f"ANCHOR NOT FOUND in {edit['file']}: {edit['marker']}"
        return (edit.get("optional", False), msg)
    if text.count(anchor) != 1:
        return (False,
                f"anchor not unique ({text.count(anchor)}x): {edit['marker']}")

    if check:
        return True, f"anchor OK: {edit['marker']}"

    where = edit["where"]
    if where == "before":
        new = text.replace(anchor, edit["inject"] + anchor, 1)
    elif where == "after":
        new = text.replace(anchor, anchor + edit["inject"], 1)
    elif where == "after-block":
        # find the anchor, then the next "{" after it, insert after that
        idx = text.index(anchor)
        brace = text.index("{", idx)
        new = text[:brace + 1] + "\n" + edit["inject"] + text[brace + 1:]
    else:
        return False, f"unknown where: {where}"

    new = _ensure_header(new, edit.get("header"))
    path.write_text(new)
    return True, f"applied: {edit['marker']}"


def verify_applied() -> int:
    """Post-apply gate: every marker must exist in its target file.

    Catches silent partial application (apply run interrupted, manual edits
    to the tree, anchor shifting without failing). Camoufox-style governance:
    a build with any missing marker must not proceed.
    """
    missing = 0
    for edit in EDITS:
        path = SRC / edit["file"]
        marker = edit.get("marker")
        try:
            text = path.read_text()
        except OSError:
            print(f"  MISS {edit['file']}: file not found")
            missing += 1
            continue
        if not _marker_present(text, marker):
            print(f"  MISS {edit['file']}: marker {marker!r} absent")
            missing += 1
    if missing:
        print(f"{missing} marker(s) absent -- apply is incomplete. Re-run "
              f"apply_edits.py.")
        return 1
    print(f"all {len(EDITS)} markers present")
    return 0


def main() -> int:
    check = "--check" in sys.argv
    verify = "--verify" in sys.argv
    if verify:
        return verify_applied()
    if not SRC.exists():
        print(f"ERROR: no checkout at {SRC}")
        return 1
    print(f"=== apex-chromium {'check' if check else 'apply'} edits ===")
    failures = 0
    for edit in EDITS:
        ok, msg = apply_one(edit, check)
        print(f"  {'OK  ' if ok else 'FAIL'} {msg}")
        if not ok:
            failures += 1
    print()
    if failures:
        print(f"{failures} edit(s) failed -- anchors need re-fitting "
              f"(Chromium drifted). Inspect the source and update EDITS.")
        return 1
    print("all edits " + ("verified" if check else "applied"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
