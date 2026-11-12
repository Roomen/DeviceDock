# 插件契约 v1

客户端插件包、GitHub Release 资产、沙箱隔离与宿主 RPC 的实际做法；只写现状、禁止项和坑。

## 包格式与清单

- 插件只在桌面客户端（`html[data-runtime='tauri']`，功能 id `plugins`）实现，网页版与移动端门控关闭，不显示任何插件入口也不加载插件执行路径。
- 每个插件独立 GitHub 仓库、各自 CI 构建发布；包根必须放 `manifest.json`，所有要由 `ddplugin://` 提供的文件（含 `entry`、脚本、样式、图标、SDK）都必须列在 `integrity` 里。
- `manifest.json` 字段（严格校验、`deny_unknown_fields`）：`schemaVersion:1`、`id`（`^[a-z0-9][a-z0-9.-]{0,62}[a-z0-9]$` 或单字符）、`name`（1–48 字符）、`version`（完整 SemVer 式 `主.次.修订`，可带 `-预发布` / `+构建`，整串只认 `[0-9A-Za-z.+-]`，预发布 / 构建标识符非空且点分隔）、`apiVersion:1`、`kind:"web"|"native"`、`entry`（包内相对路径，`web` 插件必须是 `.html`/`.htm`）、`icon?`（lucide 图标名或包内相对 `.svg` 路径，后者必须在 `integrity` 中声明）、`capabilities:[...]`（无重复）、`platforms?:["macos","windows","linux"]`（省略表示全桌面平台）、`native?`（仅 `kind:"native"` 允许）、`integrity:{ "<包内相对路径>": "sha256-<64 位十六进制>" }`、`homepage?`、`license?`。
- 版本号会拼进 `plugins/<id>/<version>/`：`valid_version` 禁止 `/`、`\`、`..` 与控制字符，`store::checked_version_dir` 落盘前再独立确认目标是插件目录下的单层子目录；`version_dir` 对非法版本退到不存在的 `.invalid-version`，`ddplugin://` 路径解析也用同一判据，后缀里塞 `../../` 越不出目录。
- 解压拒绝重复文件条目、大小写碰撞（`index.html` 与 `INDEX.html` 在大小写不敏感文件系统上指向同一文件）、**Unicode NFC 归一化碰撞**（`café` 的组合/预组合写法）、文件与目录同名、把文件当目录用；路径表键按 NFC + 小写比较，写入用 `create_new` 独占创建，不能靠解压顺序覆盖已校验内容。
- 包内路径只允许以 `/` 分隔的普通相对路径段：禁止空段、`\`、以 `/` 开头、`.` / `..`、控制字符、`:`、结尾空格或点、以及 Windows 保留设备名（`con`/`prn`/`aux`/`nul`/`com1..9`/`lpt1..9`）；校验见 `desktop/src-tauri/src/plugins/manifest.rs` 的 `safe_rel_path`。
- 单包硬上限：最多 4000 个文件、单文件不超过 8 MiB、整包解压不超过 64 MiB、`manifest.json` 不超过 256 KiB；解压时禁止符号链接、硬链接、设备节点与 FIFO。

## 资产命名与下载校验

- 用户填写仓库根地址 `https://github.com/<owner>/<repo>`（可带 `@<tag>` 指定版本，不带子路径）安装；宿主请求 GitHub Release API（最新 release 或指定 tag）。
- 资产下载**不信任** release 元数据里的 `browser_download_url`：用资产 `id` 自己拼 `https://api.github.com/repos/<owner>/<repo>/releases/assets/<id>`（`Accept: application/octet-stream`），初始 URL 再校验一次域名；重定向逐跳限制为 GitHub / `*.githubusercontent.com` 等白名单 HTTPS 域名、最多 5 跳，`bearer_auth` 标记的敏感头由 reqwest 在跨 host 时剥离，令牌不会跟到第三方地址。`id` 为 0 的资产直接拒绝。每个请求只设**一个** `Accept`（release API 是 `application/vnd.github+json`，资产下载是 `application/octet-stream`）：reqwest 的 `.header()` 是追加语义，两个 Accept 会让 GitHub 可能返回资产元数据而不是文件内容。
- 资产选择规则：优先名为 `devicedock-plugin.zip` 或 `devicedock-plugin.tar.gz` 的资产，其次匹配 `*.devicedock-plugin.zip` 或 `*.devicedock-plugin.tar.gz`；同一 release **必须**存在同名的 `<资产名>.sha256` 校验文件（支持 `sha256sum` 的 `<64hex>  <文件名>` 格式），缺失或校验不符直接拒绝，不做无校验降级。
- 下载与解压全部在 Rust 侧（`desktop/src-tauri/src/plugins/`）完成：先校验整包 `.sha256` → 解压到 `app_data_dir/plugins/.staging-<随机>/` → 解析 `manifest.json` → 按 `integrity` 对磁盘文件逐个复核 SHA-256 → 原子重命名切换到 `app_data_dir/plugins/<id>/<version>/` 并清理旧版本目录（保留同级 `storage.json`）；任何一步失败立即删除临时目录回滚。
- 安装与更新分两步：`plugin_inspect` / `plugin_check_update` 先下载校验并读出清单、版本差异与能力变化，界面展示确认卡（名称、来源仓库、版本、包 SHA-256 前 12 位、申请能力的人话说明与新增能力标记），用户点击授权后 `plugin_install` 核对 `expectedSha256` 一致才落盘；包摘要在确认后发生变化的会拒绝安装。
- 目录切换与 `state.json` 提交是**串行事务**：`PluginsState.tx` 进程内互斥锁 + `plugins/.lock` 跨进程文件锁（`fs2`），安装 / 启停 / 卸载共用，多个客户端实例也串行。`begin_install` 在**任何目录换名之前**把 `plugins/<id>/.tx.json`（`{version, backup, staging, committed}`）落盘，同版本旧目录只留到 `commit` 标记已提交并清理；`rollback` 错误一律上报，不吞掉。进程在两次动作之间被杀时，启动时 `recover_transactions` 按 `committed` 决定还原 `.old-*` 还是补做清理。卸载的状态提交与目录删除在同一段锁内完成。
- `plugin_install` 的 `expectedSha256` **必填且必须是 64 位十六进制**，与本次下载包摘要比对；`expectedCurrentVersion` / `expectedCurrentSha256` 把 `inspect`/`checkUpdate` 时的已安装状态带回，提交前在锁内用 `baseline_matches` 重新核对，并发变更（版本或摘要变了）一律要求重新确认，避免能力差异展示过期。

