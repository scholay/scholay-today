fn main() {
    tauri_build::build();
    // Tauri embeds Common Controls v6 in the app binary, but every Cargo
    // example is a separate executable. This must not depend on windows-smoke:
    // page-theme-smoke and reader-tabs-smoke also link TaskDialogIndirect and
    // otherwise fail in the Windows loader before main (0xc0000139).
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("examples/windows-smoke.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg-examples=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-examples=/MANIFESTINPUT:{}", manifest.display());
    }
}
