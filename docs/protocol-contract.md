# 协议契约 v1

外部协议包、目录、信任与缓存的实际做法；只写现状、禁止项和坑。

## 包与清单

- 一个协议包 = 一个 ESM **单文件 bundle**（`entry`）+ 一份 `manifest.json`，bundle 里不能有包内相对 `import`：宿主用 Blob URL `import()` 加载，Blob URL 无法解析相对路径，带相对依赖的包会在加载时直接失败。
- `manifest.json` 字段：`schemaVersion:1`、`kind:"protocol"`、`runtime:"js"`、`apiVersion:1`、`id`（`^[a-z0-9][a-z0-9._-]{0,63}$`）、`name`、`version`（精确 SemVer，不接受预发布 / 构建后缀）、`entry`（包内相对路径，`.js`/`.mjs`）、`integrity`（`{ "<包内路径>": "sha256-<64 位小写十六进制>" }`，必须含 `entry`）、`provides`（`[{ id, name, description? }]`，1–64 项、id 唯一）、`license`（非空字符串）、`platforms?`（`web` / `desktop` / `mobile` 的子集）。
- `runtime` 只接受 `js`；`lua` 是预留值，现在遇到就报「不支持的 runtime」，不要静默忽略或当成 js。
- `apiVersion` 只接受 `1`；不认识的版本直接拒绝，不要尝试向后兼容。
- `platforms` 的 `web` = 浏览器运行时，`desktop` = 桌面客户端（Tauri），`mobile` = 移动画像；省略表示不限。
- 包内路径只允许相对路径：不能以 `/` 开头、不能有 `\`、协议前缀、`?`、`#`、百分号编码、`.` / `..` 段；校验见 `js/protocol-contract.js` 的 `isSafePath`。
- 清单与目录里除上面这些键以外的顶层字段会被丢弃，不要往清单里塞运行参数。

## 入口

- bundle 必须 `export function activate(host)`；`host.registerProtocol(def)` 每调用一次注册一个协议，返回宿主使用的完整 id。
- `def` 是规范化协议对象：现有字段 `name`、`parseFrame`、`formatFrame`、`logView`、`findFrame`、`byteMap`、`buildDownFrame`、`presets` 全部保留（`name` 与 `parseFrame` 必填，其余可空），另外可选：`fields`（字段目录 `[{ key, name, unit?, type, read?, write?, min?, max?, step?, enum?, group? }]`，协议可以带自己的附加属性，例如 SEK 的 `tag` / `fid`）、`queries`（整包查询用例，随机读写测试用）、`metrics(frame)`（`[{ key, value }]` 数值点，供曲线面板）、`buildRead(field)` / `buildWrite(field, value)` / `matchResponse(frame, request)`（供测试流程引擎）、`mountPanel(el, api)`（自定义面板，返回 dispose）、`tx`（协议自带的测试执行器，见下）。
- `type` 只接受 `uint8`、`uint16le`、`uint32le`、`int8`、`int16le`、`int32le`、`float32le`、`float64le`、`bcd`、`ascii`、`enum`、`bool`；`enum` 归一化成 `[{ value, label }]`。
- `tx` 是给宿主测试工具（随机读写、批量配置）用的过渡执行器，必须同时提供 `queryById`、`readTag`、`writeRaw`、`readItem`、`bytesEqual`、`hasTag`、`reset`、`cancel`；v1 只有内置 SEK 提供，P3 的通用流程引擎改吃 `buildRead` / `buildWrite` / `matchResponse` / `metrics`。
- `activate` 必须同步完成注册（不要注册到 `setTimeout` / `fetch` 回调里）；宿主在 `activate` 返回后核对 id，晚注册的 id 会被当成「多出」而整包卸载。
- `activate` 抛错、超过 15 s、或没有导出 `activate`，整包按失败处理，什么都不会注册。
- 注册先进暂存区：`activate` 返回、`provides` 核对通过后才一次性发布；注册窗口在 `activate` 返回 / 抛错 / 超时后立即关闭，包再用定时器调 `registerProtocol` 会被拒绝。
- 同一来源里两个包声明同一个协议 id 会被拒绝（`协议 id 已被另一个协议包占用`），后发布的包不会覆盖前一个，失败回滚也只删本次注册。

