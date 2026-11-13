[English](README.md) | 简体中文

# DeviceDock

浏览器与桌面客户端上的串口与设备调试工作台，无需登录。

## 功能

- **通信调试**：单路或双路 A/B，两路的串口参数、协议与日志格式各自独立；HEX / TEXT / ANSI / 解析四种日志显示；列表与聊天两种日志视图；快捷发送、循环发送、日志过滤、复制与导出。
- **协议**：内置 SEK 与 CJ/T 188 解析，另可从协议仓库或本地来源添加外部协议包，见[协议契约](docs/protocol-contract.md)与[示例协议仓库](examples/protocol-repo/)。
- **测试流程与曲线**：按协议的字段目录生成批量或随机读写流程，在主发路上执行，并把解析出的指标画成实时曲线。
- **固件打包与升级**：生成压缩包或差分包、本机固件库、经当前链路升级设备；设备拒收差分包时改用压缩包重试一次。
- **仅桌面客户端**：原生串口、电脑 BLE 与经典蓝牙 SPP、插件宿主（见[插件契约](docs/plugin-contract.md)与[示例插件](examples/plugin-hello/)）、本地 MCP 服务（见 [desktop/MCP.md](desktop/MCP.md)）与应用内更新。

## 平台

网页版在 Chromium 系浏览器里运行，走 Web Serial。桌面客户端面向 macOS 与 Windows，在 Tauri 2 外壳里加载同一份页面。移动端沿用同一套布局，但画像只保留 SEK 协议设置、SEK 下发与固件升级，底层走 BLE、经典蓝牙，Android 还可走串口。

## 本地运行

网页版就是静态文件，任何静态服务器都可以：

```sh
python3 -m http.server 8000
```

用 Chrome 或 Edge 打开 `http://localhost:8000/`。Web Serial 需要安全上下文（localhost 算），Safari 与 Firefox 没有。

桌面客户端需要 Rust 工具链与本机的原生开发工具：

```sh
cd desktop
npm install
npm run dev     # 开发
npm run build   # 打包
```

产物复制进 `desktop/release/<通道>/`，通道 `main` 是正式版、`dev` 是预览版，每个通道只留最新一版。

## 下载

安装包发布在 GitHub Releases：macOS 是 `.dmg`，Windows 是免安装 `.zip`。Windows 版没有安装器，解压后运行 `DeviceDock.exe`，需要系统已装 Microsoft Edge WebView2 Runtime。客户端可在应用内检查并安装更新。

## 测试

```sh
for f in tests/*.cjs; do node "$f" || echo "FAIL $f"; done
node --test desktop/scripts/*.test.mjs
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib
cargo test --manifest-path desktop/portable-update-common/Cargo.toml
cargo test --manifest-path desktop/portable-updater/Cargo.toml
```

`tests/*.cjs` 是喂合成串口数据的 Node 脚本，不需要浏览器也不需要硬件。没有自动化测试的部分（界面、真实串口行为）在浏览器里连真实或虚拟串口手工验证。

## 许可证

[Apache License 2.0](LICENSE)
