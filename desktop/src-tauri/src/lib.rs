mod lease;
mod mcp;
mod mcp_settings;
mod serial;
mod updater;
mod portable;
mod extensions;
mod native_plugins;
#[cfg(feature = "native-ble")]
mod ble;
#[cfg(feature = "native-spp")]
mod classic;
use tauri::{Manager,Emitter};
mod menu;
#[cfg(feature="native-smoke")]
static NATIVE_SMOKE_STAGE:std::sync::Mutex<Option<String>>=std::sync::Mutex::new(None);
#[cfg(feature="native-smoke")]
fn record_native_smoke_stage(stage:&str) {
 if std::env::var("DEVICEDOCK_SMOKE_MODE").as_deref()==Ok("native-plugins") {eprintln!("native-plugin-smoke stage: {stage}");*NATIVE_SMOKE_STAGE.lock().unwrap()=Some(stage.to_string());}
}
#[cfg(feature="native-smoke")]
#[tauri::command]
fn native_smoke_stage(stage:String) {if stage.len()<120 && stage.bytes().all(|c|c.is_ascii_alphanumeric() || b"-_:".contains(&c)){record_native_smoke_stage(&stage);}}
#[cfg(feature = "native-smoke")]
#[tauri::command]
fn native_smoke_complete(app:tauri::AppHandle,result:serde_json::Value) {
 let pass=result["pass"]==true;
 let _=std::fs::write(std::env::temp_dir().join("devicedock-host-native-smoke.json"),result.to_string());
 app.exit(if pass {0}else{1});
}
#[tauri::command]
fn host_capabilities() -> serde_json::Value {
 serde_json::json!({"serial": cfg!(not(any(target_os = "android",target_os = "ios"))), "ble":cfg!(feature = "native-ble"), "nativePlugins":cfg!(any(target_os="macos",target_os="linux",windows)), "spp":cfg!(all(feature = "native-spp",any(target_os = "macos",windows)))})
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
 #[cfg(feature="native-smoke")] record_native_smoke_stage("runtime-build");
 let builder = tauri::Builder::default().plugin(tauri_plugin_updater::Builder::new().build()).manage(mcp::McpState::default()).manage(serial::SerialState::default()).manage(updater::UpdateState::default()).manage(extensions::ExtensionState::default()).manage(native_plugins::NativePluginState::default())
 .register_uri_scheme_protocol("devicedock-native",|context,request|native_plugins::response(context.app_handle(),request.uri().path()))
 .register_uri_scheme_protocol("devicedock-extension",|context,request| {
  match context.app_handle().path().app_data_dir() {Ok(root)=>extensions::response(&root.join("extensions-v1"),request.uri().path()),Err(_)=>tauri::http::Response::builder().status(404).body(Vec::new()).unwrap()}
 });
 #[cfg(feature = "native-ble")]
 let builder = builder.manage(ble::BleState::default());
 #[cfg(feature = "native-spp")]
 let builder = builder.manage(classic::ClassicState::default());
 let builder=builder.setup(|app|{
  #[cfg(feature="native-smoke")] record_native_smoke_stage("setup-entered");
  app.set_menu(menu::build(app.handle())?)?;
  #[cfg(feature="native-smoke")] record_native_smoke_stage("setup-menu-built");
  if !portable::startup_gate(app.handle()) {app.handle().exit(0);return Ok(())}
  #[cfg(feature="native-smoke")] record_native_smoke_stage("setup-startup-gate-passed");
  if let Some(handoff)=updater::read_handoff(app.handle()) {
   for (label,session) in handoff.windows {build_window(app.handle(),&label,Some(&session))?;}
   updater::remove_handoff(app.handle());
  } else {build_window(app.handle(),"main",None)?;}
  #[cfg(feature="native-smoke")]
  {
   record_native_smoke_stage("setup-window-built");
   let handle=app.handle().clone();
   std::thread::spawn(move||{std::thread::sleep(std::time::Duration::from_secs(30));let stage=NATIVE_SMOKE_STAGE.lock().unwrap().clone();let _=std::fs::write(std::env::temp_dir().join("devicedock-host-native-smoke.json"),serde_json::json!({"pass":false,"error":"native webview smoke timed out","lastStage":stage}).to_string());handle.exit(2);});
  }
  Ok(())
 }).on_menu_event(|app,event|{let id=event.id().as_ref();if id=="new-window"{let _=host_new_window(app.clone());}else if let Some(w)=app.webview_windows().into_values().find(|w|w.is_focused().unwrap_or(false)){let _=w.emit("app-menu",id);}}).on_page_load(|_webview,_payload| {
  #[cfg(feature="native-smoke")] record_native_smoke_stage(if matches!(_payload.event(),tauri::webview::PageLoadEvent::Started){"page-load-started"}else{"page-load-finished"});
  if matches!(_payload.event(),tauri::webview::PageLoadEvent::Started){mcp::release(&_webview.state::<mcp::McpState>(),_webview.label());let release=_webview.state::<native_plugins::NativePluginState>().release(_webview.label());tauri::async_runtime::spawn(native_plugins::finish_release(release));}
  #[cfg(feature="native-smoke")]
  if matches!(_payload.event(),tauri::webview::PageLoadEvent::Finished) && _webview.label()=="main" {
   if std::env::var("DEVICEDOCK_SMOKE_MODE").as_deref()==Ok("sources"){let _=_webview.eval(include_str!("../../../tests/native-sources-smoke.js"));return}
   if std::env::var("DEVICEDOCK_SMOKE_MODE").as_deref()==Ok("mcp"){let _=_webview.eval(include_str!("../../../tests/native-mcp-smoke.js"));return}
   use sha2::Digest;
   let fixture=std::env::var("DEVICEDOCK_SMOKE_BUNDLE").ok().and_then(|path|std::fs::read_to_string(path).ok()).unwrap_or_else(||include_str!("../../../tests/fixtures/trusted-package.json").to_string());
   let hash=format!("{:x}",sha2::Sha256::digest(fixture.as_bytes()));
   let template=if std::env::var("DEVICEDOCK_SMOKE_MODE").as_deref()==Ok("native-plugins"){include_str!("../../../tests/native-plugins-smoke.js")}else{include_str!("../../../tests/native-cache-smoke.js")};
   let script=template
    .replace("__FIXTURE_JSON__",&serde_json::to_string(&fixture).unwrap())
    .replace("__FIXTURE_HASH__",&serde_json::to_string(&hash).unwrap());
   record_native_smoke_stage("script-dispatch");
   if _webview.eval(&script).is_err(){record_native_smoke_stage("script-eval-error");}
  }
 });
 builder.invoke_handler(tauri::generate_handler![
  #[cfg(feature = "native-smoke")]
  native_smoke_complete,
  #[cfg(feature="native-smoke")]
  native_smoke_stage,
  #[cfg(feature = "native-smoke")]
  native_smoke_window_tool,
  #[cfg(feature = "native-smoke")]
  mcp::native_smoke_rpc,
  #[cfg(feature = "native-smoke")]
  updater::native_smoke_update_cycle,
  mcp::mcp_register,mcp::mcp_reveal_token,mcp::mcp_regenerate_token,mcp::mcp_start,mcp::mcp_stop,mcp::mcp_commit,mcp::mcp_reply,
  native_plugins::native_plugin_install,native_plugins::native_plugin_list,native_plugins::native_plugin_trust,native_plugins::native_plugin_revoke,native_plugins::native_plugin_start,native_plugins::native_plugin_call,native_plugins::native_plugin_stop,native_plugins::native_plugin_uninstall,native_plugins::native_plugin_page,native_plugins::native_plugin_release_owned,
  host_new_window,host_capabilities, serial::serial_list, serial::serial_open, serial::serial_ack_receive, serial::serial_write,
  serial::serial_set_signals, serial::serial_close, serial::serial_release_owned,
  updater::app_update_check, updater::app_update_install, updater::app_update_ack, updater::app_update_result, extensions::extension_install, extensions::extension_download, extensions::extension_read_asset,
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
   mcp::release(&window.state::<mcp::McpState>(),window.label());
   let release=window.state::<native_plugins::NativePluginState>().release(window.label());tauri::async_runtime::spawn(native_plugins::finish_release(release));
   serial::release_destroyed(&window.state::<serial::SerialState>(),window.label());
   #[cfg(feature = "native-ble")]
   ble::release_destroyed(&window.state::<ble::BleState>(),window.label());
   #[cfg(feature = "native-spp")]
   classic::release_destroyed(&window.state::<classic::ClassicState>(),window.label());
  }
 }).build(tauri::generate_context!()).expect("DeviceDock runtime failed").run(|app,event| {
  if let tauri::RunEvent::ExitRequested{api,code,..}=event {
   static EXITING:std::sync::atomic::AtomicU8=std::sync::atomic::AtomicU8::new(0);
   if EXITING.load(std::sync::atomic::Ordering::SeqCst)!=2 {api.prevent_exit();}
   if EXITING.compare_exchange(0,1,std::sync::atomic::Ordering::SeqCst,std::sync::atomic::Ordering::SeqCst).is_ok() {app.state::<native_plugins::NativePluginState>().begin_shutdown();let app=app.clone();let exit_code=code.unwrap_or(0);tauri::async_runtime::spawn(async move{app.state::<native_plugins::NativePluginState>().release_all().await;EXITING.store(2,std::sync::atomic::Ordering::SeqCst);app.exit(exit_code);});}
  }
 });
}

