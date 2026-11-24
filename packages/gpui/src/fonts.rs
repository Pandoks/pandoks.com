use std::borrow::Cow;

use gpui::{App, Result};

pub const FONT_SANS: &str = "Inter";
pub const FONT_SERIF: &str = "EB Garamond";

const EB_GARAMOND_REGULAR: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/EBGaramond.ttf"));
const INTER_REGULAR: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/Inter.ttf"));

// NOTE: GPUI does not apply variable-font weight axes, so these faces render as Regular.
pub(crate) fn register_fonts(cx: &App) -> Result<()> {
    cx.text_system().add_fonts(vec![
        Cow::Borrowed(EB_GARAMOND_REGULAR),
        Cow::Borrowed(INTER_REGULAR),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use ttf_parser::{Face, name_id};

    fn font_family_names(bytes: &[u8]) -> Vec<String> {
        let face = Face::parse(bytes, 0).expect("failed to parse embedded font");
        face.names()
            .into_iter()
            .filter(|name| {
                name.name_id == name_id::FAMILY || name.name_id == name_id::TYPOGRAPHIC_FAMILY
            })
            .filter_map(|name| name.to_string())
            .collect()
    }

    #[test]
    fn embedded_font_families_match_constants() {
        for (bytes, expected_family) in [
            (EB_GARAMOND_REGULAR, FONT_SERIF),
            (INTER_REGULAR, FONT_SANS),
        ] {
            let families = font_family_names(bytes);
            assert!(
                families.iter().any(|family| family == expected_family),
                "expected font family {expected_family:?}, found {families:?}"
            );
        }
    }
}
