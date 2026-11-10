mod lease;
mod serial;
mod updater;
mod extensions;
#[cfg(feature = "native-ble")]
mod ble;
#[cfg(feature = "native-spp")]
mod classic;
use tauri::Manager;
#[cfg(feature = "native-smoke")]
#[tauri::command]
fn native_smoke_complete(app:tauri::AppHandle,result:serde_json::Value) {
 let pass=result["pass"]==true;
 let _=std::fs::write(std::env::temp_dir().join("devicedock-host-native-smoke.json"),result.to_string());
 app.exit(if pass {0}else{1});
}
#[tauri::command]
fn host_capabilities() -> serde_json::Value {
 serde_json::json!({"serial": cfg!(not(any(target_os = "android",target_os = "ios"))), "ble":cfg!(feature = "native-ble"), "spp":cfg!(all(feature = "native-spp",any(target_os = "macos",windows)))})
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
 let builder = tauri::Builder::default().manage(serial::SerialState::default()).manage(updater::UpdateState::default()).manage(extensions::ExtensionState::default())
 .register_uri_scheme_protocol("devicedock-extension",|context,request| {
  match context.app_handle().path().app_cache_dir() {Ok(root)=>extensions::response(&root.join("extensions-v1"),request.uri().path()),Err(_)=>tauri::http::Response::builder().status(404).body(Vec::new()).unwrap()}
 });
 #[cfg(feature = "native-ble")]
 let builder = builder.manage(ble::BleState::default());
 #[cfg(feature = "native-spp")]
 let builder = builder.manage(classic::ClassicState::default());
 #[cfg(feature = "native-smoke")]
 let builder=builder.setup(|app|{
  let handle=app.handle().clone();
  std::thread::spawn(move||{std::thread::sleep(std::time::Duration::from_secs(30));let _=std::fs::write(std::env::temp_dir().join("devicedock-host-native-smoke.json"),"{\"pass\":false,\"error\":\"native webview smoke timed out\"}");handle.exit(2);});
  Ok(())
 }).on_page_load(|webview,payload| {
  if matches!(payload.event(),tauri::webview::PageLoadEvent::Finished) {
   let script=include_str!("../../../tests/native-cache-smoke.js")
    .replace("__FIXTURE_JSON__",&serde_json::to_string(include_str!("../../../tests/fixtures/trusted-package.json")).unwrap())
    .replace("__FIXTURE_HASH__",&serde_json::to_string(include_str!("../../../tests/fixtures/trusted-package.sha256")).unwrap());
   let _=webview.eval(&script);
  }
 });
 builder.invoke_handler(tauri::generate_handler![
  #[cfg(feature = "native-smoke")]
  native_smoke_complete,
  host_capabilities, serial::serial_list, serial::serial_open, serial::serial_ack_receive, serial::serial_write,
  serial::serial_set_signals, serial::serial_close, serial::serial_release_owned,
  updater::app_update_barrier, updater::app_update_check, extensions::extension_install, extensions::extension_download, extensions::extension_read_asset,
  #[cfg(feature = "native-ble")]
  ble::ble_release_owned,
  #[cfg(feature = "native-ble")]
  ble::ble_scan,
  #[cfg(feature = "native-ble")]
  ble::ble_scan_stop,
  #[cfg(feature = "native-ble")]
  ble::ble_open,
  #[cfg(feature = "native-ble")]
  ble::ble_start,
  #[cfg(feature = "native-ble")]
  ble::ble_write,
  #[cfg(feature = "native-ble")]
  ble::ble_close,
  #[cfg(feature = "native-spp")]
  classic::classic_release_owned,
  #[cfg(feature = "native-spp")]
  classic::classic_devices,
  #[cfg(feature = "native-spp")]
  classic::classic_discover,
  #[cfg(feature = "native-spp")]
  classic::classic_open,
  #[cfg(feature = "native-spp")]
  classic::classic_write,
  #[cfg(feature = "native-spp")]
  classic::classic_close
 ]).on_window_event(|window,event| {
  if let tauri::WindowEvent::Destroyed = event {
   serial::release_destroyed(&window.state::<serial::SerialState>(),window.label());
   #[cfg(feature = "native-ble")]
   ble::release_destroyed(&window.state::<ble::BleState>(),window.label());
   #[cfg(feature = "native-spp")]
   classic::release_destroyed(&window.state::<classic::ClassicState>(),window.label());
  }
 }).run(tauri::generate_context!()).expect("DeviceDock runtime failed");
}
