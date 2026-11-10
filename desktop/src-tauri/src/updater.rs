//! Shell lifecycle fence. Delivery deliberately disabled until DeviceDock signing/feeds exist.
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
#[derive(Default)]
struct Inner { frozen: bool, operations: usize }
#[derive(Default)]
pub struct UpdateState { inner: Mutex<Inner> }
pub fn frozen(app: &AppHandle) -> bool { app.state::<UpdateState>().inner.lock().unwrap().frozen }
pub struct DeviceOperation(AppHandle);
pub fn begin_device_operation(app: &AppHandle) -> Result<DeviceOperation,String> {
 let state = app.state::<UpdateState>(); let mut inner = state.inner.lock().unwrap();
 if inner.frozen { return Err("应用升级屏障已启用".into()); }
 inner.operations += 1; Ok(DeviceOperation(app.clone()))
}
impl Drop for DeviceOperation { fn drop(&mut self) { self.0.state::<UpdateState>().inner.lock().unwrap().operations -= 1; } }
#[tauri::command]
pub fn app_update_barrier(state: State<'_, UpdateState>, freeze: bool) -> Result<(),String> {
 let mut inner = state.inner.lock().unwrap();
 if freeze && inner.operations != 0 { return Err("原生设备操作尚未完成".into()); }
 inner.frozen = freeze; Ok(())
}
#[tauri::command]
pub fn app_update_check() -> Result<(),String> { Err("DeviceDock 应用更新尚未配置签名与发布源".into()) }
