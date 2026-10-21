fn main() {
    // Tauri's generated Windows resource links icon.ico, but tauri-build only
    // tracks the configuration file by default. Track the icon directory so
    // replacing an icon also regenerates resource.lib and relinks the binary.
    println!("cargo:rerun-if-changed=icons");

    // Test binaries import comctl32!TaskDialogIndirect (pulled in by
    // tauri-plugin-dialog), which only exists in the Common-Controls v6
    // side-by-side assembly. The main bin gets a manifest from tauri-build,
    // but tests link without one and die at load time (STATUS_ENTRYPOINT_
    // NOT_FOUND) on systems where v5.82 is the default. Embed the same v6
    // dependency into test executables.
    // `rustc-link-arg-tests` only covers `tests/` targets, not the lib unit
    // test binary, so apply globally — then switch the real bins back to
    // /MANIFEST:NO (later option wins) because tauri-build already links a
    // resource.lib carrying the app manifest and a second linker-generated
    // one dies with CVT1100 "duplicate resource".
    #[cfg(windows)]
    {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
    }

    tauri_build::build()
}
