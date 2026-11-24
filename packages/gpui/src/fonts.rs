use std::borrow::Cow;

use gpui::{App, Result};

pub const FONT_SANS: &str = "Inter";
pub const FONT_SERIF: &str = "EB Garamond";

const EB_GARAMOND_REGULAR: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/EBGaramond.ttf"));
const EB_GARAMOND_ITALIC: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/EBGaramond-Italic.ttf"));
const INTER_REGULAR: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/Inter.ttf"));
const INTER_ITALIC: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/Inter-Italic.ttf"));

pub fn register_fonts(cx: &App) -> Result<()> {
    cx.text_system().add_fonts(vec![
        Cow::Borrowed(EB_GARAMOND_REGULAR),
        Cow::Borrowed(EB_GARAMOND_ITALIC),
        Cow::Borrowed(INTER_REGULAR),
        Cow::Borrowed(INTER_ITALIC),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decompressed_fonts_have_sfnt_headers() {
        for bytes in [
            EB_GARAMOND_REGULAR,
            EB_GARAMOND_ITALIC,
            INTER_REGULAR,
            INTER_ITALIC,
        ] {
            assert!(bytes.len() > 1024);
            let tag = &bytes[0..4];
            assert!(
                tag == b"\x00\x01\x00\x00" || tag == b"OTTO" || tag == b"true",
                "unexpected sfnt header: {tag:?}"
            );
        }
    }
}
