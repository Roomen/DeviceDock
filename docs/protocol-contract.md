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
- `def` 是规范化协议对象：现有字段 `name`、`parseFrame`、`formatFrame`、`logView`、`findFrame`、`byteMap`、`buildDownFrame`、`presets` 全部保留（`name` 与 `parseFrame` 必填，其余可空），另外可选：`fields`（字段目录，完整定义见下节）、`queries`（整包查询用例 `[{ key, name, queryId?, expectTag?, … }]`，协议自己认它的附加属性）、`metrics(frame)`（`[{ key, value }]` 数值点，供曲线面板）、`buildRead(field)` / `buildWrite(field, value)` / `buildQuery(query)` / `matchResponse(frame, request)` / `readField(frame, field)`（测试流程引擎用，见下节）、`session`（可选会话钩子 `{ prepare?, keepalive?, idleMs?, keepaliveTimeoutMs? }`）、`mountPanel(el, api)`（自定义面板，返回 dispose）。
- `type` 只接受 `uint8`、`uint16le`、`uint32le`、`int8`、`int16le`、`int32le`、`float32le`、`float64le`、`bcd`、`ascii`、`enum`、`bool`；`enum` 归一化成 `[{ value, label }]`。
- `tx`（v1 过渡期暴露的协议自带测试执行器）已随 P3 的通用流程引擎移除：宿主工具只吃 `fields` / `queries` / `buildRead` / `buildWrite` / `buildQuery` / `matchResponse` / `readField` / `session`，注册表不再规范化 `tx`，协议包里带 `tx` 会被当成普通附加属性忽略。

## fields 字段目录

- `fields` 是 `[{ key, name, type, unit?, min?, max?, step?, enum?, read?, write?, group?, chart?, … }]`；`key` 全目录唯一（`[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}`），宿主只认上面这些键，其余（如 SEK 的 `tag` / `fid` / `source` / `fillLen`）原样保留给协议自己。
- `read` / `write` 默认都是 true；`read: false` 表示这个字段没有可寻址的读请求（例如来自帧头的信号量），`write: false` 表示只读。测试流程的「读 / 写 / 回读比对」与批量配置的字段下拉按这两个开关过滤。
- `random` 是随机读写的**显式许可**：只有 `random: true` 才进随机读写，缺省（不写）与任何非布尔值都不进；非布尔值会拒绝注册。协议目录必须自己把安全字段（采样 / 上报周期 / 显示 / 告警阈值 / 日志级别这类可读回、可恢复、写错不断链也不驱动执行机构的）逐条标 `random: true`，密码 / 表号地址 / IP·APN / 通信参数 / 时钟 / 复位类一律不标。批量配置不受影响（用户手动挑字段）。
- `chart: true` 标记「曲线上默认显示」的字段；曲线面板首次打开按它出默认勾选，用户仍可勾任意有 `metrics` 的字段。
- 数值字段的 `unit` 是曲线的 Y 轴分组依据：一个单位一根轴，最多两根，第三种单位整组不画。`min` / `max` / `step` 同时是随机读写取值的量程。
- 字段表文档由 `tools/protocol-fields-doc.mjs` 从 `fields` 生成（见「字段文档」节），协议作者不要手写。

## 构帧与应答钩子（测试流程引擎）

- `buildRead(field)`、`buildWrite(field, value)`、`buildQuery(query)` 都返回 `{ bytes, request }`：`bytes` 是整帧下行字节（数组或 Uint8Array），`request` 是协议自己定义的不透明凭证，宿主只负责「发 `bytes`、等应答、拿 `request` 去匹配」，不认识帧格式。构不出来（例如该字段没有读地址）返回 null，宿主按「不支持」记。
- `matchResponse(frame, request)` 收到解析后的上行帧：返回 `false` 表示「不是这条请求的应答，继续等」，`true` 表示成功，`{ ok: false, message?, code?, unsupported? }` 表示失败应答（`unsupported: true` 用于「设备不支持该字段」这类不算失败的结果）。
- `readField(frame, field)` 从应答帧里取该字段的原始字节（数组或 null），回读比对由引擎按 `type` 解码（bcd 比数字串、ascii 比到第一个 0x00、数值按类型解码），协议不用自己实现相等判断。
- `session` 是可选的会话钩子：`prepare()` 运行前做一次连通检查（失败整轮不跑），`keepalive()` 在空闲超过 `idleMs`（默认 20 s）后由引擎自动调用，等待窗口 `keepaliveTimeoutMs`（默认 4 s）。它们同样返回 `{ bytes, request }`，引擎不认识内容。红外 / 载波这类「不发就被断开」的链路层前置就写在这里，不要让引擎或面板写协议特判。
- 引擎不得依赖 `window.sekTx` 或任何协议帧格式；协议自己也不要把 SEK 语义暴露进这几个钩子之外的字段。

## 曲线（metrics）

- 曲线由宿主统一画图（uPlot，工作台「曲线」面板）：协议在 `metrics(frame)` 里把解析结果换算成 `[{ key, value, unit? }]` 数值点，`key` 对应 `fields` 里的字段，`value` 必须是最终数值（换算、缩放、基准水量都在协议里完成），非数值点会被丢弃；点可带可选 `unit` 覆盖字段目录的单位——`fields.unit` 保持原始编码单位（如 0.01V，写入按原始值）而曲线显示工程单位（V）时用。
- 只收实时帧：宿主在每路的实时日志路径上同步调 `metrics`（按路换入该路的协议与解析状态），历史日志重放不灌入曲线——重放会按行序把几天前的点重新塞回时间序列，既没有时间意义，也会在分批重渲时冲掉实时数据。
- 协议没有 `metrics` 或 `fields` 时曲线面板显示原因提示，不画图；协议不需要为此提供任何绘图代码。

