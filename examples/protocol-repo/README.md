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

## 字段目录与文档

`demo.a5frame` 带 `fields`（字段目录）与 `metrics(frame)`（数值点）：上行帧数据域前 2 字节是
uint16 LE 电压 0.01V，接着 2 字节是 uint16 LE 瞬时流量 L/h，宿主的「曲线」面板据此出图。
字段表文档在 `docs/demo-a5frame-fields.md`，由宿主仓库的工具从 bundle 生成：

```sh
node tools/protocol-fields-doc.mjs examples/protocol-repo/packages/demo/index.js demo.a5frame > examples/protocol-repo/docs/demo-a5frame-fields.md
```

外部协议仓库应在自己的 CI 里跑同样的生成与比对（加 `--check <文件>`，内容不一致退出 1），
保证文档永远与 bundle 一致；`tests/protocol-fields-doc.cjs` 是宿主侧的参照实现。
