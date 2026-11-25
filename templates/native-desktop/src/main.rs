mod menu;

use gpui::{
    App, Context, TitlebarOptions, Window, WindowBounds, WindowOptions, div, prelude::*, px,
    relative, size,
};
use pandoks_gpui::{Badge, BadgeVariant, FONT_SANS, FONT_SERIF, Theme};

const APP_NAME: &str = "Pandoks Native Desktop Template";
const APP_ID: &str = "com.pandoks.native-desktop-template";

struct StarterView;

impl Render for StarterView {
    fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window);

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
                        Badge::new("Mono")
                            .variant(BadgeVariant::Outline)
                            .bg(theme.card.opacity(0.75))
                            .text_color(theme.muted_foreground)
                            .px(px(16.0))
                            .py(px(4.0))
                            .text_sm(),
                    )
                    .child(
                        div()
                            .font_family(FONT_SERIF)
                            .mt(px(-8.0))
                            .text_size(px(128.0))
                            .line_height(relative(1.0))
                            .child("NativeDesktop"),
                    )
                    .child(
                        div()
                            .font_family(FONT_SERIF)
                            .mt(px(20.0))
                            .text_lg()
                            .child("Native GPUI desktop starter"),
                    ),
            )
    }
}

fn open_starter_window(cx: &mut App) {
    cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::centered(size(px(800.0), px(600.0)), cx)),
            titlebar: Some(TitlebarOptions {
                title: Some(APP_NAME.into()),
                ..Default::default()
            }),
            app_id: Some(APP_ID.into()),
            ..Default::default()
        },
        |window, cx| {
            window
                .observe_window_appearance(|window, _| window.refresh())
                .detach();
            cx.new(|_| StarterView)
        },
    )
    .expect("failed to open starter window");
}

#[cfg(target_os = "macos")]
struct AboutView;

#[cfg(target_os = "macos")]
impl Render for AboutView {
    fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::of(window);

        div()
            .flex()
            .size_full()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(8.0))
            .bg(theme.background)
            .text_color(theme.foreground)
            .font_family(FONT_SANS)
            .child(div().text_lg().child(APP_NAME))
            .child(
                div()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child(concat!("Version ", env!("CARGO_PKG_VERSION"))),
            )
    }
}

#[cfg(target_os = "macos")]
fn open_about_window(cx: &mut App) {
    if let Some(existing) = cx
        .windows()
        .into_iter()
        .find_map(|window| window.downcast::<AboutView>())
    {
        cx.defer(move |cx| {
            existing
                .update(cx, |_, window, _| window.activate_window())
                .expect("failed to activate about window");
        });
        return;
    }

    cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::centered(size(px(360.0), px(160.0)), cx)),
            titlebar: Some(TitlebarOptions {
                title: Some(format!("About {APP_NAME}").into()),
                ..Default::default()
            }),
            is_resizable: false,
            is_minimizable: false,
            ..Default::default()
        },
        |window, cx| {
            window
                .observe_window_appearance(|window, _| window.refresh())
                .detach();
            cx.new(|_| AboutView)
        },
    )
    .expect("failed to open about window");
}

fn init_app(cx: &mut App) {
    pandoks_gpui::init(cx).expect("failed to initialize shared GPUI package");
    menu::register(cx);

    #[cfg(target_os = "macos")]
    cx.set_menus(menu::app_menus());
}

fn main() {
    let app = gpui_platform::application();

    #[cfg(target_os = "macos")]
    app.on_reopen(|cx| {
        if cx.windows().is_empty() {
            open_starter_window(cx);
        }
    });

    app.run(|cx: &mut App| {
        init_app(cx);
        open_starter_window(cx);
        cx.activate(true);
    });
}

#[cfg(test)]
mod tests {
    use gpui::TestAppContext;

    use super::*;

    #[test]
    fn starter_window_and_new_window_shortcut() {
        let mut cx = TestAppContext::single();
        cx.update(init_app);

        cx.update(open_starter_window);
        let starter = cx.windows()[0];

        cx.simulate_keystrokes(starter, "secondary-n");
        let windows = cx.windows();
        assert_eq!(windows.len(), 2);
        assert!(
            windows
                .iter()
                .all(|window| window.downcast::<StarterView>().is_some())
        );
    }

    #[cfg(target_os = "macos")]
    fn choose_about_menu_item(cx: &TestAppContext) {
        cx.update(|cx| {
            let about = cx
                .get_menus()
                .expect("menus not set")
                .iter()
                .flat_map(|menu| &menu.items)
                .find_map(|item| match item {
                    gpui::OwnedMenuItem::Action { name, action, .. }
                        if name.starts_with("About ") =>
                    {
                        Some(action.boxed_clone())
                    }
                    _ => None,
                })
                .expect("about menu item missing");
            cx.dispatch_action(about.as_ref());
        });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn about_window() {
        let mut cx = TestAppContext::single();
        cx.update(init_app);

        cx.update(open_starter_window);
        let starter = cx.windows()[0];
        cx.update_window(starter, |_, window, _| window.activate_window())
            .unwrap();
        choose_about_menu_item(&cx);

        let windows = cx.windows();
        assert_eq!(windows.len(), 2);
        let about = windows
            .into_iter()
            .find(|window| *window != starter)
            .expect("about window not opened");
        assert!(about.downcast::<AboutView>().is_some());

        cx.update_window(starter, |_, window, _| window.activate_window())
            .unwrap();
        choose_about_menu_item(&cx);
        assert_eq!(cx.windows().len(), 2);
        assert_eq!(cx.read(App::active_window), Some(about));

        choose_about_menu_item(&cx);
        assert_eq!(cx.windows().len(), 2);
        assert_eq!(cx.read(App::active_window), Some(about));

        let cx = TestAppContext::single();
        cx.update(init_app);
        choose_about_menu_item(&cx);
        let windows = cx.windows();
        assert_eq!(windows.len(), 1);
        assert!(windows[0].downcast::<AboutView>().is_some());
    }
}
