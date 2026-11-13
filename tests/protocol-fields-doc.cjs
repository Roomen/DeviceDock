// Run: node tests/protocol-fields-doc.cjs — synthetic data only.
// 字段文档与协议 fields 的一致性：SEK 与示例协议仓库各生成一份，与仓库里的文档逐字比对，
// 再抽查表格行（key / 类型 / 读写 / 曲线标记）。改 fields 而不重新生成文档时这里必须失败。
require('./i18n-env.cjs')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const TOOL = path.join(ROOT, 'tools/protocol-fields-doc.mjs')

function run(args) {
	return execFileSync(process.execPath, [TOOL].concat(args), { cwd: ROOT, encoding: 'utf8' })
}

// SEK：生成内容与 docs/protocols/sek-fields.md 一致
const sekMd = run(['--sek'])
const sekDoc = path.join(ROOT, 'docs/protocols/sek-fields.md')
assert.ok(fs.existsSync(sekDoc), 'docs/protocols/sek-fields.md 必须随仓库提交')
assert.equal(sekMd, fs.readFileSync(sekDoc, 'utf8'), 'SEK 字段文档与 js/sek-test-profile.js 的 fields 不一致，重新生成：node tools/protocol-fields-doc.mjs --sek > docs/protocols/sek-fields.md')
assert.match(sekMd, /rw-t3-0.*过流告警阈值.*uint32le.*L\/h.*1 ~ 50000 \| RW/, '字段表行内容')
assert.match(sekMd, /\| `m-batt-comm` \|/, '曲线用的只读字段也在表里')
assert.match(sekMd, /m-rsrp.*✓/, '帧头信号字段标了曲线')
assert.match(sekMd, /字段 \d+ 项/, '头部统计')
// 随机列：危险字段 random:false 标 —（SN 密钥 / 表号 / IP 等），普通字段 ✓；unit 保持原始编码单位
assert.match(sekMd, /\| `rw-t3-4` \| 电压告警阈值 \| `uint16le` \| 0\.01V \|/, '原始编码单位保留在 fields.unit')
assert.match(sekMd, /\| `w-t3-16-ascii` \| 设置SN密钥 \|.*— \|/, '危险字段随机列标 —')
assert.match(sekMd, /随机列为 — 表示 `random: false`/, '脚注说明')

// --check 模式：一致退出 0，被篡改退出非 0
const check = execFileSync(process.execPath, [TOOL, '--sek', '--check', sekDoc], { cwd: ROOT, encoding: 'utf8' })
assert.match(check, /fields doc check ok/)
const tampered = path.join(ROOT, 'docs/protocols', 'sek-fields.bad.md')
fs.writeFileSync(tampered, sekMd.replace('过流告警阈值', '别的名字'))
let failed = false
try {
	execFileSync(process.execPath, [TOOL, '--sek', '--check', tampered], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
} catch (e) { failed = true }
assert.ok(failed, '文档被改后 --check 必须失败')
fs.unlinkSync(tampered)

// 示例协议仓库：bundle 的 activate 产出 fields，文档与之一致
const bundle = path.join(ROOT, 'examples/protocol-repo/packages/demo/index.js')
const exampleMd = run([bundle, 'demo.a5frame'])
const exampleDoc = path.join(ROOT, 'examples/protocol-repo/docs/demo-a5frame-fields.md')
assert.ok(fs.existsSync(exampleDoc), '示例仓库的字段文档必须随仓库提交')
assert.equal(exampleMd, fs.readFileSync(exampleDoc, 'utf8'), '示例协议字段文档与 bundle 不一致，重新生成：node tools/protocol-fields-doc.mjs examples/protocol-repo/packages/demo/index.js demo.a5frame > examples/protocol-repo/docs/demo-a5frame-fields.md')
assert.match(exampleMd, /a5-voltage.*A5 电压.*uint16le.* V \|.*✓/, '示例字段行带曲线标记（电压已是工程单位 V）')

// bundle 未提供 fields 时报错退出（提示协议作者补 fields，而不是生成空表）
let threw = false
try {
	run([bundle, 'demo.modbus-rtu'])
} catch (e) { threw = true }
assert.ok(threw, '没有 fields 的协议必须报错而不是生成空文档')

console.log('protocol-fields-doc: ok')