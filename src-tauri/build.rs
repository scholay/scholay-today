fn main() {
    tauri_build::build();
    // Tauri embeds Common Controls v6 in the app binary, but Cargo examples
    // are separate executables. Without it TaskDialogIndirect cannot load.
    if std::env::var_os("CARGO_FEATURE_WINDOWS_SMOKE").is_some()
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("examples/windows-smoke.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg-examples=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-examples=/MANIFESTINPUT:{}", manifest.display());
    }
}
