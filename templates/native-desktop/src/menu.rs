use gpui::{App, AppContext, KeyBinding, Menu, MenuItem, OsAction, PromptLevel, actions};

#[cfg(target_os = "macos")]
use gpui::SystemMenuType;

use crate::APP_NAME;

actions!(
    native_desktop,
    [
        About, Hide, HideOthers, ShowAll, Quit, NewWindow, Undo, Redo, Cut, Copy, Paste, SelectAll,
    ]
);

pub fn register_keybindings(cx: &mut App) {
    #[cfg(target_os = "macos")]
    let bindings = [
        KeyBinding::new("cmd-h", Hide, None),
        KeyBinding::new("cmd-alt-h", HideOthers, None),
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-n", NewWindow, None),
        KeyBinding::new("cmd-z", Undo, None),
        KeyBinding::new("cmd-shift-z", Redo, None),
        KeyBinding::new("cmd-x", Cut, None),
        KeyBinding::new("cmd-c", Copy, None),
        KeyBinding::new("cmd-v", Paste, None),
        KeyBinding::new("cmd-a", SelectAll, None),
    ];

    #[cfg(not(target_os = "macos"))]
    let bindings = [
        KeyBinding::new("ctrl-n", NewWindow, None),
        KeyBinding::new("ctrl-q", Quit, None),
        KeyBinding::new("ctrl-z", Undo, None),
        KeyBinding::new("ctrl-shift-z", Redo, None),
        KeyBinding::new("ctrl-x", Cut, None),
        KeyBinding::new("ctrl-c", Copy, None),
        KeyBinding::new("ctrl-v", Paste, None),
        KeyBinding::new("ctrl-a", SelectAll, None),
    ];

    cx.bind_keys(bindings);
}

pub fn register_actions(cx: &mut App, open_window: fn(&mut App)) {
    cx.on_action(|_: &About, cx| {
        if let Some(window) = cx.active_window() {
            let _ = window.update(cx, |_, window, cx| {
                let prompt = window.prompt(
                    PromptLevel::Info,
                    APP_NAME,
                    Some(concat!("Version ", env!("CARGO_PKG_VERSION"))),
                    &["OK"],
                    cx,
                );
                cx.background_spawn(async move {
                    let _ = prompt.await;
                })
                .detach();
            });
        }
    });
    cx.on_action(|_: &Hide, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.on_action(move |_: &NewWindow, cx| open_window(cx));
}

pub fn app_menus() -> Vec<Menu> {
    let mut menus = Vec::new();

    #[cfg(target_os = "macos")]
    menus.push(Menu {
        name: APP_NAME.into(),
        disabled: false,
        items: vec![
            MenuItem::action(format!("About {APP_NAME}"), About),
            MenuItem::separator(),
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action(format!("Hide {APP_NAME}"), Hide),
            MenuItem::action("Hide Others", HideOthers),
            MenuItem::action("Show All", ShowAll),
            MenuItem::separator(),
            MenuItem::action(format!("Quit {APP_NAME}"), Quit),
        ],
    });

    #[cfg(target_os = "macos")]
    let file_items = vec![MenuItem::action("New Window", NewWindow)];
    #[cfg(not(target_os = "macos"))]
    let file_items = vec![
        MenuItem::action("New Window", NewWindow),
        MenuItem::separator(),
        MenuItem::action("Quit", Quit),
    ];
    menus.push(Menu {
        name: "File".into(),
        disabled: false,
        items: file_items,
    });

    menus.push(Menu {
        name: "Edit".into(),
        disabled: false,
        items: vec![
            MenuItem::os_action("Undo", Undo, OsAction::Undo),
            MenuItem::os_action("Redo", Redo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action("Cut", Cut, OsAction::Cut),
            MenuItem::os_action("Copy", Copy, OsAction::Copy),
            MenuItem::os_action("Paste", Paste, OsAction::Paste),
            MenuItem::separator(),
            MenuItem::os_action("Select All", SelectAll, OsAction::SelectAll),
        ],
    });

    menus
}