## 字段文档

- `tools/protocol-fields-doc.mjs`（无依赖）从协议的 `fields` 生成 Markdown 字段表：内置 SEK 用 `--sek`（VM 加载 `js/sek-test-profile.js`），外部协议传 bundle 入口与协议 id（`node tools/protocol-fields-doc.mjs <entry> <id>`），生成器 `import` bundle 并调用 `activate(host stub)` 取注册对象的 `fields`——与页面同一条入口，不要在 manifest 或文档里另抄一份目录。
- 生成：`node tools/protocol-fields-doc.mjs --sek > docs/protocols/sek-fields.md`；比对：加 `--check <文件>`，内容不一致退出 1。`tests/protocol-fields-doc.cjs` 对 SEK 与示例仓库各做一次生成比对，改了 `fields` 不重新生成文档时测试会失败。
- **外部协议仓库应在自己的 CI 里对同样的入口跑同样的生成与比对**（把生成命令与 `--check` 写进仓库的 CI 脚本），保证仓库里的字段文档永远与 bundle 一致；示例见 `examples/protocol-repo/`（`docs/demo-a5frame-fields.md` + `tools/` 里的摘要刷新）。
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
- 启动登记 pending 时同时记下完整 id 列表；启动加载失败或来源在加载期间被删除，按这份列表 `settle`，不能靠「再找一次来源」清理（来源没了会永久残留）。

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
- 刷新进行中不允许对同一来源启动启用（服务层拒绝，面板同时禁用开关）；刷新替换目录会作废旧操作，启用提交前还会核对包版本 / 入口摘要 / 清单身份，换过就拒绝。
- 入口模块有顶层 await 时，`import` 返回、调用 `activate` 之前再确认一次来源与版本；已取消就不再调用 `activate`（已开始求值的模块代码无法撤回）。
- 刷新来源时，已启用包的版本或入口摘要变了就自动停用并在面板里提示「需要重新信任」，不要静默换成新版本。
- 删除来源、刷新来源、停用包、撤销信任都会作废正在进行的启用（代次检查），慢下载 / 慢 `activate` 不能在来源没了之后落地。
- 读写 localStorage / IndexedDB 全部 try/catch：缓存写失败不影响本次启用，存储不可用时只是不持久化。
- 离线启动只用缓存启用；缓存缺失时如实报「本机没有该版本的缓存」，不要偷偷联网下载。

## 平台

- 外部协议只在桌面画像可用；移动画像沿用 `platformAllowsProtocol`（只有 `sek`），管理入口（配置 →「协议来源…」）在移动端隐藏，不要在移动端加载或列出外部协议。

## 内置协议

- `sek` / `cjt188` / `sk-ultrasonic` 经同一条规范化路径注册（`js/common.js` 的 `registerProtocol` → `js/protocol-registry.js`），解析行为不变。
- SEK 的字段目录、查询用例、构帧钩子、`metrics` 与会话钩子都在 `js/sek-test-profile.js`：可写字段由下行预设（`0x01` 且带单值 param）派生，只读字段来自 `SK_TAGS` 里单位明确的数值项，帧头信号（RSRP / SNR / CSQ / ECL）来自解析结果。测试流程（批量配置 / 随机读写）与曲线从当前协议读 `fields` / `queries` / `buildRead` / `buildWrite` / `buildQuery` / `matchResponse` / `readField` / `session` / `metrics`，协议不支持时给「未提供字段目录 / 构帧钩子」提示；不要再往这两个工具里写死协议数据。
- CJ/T 188 没有稳定的读写字段目录（数据标识按命令走、没有统一量程），`fields` 留空，测试流程与曲线面板在 188 下按「未提供字段目录」处理，卡片沿用旧行为直接隐藏。

## 宿主工具

- 曲线面板（工作台 `curves`，`js/curves-core.js` + `js/curves.js` + `js/curves-panel.js`）：环形缓冲每序列默认 5000 点（面板可调 100–50000，存 `serialCurvesModern`），按「路 / 字段」隔离（S / A / B 各自的协议与状态），字段按单位分轴（最多两根），A 青 / B 琥珀 / 单路 accent 只从 CSS 变量取色。交互：字段选择（协议标了 `chart: true` 的默认勾选）、暂停 / 继续、清空、缩放后复位、悬停读数（等宽数字）、导出 CSV。
- 测试流程面板（工作台 `flow`，`js/test-flow.js` 纯逻辑 + `js/test-flow-panel.js` 界面）：步骤 `{ kind: 'read'|'write'|'verify'|'wait'|'send-raw', field?, value?, raw?, query?, expect?, delayAfterMs?, timeoutMs?, retries?, verify? }` + 全局默认（延时 / 超时 / 重试 / 失败策略 / 恢复原值）。批量配置：从字段目录挑可写字段、填值（`{n}` 替换为产线计数，bcd 字段支持逐台步进）、上下移排序、写后回读，保存为命名流程（`testFlowFlowsV1`）可导入导出 JSON；随机读写：按量程 / 枚举随机生成 N 步（seed 可复现，`{n}` 之外支持 `randomValue` 运行时取值），写过的字段末尾按比例抽检。运行时钉扎主发路，串口收发走 `serialApi.writeRaw` + 面板的按协议匹配泵，不另开串口、不碰 `sekTx`。
- 流程结果每步记录请求帧、应答帧、耗时、状态（成功 / 失败 / 超时 / 不匹配 / 不支持 / 跳过）与原因，可导出 JSON / CSV；产线计数存 sessionStorage（`sk-batch-state.index`，按实例隔离），编辑中的流程存 localStorage（`sk-batch-state`）。

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