fn build_window(app:&tauri::AppHandle,label:&str,session:Option<&std::collections::HashMap<String,String>>)->tauri::Result<()> {
 let handle=app.clone();
 let mut builder=tauri::WebviewWindowBuilder::new(app,label,tauri::WebviewUrl::App("index.html".into())).title("DeviceDock").inner_size(1320.,860.).min_inner_size(700.,540.).on_download(move |webview,event|{match event{
  tauri::webview::DownloadEvent::Requested{destination,..}=>{let name=destination.file_name().and_then(|n|n.to_str()).unwrap_or("download").to_string();if let Ok(dir)=handle.path().download_dir(){*destination=unique_path(&dir,&name);}},
  tauri::webview::DownloadEvent::Finished{success,..}=>{let _=webview.emit("app-download",serde_json::json!({"success":success}));},_=>{}}true});
 if let Some(session)=session{builder=builder.initialization_script(updater::session_script(session));}
 builder.build()?;Ok(())
}
#[tauri::command]
fn host_new_window(app:tauri::AppHandle)->Result<(),String>{updater::with_window_creation(&app,||{let windows=app.webview_windows();let index=(2..).find(|n|!windows.contains_key(&format!("main-{n}"))).unwrap();build_window(&app,&format!("main-{index}"),None)}).map_err(|_|"Cannot create window during update".into())}

