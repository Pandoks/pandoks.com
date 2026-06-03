#!/usr/bin/env python3
"""apex-chromium: anchor-based source edits.

The raw `.patch` files in patches/ describe WHAT to change, but hand-written
unified-diff line numbers never apply cleanly across Chromium versions. This
script instead applies each mid-function edit by ANCHOR: it finds a unique,
stable substring in the real source file and inserts the apex code relative to
it. Anchor matching survives line-number drift -- it only breaks if Chromium
actually renames/removes the anchored code, which refresh_patches.sh detects.

Run by scripts/apply.sh after the chromium_src overlays are installed.
Idempotent: every edit is tagged with an `// apex:` marker and skipped if the
marker is already present.

Usage:  APEX_CHROMIUM_WORK=/path python3 apply_edits.py [--check]
  --check : verify every anchor is findable, change nothing (dry run).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

WORK = Path(os.environ.get("APEX_CHROMIUM_WORK",
                           str(Path.home() / "apex-chromium-build")))
SRC = WORK / "chromium" / "src"

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
    # --- navigator.userAgentData.platform ------------------------------
    {
        "file": "third_party/blink/renderer/core/frame/navigator_ua_data.cc",
        "header": '#include "apex_fingerprint.h"',
        "marker": "apex-uadata-platform",
        "anchor": "void NavigatorUAData::SetPlatform(const String& brand, "
                  "const String& version) {\n",
        "where": "after",
        "inject": "  // apex-uadata-platform\n"
                  "  if (apex_fp::HasOverride(\"APEX_FP_UA_PLATFORM\")) {\n"
                  "    platform_ = String::FromUtf8(std::string_view(\n"
                  "        apex_fp::EnvStr(\"APEX_FP_UA_PLATFORM\")));\n"
                  "    platform_version_ = version;\n"
                  "    return;\n"
                  "  }\n",
    },
    # --- WebRTC: force no non-proxied UDP ------------------------------
    # Inserted BEFORE the policy switch: when apex is active, force the
    # no-leak config and rewrite the policy var to kDisableNonProxiedUdp so
    # the switch (which still runs) reaffirms it. This avoids an invalid
    # statement-before-first-case and keeps the switch well-formed.
    {
        "file": "third_party/blink/renderer/modules/peerconnection/"
                "peer_connection_dependency_factory.cc",
        "header": '#include "apex_fingerprint.h"',
        "marker": "apex-webrtc-noleak",
        "anchor": "      switch (webrtc_ip_handling_policy) {\n",
        "where": "before",
        "inject": "      // apex-webrtc-noleak: never let WebRTC leak the real IP\n"
                  "      if (apex_fp::Active()) {\n"
                  "        webrtc_ip_handling_policy =\n"
                  "            mojom::blink::WebRtcIpHandlingPolicy::"
                  "kDisableNonProxiedUdp;\n"
                  "      }\n",
    },
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
    # Verified anchor (Chromium 148): after readPixels() fills image_data's
    # SkPixmap inside getImageDataInternal's `if (snapshot)` block, perturb
    # the pixels before the function returns.
    {
        "file": "third_party/blink/renderer/modules/canvas/canvas2d/"
                "base_rendering_context_2d.cc",
        "header": '#include "third_party/blink/renderer/modules/canvas/'
                  'canvas2d/apex_canvas_noise.h"',
        "marker": "apex-canvas-getimagedata",
        "anchor": "    if (!read_pixels_successful) {\n",
        "where": "before",
        "inject": "    // apex-canvas-getimagedata: perturb the readback pixels\n"
                  "    if (apex_fp::Active()) {\n"
                  "      apex_fp::PerturbRGBA(\n"
                  "          static_cast<uint8_t*>("
                  "image_data_pixmap.writable_addr()),\n"
                  "          static_cast<size_t>(image_data_pixmap.width()) *\n"
                  "              static_cast<size_t>("
                  "image_data_pixmap.height()));\n"
                  "    }\n",
    },
    # --- canvas toDataURL / toBlob noise -------------------------------
    # Verified anchor (Chromium 148): the ImageDataBuffer(StaticBitmapImage)
    # constructor's texture-backed path reads pixels into a fresh writable
    # buffer via paint_image.readPixels(...). Perturbing there covers every
    # encode path (toDataURL, toBlob, convertToBlob) with one edit.
    {
        "file": "third_party/blink/renderer/platform/graphics/"
                "image_data_buffer.cc",
        "header": '#include "third_party/blink/renderer/modules/canvas/'
                  'canvas2d/apex_canvas_noise.h"',
        "marker": "apex-canvas-encode",
        "anchor": "    if (!paint_image.readPixels(info, pixmap_.writable_addr()"
                  ", rowBytes, 0,\n"
                  "                                0)) {\n"
                  "      pixmap_.reset();\n"
                  "      return;\n"
                  "    }\n",
        "where": "after",
        "inject": "    // apex-canvas-encode: perturb pixels before any encode\n"
                  "    if (apex_fp::Active()) {\n"
                  "      apex_fp::PerturbRGBA(\n"
                  "          static_cast<uint8_t*>(pixmap_.writable_addr()),\n"
                  "          static_cast<size_t>(pixmap_.width()) *\n"
                  "              static_cast<size_t>(pixmap_.height()));\n"
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
    # --- audio: perturb channel data on AudioBuffer construction -------
    # Verified anchor (Chromium 148): in AudioBuffer(AudioBus*), each channel
    # is filled via AsSpan().copy_from(...); perturb just after, before push.
    {
        "file": "third_party/blink/renderer/modules/webaudio/audio_buffer.cc",
        "header": '#include "third_party/blink/renderer/modules/webaudio/'
                  'apex_audio_noise.h"',
        "marker": "apex-audio-noise",
        "anchor": "    channel_data_array->AsSpan().copy_from("
                  "bus->Channel(i)->Span());\n",
        "where": "after",
        "inject": "    // apex-audio-noise: imperceptible per-session offset\n"
                  "    if (apex_fp::Active()) {\n"
                  "      apex_fp::PerturbAudioChannel(\n"
                  "          channel_data_array->AsSpan(), i);\n"
                  "    }\n",
    },
    # --- mediaDevices.enumerateDevices --------------------------------
    # Verified anchor (Chromium 148): in DevicesEnumerated, the
    # MediaDeviceInfoVector `media_devices` is resolved via
    # result_tracker->Resolve(media_devices). Fill it in first if sparse.
    {
        "file": "third_party/blink/renderer/modules/mediastream/"
                "media_devices.cc",
        "header": '#include "third_party/blink/renderer/modules/mediastream/'
                  'apex_devices.h"',
        "marker": "apex-devices",
        "anchor": "  result_tracker->Resolve(media_devices);\n",
        "where": "before",
        "inject": "  // apex-devices: ensure a realistic, non-empty device set\n"
                  "  apex_fp::EnsureRealisticDevices(&media_devices,\n"
                  "                                  GetExecutionContext());\n",
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
    # The single readPixels chokepoint -- every WebGL pixel-readback form
    # funnels through ContextGL()->ReadPixels(...). Perturb the returned
    # buffer with the same sparse +/-1 RGBA noise used for 2D canvas so
    # a JS attacker who hashes a rendered WebGL scene gets a different
    # hash per session, but stable within one session.
    {
        "file": "third_party/blink/renderer/modules/webgl/"
                "webgl_rendering_context_base.cc",
        "header": '#include "third_party/blink/renderer/modules/canvas/'
                  'canvas2d/apex_canvas_noise.h"',
        "marker": "apex-webgl-readpixels",
        "anchor": "    ContextGL()->ReadPixels(x, y, width, height, "
                  "format, type, data);\n",
        "where": "after",
        "inject": "    // apex-webgl-readpixels: per-session pixel farbling\n"
                  "    if (apex_fp::Active() && data != nullptr) {\n"
                  "      apex_fp::PerturbRGBA(\n"
                  "          static_cast<uint8_t*>(data),\n"
                  "          static_cast<size_t>(width) *\n"
                  "              static_cast<size_t>(height));\n"
                  "    }\n",
    },

    # --- Canvas measureText farbling ----------------------------------
    # Apply a +/-0.0003% scale to every TextMetrics field at the end of
    # TextMetrics::Update -- a single edit covers width, the four
    # actualBoundingBox*, the two fontBoundingBox*, emHeight*, and the
    # three baselines via the Baselines object. Stable per (seed, font, text).
    {
        "file": "third_party/blink/renderer/core/html/canvas/text_metrics.cc",
        "header": '#include "third_party/blink/renderer/core/html/canvas/'
                  'apex_text_metrics_noise.h"',
        "marker": "apex-measuretext-farbling",
        # The constructor body ends with the IdeographicBaseline if/else;
        # anchor on the final closing brace of the Update() function.
        "anchor": "    baselines_->setIdeographic(-descent - baseline_y);\n"
                  "  }\n"
                  "}\n",
        "where": "before",
        "inject": "  // apex-measuretext-farbling: imperceptible per-session\n"
                  "  // scaling on every metric. Stable within a session;\n"
                  "  // different across sessions / fonts / texts.\n"
                  "  if (apex_fp::Active()) {\n"
                  "    // AtomicString::Utf8() -> std::string directly.\n"
                  "    const std::string font_id =\n"
                  "        font_ ? font_->GetFontDescription()\n"
                  "                     .Family().FamilyName().Utf8()\n"
                  "             : std::string();\n"
                  "    const std::string text_str = text.Utf8();\n"
                  "    double f = apex_fp::TextMetricNoiseFactor(\n"
                  "        font_id, text_str);\n"
                  "    width_ *= f;\n"
                  "    actual_bounding_box_left_ *= f;\n"
                  "    actual_bounding_box_right_ *= f;\n"
                  "    actual_bounding_box_ascent_ *= f;\n"
                  "    actual_bounding_box_descent_ *= f;\n"
                  "    font_bounding_box_ascent_ *= f;\n"
                  "    font_bounding_box_descent_ *= f;\n"
                  "    em_height_ascent_ *= f;\n"
                  "    em_height_descent_ *= f;\n"
                  "  }\n",
    },

    # --- navigator.connection.effectiveType ---------------------------
    # Datacenter/headless hosts often report a NetInfo profile that differs
    # from a residential machine (rtt≈0, missing/odd effectiveType). Spoof a
    # plausible residential broadband profile. Returned BEFORE the upstream
    # body so the holdback-experiment + observer paths are bypassed cleanly.
    {
        "file": "third_party/blink/renderer/modules/netinfo/"
                "network_information.cc",
        "header": '#include "apex_fingerprint.h"',
        "marker": "apex-net-effective-type",
        "anchor": "V8EffectiveConnectionType NetworkInformation::effectiveType()"
                  " {\n",
        "where": "after",
        "inject": "  // apex-net-effective-type\n"
                  "  if (apex_fp::HasOverride(\"APEX_FP_NET_EFFECTIVE_TYPE\")) {\n"
                  "    const std::string ect =\n"
                  "        apex_fp::EnvStr(\"APEX_FP_NET_EFFECTIVE_TYPE\");\n"
                  "    if (ect == \"slow-2g\")\n"
                  "      return V8EffectiveConnectionType(\n"
                  "          V8EffectiveConnectionType::Enum::kSlow2G);\n"
                  "    if (ect == \"2g\")\n"
                  "      return V8EffectiveConnectionType(\n"
                  "          V8EffectiveConnectionType::Enum::k2G);\n"
                  "    if (ect == \"3g\")\n"
                  "      return V8EffectiveConnectionType(\n"
                  "          V8EffectiveConnectionType::Enum::k3G);\n"
                  "    if (ect == \"4g\")\n"
                  "      return V8EffectiveConnectionType(\n"
                  "          V8EffectiveConnectionType::Enum::k4G);\n"
                  "  }\n",
    },
    # --- navigator.connection.rtt -------------------------------------
    # Chrome rounds RTT to the nearest 50ms for privacy; mirror that so the
    # spoofed value can't be distinguished by its granularity.
    {
        "file": "third_party/blink/renderer/modules/netinfo/"
                "network_information.cc",
        "marker": "apex-net-rtt",
        "anchor": "uint32_t NetworkInformation::rtt() {\n",
        "where": "after",
        "inject": "  // apex-net-rtt\n"
                  "  if (apex_fp::HasOverride(\"APEX_FP_NET_RTT\")) {\n"
                  "    uint32_t v = apex_fp::EnvU32(\"APEX_FP_NET_RTT\", 0u);\n"
                  "    return ((v + 25u) / 50u) * 50u;\n"
                  "  }\n",
    },
    # --- navigator.connection.downlink --------------------------------
    {
        "file": "third_party/blink/renderer/modules/netinfo/"
                "network_information.cc",
        "marker": "apex-net-downlink",
        "anchor": "double NetworkInformation::downlink() {\n",
        "where": "after",
        "inject": "  // apex-net-downlink\n"
                  "  if (apex_fp::HasOverride(\"APEX_FP_NET_DOWNLINK\")) {\n"
                  "    double v = apex_fp::EnvDouble(\"APEX_FP_NET_DOWNLINK\","
                  " -1.0);\n"
                  "    if (v >= 0.0) return v;\n"
                  "  }\n",
    },

    # --- navigator.storage.estimate() quota ---------------------------
    # Spoof the per-origin quota the engine reports. Datacenter VMs expose a
    # small/uniform quota (a function of the host disk); a residential machine
    # reports a large one. Override only on the success path (this runs after
    # the QuotaStatusCode error check, right after the real quota is set).
    {
        "file": "third_party/blink/renderer/modules/quota/storage_manager.cc",
        "header": '#include "apex_fingerprint.h"',
        "marker": "apex-storage-quota",
        "anchor": "  estimate->setQuota(quota_in_bytes);\n",
        "where": "after",
        "inject": "  // apex-storage-quota\n"
                  "  if (apex_fp::HasOverride(\"APEX_FP_STORAGE_QUOTA\")) {\n"
                  "    estimate->setQuota(static_cast<int64_t>(\n"
                  "        apex_fp::EnvU64(\"APEX_FP_STORAGE_QUOTA\", 0)));\n"
                  "  }\n",
    },
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


def apply_one(edit: dict, check: bool) -> tuple[bool, str]:
    """Apply (or check) a single edit. Returns (ok, message)."""
    path = SRC / edit["file"]
    if not path.exists():
        return (edit.get("optional", False),
                f"file not found: {edit['file']}"
                + (" (optional, skipped)" if edit.get("optional") else ""))
    text = path.read_text()

    if f"// {edit['marker']}" in text or edit["marker"] in text:
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


def main() -> int:
    check = "--check" in sys.argv
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
