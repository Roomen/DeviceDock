fn main() {
	if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
		cc::Build::new()
			.file("src/classic/macos.m")
			.flag("-fobjc-arc")
			.flag("-mmacosx-version-min=11.0")
			.compile("classic_native");
		println!("cargo:rustc-link-lib=framework=IOBluetooth");
		println!("cargo:rustc-link-lib=framework=IOBluetoothUI");
		println!("cargo:rerun-if-changed=src/classic/macos.m");
	}
	let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
	tauri_build::build();
	if windows_msvc {
		// 必须在 tauri_build::build() 之后调用：资源文件是它生成的。
		embed_resources_in_tests();
	}
}

/// Windows 的单元测试 exe 也要带应用清单。
///
/// tauri-build 用 embed-resource 把应用清单(连同图标、版本信息)编成 Windows 资源文件，
/// 但只挂到 bin(cargo:rustc-link-arg-bins)：cargo test --lib 的测试 exe 因此没有清单，
/// 加载时把 comctl32 解析到 v5.82，缺 TaskDialogIndirect 这类 v6 专有入口，
/// 进程直接以 0xc0000139(STATUS_ENTRYPOINT_NOT_FOUND) 退出。
/// 把同一份资源文件再挂给测试目标即可：清单与程序完全一致，也不用 /MANIFESTINPUT
/// (lld-link 合并外部清单要调用 mt.exe，用 rust-lld 链接时它不一定在 PATH 上)。
fn embed_resources_in_tests() {
	let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR is set by cargo");
	let resource = std::fs::read_dir(&out_dir)
		.unwrap_or_else(|error| panic!("cannot list {out_dir}: {error}"))
		.filter_map(Result::ok)
		.map(|entry| entry.path())
		.find(|path| {
			path.file_stem().and_then(|stem| stem.to_str()) == Some("resource")
				&& matches!(path.extension().and_then(|ext| ext.to_str()), Some("lib") | Some("res"))
		})
		.unwrap_or_else(|| panic!("tauri-build did not produce its Windows resource file in {out_dir}; test binaries would have no application manifest"));
	println!("cargo:rustc-link-arg-tests={}", resource.display());
}
