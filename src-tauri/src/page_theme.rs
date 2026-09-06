//! Reversible styling of remote pages. No remote IPC or native network bridge.
use std::sync::atomic::{AtomicBool, Ordering};

const ENGINE: &str = include_str!("../vendor/darkreader.js");
const LICENSE: &str = include_str!("../vendor/DARKREADER-LICENSE");
const CONTROLLER: &str = include_str!("page-theme-controller.js");
static DARK: AtomicBool = AtomicBool::new(false);

pub fn set_dark(dark: bool) {
    DARK.store(dark, Ordering::Release);
}

pub fn is_dark() -> bool {
    DARK.load(Ordering::Acquire)
}

/// UI overlays and first-paint preparation are independent reasons to hide.
/// Revisions prevent an old navigation/theme job from revealing a newer page.
pub struct Presentation {
    pub visible: bool,
    preparing: bool,
    revision: u64,
}

impl Presentation {
    pub fn new(visible: bool, dark: bool) -> Self {
        Self {
            visible,
            preparing: dark,
            revision: 0,
        }
    }
    pub fn begin(&mut self, dark: bool) -> u64 {
        self.revision += 1;
        self.preparing = dark;
        self.revision
    }
    pub fn pending(&self, revision: u64) -> bool {
        self.preparing && self.revision == revision
    }
    pub fn finish(&mut self, revision: u64) {
        if self.revision == revision {
            self.preparing = false;
        }
    }
    pub fn should_show(&self) -> bool {
        self.visible && !self.preparing
    }
}

/// Fixed readback only. The remote page is not granted IPC capabilities.
pub const PREPARE_SCRIPT: &str = r#"(() => {
  const theme = window.__scholayPageThemeV1;
  if (!theme) return false;
  theme.setEnabled(true);
  return document.readyState !== 'loading' && theme.isReadyToDisplay();
})();"#;

/// Keep the native backing dark too: showing a newly painted WebKit view must
/// not briefly expose its default white canvas. Only touches this child view.
pub fn apply_backing(view: &tauri::Webview, dark: bool) {
    #[cfg(not(target_os = "macos"))]
    let _ = view.set_background_color(dark.then_some(tauri::webview::Color(29, 30, 31, 255)));
    #[cfg(target_os = "macos")]
    let _ = view.with_webview(move |platform| unsafe {
        use objc2::{msg_send, runtime::AnyObject};
        use objc2_app_kit::NSColor;
        use objc2_foundation::{NSNumber, NSString};
        use objc2_web_kit::WKWebView;
        let wk = &*platform.inner().cast::<WKWebView>();
        // Same WebKit backing switch as backing.rs / wry's transparent mode.
        // Restore the default opaque canvas when adaptation is switched off.
        let object = wk as *const WKWebView as *mut AnyObject;
        let opaque = NSNumber::numberWithBool(!dark);
        let key = NSString::from_str("drawsBackground");
        let _: () = msg_send![object, setValue: &*opaque, forKey: &*key];
        if objc2::available!(macos = 12.0) {
            let color = NSColor::colorWithSRGBRed_green_blue_alpha(
                29.0 / 255.0,
                30.0 / 255.0,
                31.0 / 255.0,
                1.0,
            );
            wk.setUnderPageBackgroundColor(if dark { Some(&color) } else { None });
        }
    });
}

pub fn update_script() -> &'static str {
    if DARK.load(Ordering::Acquire) {
        "window.__scholayPageThemeV1?.setEnabled(true);"
    } else {
        "window.__scholayPageThemeV1?.setEnabled(false);"
    }
}

pub fn initialization_script() -> String {
    // CommonJS exports and a private Chrome runtime keep Dark Reader from
    // replacing the site's DarkReader or patching an existing chrome.runtime.
    // Its temporary window.chrome compatibility stub is restored immediately.
    format!(
        r#"(() => {{
          if (window.top !== window || !/^https?:$/.test(location.protocol)) return;
          if (!window.__scholayPageThemeV1) {{
            window.__scholayPageThemeV1 = ({CONTROLLER})(() => {{
              const chrome = {{ runtime: {{}} }};
              const exports = {{}};
              const module = {{ exports }};
              const previousChrome = Object.getOwnPropertyDescriptor(window, 'chrome');
              try {{
                /* {LICENSE} */
                {ENGINE}
                return module.exports;
              }} finally {{
                if (previousChrome) Object.defineProperty(window, 'chrome', previousChrome);
                else delete window.chrome;
              }}
            }});
          }}
          // The native owner decides visibility and supplies the CURRENT
          // preference on each document commit. Never bake a stale dark-mode
          // value into future reloads after the user has chosen original colours.
          window.__scholayPageThemeV1.setEnabled(false);
        }})();"#,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_engine_and_private_runtime_are_embedded() {
        let script = initialization_script();
        assert!(script.contains("Dark Reader v4.9.130"));
        assert!(script.contains("const chrome = { runtime: {} }"));
        assert!(script.contains("const module = { exports }"));
        assert!(script.contains("else delete window.chrome"));
        assert!(script.contains("window.top !== window"));
        assert!(!script.contains("__TAURI_INTERNALS__"));
    }

    #[test]
    fn original_pages_are_immediate_but_dark_pages_wait() {
        assert!(Presentation::new(true, false).should_show());
        assert!(!Presentation::new(true, true).should_show());
    }

    #[test]
    fn old_readiness_cannot_reveal_a_new_navigation_or_modal() {
        let mut state = Presentation::new(true, true);
        let old = state.begin(true);
        let current = state.begin(true);
        state.finish(old);
        assert!(!state.should_show());
        state.visible = false;
        state.finish(current);
        assert!(!state.should_show());
        state.visible = true;
        assert!(state.should_show());
    }

    #[test]
    fn opt_out_interrupts_wait_without_waiting_for_a_callback() {
        let mut state = Presentation::new(true, true);
        let old = state.begin(true);
        state.begin(false);
        assert!(state.should_show());
        assert!(!state.pending(old));
        state.finish(old);
        assert!(state.should_show());
    }
}
