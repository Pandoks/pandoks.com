use gpui::{
    App, Div, ElementId, InteractiveElement, IntoElement, ParentElement, PathBuilder, RenderOnce,
    Role, Stateful, StatefulInteractiveElement, Styled, Toggled, Window, canvas, div, point, px,
};

use crate::Theme;

#[derive(IntoElement)]
pub struct Checkbox {
    base: Stateful<Div>,
    checked: bool,
}

impl Checkbox {
    pub fn new(id: impl Into<ElementId>, checked: bool) -> Self {
        Self {
            base: div().id(id),
            checked,
        }
    }

    pub fn on_change(mut self, handler: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        let next = !self.checked;
        self.base = self
            .base
            .on_click(move |_event, window, cx| handler(next, window, cx));
        self
    }
}

impl RenderOnce for Checkbox {
    fn render(self, window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let theme = Theme::of(window);
        let checkbox = self
            .base
            .role(Role::CheckBox)
            .aria_toggled(Toggled::from(self.checked))
            .flex_shrink_0()
            .size(px(16.0))
            .rounded(px(4.0))
            .border_1()
            .cursor_pointer();

        if self.checked {
            let stroke_color = theme.primary_foreground;
            checkbox
                .bg(theme.primary)
                .border_color(theme.primary)
                .child(
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
                                window.paint_path(path, stroke_color);
                            }
                        },
                    )
                    .size_full(),
                )
        } else {
            checkbox.border_color(theme.input)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{Context, Modifiers, Render, TestAppContext, VisualTestContext};

    struct ControlledCheckbox {
        checked: bool,
        changes: Vec<bool>,
    }

    impl Render for ControlledCheckbox {
        fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let entity = cx.entity();
            Checkbox::new("toggle", self.checked).on_change(move |next, _window, cx| {
                entity.update(cx, |this, cx| {
                    this.changes.push(next);
                    this.checked = next;
                    cx.notify();
                });
            })
        }
    }

    #[gpui::test]
    fn click_toggles_controlled_parent_in_both_directions(cx: &mut TestAppContext) {
        let window = cx.add_window(|_, _| ControlledCheckbox {
            checked: false,
            changes: Vec::new(),
        });
        let mut visual_cx = VisualTestContext::from_window(window.into(), cx);
        let view = window.root(&mut visual_cx).expect("root view");
        visual_cx.run_until_parked();

        visual_cx.simulate_click(point(px(8.0), px(8.0)), Modifiers::none());
        visual_cx.simulate_click(point(px(8.0), px(8.0)), Modifiers::none());

        assert_eq!(
            view.read_with(&visual_cx, |view, _| (view.checked, view.changes.clone())),
            (false, vec![true, false])
        );
    }
}
