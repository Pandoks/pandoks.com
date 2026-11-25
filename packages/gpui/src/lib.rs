mod badge;
mod button;
mod checkbox;
mod fonts;
mod theme;

pub use badge::{Badge, BadgeVariant};
pub use button::{Button, ButtonVariant};
pub use checkbox::Checkbox;
pub use fonts::{FONT_SANS, FONT_SERIF};
pub use theme::Theme;

use gpui::{App, Result};

pub fn init(cx: &mut App) -> Result<()> {
    fonts::register_fonts(cx)
}