## 隔离模型与安全边界

- `web` 插件 UI 在主视图区（`#views > .plugin-view`）用 `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer">` 加载，**绝不授予 `allow-same-origin`**：插件文档处于 opaque origin，拿不到宿主 DOM、`localStorage`、`sessionStorage`、`indexedDB` 或 `__TAURI__` 全局量。
- `iframe.src` 走 Tauri 自定义协议 `ddplugin://`（macOS/Linux 为 `ddplugin://localhost/<id>/<version>/<path>`，Windows WebView2 为 `http://ddplugin.localhost/<id>/<version>/<path>`，由 `convertFileSrc` 统一生成）；协议处理器只返回「当前已安装 + 已启用 + 版本匹配 + 列在 `manifest.integrity` 中 + 实时读取复核 SHA-256 通过」的普通文件，停用或卸载后立即返回 404。
- `ddplugin://` 响应头固定带严格 CSP：`default-src 'none'; script-src <scheme> 'unsafe-inline'; style-src <scheme> 'unsafe-inline'; img-src <scheme> data:; font-src <scheme> data:; media-src <scheme>; connect-src 'none'; form-action 'none'; base-uri 'none'`，插件不能直接发外部网络请求，所有外部交互必须经宿主 RPC。
- **能力白名单是 Web 插件的真实权限边界**：插件通过 `window.parent.postMessage({ __devicedock: 1, id, method, params }, '*')` 发请求，宿主 `js/plugin-host.js` 先按 `event.source === view.iframe.contentWindow` 识别来源插件实例，再由 `js/plugin-rpc.js` 的 `authorize(capabilities, method)` 逐次核对该插件已授权的能力，未声明对应能力的调用一律返回 `capability_denied`。先做 O(1) 准入（在飞 ≤ 8、每秒 ≤ 60 次，无效 / 超大 / 高频消息都先计数），再做**有界**遍历：消息 256 KiB、参数 128 KiB，`estimateSize` 的节点数与字符数都受预算限制，大数组不整体压栈（超预算立即返回 `Infinity`）；超限回 `too_large` / `rate_limited`。`app.saveFile` 另有 8 MiB 导出上限，`app.storageSet` 单值 64 KiB。
- 宿主 → 插件的事件（`serial.rx`/`tx`、`protocol.frame`、`device.*` 等）按插件限流（每秒 ≤ 120），超额丢弃；本窗口第一次丢弃立刻发 `events.dropped` 计数事件，窗口切换时补报剩余计数，插件据此知道数据有缺口。
- 逐版本信任也覆盖**同版本重装**：已加载 iframe 的版本、入口、包 SHA-256 或授权集合任一变化（`DeviceDockPluginRpc.pluginChanged`）就销毁旧 iframe、等资源收尾完成后再加载新确认的包；不能让旧代码继续拿新能力表授权。
- `protocol.read` 的 `protocol.info` / `protocol.call` 经 `serialLanes.callInIsolatedLane`（内部 `inLane`）换入该路协议与该路实时 `skSession` 的**快照拷贝**（用完即丢，不回写）/ 隔离 ansi 状态：解析能读到这一路已有的基准水量，但插件传入的字节改动不了实时会话，双路 A/B 不串；`inLane` 里只跑同步代码，协议函数返回 thenable 一律以 `unsupported_async` 拒绝（异步实现不能等隔离上下文退出后继续跑）。
- `native` 插件是预留给需要本地可执行文件场景的扩展类型（`manifest.json` 保留 `kind:"native"` 与 `native` 字段校验，当前安装阶段拒绝落地并提示尚未开放）：**一旦启用本地子进程，它就是操作系统级本地进程，`capabilities` 声明对它只是宿主桥层的权限列表，不是操作系统沙箱**，不要把 `capabilities` 当成对本地二进制的沙箱承诺。

