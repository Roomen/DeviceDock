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
	// Windows 的应用清单不再交给 tauri-build：它把资源文件只挂到 bin(cargo:rustc-link-arg-bins)，
	// 而 rustc-link-arg-tests 只作用于集成测试目标，cargo test --lib 的单元测试 exe 不在其内，
	// 那条指令还会让 cargo 直接报错(package does not have a test target)。
	// 所以这里关掉它的清单，另编一份只含清单的资源挂给全部目标(embed_resource_in_every_target)。
	// 图标与版本信息仍在 tauri-build 生成的资源文件里，只挂 bin。
	let mut attributes = tauri_build::Attributes::new();
	if windows_msvc {
		attributes = attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
	}
	tauri_build::try_build(attributes).unwrap_or_else(|error| panic!("tauri-build failed: {error:#}"));
	if windows_msvc {
		embed_resource_in_every_target();
	}
}

/// 把应用清单编成资源并挂给每一个目标，含库的单元测试 exe。
///
/// 没有清单时进程把 comctl32 解析到 v5.82，缺 TaskDialogIndirect 这类 v6 专有入口，
/// 一启动就以 0xc0000139(STATUS_ENTRYPOINT_NOT_FOUND) 退出——这正是 cargo test --lib 在 Windows 上的死法。
/// cargo:rustc-link-arg 对所有会走链接的目标生效(bin、tests、benches、examples、cdylib)，
/// 因此 bin 与测试 exe 用的是同一份清单，也不必走 /MANIFESTINPUT
/// (lld-link 合并外部清单要调用 mt.exe，用 rust-lld 链接时它不一定在 PATH 上)。
fn embed_resource_in_every_target() {
	let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo");
	// windows-manifest.rc 里写的是相对路径 windows.manifest，两者都在包根目录；
	// 包根目录显式加进 rc 的 include 路径，免得换 rc 实现后按别的目录解析。
	embed_resource::compile_for_everything("windows-manifest.rc", embed_resource::ParamsIncludeDirs([manifest_dir.as_str()]))
		.manifest_required()
		.unwrap_or_else(|error| panic!("cannot embed {manifest_dir}/windows.manifest: {error}"));
	println!("cargo:rerun-if-changed=windows-manifest.rc");
	println!("cargo:rerun-if-changed=windows.manifest");
}
