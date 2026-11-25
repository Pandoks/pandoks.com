use gpui::{
    AnyElement, App, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement,
    Refineable, RenderOnce, Role, StatefulInteractiveElement, StyleRefinement, Styled, Window, div,
    px,
};

use crate::Theme;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ButtonVariant {
    #[default]
    Default,
    Destructive,
    Outline,
    Secondary,
    Ghost,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ButtonSize {
    #[default]
    Default,
    Sm,
    Lg,
    Icon,
}

type ClickHandler = Box<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Button {
    id: ElementId,
    variant: ButtonVariant,
    size: ButtonSize,
    disabled: bool,
    children: Vec<AnyElement>,
    on_click: Option<ClickHandler>,
    style: StyleRefinement,
}

impl Button {
    pub fn new(id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            variant: ButtonVariant::Default,
            size: ButtonSize::Default,
            disabled: false,
            children: Vec::new(),
            on_click: None,
            style: StyleRefinement::default(),
        }
    }

    pub fn variant(mut self, variant: ButtonVariant) -> Self {
        self.variant = variant;
        self
    }

    pub fn size(mut self, size: ButtonSize) -> Self {
        self.size = size;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Box::new(handler));
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
        self.children.extend(elements);
    }
}

impl RenderOnce for Button {
    fn render(self, window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window);
        let radius_md = theme.radius - px(2.0);

        let mut button = div()
            .id(self.id)
            .role(Role::Button)
            .flex()
            .flex_shrink_0()
            .items_center()
            .justify_center()
            .gap(px(8.0))
            .rounded(radius_md)
            .text_sm()
            .whitespace_nowrap();

        button = match self.size {
            ButtonSize::Default => button.h(px(36.0)).px(px(16.0)),
            ButtonSize::Sm => button.h(px(32.0)).px(px(12.0)).gap(px(6.0)),
            ButtonSize::Lg => button.h(px(40.0)).px(px(24.0)),
            ButtonSize::Icon => button.size(px(36.0)),
        };

        button = match self.variant {
            ButtonVariant::Default => button
                .bg(theme.primary)
                .text_color(theme.primary_foreground)
                .hover(move |style| style.bg(theme.primary.opacity(0.9))),
            ButtonVariant::Destructive => {
                let bg = if theme.dark {
                    theme.destructive.opacity(0.6)
                } else {
                    theme.destructive
                };
                button
                    .bg(bg)
                    .text_color(theme.destructive_foreground)
                    .hover(move |style| style.bg(theme.destructive.opacity(0.9)))
            }
            ButtonVariant::Outline => {
                let (bg, border, hover_bg) = if theme.dark {
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
                    .bg(bg)
                    .border_color(border)
                    .text_color(theme.foreground)
                    .hover(move |style| style.bg(hover_bg).text_color(theme.accent_foreground))
            }
            ButtonVariant::Secondary => button
                .bg(theme.secondary)
                .text_color(theme.secondary_foreground)
                .hover(move |style| style.bg(theme.secondary.opacity(0.8))),
            ButtonVariant::Ghost => {
                let hover_bg = if theme.dark {
                    theme.accent.opacity(0.5)
                } else {
                    theme.accent
                };
                button
                    .text_color(theme.foreground)
                    .hover(move |style| style.bg(hover_bg).text_color(theme.accent_foreground))
            }
        };

        if self.disabled {
            button = button.opacity(0.5);
        } else {
            button = button.cursor_pointer();
            if let Some(on_click) = self.on_click {
                button = button.on_click(move |event, window, cx| on_click(event, window, cx));
            }
        }

        button.style().refine(&self.style);
        button.children(self.children)
    }
}
