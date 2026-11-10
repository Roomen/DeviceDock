fn main() {
 if std::env::var("CARGO_FEATURE_NATIVE_SPP").is_ok() && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
  cc::Build::new().file("src/classic/macos.m").flag("-fobjc-arc").flag("-mmacosx-version-min=11.0").compile("classic_native");
  println!("cargo:rustc-link-lib=framework=IOBluetooth");
  println!("cargo:rustc-link-lib=framework=IOBluetoothUI");
  println!("cargo:rerun-if-changed=src/classic/macos.m");
 }
 let windows_msvc=std::env::var("CARGO_CFG_TARGET_OS").as_deref()==Ok("windows") && std::env::var("CARGO_CFG_TARGET_ENV").as_deref()==Ok("msvc");
 if windows_msvc {
  // Tauri's icon/version resource is bins-only. Embed the SAME manifest once through
  // all-target linker flags so library unit-test EXEs also select Common Controls v6.
  let manifest=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows.manifest");
  println!("cargo:rerun-if-changed={}",manifest.display());
  let attributes=tauri_build::Attributes::new().windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
  tauri_build::try_build(attributes).expect("failed to prepare Tauri Windows resources");
  println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
  println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}",manifest.display());
 } else {
  tauri_build::build()
 }
}
