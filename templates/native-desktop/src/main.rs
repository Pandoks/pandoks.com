mod menu;

use gpui::{
    App, Bounds, Context, Role, TitlebarOptions, Window, WindowBounds, WindowOptions, div,
    prelude::*, px, relative, size,
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
                            .id("heading")
                            .role(Role::Heading)
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
    let bounds = Bounds::centered(None, size(px(800.0), px(600.0)), cx);
    cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
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
        if cx.active_window() != Some(existing.into()) {
            existing
                .update(cx, |_, window, _| window.activate_window())
                .expect("failed to activate about window");
        }
        return;
    }

    let bounds = Bounds::centered(None, size(px(360.0), px(160.0)), cx);
    cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some(format!("About {APP_NAME}").into()),
                ..Default::default()
            }),
            app_id: Some(APP_ID.into()),
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
    menu::register_keybindings(cx);
    menu::register_actions(cx);
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

        #[cfg(not(target_os = "macos"))]
        cx.on_window_closed(|cx, _window_id| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        open_starter_window(cx);
        cx.activate(true);

        #[cfg(target_os = "macos")]
        cx.set_menus(menu::app_menus());
    });
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;
    use std::sync::{Arc, Mutex};

    use gpui::{
        Bounds, DevicePixels, Font, FontId, FontMetrics, FontRun, GlyphId, LineLayout,
        NoopTextSystem, Pixels, PlatformTextSystem, RenderGlyphParams, Result, Size,
        TestAppContext, TestDispatcher, TextRenderingMode, VisualTestContext,
    };

    use super::*;

    struct RecordingTextSystem {
        laid_out: Mutex<Vec<String>>,
        painted: Mutex<Vec<String>>,
    }

    impl RecordingTextSystem {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                laid_out: Mutex::new(Vec::new()),
                painted: Mutex::new(Vec::new()),
            })
        }

        fn painted_contains(&self, text: &str) -> bool {
            self.painted
                .lock()
                .unwrap()
                .iter()
                .any(|entry| entry == text)
        }
    }

    impl PlatformTextSystem for RecordingTextSystem {
        fn add_fonts(&self, fonts: Vec<Cow<'static, [u8]>>) -> Result<()> {
            NoopTextSystem.add_fonts(fonts)
        }

        fn all_font_names(&self) -> Vec<String> {
            NoopTextSystem.all_font_names()
        }

        fn font_id(&self, descriptor: &Font) -> Result<FontId> {
            NoopTextSystem.font_id(descriptor)
        }

        fn font_metrics(&self, font_id: FontId) -> FontMetrics {
            NoopTextSystem.font_metrics(font_id)
        }

        fn typographic_bounds(&self, font_id: FontId, glyph_id: GlyphId) -> Result<Bounds<f32>> {
            NoopTextSystem.typographic_bounds(font_id, glyph_id)
        }

        fn advance(&self, font_id: FontId, glyph_id: GlyphId) -> Result<Size<f32>> {
            NoopTextSystem.advance(font_id, glyph_id)
        }

        fn glyph_for_char(&self, font_id: FontId, ch: char) -> Option<GlyphId> {
            NoopTextSystem.glyph_for_char(font_id, ch)
        }

        fn glyph_raster_bounds(&self, params: &RenderGlyphParams) -> Result<Bounds<DevicePixels>> {
            let laid_out = self.laid_out.lock().unwrap();
            if let Some(text) = laid_out.get(params.glyph_id.0 as usize) {
                self.painted.lock().unwrap().push(text.clone());
            }
            NoopTextSystem.glyph_raster_bounds(params)
        }

        fn rasterize_glyph(
            &self,
            params: &RenderGlyphParams,
            raster_bounds: Bounds<DevicePixels>,
        ) -> Result<(Size<DevicePixels>, Vec<u8>)> {
            NoopTextSystem.rasterize_glyph(params, raster_bounds)
        }

        fn layout_line(&self, text: &str, font_size: Pixels, runs: &[FontRun]) -> LineLayout {
            let mut layout = NoopTextSystem.layout_line(text, font_size, runs);
            let mut laid_out = self.laid_out.lock().unwrap();
            let line_id = GlyphId(laid_out.len() as u32);
            laid_out.push(text.to_owned());
            for run in &mut layout.runs {
                for glyph in &mut run.glyphs {
                    glyph.id = line_id;
                    glyph.is_emoji = false;
                }
            }
            layout
        }

        fn recommended_rendering_mode(
            &self,
            font_id: FontId,
            font_size: Pixels,
        ) -> TextRenderingMode {
            NoopTextSystem.recommended_rendering_mode(font_id, font_size)
        }
    }

    fn new_test_context() -> (TestAppContext, Arc<RecordingTextSystem>) {
        let text_system = RecordingTextSystem::new();
        let cx = TestAppContext::build_with_text_system(
            TestDispatcher::new(0),
            None,
            text_system.clone(),
        );
        cx.update(init_app);
        (cx, text_system)
    }

    #[test]
    fn starter_window_paints_heading_and_new_window_shortcut_opens_second_window() {
        let (cx, text_system) = new_test_context();

        cx.update(open_starter_window);
        let window = cx.windows()[0];
        let mut visual_cx = VisualTestContext::from_window(window, &cx);
        visual_cx.run_until_parked();

        assert!(
            text_system.painted_contains("NativeDesktop"),
            "heading text was not painted"
        );

        assert_eq!(cx.windows().len(), 1);
        #[cfg(target_os = "macos")]
        let shortcut = "cmd-n";
        #[cfg(not(target_os = "macos"))]
        let shortcut = "ctrl-n";
        visual_cx.simulate_keystrokes(shortcut);
        assert_eq!(cx.windows().len(), 2);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn about_opens_window_with_or_without_an_active_window() {
        let (cx, text_system) = new_test_context();

        // With an active window open (window is leased during dispatch).
        cx.update(open_starter_window);
        let starter = cx.windows()[0];
        let visual_cx = VisualTestContext::from_window(starter, &cx);
        visual_cx.run_until_parked();
        cx.update(|cx| {
            starter
                .update(cx, |_, window, _| window.activate_window())
                .unwrap();
        });
        cx.update(|cx| cx.dispatch_action(&menu::About));
        visual_cx.run_until_parked();

        assert_eq!(cx.windows().len(), 2);
        assert!(text_system.painted_contains(APP_NAME));
        assert!(text_system.painted_contains(concat!("Version ", env!("CARGO_PKG_VERSION"))));

        // With zero windows open (macOS keeps the app running after the last window closes).
        let (cx, text_system) = new_test_context();
        assert_eq!(cx.windows().len(), 0);
        cx.update(|cx| cx.dispatch_action(&menu::About));
        cx.run_until_parked();

        assert_eq!(cx.windows().len(), 1);
        assert!(text_system.painted_contains(APP_NAME));
        assert!(text_system.painted_contains(concat!("Version ", env!("CARGO_PKG_VERSION"))));
    }
}