fn unique_path(dir:&std::path::Path,name:&str)->std::path::PathBuf{let p=std::path::Path::new(name);let name=p.file_name().unwrap_or(std::ffi::OsStr::new("download"));let first=dir.join(name);if !first.exists(){return first}let stem=p.file_stem().and_then(|s|s.to_str()).unwrap_or("download");let ext=p.extension().and_then(|s|s.to_str()).map(|s|format!(".{s}")).unwrap_or_default();for i in 1..{let next=dir.join(format!("{stem} ({i}){ext}"));if !next.exists(){return next}}unreachable!()}

#[cfg(feature="native-smoke")]
#[tauri::command]
fn native_smoke_window_tool(app:tauri::AppHandle,enabled:bool)->Result<(),String>{
 let window=app.get_webview_window("main-2").ok_or("second smoke window missing")?;
 let action=if enabled{r#"await app.host.enable({schemaVersion:1,id:'org.test.window',name:'fixture',version:'1.0.0',apiVersion:1,kind:'plugin',entry:'index.js',platforms:['desktop'],capabilities:[],license:'MIT',integrity:{'index.js':'sha256-'+'0'.repeat(64)}},'fixture',true,async()=>({activate(api){api.registerMcpTool({name:'org.test.window.tool',description:'smoke',inputSchema:{type:'object',properties:{}}},()=>({ok:true}))}}))"#}else{"await app.host.disable('org.test.window')"};
 window.eval(format!("(async()=>{{const app=(await import('./src/app.js')).application;{action}}})()" )).map_err(|_|"smoke window eval failed".into())
}
