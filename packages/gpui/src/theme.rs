use std::sync::LazyLock;

use gpui::{Hsla, Pixels, Window, WindowAppearance, px, rgb, rgba};

// NOTE: sRGB conversions of the OKLCH tokens in `packages/svelte/src/app.css`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Theme {
    pub dark: bool,
    pub radius: Pixels,
    pub background: Hsla,
    pub foreground: Hsla,
    pub card: Hsla,
    pub card_foreground: Hsla,
    pub popover: Hsla,
    pub popover_foreground: Hsla,
    pub primary: Hsla,
    pub primary_foreground: Hsla,
    pub secondary: Hsla,
    pub secondary_foreground: Hsla,
    pub muted: Hsla,
    pub muted_foreground: Hsla,
    pub accent: Hsla,
    pub accent_foreground: Hsla,
    pub destructive: Hsla,
    pub destructive_foreground: Hsla,
    pub border: Hsla,
    pub input: Hsla,
    pub ring: Hsla,
}

static LIGHT: LazyLock<Theme> = LazyLock::new(|| Theme {
    dark: false,
    radius: px(10.0),
    background: rgb(0xffffff).into(),
    foreground: rgb(0x0a0a0a).into(),
    card: rgb(0xffffff).into(),
    card_foreground: rgb(0x0a0a0a).into(),
    popover: rgb(0xffffff).into(),
    popover_foreground: rgb(0x0a0a0a).into(),
    primary: rgb(0x171717).into(),
    primary_foreground: rgb(0xfafafa).into(),
    secondary: rgb(0xf5f5f5).into(),
    secondary_foreground: rgb(0x171717).into(),
    muted: rgb(0xf5f5f5).into(),
    muted_foreground: rgb(0x737373).into(),
    accent: rgb(0xf5f5f5).into(),
    accent_foreground: rgb(0x171717).into(),
    destructive: rgb(0xe7000b).into(),
    destructive_foreground: rgb(0xffffff).into(),
    border: rgb(0xe5e5e5).into(),
    input: rgb(0xe5e5e5).into(),
    ring: rgb(0xa1a1a1).into(),
});

static DARK: LazyLock<Theme> = LazyLock::new(|| Theme {
    dark: true,
    radius: px(10.0),
    background: rgb(0x0a0a0a).into(),
    foreground: rgb(0xfafafa).into(),
    card: rgb(0x171717).into(),
    card_foreground: rgb(0xfafafa).into(),
    popover: rgb(0x171717).into(),
    popover_foreground: rgb(0xfafafa).into(),
    primary: rgb(0xe5e5e5).into(),
    primary_foreground: rgb(0x171717).into(),
    secondary: rgb(0x262626).into(),
    secondary_foreground: rgb(0xfafafa).into(),
    muted: rgb(0x262626).into(),
    muted_foreground: rgb(0xa1a1a1).into(),
    accent: rgb(0x262626).into(),
    accent_foreground: rgb(0xfafafa).into(),
    destructive: rgb(0xff6467).into(),
    destructive_foreground: rgb(0xffffff).into(),
    border: rgba(0xffffff1a).into(),
    input: rgba(0xffffff26).into(),
    ring: rgb(0x737373).into(),
});

impl Theme {
    pub fn of(window: &Window) -> &'static Self {
        match window.appearance() {
            WindowAppearance::Dark | WindowAppearance::VibrantDark => &DARK,
            WindowAppearance::Light | WindowAppearance::VibrantLight => &LIGHT,
        }
    }
}
