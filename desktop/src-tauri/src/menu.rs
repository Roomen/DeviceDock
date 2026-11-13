// 原生菜单栏(macOS 是系统菜单栏，Windows 是窗口菜单)，中文 / 英文跟随页面的界面语言。除新建窗口外，菜单动作一律以「app-menu」事件
// 发给当前聚焦的窗口，由 js/native-shell.js 按 id 驱动页面已有的控件与 API，这里不写业务。可用 / 勾选状态与界面语言由页面经 menu_sync
// 报回来，只认聚焦窗口的报告(macOS 菜单栏是全应用共用一份，多开时显示的是前台窗口的状态)；报来的语言与当前菜单不同就按该语言重建整套菜单。
use serde::Deserialize;
use std::sync::Mutex;
use tauri::menu::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State, Window, Wry};

pub const NEW_WINDOW: &str = "new-window";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
	Zh,
	En,
}

impl Lang {
	// 页面报的是 I18n.locale(zh-CN / en)；认不出的一律按英文
	pub fn from_locale(locale: &str) -> Lang {
		if locale.to_ascii_lowercase().starts_with("zh") {
			Lang::Zh
		} else {
			Lang::En
		}
	}
	fn pick(self, zh: &'static str, en: &'static str) -> &'static str {
		match self {
			Lang::Zh => zh,
			Lang::En => en,
		}
	}
	fn connect_text(self, connected: bool) -> &'static str {
		if connected {
			self.pick("断开串口", "Disconnect Port")
		} else {
			self.pick("连接串口", "Connect Port")
		}
	}
}

struct Handles {
	lang: Lang,
	connect: MenuItem<Wry>,
	auto_scroll: CheckMenuItem<Wry>,
	themes: Vec<(&'static str, CheckMenuItem<Wry>)>,
	// 只在通信调试视图里有意义的项，页面按当前视图启停
	view_items: Vec<MenuItem<Wry>>,
}

pub struct MenuHandles(Mutex<Option<Handles>>);

fn item(app: &AppHandle, id: &str, text: &str, accel: Option<&str>) -> tauri::Result<MenuItem<Wry>> {
	MenuItem::with_id(app, id, text, true, accel)
}

// 启动时页面还没报语言，先按中文建；第一份聚焦窗口的报告带着 locale，不同就重建
pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
	let (menu, handles) = build_for(app, Lang::Zh)?;
	app.manage(MenuHandles(Mutex::new(Some(handles))));
	Ok(menu)
}

