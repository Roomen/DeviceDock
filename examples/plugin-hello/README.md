# Hello 示例插件（`examples/plugin-hello`）

演示 DeviceDock 客户端 Web 插件的最小完整结构：

- **设备列表与通道状态（`device.read`）**：列出当前在位串口与各路连接状态，监听热插拔与通道变化事件。
- **串口 RX 字节计数（`serial.io`）**：实时订阅各路接收到的原始字节并统计字节数。
- **亮/暗色自动适配（`app`）**：通过 `sdk/devicedock-plugin.js` 的 `applyTheme()` 将宿主 `:root` CSS 变量同步到插件文档，随宿主实时切换亮/暗色。
- **应用更新冻结保护（`app` · busy 源）**：演示 `app.busyAcquire` / `app.busyRelease` 在插件执行关键任务期间阻止宿主安装应用更新。

## 构建与校验

```bash
# 刷新 manifest.json 的 integrity 并在 dist/ 下产出 devicedock-plugin.zip 与 .sha256
node examples/plugin-hello/tools/build.mjs
```

## 发布工作流

将 `.github/workflows/release.yml` 复制到独立插件仓库的同名路径，推送 `v1.0.0` 标签即可自动构建并上传 `devicedock-plugin.zip` 与 `devicedock-plugin.zip.sha256` 到 GitHub Release。
