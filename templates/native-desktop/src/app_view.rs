use gpui::{
    App, Bounds, Context, FontWeight, Role, SharedString, Subscription, TitlebarOptions, Window,
    WindowBounds, WindowOptions, div, prelude::*, px, relative, rgba, size,
};
use pandoks_gpui::{Badge, BadgeVariant, FONT_SANS, FONT_SERIF, Theme};

use crate::APP_NAME;

pub struct StarterView {
    pub title: SharedString,
    pub subtitle: SharedString,
    pub badge: SharedString,
    _appearance_subscription: Subscription,
}

impl StarterView {
    pub fn new(window: &Window, cx: &mut Context<Self>) -> Self {
        let appearance_subscription = Theme::observe_window(window, cx);
        Self {
            title: "NativeDesktop".into(),
            subtitle: "Native GPUI desktop starter".into(),
            badge: "Mono".into(),
            _appearance_subscription: appearance_subscription,
        }
    }
}

impl Render for StarterView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = *Theme::global(cx);
        let (badge_bg, badge_border, badge_fg) = if theme.dark {
            (rgba(0x171717bf), rgba(0x404040ff), rgba(0xa3a3a3ff))
        } else {
            (rgba(0xffffffbf), rgba(0xd4d4d4ff), rgba(0x525252ff))
        };

        div()
            .flex()
            .size_full()
            .flex_col()
            .items_center()
            .justify_center()
            .bg(theme.background)
            .text_color(theme.foreground)
            .font_family(FONT_SANS)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .mt(px(-80.0))
                    .child(
                        Badge::new(self.badge.clone())
                            .variant(BadgeVariant::Outline)
                            .bg(badge_bg)
                            .border_color(badge_border)
                            .text_color(badge_fg)
                            .px(px(16.0))
                            .py(px(4.0))
                            .text_sm(),
                    )
                    .child(
                        div()
                            .id("heading")
                            .role(Role::Heading)
                            .debug_selector(|| "heading".into())
                            .font_family(FONT_SERIF)
                            .mt(px(-8.0))
                            .text_size(px(128.0))
                            .line_height(relative(1.0))
                            .font_weight(FontWeight::MEDIUM)
                            .child(self.title.clone()),
                    )
                    .child(
                        div()
                            .id("subtitle")
                            .debug_selector(|| "subtitle".into())
                            .font_family(FONT_SERIF)
                            .mt(px(20.0))
                            .text_lg()
                            .child(self.subtitle.clone()),
                    ),
            )
    }
}

pub fn open_starter_window(cx: &mut App) {
    let bounds = Bounds::centered(None, size(px(800.0), px(600.0)), cx);
    cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some(APP_NAME.into()),
                ..Default::default()
            }),
            ..Default::default()
        },
        |window, cx| cx.new(|cx| StarterView::new(window, cx)),
    )
    .expect("failed to open starter window");
}

pub fn init_app(cx: &mut App, open_window: fn(&mut App)) {
    pandoks_gpui::init(cx).expect("failed to initialize shared GPUI package");
    crate::menu::register_keybindings(cx);
    crate::menu::register_actions(cx, open_window);
    cx.set_menus(crate::menu::app_menus());
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{TestAppContext, VisualTestContext};

    #[gpui::test]
    async fn starter_window_renders_visible_heading_and_opens_new_window(cx: &mut TestAppContext) {
        cx.update(|cx| init_app(cx, open_starter_window));

        let window = cx.add_window(|window, cx| StarterView::new(window, cx));
        let mut visual_cx = VisualTestContext::from_window(window.into(), cx);
        visual_cx.run_until_parked();

        let heading_bounds = visual_cx
            .debug_bounds("heading")
            .expect("heading element was not laid out");
        assert!(heading_bounds.size.width > px(0.0));
        assert!(heading_bounds.size.height > px(0.0));

        let subtitle_bounds = visual_cx
            .debug_bounds("subtitle")
            .expect("subtitle element was not laid out");
        assert!(subtitle_bounds.size.height > px(0.0));

        assert_eq!(cx.windows().len(), 1);
        visual_cx.dispatch_action(crate::menu::NewWindow);
        visual_cx.run_until_parked();
        assert_eq!(cx.windows().len(), 2);
    }
}