## 宿主 API 与能力表

- `device.read`：`device.listPorts`（在位/已授权串口的文档内 `key`、口名、产品名、别名、VID/PID、序列号、当前归属与占用者）、`device.listBle`、`device.listClassic`、`device.bleScan`（启停 BLE 扫描，插件关闭时自动停止）、`device.lanes`（当前可见的 `S` 或 `A`/`B` 路连接态、协议、参数、端口信息）；宿主向拥有该能力的插件推送 `device.ports`（热插拔/列表变化）与 `device.lane`（通道连接态变化）事件。
- `serial.io`：`serial.write({ lane, bytes })`（向当前可见且已打开的 `S`/`A`/`B` 路写入字节数组或十六进制串，单次上限 64 KiB）；宿主经 `window.serialByteTap` 向拥有该能力的插件实时推送 `serial.rx` 与 `serial.tx`（`{ lane, at, bytes }`）。
- `serial.claim`：`claim.acquire({ portKey, mode })`（声明 `exclusive` 或 `shared` 占用某个串口，登记到 `window.serialPortClaims`，宿主的 `SerialHub.busyOwnerOfPort`、选口冲突提示「该口已被插件『…』占用」与热插拔 `findRebindSession` 都认这个声明）、`claim.release`、`claim.list`、`claim.open` / `claim.close` / `claim.write`（直接读写被插件占用的端口，收到的数据以 `claim.rx` 事件推给该插件）。
- `protocol.read`：`protocol.info({ lane })`（读取该路当前协议 id、名称、`fields` 与 `queries`）、`protocol.call({ lane, fn, args })`（调用协议的 `parseFrame` / `formatFrame` / `findFrame` / `metrics` / `buildRead` / `buildWrite` / `matchResponse` / `logView` / `byteMap` / `buildDownFrame`，返回值经 JSON 克隆剔除函数与 DOM 引用）；宿主推送 `protocol.frame` 事件。
- `log`：`log.write({ text })`（向宿主当前日志区写入带 `[插件名]` 前缀的系统行）、`log.recent({ count })`（读最近最多 500 行日志摘要）、`log.export`（导出当前日志纯文本）。
- `app`：`app.theme`（当前 `{ theme, tokens }`）、`app.platform`（系统、运行时、画像、通道数、应用版本与插件自身身份）、`app.busyAcquire({ label })` / `app.busyRelease({ busyId })`（注册/注销应用更新阻断源，`js/app-update.js` 的 `blockers` 会把插件持有的 busy 标签并入阻断原因，阻止更新下载与安装）、`app.storageGet` / `app.storageSet` / `app.storageRemove`（按插件 id 隔离在 `app_data_dir/plugins/<id>/storage.json`，最多 256 个键、单值 64 KiB，卸载插件时随目录一并删除）、`app.saveFile`、`app.dialog`（转调 `AppDialog.alert/confirm/prompt`）、`app.notify`。

