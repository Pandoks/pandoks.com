use gpui::{
    AnyElement, App, ClickEvent, Div, ElementId, InteractiveElement, IntoElement, ParentElement,
    Refineable, RenderOnce, Role, Stateful, StatefulInteractiveElement, StyleRefinement, Styled,
    Window, div, px,
};

use crate::Theme;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ButtonVariant {
    #[default]
    Default,
    Outline,
    Secondary,
}

#[derive(IntoElement)]
pub struct Button {
    base: Stateful<Div>,
    variant: ButtonVariant,
    style: StyleRefinement,
}

impl Button {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            base: div().id(id),
            variant: ButtonVariant::Default,
            style: StyleRefinement::default(),
        }
    }

    pub fn variant(mut self, variant: ButtonVariant) -> Self {
        self.variant = variant;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.base = self.base.on_click(handler);
        self
    }
}

impl Styled for Button {
    fn style(&mut self) -> &mut StyleRefinement {
        &mut self.style
    }
}

impl ParentElement for Button {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        self.base.extend(elements);
    }
}

impl RenderOnce for Button {
    fn render(self, window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window);

        let mut button = self
            .base
            .role(Role::Button)
            .flex()
            .flex_shrink_0()
            .items_center()
            .justify_center()
            .h(px(36.0))
            .px(px(16.0))
            .gap(px(8.0))
            .rounded(theme.radius - px(2.0))
            .text_sm()
            .whitespace_nowrap()
            .cursor_pointer();

        button = match self.variant {
            ButtonVariant::Default => button
                .bg(theme.primary)
                .text_color(theme.primary_foreground)
                .hover(move |style| style.bg(theme.primary.opacity(0.9))),
            ButtonVariant::Outline => {
                let (background, border, hover_background) = if theme.dark {
                    (
                        theme.input.opacity(0.3),
                        theme.input,
                        theme.input.opacity(0.5),
                    )
                } else {
                    (theme.background, theme.border, theme.accent)
                };
                button
                    .border_1()
                    .bg(background)
                    .border_color(border)
                    .text_color(theme.foreground)
                    .hover(move |style| {
                        style
                            .bg(hover_background)
                            .text_color(theme.accent_foreground)
                    })
            }
            ButtonVariant::Secondary => button
                .bg(theme.secondary)
                .text_color(theme.secondary_foreground)
                .hover(move |style| style.bg(theme.secondary.opacity(0.8))),
        };

        button.style().refine(&self.style);
        button
    }
}