## 多协议仓库

- 仓库根目录（或 `/tree/<ref>/<子目录>` 指定的目录）放 `catalog.json`：`{ schemaVersion:1, name, packages:[{ manifest:"<相对路径>/manifest.json", sha256:"<manifest 文件摘要>" }] }`。
- 读目录与清单**不执行代码**：宿主只下载 `catalog.json` 与各 `manifest.json`，校验摘要后就能列出仓库里全部协议（来自 `provides`）。
- 启用某个包时：校验清单摘要 → 下载 `entry` 并按 `integrity` 校验 → Blob URL `import()` → 调用 `activate`；入口与其它包内路径一律**相对该包的 manifest 解析**（GitHub 上 manifest 常在自己的子目录里，按仓库根拼会 404）。
- 实际注册的 id 集合必须与 `provides` **严格相等**，多一个少一个都拒绝并卸载整包，错误信息列出多出 / 缺少的 id。
- 一个包可以声明多个协议；一个仓库可以有多个包（示例见 `examples/protocol-repo/`）。

## 命名空间与下拉框

- 外部协议在注册表里的 id 是 `<来源键>/<协议 id>`；来源键由 URL 推出：GitHub 是 `github.com/<owner>/<repo>`（小写），直连是 origin + 目录路径。
- `#serial-protocol-select` 用 `<optgroup>`：「内置」组放 `sek` / `cjt188` / `sk-ultrasonic`，每个来源一组（组名取目录 `name`）；每路连接栏的协议键照抄同样的分组，不要在模块里自己插 `<option>`。
- 存下的协议指向未启用 / 已删除的外部协议时回退 `sek`（`window.normalizeProtocolSelection`），单路 S 在双路期间单独保存的选择也要一起归一化；已启用但还在加载的 id 由注册表登记为 pending，启动时不会误判为未知。

## 来源 URL

- GitHub 仓库：`https://github.com/<owner>/<repo>`，可带 `@<ref>` 或 `/tree/<ref>[/<子目录>]`，`.git` 后缀与末尾斜杠都可；宿主用 `api.github.com/repos/<o>/<r>/commits/<ref>` 解析到具体 commit sha，再从 `raw.githubusercontent.com/<o>/<r>/<sha>/…` 取目录与文件（固定 sha = 内容不可变）。
- 直接地址：`catalog.json` 或单个 `manifest.json` 的 URL，需要目标站点允许 CORS；只接受 HTTPS，本机 `localhost` / `127.0.0.1` / `[::1]` 例外允许 http（示例仓库用 `python3 -m http.server` 自测）。
- GitHub API 未认证限额是每小时 60 次：限额用完时提示「可在地址后加 @<40 位提交 SHA>」，直接给 40 位 sha 会跳过 API；已缓存的来源在限额期间仍可离线启用，不要靠自动重试硬撞限额。
- 错误一律中文、就地显示：CORS / 网络不可达、404、HTTP 状态、清单摘要不符、入口摘要不符、id 与 provides 不符、runtime 不支持、apiVersion 不支持、平台不支持。

## 信任与缓存