## 主题、生命周期与令牌存储

- 主题同步：插件 iframe `load` 完成时宿主立即推送 `ready` 事件（内含初始 `{ theme: "light"|"dark", tokens }`，其中 `tokens` 为宿主 `:root` 上全部 `--*` CSS 变量的快照）；用户在宿主切换亮/暗色时，`MutationObserver` 监听 `html[data-theme]` 并实时向所有就绪插件推送 `theme-change` 事件；SDK（`sdk/devicedock-plugin.js`）默认在 `ready` 与 `theme-change` 时调用 `applyTheme()`，把 `data-theme` 与 `--*` 变量写到插件文档 `:root`。
- 左栏与排序：已启用且支持当前系统的插件在左侧导航栏 `#rail-plugins`（「插件」分组）下生成标签，没有可用插件时整段隐藏；支持鼠标拖拽排序与聚焦后 `Alt+↑` / `Alt+↓` 键盘排序，顺序持久化在 `localStorage.pluginOrderV1`。
- 停用、卸载与应用更新准备：停用或卸载插件、或者应用进入更新冻结阶段（`prepare`）时，宿主立即销毁对应插件的 iframe、执行并**等待**全部 `teardown` 回调（BLE 扫描的所有权在启动前就登记，停用时等 `stopScan` 与扫描任务真实收尾；teardown 失败**不吞掉**，与串口关闭失败一起记进 `pendingReleases`）。`serial.claim` 的串口走统一异步关闭：作废在飞 `open()`、**等在飞 `claim.write` 结束**（写流还被锁着时不能 close）、取消并等待持锁 reader 与读循环、再 `close()`，关闭串行化避免并发重试。普通 `claim.close` 不置 `cancelled`，同一声明之后还能重新 `claim.open`；停用才永久作废。释放失败保留占用声明与 busy 源，但**可重试**（管理面板「重试释放」、重开插件、更新屏障前各重试一次），不会永久占口或挡更新；一直失败时 `plugin-host.release()` 抛错让更新冻结失败，不提前放行。未完成 / 失败的释放期间不会为同一插件创建新 iframe。
- 示例发布工作流固定 `runs-on: ubuntu-24.04`，`actions/checkout@v7.0.1` / `actions/setup-node@v7.1.0`（均为 node24 运行时的稳定版本）。
- GitHub 令牌：用于访问私有插件仓库或提高 GitHub API 限额，由 Rust 经 `keyring` 存入系统钥匙串（macOS 登录钥匙串 / Windows 凭据管理器，service `DeviceDock`、account `github-token`），不写 `localStorage`、不写应用数据目录文件；前端只能查 `plugin_token_status`（`{ set: bool }`）、设置新值或清除，永远无法读回令牌明文。
