use gpui::{
    App, ElementId, InteractiveElement, IntoElement, ParentElement, PathBuilder, Refineable,
    RenderOnce, Role, StatefulInteractiveElement, StyleRefinement, Styled, Toggled, Window, canvas,
    div, point, px,
};

use crate::Theme;

type ChangeHandler = Box<dyn Fn(bool, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct Checkbox {
    id: ElementId,
    checked: bool,
    disabled: bool,
    on_change: Option<ChangeHandler>,
    style: StyleRefinement,
}

impl Checkbox {
    pub fn new(id: impl Into<ElementId>, checked: bool) -> Self {
        Self {
            id: id.into(),
            checked,
            disabled: false,
            on_change: None,
            style: StyleRefinement::default(),
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_change(mut self, handler: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Box::new(handler));
        self
    }
}

impl Styled for Checkbox {
    fn style(&mut self) -> &mut StyleRefinement {
        &mut self.style
    }
}

impl RenderOnce for Checkbox {
    fn render(self, window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window);
        let checked = self.checked;

        let mut box_el = div()
            .id(self.id)
            .role(Role::CheckBox)
            .aria_toggled(if checked {
                Toggled::True
            } else {
                Toggled::False
            })
            .flex()
            .flex_shrink_0()
            .items_center()
            .justify_center()
            .size(px(16.0))
            .rounded(px(4.0))
            .border_1();

        box_el = if checked {
            let fg = theme.primary_foreground;
            box_el.bg(theme.primary).border_color(theme.primary).child(
                canvas(
                    |_, _, _| {},
                    move |bounds, _, window, _| {
                        if !bounds.intersects(&window.content_mask().bounds) {
                            return;
                        }
                        let mut builder = PathBuilder::stroke(px(1.75));
                        builder.move_to(point(
                            bounds.left() + bounds.size.width * 0.22,
                            bounds.top() + bounds.size.height * 0.52,
                        ));
                        builder.line_to(point(
                            bounds.left() + bounds.size.width * 0.42,
                            bounds.top() + bounds.size.height * 0.72,
                        ));
                        builder.line_to(point(
                            bounds.left() + bounds.size.width * 0.78,
                            bounds.top() + bounds.size.height * 0.30,
                        ));
                        if let Ok(path) = builder.build() {
                            window.paint_path(path, fg);
                        }
                    },
                )
                .size_full(),
            )
        } else {
            box_el.border_color(theme.input)
        };

        if self.disabled {
            box_el = box_el.opacity(0.5);
        } else {
            box_el = box_el.cursor_pointer();
            if let Some(on_change) = self.on_change {
                box_el = box_el.on_click(move |_event, window, cx| {
                    on_change(!checked, window, cx);
                });
            }
        }

        box_el.style().refine(&self.style);
        box_el
    }
}
