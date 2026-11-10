use tauri::{AppHandle,Wry};
use tauri::menu::{Menu,MenuItem,Submenu,PredefinedMenuItem};
pub fn build(app:&AppHandle)->tauri::Result<Menu<Wry>>{
 let item=|id,text,shortcut|MenuItem::with_id(app,id,text,true,shortcut);
 let file=Submenu::with_items(app,"文件",true,&[&item("new-window","新建窗口",Some("CmdOrCtrl+N"))?,&item("save-log","保存日志",Some("CmdOrCtrl+S"))?,&PredefinedMenuItem::close_window(app,Some("关闭窗口"))?])?;
 let edit=Submenu::with_items(app,"编辑",true,&[&PredefinedMenuItem::undo(app,None)?,&PredefinedMenuItem::redo(app,None)?,&PredefinedMenuItem::cut(app,None)?,&PredefinedMenuItem::copy(app,None)?,&PredefinedMenuItem::paste(app,None)?,&PredefinedMenuItem::select_all(app,None)?,&item("find-log","查找日志",Some("CmdOrCtrl+F"))?])?;
 let serial=Submenu::with_items(app,"通信",true,&[&item("toggle-connect","连接 / 断开",Some("CmdOrCtrl+O"))?,&item("send","发送",Some("CmdOrCtrl+Enter"))?,&item("clear-log","清空日志",Some("CmdOrCtrl+Shift+K"))?,&item("auto-scroll","自动滚动",None)?])?;
 let view=Submenu::with_items(app,"视图",true,&[&item("view-serial","通信工作台",Some("CmdOrCtrl+1"))?,&item("view-extensions","扩展工具",Some("CmdOrCtrl+2"))?,&item("view-shell","客户端服务",Some("CmdOrCtrl+3"))?,&item("command-palette","命令面板",Some("CmdOrCtrl+K"))?,&item("theme-auto","跟随系统",None)?,&item("theme-light","浅色",None)?,&item("theme-dark","深色",None)?])?;
 let menu=Menu::with_items(app,&[&file,&edit,&serial,&view])?;
 #[cfg(target_os="macos")]
 {let app_menu=Submenu::with_items(app,"DeviceDock",true,&[&PredefinedMenuItem::about(app,None,None)?,&PredefinedMenuItem::hide(app,None)?,&PredefinedMenuItem::hide_others(app,None)?,&PredefinedMenuItem::show_all(app,None)?,&PredefinedMenuItem::quit(app,None)?])?;menu.prepend(&app_menu)?;}
 Ok(menu)
}