fn build_for(app: &AppHandle, lang: Lang) -> tauri::Result<(Menu<Wry>, Handles)> {
	let l = |zh: &'static str, en: &'static str| lang.pick(zh, en);
	let sep = || PredefinedMenuItem::separator(app);
	let name = app.package_info().name.clone();
	let about = PredefinedMenuItem::about(
		app,
		Some(&match lang { Lang::Zh => format!("关于 {}", name), Lang::En => format!("About {}", name) }),
		Some(AboutMetadata {
			name: Some(name.clone()),
			version: Some(app.package_info().version.to_string()),
			..Default::default()
		}),
	)?;
	let prefs = item(app, "preferences", l("偏好设置…", "Settings…"), Some("CmdOrCtrl+Comma"))?;

	// ---- 文件 ----
	let new_window = item(app, NEW_WINDOW, l("新建窗口", "New Window"), Some("CmdOrCtrl+N"))?;
	let save_log = item(app, "save-log", l("保存日志…", "Save Log…"), Some("CmdOrCtrl+S"))?;
	let close = PredefinedMenuItem::close_window(app, Some(l("关闭窗口", "Close Window")))?;
	#[cfg(target_os = "macos")]
	let file = Submenu::with_items(app, l("文件", "File"), true, &[&new_window, &sep()?, &save_log, &sep()?, &close])?;
	// Windows / Linux 没有应用菜单：偏好设置与退出放进「文件」
	#[cfg(not(target_os = "macos"))]
	let file = Submenu::with_items(
		app,
		l("文件", "File"),
		true,
		&[
			&new_window,
			&sep()?,
			&save_log,
			&sep()?,
			&prefs,
			&sep()?,
			&close,
			&PredefinedMenuItem::quit(app, Some(l("退出", "Exit")))?,
		],
	)?;

	// ---- 编辑：WebView 里的输入框靠这些预置项才有 ⌘C / ⌘V 等快捷键，不能删 ----
	let find = item(app, "find-log", l("查找日志", "Find in Log"), Some("CmdOrCtrl+F"))?;
	let edit = Submenu::with_items(
		app,
		l("编辑", "Edit"),
		true,
		&[
			&PredefinedMenuItem::undo(app, Some(l("撤销", "Undo")))?,
			&PredefinedMenuItem::redo(app, Some(l("重做", "Redo")))?,
			&sep()?,
			&PredefinedMenuItem::cut(app, Some(l("剪切", "Cut")))?,
			&PredefinedMenuItem::copy(app, Some(l("拷贝", "Copy")))?,
			&PredefinedMenuItem::paste(app, Some(l("粘贴", "Paste")))?,
			&PredefinedMenuItem::select_all(app, Some(l("全选", "Select All")))?,
			&sep()?,
			&find,
		],
	)?;

	// ---- 串口 ----
	// ⌘K 是页面的命令面板，清空日志用 ⇧⌘K；发送沿用发送框原有的 ⌘/Ctrl + Enter
	let connect = item(app, "toggle-connect", lang.connect_text(false), Some("CmdOrCtrl+O"))?;
	let pick = item(app, "pick-port", l("选择设备…", "Select Device…"), Some("CmdOrCtrl+Shift+O"))?;
	let send = item(app, "send", l("发送", "Send"), Some("CmdOrCtrl+Enter"))?;
	let clear = item(app, "clear-log", l("清空日志", "Clear Log"), Some("CmdOrCtrl+Shift+K"))?;
	let auto_scroll = CheckMenuItem::with_id(app, "auto-scroll", l("自动滚动", "Auto-scroll"), true, true, None::<&str>)?;
	let serial = Submenu::with_items(app, l("串口", "Port"), true, &[&connect, &pick, &sep()?, &send, &sep()?, &clear, &auto_scroll])?;

	// ---- 视图 ----
	let v_serial = item(app, "view-serial", l("通信调试", "Communication"), Some("CmdOrCtrl+1"))?;
	let v_fw = item(app, "view-firmware", l("固件", "Firmware"), Some("CmdOrCtrl+2"))?;
	let v_power = item(app, "view-power", l("功耗分析", "Power Analysis"), Some("CmdOrCtrl+3"))?;
	let palette = item(app, "command-palette", l("命令面板…", "Command Palette…"), Some("CmdOrCtrl+K"))?;
	let right = item(app, "toggle-right-pane", l("显示 / 隐藏右侧面板", "Show / Hide Right Panel"), Some("CmdOrCtrl+Alt+0"))?;
	let zoom_in = item(app, "log-zoom-in", l("放大日志", "Zoom In Log"), Some("CmdOrCtrl+Equal"))?;
	let zoom_out = item(app, "log-zoom-out", l("缩小日志", "Zoom Out Log"), Some("CmdOrCtrl+Minus"))?;
	let zoom_reset = item(app, "log-zoom-reset", l("日志实际大小", "Actual Log Size"), Some("CmdOrCtrl+0"))?;
	let t_auto = CheckMenuItem::with_id(app, "theme-auto", l("跟随系统", "Follow System"), true, true, None::<&str>)?;
	let t_light = CheckMenuItem::with_id(app, "theme-light", l("浅色", "Light"), true, false, None::<&str>)?;
	let t_dark = CheckMenuItem::with_id(app, "theme-dark", l("深色", "Dark"), true, false, None::<&str>)?;
	let theme = Submenu::with_items(app, l("主题", "Theme"), true, &[&t_auto, &t_light, &t_dark])?;
	let view = Submenu::with_items(
		app,
		l("视图", "View"),
		true,
		&[
			&v_serial,
			&v_fw,
			&v_power,
			&sep()?,
			&palette,
			&right,
			&sep()?,
			&zoom_in,
			&zoom_out,
			&zoom_reset,
			&sep()?,
			&theme,
		],
	)?;
	#[cfg(target_os = "macos")]
	view.append_items(&[&sep()?, &PredefinedMenuItem::fullscreen(app, Some(l("进入全屏幕", "Enter Full Screen")))?])?;

	// ---- 窗口 / 帮助 ----
	let window = Submenu::with_items(
		app,
		l("窗口", "Window"),
		true,
		&[
			&PredefinedMenuItem::minimize(app, Some(l("最小化", "Minimize")))?,
			&PredefinedMenuItem::maximize(app, Some(l("缩放", "Zoom")))?,
		],
	)?;
	#[cfg(target_os = "macos")]
	window.append_items(&[&sep()?, &PredefinedMenuItem::bring_all_to_front(app, Some(l("前置全部窗口", "Bring All to Front")))?])?;
	let feedback = item(app, "help-feedback", l("反馈问题…", "Report an Issue…"), None)?;
	let homepage = item(app, "help-homepage", l("项目主页", "Project Homepage"), None)?;
	let update = item(app, "check-update", l("检查更新…", "Check for Updates…"), None)?;
	let help = Submenu::with_items(app, l("帮助", "Help"), true, &[&update, &sep()?, &feedback, &homepage])?;
	#[cfg(not(target_os = "macos"))]
	help.append_items(&[&sep()?, &about])?;

	#[cfg(target_os = "macos")]
	let menu = {
		let app_menu = Submenu::with_items(
			app,
			&name,
			true,
			&[
				&about,
				&sep()?,
				&prefs,
				&sep()?,
				&PredefinedMenuItem::services(app, Some(l("服务", "Services")))?,
				&sep()?,
				&PredefinedMenuItem::hide(app, Some(&match lang { Lang::Zh => format!("隐藏 {}", name), Lang::En => format!("Hide {}", name) }))?,
				&PredefinedMenuItem::hide_others(app, Some(l("隐藏其他", "Hide Others")))?,
				&PredefinedMenuItem::show_all(app, Some(l("全部显示", "Show All")))?,
				&sep()?,
				&PredefinedMenuItem::quit(app, Some(&match lang { Lang::Zh => format!("退出 {}", name), Lang::En => format!("Quit {}", name) }))?,
			],
		)?;
		Menu::with_items(app, &[&app_menu, &file, &edit, &serial, &view, &window, &help])?
	};
	#[cfg(not(target_os = "macos"))]
	let menu = Menu::with_items(app, &[&file, &edit, &serial, &view, &window, &help])?;
	// macOS 在「窗口」里列出打开的窗口，「帮助」带系统搜索框
	#[cfg(target_os = "macos")]
	{
		window.set_as_windows_menu_for_nsapp()?;
		help.set_as_help_menu_for_nsapp()?;
	}

	let handles = Handles {
		lang,
		connect,
		auto_scroll,
		themes: vec![("auto", t_auto), ("light", t_light), ("dark", t_dark)],
		view_items: vec![save_log, find, send, clear, right, zoom_in, zoom_out, zoom_reset],
	};
	Ok((menu, handles))
}