- 添加来源、刷新、列出包都**不执行代码**；只有用户逐包点「信任此版本」并打开「启用」才会加载入口字节。
- 信任键 = 来源 + 包 id + 版本 + 入口摘要（`js/protocol-contract.js` 的 `trustKey`）；换版本、换来源、换字节都不继承旧决定。
- 来源列表、信任、启用状态存 localStorage（`protocolSourcesV1` / `protocolTrustV1` / `protocolEnabledV1`）；已校验的字节按 sha256 存 IndexedDB `devicedock-protocols`（`files` 表，最多 32 份 / 16 MiB，按最近写入淘汰）。
- 从缓存启用前也按摘要复核内容：缓存键不能证明内容正确，不符就丢弃缓存并拒绝执行（离线时同样不能执行未校验字节）。
- 刷新来源时，已启用包的版本或入口摘要变了就自动停用并在面板里提示「需要重新信任」，不要静默换成新版本。
- 删除来源、刷新来源、停用包、撤销信任都会作废正在进行的启用（代次检查），慢下载 / 慢 `activate` 不能在来源没了之后落地。
- 读写 localStorage / IndexedDB 全部 try/catch：缓存写失败不影响本次启用，存储不可用时只是不持久化。
- 离线启动只用缓存启用；缓存缺失时如实报「本机没有该版本的缓存」，不要偷偷联网下载。

## 平台

- 外部协议只在桌面画像可用；移动画像沿用 `platformAllowsProtocol`（只有 `sek`），管理入口（配置 →「协议来源…」）在移动端隐藏，不要在移动端加载或列出外部协议。

## 内置协议

- `sek` / `cjt188` / `sk-ultrasonic` 经同一条规范化路径注册（`js/common.js` 的 `registerProtocol` → `js/protocol-registry.js`），解析行为不变。
- SEK 的字段目录、查询用例、tag→查询映射与测试执行器在 `js/sek-test-profile.js`，随机读写与批量配置从当前协议读 `fields` / `queries` / `presets` / `tx`，协议不支持时给「当前协议未提供字段目录 / 配置项目录」提示；不要再往这两个工具里写死协议数据。
- CJ/T 188 没有稳定的读写字段目录（数据标识按命令走、没有统一量程），`fields` 留空，随机读写与批量配置在 188 下按「未提供字段目录」处理。

## 管理界面

- 入口在左栏「配置」菜单 →「协议来源…」：来源是应用级设置（和导入 / 导出 / 重置同类），不属于某一路串口，也不该占主视图；面板用 `AppDialog.panel`，与 MCP 服务面板同一套模态外壳。
- 面板内容：添加 URL、刷新、删除（面板内两步确认，不嵌套 `AppDialog.confirm`）、每个来源列出包 / provides / 版本 / 摘要前 12 位 / 来源 sha、每包「信任此版本」与「启用」开关、错误就地显示。
- 界面遵守 AGENTS.md 的令牌、7 档字号、无裸 hex、无 `transition: all`、lucide 图标与亮 / 暗一致；外部文本一律 `textContent`。

## 安全边界

- 外部协议与页面同源执行，能拿到页面的全部权限（串口、存储、网络）：**信任只是用户确认，不是沙箱**；只添加你信任的仓库，摘要只保证传输内容与已信任版本一致，不证明作者可信。
- 不要自动添加来源、不要自动信任、不要在移动端或后台偷偷启用；所有启用动作必须由用户点击触发。

## 示例仓库与本地验证

- `examples/protocol-repo/` 是一个可直接托管的仓库：`catalog.json` + 一个包含两个协议的包（`demo.a5frame` / `demo.modbus-rtu`）。
- 本地验证：在仓库根目录运行 `python3 -m http.server 8000`，页面「配置 → 协议来源…」添加 `http://localhost:8000/examples/protocol-repo/catalog.json`，信任并启用后下拉出现「DeviceDock 示例协议」组。
- 示例帧：`A5 03 01 0A 0B 0C AA`（A5 帧）、`01 03 04 00 0A 00 0B 9B F6`（Modbus 应答），粘到协议解析的 HEX 输入区并把日志格式勾上「解析」。
- 改过示例的入口或清单后重算摘要：`node examples/protocol-repo/tools/refresh-integrity.mjs`（无依赖）。
- 回归：`node tests/protocol-contract.cjs` 覆盖清单 / 目录校验、路径穿越、SemVer、URL 解析、命名空间、provides 一致、信任键与示例仓库摘要自洽。
