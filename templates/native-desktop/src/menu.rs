use gpui::{App, KeyBinding, actions};

#[cfg(target_os = "macos")]
use gpui::{Menu, MenuItem, SystemMenuType};

#[cfg(target_os = "macos")]
use crate::APP_NAME;

actions!(native_desktop, [Quit, NewWindow]);

#[cfg(target_os = "macos")]
actions!(native_desktop, [About, Hide, HideOthers, ShowAll]);

pub(super) fn register(cx: &mut App) {
    #[cfg(target_os = "macos")]
    {
        cx.bind_keys([
            KeyBinding::new("cmd-h", Hide, None),
            KeyBinding::new("cmd-alt-h", HideOthers, None),
            KeyBinding::new("cmd-q", Quit, None),
            KeyBinding::new("cmd-n", NewWindow, None),
        ]);
        cx.on_action(|_: &About, cx| crate::open_about_window(cx));
        cx.on_action(|_: &Hide, cx| cx.hide());
        cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
        cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    }

    #[cfg(not(target_os = "macos"))]
    cx.bind_keys([
        KeyBinding::new("ctrl-n", NewWindow, None),
        KeyBinding::new("ctrl-q", Quit, None),
    ]);

    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.on_action(|_: &NewWindow, cx| crate::open_starter_window(cx));
}

#[cfg(target_os = "macos")]
pub(super) fn app_menus() -> Vec<Menu> {
    vec![
        Menu::new(APP_NAME).items([
            MenuItem::action(format!("About {APP_NAME}"), About),
            MenuItem::separator(),
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action(format!("Hide {APP_NAME}"), Hide),
            MenuItem::action("Hide Others", HideOthers),
            MenuItem::action("Show All", ShowAll),
            MenuItem::separator(),
            MenuItem::action(format!("Quit {APP_NAME}"), Quit),
        ]),
        Menu::new("File").items([MenuItem::action("New Window", NewWindow)]),
    ]
}
