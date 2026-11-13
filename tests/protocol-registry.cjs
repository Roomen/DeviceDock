// Run: node tests/protocol-registry.cjs
// 协议注册表（js/protocol-registry.js）的纯逻辑回归：内置 / 外部同一张表、下拉分组、
// pending 登记（启动时未知协议回退不能清掉还没加载完的外部协议）、extend 与卸载。
'use strict'
const assert = require('node:assert/strict')
const path = require('node:path')

globalThis.window = globalThis
globalThis.document = { dispatchEvent: function () {}, addEventListener: function () {} }
require(path.join(__dirname, '../js/protocol-contract.js'))
require(path.join(__dirname, '../js/protocol-registry.js'))

const P = globalThis.DeviceDockProtocols
const def = (name) => ({ name: name, parseFrame: function () { return {} } })

P.register('sek', def('SEK'))
P.register('cjt188', def('188协议'))
assert.deepEqual(P.ids(), ['sek', 'cjt188'])
assert.deepEqual(P.groups().map(g => g.label), ['内置'])
assert.equal(P.get('sek').name, 'SEK')
assert.equal(P.has('sek'), true)
assert.equal(P.has('nope'), false)

// 已启用、字节还没加载完的外部协议：登记 pending，启动时的「未知协议回退」不能把它当未知
P.expect('github.com/o/r/demo.a5')
assert.equal(P.isPending('github.com/o/r/demo.a5'), true)
assert.equal(P.isKnownOrPending('github.com/o/r/demo.a5'), true)
assert.equal(P.isKnownOrPending('github.com/o/r/other'), false)
P.settle('github.com/o/r/demo.a5')
assert.equal(P.isKnownOrPending('github.com/o/r/demo.a5'), false)

// 外部协议：命名空间 id + 分组 + 元数据
P.registerExternal('github.com/o/r', 'demo.a5', { id: 'demo.a5', name: 'A5 帧', parseFrame: function () { return {} } }, {
	sourceName: '示例协议', packageId: 'demo.protocols', version: '1.0.0', digest: 'a'.repeat(64),
})
assert.ok(P.has('github.com/o/r/demo.a5'))
assert.deepEqual(P.groups().map(g => g.label), ['内置', '示例协议'])
assert.deepEqual(P.groups()[1].items, [{ id: 'github.com/o/r/demo.a5', name: 'A5 帧' }])
const meta = P.meta('github.com/o/r/demo.a5')
assert.equal(meta.builtin, false)
assert.equal(meta.source, 'github.com/o/r')
assert.equal(meta.packageId, 'demo.protocols')
assert.equal(meta.version, '1.0.0')

// 同一来源里两个包声明同一个协议 id：后一个不能覆盖前一个（失败回滚也不会删掉前一个）
P.registerExternal('github.com/o/r', 'demo.dup', { id: 'demo.dup', name: 'Dup A', parseFrame: function () {} }, {
	packageId: 'pkg.a', version: '1.0.0', digest: 'b'.repeat(64),
})
assert.throws(() => P.registerExternal('github.com/o/r', 'demo.dup', { id: 'demo.dup', name: 'Dup B', parseFrame: function () {} }, {
	packageId: 'pkg.b', version: '1.0.0', digest: 'c'.repeat(64),
}), /已被另一个协议包占用/)
assert.equal(P.get('github.com/o/r/demo.dup').name, 'Dup A')
// 同一个包重新注册（升级 / 重载）允许覆盖自己的注册
P.registerExternal('github.com/o/r', 'demo.dup', { id: 'demo.dup', name: 'Dup A2', parseFrame: function () {} }, {
	packageId: 'pkg.a', version: '1.0.1', digest: 'd'.repeat(64),
})
assert.equal(P.get('github.com/o/r/demo.dup').name, 'Dup A2')
P.unregister('github.com/o/r/demo.dup')

// 晚补充字段目录（SEK 的 js/sek-test-profile.js 就是这么接进来的）
assert.equal(P.get('sek').fields.length, 0)
P.extend('sek', { fields: [{ key: 'rssi', name: '信号', type: 'int16le' }], queries: [{ key: 'q1', name: '查询' }] })
assert.equal(P.get('sek').fields.length, 1)
assert.equal(P.get('sek').queries.length, 1)
assert.equal(P.extend('nope', { fields: [] }), null)

// 非法协议对象不会进表
assert.throws(() => P.register('bad', { name: 'x' }), /parseFrame/)
assert.equal(P.has('bad'), false)

P.unregister('github.com/o/r/demo.a5')
assert.equal(P.has('github.com/o/r/demo.a5'), false)
assert.deepEqual(P.groups().map(g => g.label), ['内置'])

console.log('protocol-registry: ok')
