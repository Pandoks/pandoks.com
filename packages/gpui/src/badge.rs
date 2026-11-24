use gpui::{
    App, FontWeight, IntoElement, ParentElement, Refineable, RenderOnce, SharedString,
    StyleRefinement, Styled, Window, div, px,
};

use crate::Theme;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BadgeVariant {
    #[default]
    Default,
    Secondary,
    Destructive,
    Outline,
}

#[derive(IntoElement)]
pub struct Badge {
    label: SharedString,
    variant: BadgeVariant,
    style: StyleRefinement,
}

impl Badge {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            variant: BadgeVariant::Default,
            style: StyleRefinement::default(),
        }
    }

    pub fn variant(mut self, variant: BadgeVariant) -> Self {
        self.variant = variant;
        self
    }
}

impl Styled for Badge {
    fn style(&mut self) -> &mut StyleRefinement {
        &mut self.style
    }
}

impl RenderOnce for Badge {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = *Theme::global(cx);
        let mut badge = div()
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .border_1()
            .px(px(8.0))
            .py(px(2.0))
            .text_xs()
            .font_weight(FontWeight::MEDIUM)
            .whitespace_nowrap();

        badge = match self.variant {
            BadgeVariant::Default => badge
                .bg(theme.primary)
                .text_color(theme.primary_foreground)
                .border_color(gpui::transparent_black()),
            BadgeVariant::Secondary => badge
                .bg(theme.secondary)
                .text_color(theme.secondary_foreground)
                .border_color(gpui::transparent_black()),
            BadgeVariant::Destructive => badge
                .bg(theme.destructive)
                .text_color(theme.destructive_foreground)
                .border_color(gpui::transparent_black()),
            BadgeVariant::Outline => badge
                .text_color(theme.foreground)
                .border_color(theme.border),
        };

        badge.style().refine(&self.style);
        badge.child(self.label)
    }
}
