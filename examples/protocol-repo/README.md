# examples/protocol-repo

一个最小的外部协议仓库：根目录 `catalog.json`，一个包里两个协议（`demo.a5frame` / `demo.modbus-rtu`）。
契约见 `docs/protocol-contract.md`。

本地验证：

```sh
python3 -m http.server 8000          # 在仓库根目录起服务
```

页面「配置 → 协议来源…」添加：

```
http://localhost:8000/examples/protocol-repo/catalog.json
```

示例帧（粘贴到日志 HEX 输入区或发送框，日志格式勾上「解析」）：

```
A5 03 01 0A 0B 0C AA
01 03 04 00 0A 00 0B 9B F6
```

改过 `packages/demo/index.js` 或 `manifest.json` 后重算摘要：

```sh
node examples/protocol-repo/tools/refresh-integrity.mjs
```
