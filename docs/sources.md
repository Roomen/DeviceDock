# 来源目录和包安装

分别使用 protocol/plugin namespace。同一地址可登记为不同用途；同 namespace 的规范化地址不重复。GitHub 地址去掉 .git/尾斜线并规范大小写；拒绝凭据、查询、fragment、非 HTTPS 和非组织/仓库结构。来源更新失败保持原目录，损坏缓存恢复为空。

目录 schemaVersion=1，packages 数组每项：
```json
{"id":"org.example.protocol","kind":"protocol","version":"1.0.0","apiVersion":1,"platforms":["web","desktop"],"sha256":"<64 lowercase hex>","url":"https://example.org/immutable-package.json"}
```
plugin namespace 也接受 kind=firmware/transport。API、平台、版本、产物摘要和清单身份必须一致。固定版本不能被可变 latest 下载替换；HEAD 仅用来发现数据目录。没有执行安装脚本、npm hooks 或远端 import。原生动态库不在此交付模型内。

产物 JSON 是 `{manifest, files}`；files 的键是完整包相对路径，值是 base64 字节。每个相对 ESM 导入必须静态可发现、留在包内、出现在完整性表中；动态计算导入、裸依赖和外部 URL 被拒绝。Worker/WASM/其他资源需在相同表中，禁止符号链接和穿越。JSON 包大小限 44 MiB，解码资源限 32 MiB、500 个文件。

浏览器安装：校验完整包 → worker 再校验 → 内容摘要缓存 → 完成标记 → 保存已安装记录。完整相同缓存不覆盖。桌面安装：原生 HTTPS 下载校验产物摘要 → JS 图和文件校验 → 原生规范字节摘要/文件复核 → 暂存 → 原子重命名 → 记录 URL。自定义协议只返回对应摘要包的声明文件，每次读核对实际字节。

启用独立于安装。来源加包 ID 是设置命名空间；同 ID 不允许同时激活，用户明确选择来源和版本。原生模块加载与浏览器模块加载都不能真正卸载 ESM 代码，扩展必须清理资源。切换版本前先安全停用；失败恢复之前的激活版本。回退不会删除旧产物。删除安装记录保留缓存，方便离线恢复；磁盘空间回收当前需要用户清理应用缓存，不在活动扩展运行时删除。

参考实现：router-for-me/CLIProxyAPI revision `6db7d4b839d86c5b24e17bbe73bcd4db18ef1b1a` 的源/版本/清单/摘要/暂存机制。DeviceDock 使用浏览器 ESM 与独立 Rust shell，没有复制其 Go 原生动态库安装器、未验证备用下载或默认源回退。
