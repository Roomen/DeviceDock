// 把更新公钥编译进 helper：helper 在主程序退出后独立复核签名，不依赖应用进程内存里的结果。
// 公钥是公开信息(发布清单里本来就带)，但只在配置了签名时才内嵌；没配时内嵌空串，
// helper 会拒绝任何更新(失败关闭)，本地无签名构建仍然能打出可手动使用的便携 ZIP。
fn main() {
	let pubkey = std::env::var("TAURI_UPDATER_PUBLIC_KEY").unwrap_or_default();
	let pubkey = pubkey.trim();
	println!("cargo:rerun-if-env-changed=TAURI_UPDATER_PUBLIC_KEY");
	println!("cargo:rustc-env=DEVICEDOCK_UPDATER_PUBKEY={pubkey}");

	// Windows 上自带一份 asInvoker 清单：MSVC 的 link.exe 会为没有清单的 exe 自动生成一份，
	// 换成 rust-lld 后不会；而这个名字含 "update" 的程序没有清单会命中安装器检测，
	// 可能被要求提权。lld-link 生成默认清单不用外部工具，所以只加 /MANIFEST:EMBED 与 UAC 级别。
	let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
		&& std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
	if windows_msvc {
		println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
		println!("cargo:rustc-link-arg=/MANIFESTUAC:level='asInvoker' uiAccess='false'");
	}
}
