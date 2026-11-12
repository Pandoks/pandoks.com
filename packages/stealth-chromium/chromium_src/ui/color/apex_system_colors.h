// apex_system_colors.h -- module-local helper for the Windows system-color
// persona spoof.
//
// Included only by ui/color/color_provider_utils.cc. On Linux the CSS
// system-color palette is produced by
// CompleteDefaultCssSystemColorDefinition() (Linux's
// MapNativeColorsToCssSystemColors in css_system_color_mixer.cc is an empty
// no-op, so the page sees the built-in default table: ActiveText is the
// built-in palette red rgb(255,0,0), LinkText/Hotlight rgb(0,0,238),
// VisitedText rgb(85,26,139), GrayText rgb(128,128,128), ...). That red
// ActiveText is what rebrowser flags as platformMismatch: the browser claims
// Windows but the CSS system colors are the Linux ones.
//
// Real Windows Chrome resolves the same kColorCssSystem* ids from live
// GetSysColor() values (ui/color/win/css_system_color_mixer_win.cc ->
// ui/color/win/native_color_mixers_win.cc), so with a Windows persona we
// replace the palette with the Windows default system colors instead.
//
// Env contract (no new variables; reuses the persona platform state):
//   APEX_FP_PLATFORM  the navigator.platform override. A "Win32" value (what
//                     a Windows persona sets) selects the Windows palette.
//                     If unset, the UA persona record
//                     (APEX_FP_UA_PLATFORM == "Windows") selects it.
//
// Windows default values are the Windows 10 default theme colors
// (HKCU\Control Panel\Colors), the same table GetSysColor() returns for a
// default Windows 10/11 light install:
//   Window 255,255,255   WindowText 0,0,0    ButtonFace 240,240,240
//   ButtonText 0,0,0     GrayText 109,109,109  Hilight 0,120,215
//   HilightText 255,255,255  HotTrackingColor 0,102,204
//   MenuHighlight 0,120,215  Scrollbar 200,200,200
// The dark table mirrors the Windows 10 dark theme (Window/ButtonFace
// 32,32,32, texts white; the accent-derived ids are theme-independent).

#ifndef APEX_UI_COLOR_SYSTEM_COLORS_H_
#define APEX_UI_COLOR_SYSTEM_COLORS_H_

#include "apex_fingerprint.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/color/color_id.h"
#include "ui/color/color_mixer.h"
#include "ui/color/color_recipe.h"

namespace apex_system_colors {

using ui::ColorMixer;

// True when the persona claims Windows: either the direct APEX_FP_PLATFORM
// override is a Win32 value, or the UA persona record resolves to platform
// "Windows" (which is how the launcher drives a Windows persona when
// APEX_FP_PLATFORM is not explicitly set).
inline bool WindowsPersona() {
  if (!apex_fp::Active()) {
    return false;
  }
  const std::string platform = apex_fp::EnvStr("APEX_FP_PLATFORM");
  if (!platform.empty()) {
    return platform == "Win32";
  }
  return apex_fp::GetUAPersona().platform == "Windows";
}

// Replace the CSS system-color ids with the Windows default palette. The
// dependent ids keep the same shape upstream uses (Field -> Window,
// FieldText -> WindowText, ActiveText/LinkText/VisitedText -> Hotlight), so
// every consumer of the provider stays internally coherent.
inline void ApplyWindowsSystemColors(ColorMixer& mixer, bool dark_mode) {
  if (!WindowsPersona()) {
    return;
  }
  const SkColor apex_window =
      dark_mode ? SkColorSetRGB(0x20, 0x20, 0x20) : SK_ColorWHITE;
  const SkColor apex_window_text =
      dark_mode ? SK_ColorWHITE : SK_ColorBLACK;
  const SkColor apex_btn_face = apex_window;
  const SkColor apex_btn_text = apex_window_text;
  const SkColor apex_gray_text = SkColorSetRGB(0x6D, 0x6D, 0x6D);
  const SkColor apex_highlight = SkColorSetRGB(0x00, 0x78, 0xD7);
  const SkColor apex_highlight_text = SK_ColorWHITE;
  const SkColor apex_hotlight = SkColorSetRGB(0x00, 0x66, 0xCC);
  const SkColor apex_menu_hilight = apex_highlight;
  const SkColor apex_scrollbar =
      dark_mode ? SkColorSetRGB(0x3C, 0x3C, 0x3C)
                : SkColorSetRGB(0xC8, 0xC8, 0xC8);

  mixer[ui::kColorCssSystemBtnFace] = {apex_btn_face};
  mixer[ui::kColorCssSystemBtnText] = {apex_btn_text};
  mixer[ui::kColorCssSystemGrayText] = {apex_gray_text};
  mixer[ui::kColorCssSystemHighlight] = {apex_highlight};
  mixer[ui::kColorCssSystemHighlightText] = {apex_highlight_text};
  mixer[ui::kColorCssSystemHotlight] = {apex_hotlight};
  mixer[ui::kColorCssSystemMenuHilight] = {apex_menu_hilight};
  mixer[ui::kColorCssSystemScrollbar] = {apex_scrollbar};
  mixer[ui::kColorCssSystemWindow] = {apex_window};
  mixer[ui::kColorCssSystemWindowText] = {apex_window_text};
  mixer[ui::kColorCssSystemField] = {ui::kColorCssSystemWindow};
  mixer[ui::kColorCssSystemFieldText] = {ui::kColorCssSystemWindowText};
  mixer[ui::kColorCssSystemActiveText] = {ui::kColorCssSystemHotlight};
  mixer[ui::kColorCssSystemLinkText] = {ui::kColorCssSystemHotlight};
  mixer[ui::kColorCssSystemVisitedText] = {ui::kColorCssSystemHotlight};
}

}  // namespace apex_system_colors

#endif  // APEX_UI_COLOR_SYSTEM_COLORS_H_
