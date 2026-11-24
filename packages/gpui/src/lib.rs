pub mod badge;
pub mod fonts;
pub mod theme;

pub use badge::{Badge, BadgeVariant};
pub use fonts::{FONT_SANS, FONT_SERIF, register_fonts};
pub use theme::Theme;

use gpui::{App, Result};

pub fn init(cx: &mut App) -> Result<()> {
    register_fonts(cx)?;
    cx.set_global(Theme::for_appearance(cx.window_appearance()));
    Ok(())
}
