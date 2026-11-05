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
# Bounds: every access goes through base::span (CHECKed), never raw indexing,
# so the body is -Wunsafe-buffer-usage clean; the one pointer->span step is
# wrapped in UNSAFE_BUFFERS with its invariant stated. The span covers exactly
# the bytes GL / Skia wrote -- (apex_h - 1) full strides plus one unpadded
# final row -- which is the size the upstream validators already require.
_RGBA_NOISE_LOOP = (
    "      const uint32_t apex_seed = apex_fp::Seed();\n"
    "      if (apex_seed != 0 && apex_w >= 3u && apex_h >= 3u &&\n"
    "          apex_stride >= apex_w * 4u) {\n"
    "        // SAFETY: caller-validated 8-bit RGBA/BGRA buffer of apex_h\n"
    "        // rows apex_stride bytes apart; last row >= apex_w * 4 bytes.\n"
    "        base::span<uint8_t> apex_buf = UNSAFE_BUFFERS(base::span<uint8_t>(\n"
    "            apex_px, apex_stride * (apex_h - 1u) + apex_w * 4u));\n"
    "        auto apex_at = [&](size_t ax, size_t ay) {\n"
    "          return apex_buf.subspan(ay * apex_stride + ax * 4u, 4u);\n"
    "        };\n"
    "        apex_fp::Mulberry32 apex_rng(apex_seed);\n"
    "        for (size_t ay = 1; ay + 1 < apex_h; ++ay) {\n"
    "          for (size_t ax = 1; ax + 1 < apex_w; ++ax) {\n"
    "            if (apex_rng.NextDouble() >= 0.003) continue;\n"
    "            base::span<uint8_t> apex_p = apex_at(ax, ay);\n"
    "            if (apex_p[3] == 0) continue;  // transparent: untouched\n"
    "            bool apex_uniform = true;\n"
    "            for (size_t ady = 0; ady < 3u && apex_uniform; ++ady) {\n"
    "              for (size_t adx = 0; adx < 3u; ++adx) {\n"
    "                base::span<uint8_t> apex_n =\n"
    "                    apex_at(ax + adx - 1u, ay + ady - 1u);\n"
    "                if (apex_n[0] != apex_p[0] || apex_n[1] != apex_p[1] ||\n"
    "                    apex_n[2] != apex_p[2] || apex_n[3] != apex_p[3]) {\n"
    "                  apex_uniform = false;\n"
    "                  break;\n"
    "                }\n"
    "              }\n"
    "            }\n"
    "            if (apex_uniform) continue;  // solid fill: untouched\n"
    "            for (size_t ac = 0; ac < 3u; ++ac) {  // bytes 0..2, not A\n"
    "              const int apex_d = (apex_rng.NextDouble() < 0.5) ? -1 : 1;\n"
    "              const int apex_v = static_cast<int>(apex_p[ac]) + apex_d;\n"
    "              apex_p[ac] = static_cast<uint8_t>(\n"
    "                  apex_v < 0 ? 0 : (apex_v > 255 ? 255 : apex_v));\n"
    "            }\n"
    "          }\n"
    "        }\n"
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
    # --- WebRTC: default (mDNS-obfuscated) candidate gathering ---------
    # NOTE: an earlier edit here forced webrtc_ip_handling_policy =
    # kDisableNonProxiedUdp when apex was active ("never leak the real IP").
    # It backfired: that policy drops ALL host candidates, so ICE produced
    # zero candidates (round-2 F12) while real desktop Chrome always emits
    # host candidates (mDNS .local names). Default candidate gathering with
    # mDNS obfuscation IS the no-leak mechanism: host candidates carry only
    # obfuscated .local names (the LAN IPs never reach the page) and srflx
    # carries the WAN IP -- exactly what a real user behind a proxy exposes.
    # The forced-policy edit is removed; no binary change is needed for
    # WebRTC.
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
                  + _RGBA_NOISE_LOOP +
                  "    }\n",
    },

    # WebGPU adapter info: report the persona GPU instead of the host GPU so
    # navigator.gpu adapter info is identity-coherent with the WebGL strings
    # (the adapter handle itself stays real, so limits/features stay native).
    {
        "file": "third_party/blink/renderer/modules/webgpu/gpu_adapter.cc",
        "header": '#include "apex_fingerprint.h"',
        "marker": "apex-webgpu-identity",
        "anchor": ("  description_ = String::FromUtf8(info.device);\n"
                   "  driver_ = String::FromUtf8(info.description);\n"),
        "where": "after",
        "inject": (
            '        {  // apex-webgpu-identity\n'
            '          if (apex_fp::HasOverride("APEX_FP_WEBGPU_VENDOR"))\n'
            '            vendor_ = String::FromUtf8(\n'
            '                apex_fp::EnvStr("APEX_FP_WEBGPU_VENDOR"));\n'
            '          if (apex_fp::HasOverride("APEX_FP_WEBGPU_ARCH"))\n'
            '            architecture_ = String::FromUtf8(\n'
            '                apex_fp::EnvStr("APEX_FP_WEBGPU_ARCH"));\n'
            '        }\n'
        ),
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
