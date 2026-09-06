#[cfg(windows)]
fn main() {
    papr_lib::run_windows_smoke();
}
#[cfg(not(windows))]
fn main() {
    eprintln!("Run this fixture on Windows with WebView2 installed.");
}
