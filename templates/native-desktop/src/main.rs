use gpui::App;

use native_desktop::app_view::{init_app, open_starter_window};

fn main() {
    let app = gpui_platform::application();

    #[cfg(target_os = "macos")]
    app.on_reopen(|cx| {
        if cx.windows().is_empty() {
            open_starter_window(cx);
        }
    });

    app.run(|cx: &mut App| {
        init_app(cx, open_starter_window);

        #[cfg(not(target_os = "macos"))]
        cx.on_window_closed(|cx, _window_id| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        open_starter_window(cx);
        cx.activate(true);
    });
}
