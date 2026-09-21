//! Native accelerators work even when a remote child WebView has focus.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager,
};
static READING_ENABLED: AtomicBool = AtomicBool::new(false);

pub struct ReaderShortcuts {
    reading: Vec<MenuItem<tauri::Wry>>,
    workspaces: Vec<MenuItem<tauri::Wry>>,
}

pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    install_keyboard_monitor(app);
    let menu = Menu::new(app)?;
    let application = Submenu::with_items(
        app,
        "scholay today",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::services(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::hide(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let reading = Submenu::new(app, "Reading", true)?;
    let mut items = Vec::new();
    for (id, label, key) in [
        ("close", "Close Reading Tab", "CmdOrCtrl+W"),
        ("reopen", "Reopen Closed Tab", "CmdOrCtrl+Shift+T"),
        ("next", "Next Reading Tab", "Ctrl+Tab"),
        ("previous", "Previous Reading Tab", "Ctrl+Shift+Tab"),
    ] {
        let item = MenuItem::with_id(app, format!("reading-{id}"), label, false, Some(key))?;
        reading.append(&item)?;
        items.push(item);
    }
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let workspaces = Submenu::new(app, "Workspace", true)?;
    let mut workspace_items = Vec::new();
    for (index, label) in ["RSS", "Library", "Trends", "Labels", "Calendar", "History"]
        .iter()
        .enumerate()
    {
        let n = index + 1;
        let item = MenuItem::with_id(
            app,
            format!("workspace-{n}"),
            label,
            true,
            Some(format!("CmdOrCtrl+{n}")),
        )?;
        workspaces.append(&item)?;
        workspace_items.push(item);
    }
    menu.append_items(&[&application, &edit, &reading, &workspaces, &window])?;
    app.set_menu(menu)?;
    app.manage(ReaderShortcuts {
        reading: items,
        workspaces: workspace_items,
    });
    app.on_menu_event(|app, event| {
        if let Some(action) = event.id.as_ref().strip_prefix("reading-") {
            let _ = app.emit_to(
                tauri::EventTarget::Webview {
                    label: "main".into(),
                },
                "reader-tab-shortcut",
                action,
            );
        }
        if let Some(index) = event.id.as_ref().strip_prefix("workspace-") {
            let _ = app.emit_to(
                tauri::EventTarget::Webview {
                    label: "main".into(),
                },
                "workspace-shortcut",
                index,
            );
        }
    });
    Ok(())
}

#[tauri::command]
pub fn set_reader_shortcuts(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    READING_ENABLED.store(enabled, Ordering::Release);
    if let Some(shortcuts) = app.try_state::<ReaderShortcuts>() {
        for item in &shortcuts.reading {
            item.set_enabled(enabled).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// App-local monitor, never a global keyboard hook or a remote-page bridge.
/// AppKit doesn't dispatch control-tab NSMenu accelerators consistently when a
/// WKWebView is first responder. Consume the combination before WebKit handles
/// it; disabled/modal states pass the original event through untouched.
#[cfg(target_os = "macos")]
fn install_keyboard_monitor(app: &tauri::AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags as Flags};
    let handle = app.clone();
    let callback = RcBlock::new(
        move |incoming: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
            let event = incoming.as_ptr();
            if !READING_ENABLED.load(Ordering::Acquire) {
                return event;
            }
            let Some(key) = (unsafe { event.as_ref() }) else {
                return event;
            };
            let flags = key.modifierFlags();
            if flags.contains(Flags::Option) {
                return event;
            }
            let shift = flags.contains(Flags::Shift);
            let control = flags.contains(Flags::Control);
            let modifier = control || flags.contains(Flags::Command);
            let chars = key
                .charactersIgnoringModifiers()
                .map(|s| s.to_string().to_lowercase())
                .unwrap_or_default();
            let action = if control && key.keyCode() == 48 {
                Some(if shift { "previous" } else { "next" })
            } else if modifier && !shift && chars == "w" {
                Some("close")
            } else if modifier && shift && chars == "t" {
                Some("reopen")
            } else {
                None
            };
            if let Some(action) = action {
                let _ = handle.emit_to(
                    tauri::EventTarget::Webview {
                        label: "main".into(),
                    },
                    "reader-tab-shortcut",
                    action,
                );
                std::ptr::null_mut()
            } else {
                event
            }
        },
    );
    // NSEvent retains the block; retain the monitor token for the app lifetime.
    if let Some(monitor) = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &callback)
    } {
        std::mem::forget(monitor);
    }
}

#[tauri::command]
pub fn set_workspace_shortcuts(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(shortcuts) = app.try_state::<ReaderShortcuts>() {
        for item in &shortcuts.workspaces {
            item.set_enabled(enabled).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