pub fn focused_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
	app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false))
}

// 菜单动作只发给聚焦窗口；没有聚焦窗口(macOS 关掉了所有窗口)时安静忽略
pub fn dispatch(app: &AppHandle, id: &str) {
	if let Some(w) = focused_window(app) {
		let _ = w.emit_to(w.label(), "app-menu", id);
	}
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MenuState {
	// 当前视图是不是通信调试
	serial_view: Option<bool>,
	// 当前主发路是否已连接
	connected: Option<bool>,
	auto_scroll: Option<bool>,
	// auto | light | dark
	theme: Option<String>,
	// 页面的界面语言(I18n.locale：zh-CN / en)
	locale: Option<String>,
}

#[tauri::command]
pub fn menu_sync(window: Window, handles: State<'_, MenuHandles>, state: MenuState) {
	if !window.is_focused().unwrap_or(false) {
		return;
	}
	let app = window.app_handle();
	let Ok(mut slot) = handles.0.lock() else {
		return;
	};
	if let Some(want) = state.locale.as_deref().map(Lang::from_locale) {
		if slot.as_ref().map(|h| h.lang) != Some(want) {
			// 重建整套菜单：随后把这份报告里的勾选 / 可用状态套到新菜单上(新菜单是默认状态)
			if let Ok((menu, fresh)) = build_for(app, want) {
				if app.set_menu(menu).is_ok() {
					*slot = Some(fresh);
				}
			}
		}
	}
	let Some(h) = slot.as_ref() else {
		return;
	};
	if let Some(c) = state.connected {
		let _ = h.connect.set_text(h.lang.connect_text(c));
	}
	if let Some(a) = state.auto_scroll {
		let _ = h.auto_scroll.set_checked(a);
	}
	if let Some(t) = state.theme.as_deref() {
		for (id, it) in &h.themes {
			let _ = it.set_checked(*id == t);
		}
	}
	if let Some(on) = state.serial_view {
		for it in &h.view_items {
			let _ = it.set_enabled(on);
		}
		let _ = h.auto_scroll.set_enabled(on);
	}
}

#[cfg(test)]
mod tests {
	use super::Lang;

	#[test]
	fn locale_maps_to_menu_language() {
		assert_eq!(Lang::from_locale("zh-CN"), Lang::Zh);
		assert_eq!(Lang::from_locale("zh"), Lang::Zh);
		assert_eq!(Lang::from_locale("en"), Lang::En);
		assert_eq!(Lang::from_locale(""), Lang::En);
		assert_eq!(Lang::En.connect_text(true), "Disconnect Port");
		assert_eq!(Lang::Zh.connect_text(false), "连接串口");
	}
}
