# DeviceDock

独立的设备通信工作台。核心只有串口连接、原始收发、日志和扩展管理。无需登录。协议设置、功耗、设备固件和无线/桥工具由独立包提供。

## 启动

Node 22 或更新版本：

```sh
npm ci
npm run dev
```

打开终端显示的本地地址。Web 串口需要 Chromium 和安全上下文；iOS 浏览器没有 Web Serial，界面会明确显示能力不可用。移动画像只显示一路。A/B 连接意图和会话不会写入共享持久设置。

```sh
npm run build                  # 当前已集成包的独立 dist；无包时为零插件
node tools/build.mjs --core     # 独立零插件 dist-core
SERVE_DIST=dist node tools/serve.mjs
SERVE_DIST=dist-core node tools/serve.mjs
```

`dist` 与 `dist-core` 均无需旧项目、兄弟仓库、node_modules、外部 CDN 或运行时符号链接。构建产物包含首方资源和包资源的离线清单；浏览器完成首次缓存后可以离线重载。原生壳直接携带网页资源。首次运行时均不自动执行未授权包。

## 协议和插件交付

SDK 和规范见 [扩展契约](docs/extension-contract.md)。独立仓库各自生成完整目录与 base64 JSON 包；宿主安装只消费发布产物，不在运行时读取源码仓库。由另两仓库执行各自 README 中的构建后，显式集成：

```sh
node tools/integrate-release.mjs protocol /path/to/protocol-artifacts --replace
node tools/integrate-release.mjs plugin /path/to/plugin-artifacts --replace
npm run build
```

集成脚本核对目录中的 catalog、产物 SHA-256、完整模块图、各文件摘要和目录内容一致性。每个版本进入内容摘要目录，最后原子切换 `extensions/installed.json`。该生成目录和注册表被 Git 忽略；仓库源码本身可零插件启动。生产输出把包复制到自己的树中。也可用 `node tools/integrate.mjs pack <directory> <output.json>` 生成可在扩展管理中导入的包。

界面支持多个协议仓库和插件仓库，配置 HTTPS 仓库 URL。GitHub 默认分支需提供 `catalog.json`，格式见 [来源目录](docs/sources.md)。添加/刷新/下载/安装均不执行代码；勾选信任并启用才执行。远端版本必须有固定摘要。浏览器使用完整校验的 Service Worker 缓存 URL，桌面使用校验过的原生不可变缓存与受限资源协议。启用失败会清理贡献，切换失败会恢复上一个已启用版本。未提供签名认证服务：同源扩展拥有页面权限，清单能力不是沙箱。

## 桌面

```sh
npm ci --prefix desktop
npm run build --prefix desktop
# 可选原生无线驱动：
cd desktop
npx tauri build --no-bundle --features native-ble,native-spp
```

需要 Rust、当前系统原生开发工具。默认构建提供真实原生串口；可选 feature 才编译和提供 BLE/SPP。无线插件通过相同会话访问这些 shell 驱动；BLE 需扫描、选择设备并确认 TX/RX GATT 特征，SPP 使用系统配对选择。动态安装原生驱动不受支持。应用自己的自动更新暂未配置新签名和发布源，明确不可用；设备固件扩展是独立功能。

桌面扩展源下载有 HTTPS、重定向、大小、时限和摘要检查；安装再次验证每个文件。原生缓存请求逐次核对摘要、路径和符号链接。缓存损坏拒绝执行并保留旧版本，不静默改源。

## 验证

```sh
npm test
node tests/integration.mjs       # 需先集成两个冻结目录，包含独立 patch provider
SERVE_DIST=dist node tests/browser-smoke.mjs
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib --all-features
```

浏览器烟测使用隔离临时配置的本机 Chrome，不使用个人配置、不生成截图。集成测试导入宿主自己的已打包目录，模拟真实流与协议字节，覆盖业务服务和所有权，不伪造业务服务成功。

当前能力与未迁移范围见 [能力矩阵](docs/capabilities.md)。原项目归属及第三方许可见 LICENSE、NOTICE 和 vendor/。尚未发布或推送任何仓库。

原生 WebKit 缓存/Worker 烟测使用独立测试 feature（普通构建不暴露测试命令）：

```sh
node tools/build.mjs --core
TAURI_CONFIG='{"build":{"frontendDist":"../../dist-core","devUrl":null}}' cargo run --manifest-path desktop/src-tauri/Cargo.toml --bin devicedock --features native-smoke,native-ble,native-spp
```

该测试默认安装合成包；设置 DEVICEDOCK_SMOKE_BUNDLE 为经宿主 verifyPackage 生成的规范包 JSON，可验证实际 org.devicedock.patch 包。它验证原生缓存 ESM、WASM MIME/CORS 和 Blob Worker 中实际 WASM 加法结果，并自动退出。结果位于系统临时目录 `devicedock-host-native-smoke.json`。它不扫描或连接真实硬件。
