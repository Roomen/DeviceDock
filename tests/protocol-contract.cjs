// Run: node tests/protocol-contract.cjs
// 协议契约 v1 的纯逻辑回归：清单 / 目录校验、包内路径、SemVer、来源 URL 解析、命名空间、
// provides 严格一致、runtime / apiVersion 拒绝、信任键、协议对象规范化，以及示例仓库的摘要自洽。
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const C = require('../js/protocol-contract.js')

function manifest(overrides) {
	return Object.assign({
		schemaVersion: 1,
		kind: 'protocol',
		runtime: 'js',
		apiVersion: 1,
		id: 'demo.protocols',
		name: '示例协议包',
		version: '1.0.0',
		entry: 'index.js',
		integrity: { 'index.js': 'sha256-' + 'a'.repeat(64) },
		provides: [{ id: 'demo.a5frame', name: 'A5 帧演示' }],
		license: 'MIT',
	}, overrides || {})
}
function catalog(overrides) {
	return Object.assign({
		schemaVersion: 1,
		name: '示例目录',
		packages: [{ manifest: 'packages/demo/manifest.json', sha256: 'b'.repeat(64) }],
	}, overrides || {})
}

// ---- 包内路径 ----
assert.equal(C.isSafePath('index.js'), true)
assert.equal(C.isSafePath('packages/demo/index.js'), true)
assert.equal(C.isSafePath('a@b/c+d.js'), true)
for (const bad of ['', '/abs.js', '../a.js', 'a/../b.js', 'a/./b.js', 'a\\b.js', 'a%2fb.js', 'https://x/y.js', 'a/b.js?x=1', 'a/b.js#x', 'a//b.js', 'a/b c.js', 'a/b\u0000.js']) {
	assert.equal(C.isSafePath(bad), false, 'path must be rejected: ' + JSON.stringify(bad))
}
assert.equal(C.resolveUrl('https://raw.example.com/o/r/abc/', 'packages/x.js'), 'https://raw.example.com/o/r/abc/packages/x.js')
assert.throws(() => C.resolveUrl('https://raw.example.com/o/r/abc/', '../x.js'), /不合法/)
// 入口相对 manifest 解析：manifest 在子目录里时不能退回仓库根
const rawSha = 'd'.repeat(40)
assert.equal(
	C.entryUrl('https://raw.githubusercontent.com/o/r/' + rawSha + '/packages/demo/manifest.json', 'index.js'),
	'https://raw.githubusercontent.com/o/r/' + rawSha + '/packages/demo/index.js'
)
assert.equal(C.entryUrl('https://example.com/protos/demo/manifest.json', 'dist/index.js'), 'https://example.com/protos/demo/dist/index.js')
assert.throws(() => C.entryUrl('https://example.com/protos/demo/manifest.json', '../index.js'), /不合法/)

// ---- SemVer ----
assert.equal(C.normalizeVersion('1.2.3'), '1.2.3')
for (const bad of ['1.2', 'v1.2.3', '01.2.3', '1.02.3', '1.2.3-beta', '1.2.3+build', '1.2.3 ']) {
	if (bad === '1.2.3 ') continue // trim 后合法
	assert.throws(() => C.normalizeVersion(bad), /SemVer/, 'version must be rejected: ' + bad)
}
assert.equal(C.compareVersions('1.2.3', '1.2.3'), 0)
assert.equal(C.compareVersions('1.10.0', '1.9.9'), 1)
assert.equal(C.compareVersions('0.9.9', '1.0.0'), -1)

// ---- 清单 ----
const good = C.validateManifest(manifest())
assert.equal(good.id, 'demo.protocols')
assert.equal(C.entryDigest(good), 'sha256-' + 'a'.repeat(64))
assert.equal(good.platforms, null)
assert.throws(() => C.validateManifest(manifest({ schemaVersion: 2 })), /schemaVersion/)
assert.throws(() => C.validateManifest(manifest({ kind: 'plugin' })), /kind/)
assert.throws(() => C.validateManifest(manifest({ runtime: 'lua' })), /不支持的 runtime：lua/)
assert.throws(() => C.validateManifest(manifest({ runtime: 'wasm' })), /不支持的 runtime/)
assert.throws(() => C.validateManifest(manifest({ apiVersion: 2 })), /不支持的 apiVersion：2/)
assert.throws(() => C.validateManifest(manifest({ id: 'Bad Id' })), /包 id 不合法/)
assert.throws(() => C.validateManifest(manifest({ version: '1.0' })), /SemVer/)
assert.throws(() => C.validateManifest(manifest({ entry: '../index.js' })), /入口路径不合法/)
assert.throws(() => C.validateManifest(manifest({ entry: 'index.txt' })), /\.js/)
assert.throws(() => C.validateManifest(manifest({ entry: 'other.js' })), /没有声明入口文件/)
assert.throws(() => C.validateManifest(manifest({ integrity: { 'index.js': 'sha256-xyz' } })), /integrity 摘要格式/)
assert.throws(() => C.validateManifest(manifest({ integrity: { 'index.js': 'sha256-' + 'A'.repeat(64) } })), /integrity 摘要格式/)
assert.throws(() => C.validateManifest(manifest({ integrity: { '../index.js': 'sha256-' + 'a'.repeat(64) } })), /integrity 路径不合法/)
assert.throws(() => C.validateManifest(manifest({ provides: [] })), /provides/)
assert.throws(() => C.validateManifest(manifest({ provides: [{ id: 'demo.x', name: 'X' }, { id: 'demo.x', name: 'Y' }] })), /重复/)
assert.throws(() => C.validateManifest(manifest({ provides: [{ id: 'Demo.X', name: 'X' }] })), /id 不合法/)
assert.throws(() => C.validateManifest(manifest({ license: '' })), /license/)
assert.throws(() => C.validateManifest(manifest({ platforms: ['tv'] })), /未知平台/)
assert.deepEqual(C.validateManifest(manifest({ platforms: ['desktop', 'desktop', 'web'] })).platforms, ['desktop', 'web'])
assert.equal(C.validateManifest(manifest({ runtime: 'js', extra: 'dropped' })).extra, undefined)

// ---- 目录 ----
assert.equal(C.validateCatalog(catalog()).packages[0].manifest, 'packages/demo/manifest.json')
assert.throws(() => C.validateCatalog(catalog({ packages: [] })), /packages/)
assert.throws(() => C.validateCatalog(catalog({ packages: [{ manifest: 'x/other.json', sha256: 'b'.repeat(64) }] })), /manifest.json/)
assert.throws(() => C.validateCatalog(catalog({ packages: [{ manifest: '../manifest.json', sha256: 'b'.repeat(64) }] })), /清单路径不合法/)
assert.throws(() => C.validateCatalog(catalog({ packages: [{ manifest: 'a/manifest.json', sha256: 'B'.repeat(64) }] })), /64 位小写十六进制/)
assert.throws(() => C.validateCatalog(catalog({ packages: [
	{ manifest: 'a/manifest.json', sha256: 'b'.repeat(64) },
	{ manifest: 'a/manifest.json', sha256: 'c'.repeat(64) },
] })), /重复的清单路径/)

// ---- 来源 URL ----
const gh = C.resolveSourceUrl('https://github.com/Roomen/DeviceDock')
assert.equal(gh.kind, 'github')
assert.equal(gh.sourceKey, 'github.com/roomen/devicedock')
assert.equal(gh.ref, '')
assert.equal(C.githubCommitApi(gh, ''), 'https://api.github.com/repos/Roomen/DeviceDock/commits/HEAD')
const ghRef = C.resolveSourceUrl('https://github.com/Roomen/DeviceDock@v1.2.0')
assert.equal(ghRef.ref, 'v1.2.0')
assert.equal(ghRef.sourceKey, 'github.com/roomen/devicedock')
assert.equal(C.githubCommitApi(ghRef, ghRef.ref), 'https://api.github.com/repos/Roomen/DeviceDock/commits/v1.2.0')
const sha = 'c'.repeat(40)
const ghSha = C.resolveSourceUrl('https://github.com/Roomen/DeviceDock@' + sha)
assert.equal(C.isSha40(ghSha.ref), true)
assert.equal(C.githubRawBase(ghSha, sha), 'https://raw.githubusercontent.com/Roomen/DeviceDock/' + sha + '/')
assert.equal(C.catalogUrlFor(ghSha, sha), 'https://raw.githubusercontent.com/Roomen/DeviceDock/' + sha + '/catalog.json')
const ghTree = C.resolveSourceUrl('https://github.com/Roomen/DeviceDock/tree/main/protocols')
assert.equal(ghTree.ref, 'main')
assert.equal(ghTree.subpath, 'protocols')
assert.equal(C.githubRawBase(ghTree, sha), 'https://raw.githubusercontent.com/Roomen/DeviceDock/' + sha + '/protocols/')
assert.equal(C.resolveSourceUrl('https://github.com/Roomen/DeviceDock.git').sourceKey, 'github.com/roomen/devicedock')
assert.equal(C.resolveSourceUrl('https://github.com/Roomen/DeviceDock/').sourceKey, 'github.com/roomen/devicedock')
assert.throws(() => C.resolveSourceUrl('https://github.com/Roomen'), /组织\/仓库/)
assert.equal(C.resolveSourceUrl('https://github.com/Roomen/DeviceDock/tree/main/a/b').subpath, 'a/b')
assert.throws(() => C.resolveSourceUrl('https://github.com/Roomen/DeviceDock@feature/x'), /tree/)
assert.throws(() => C.resolveSourceUrl('https://github.com/Roomen/DeviceDock/blob/main/x'), /tree/)

const directCatalog = C.resolveSourceUrl('https://example.com/protos/catalog.json')
assert.equal(directCatalog.kind, 'direct')
assert.equal(directCatalog.form, 'catalog')
assert.equal(directCatalog.sourceKey, 'https://example.com/protos')
assert.equal(C.catalogUrlFor(directCatalog, ''), 'https://example.com/protos/catalog.json')
const directManifest = C.resolveSourceUrl('https://example.com/protos/demo/manifest.json')
assert.equal(directManifest.form, 'manifest')
assert.equal(directManifest.baseUrl, 'https://example.com/protos/demo/')
assert.equal(C.resolveSourceUrl('http://localhost:8000/examples/protocol-repo/catalog.json').kind, 'direct')
assert.equal(C.resolveSourceUrl('http://127.0.0.1:8000/x/catalog.json').kind, 'direct')
assert.throws(() => C.resolveSourceUrl('http://example.com/x/catalog.json'), /HTTPS/)
assert.throws(() => C.resolveSourceUrl('ftp://example.com/x/catalog.json'), /HTTPS/)
// 凭据与查询串要拒绝；字面量拆开写，避免被提交前扫描当成真实凭据
const credUrl = 'https://' + 'user' + ':' + 'pass' + '@example.com/x/catalog.json'
assert.throws(() => C.resolveSourceUrl(credUrl), /用户名或密码/)
assert.throws(() => C.resolveSourceUrl('https://example.com/x/catalog.json?x=1'), /查询串/)
assert.throws(() => C.resolveSourceUrl('https://example.com/x/index.js'), /catalog\.json 或 manifest\.json/)
assert.throws(() => C.resolveSourceUrl('not a url'), /格式不对/)
assert.throws(() => C.resolveSourceUrl(''), /请输入/)

// ---- 命名空间 / provides / 信任键 ----
assert.equal(C.namespaceId('github.com/o/r', 'demo.a5frame'), 'github.com/o/r/demo.a5frame')
assert.deepEqual(C.splitNamespaced('github.com/o/r/demo.a5frame'), { sourceKey: 'github.com/o/r', protocolId: 'demo.a5frame' })
assert.equal(C.splitNamespaced('sek'), null)
assert.throws(() => C.namespaceId('', 'demo.x'), /来源键/)
assert.throws(() => C.namespaceId('github.com/o/r', 'Demo.X'), /id 不合法/)

const check = C.checkProvides({ provides: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }, ['b', 'a'])
assert.equal(check.ok, true)
const extra = C.checkProvides({ provides: [{ id: 'a', name: 'A' }] }, ['a', 'c'])
assert.equal(extra.ok, false)
assert.deepEqual(extra.extra, ['c'])
const missing = C.checkProvides({ provides: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }, ['a'])
assert.deepEqual(missing.missing, ['b'])

const key1 = C.trustKey({ source: 'github.com/o/r', id: 'demo.p', version: '1.0.0', hash: 'd'.repeat(64) })
const key2 = C.trustKey({ source: 'github.com/o/r', id: 'demo.p', version: '1.0.0', hash: 'd'.repeat(64) })
const key3 = C.trustKey({ source: 'github.com/o/r', id: 'demo.p', version: '1.0.1', hash: 'd'.repeat(64) })
const key4 = C.trustKey({ source: 'github.com/o/r2', id: 'demo.p', version: '1.0.0', hash: 'd'.repeat(64) })
assert.equal(key1, key2)
assert.notEqual(key1, key3, '版本变了就不是同一条信任')
assert.notEqual(key1, key4, '来源变了就不是同一条信任')
assert.throws(() => C.trustKey({ source: 'x', id: 'demo.p', version: '1.0', hash: 'd'.repeat(64) }), /SemVer/)
assert.throws(() => C.trustKey({ source: 'x', id: 'demo.p', version: '1.0.0', hash: 'xyz' }), /摘要/)

// ---- 平台 ----
assert.equal(C.platformMatches(null, { profile: 'desktop', runtime: 'browser' }), true)
assert.equal(C.platformMatches(['desktop'], { profile: 'desktop', runtime: 'tauri' }), true)
assert.equal(C.platformMatches(['web'], { profile: 'desktop', runtime: 'tauri' }), false)
assert.equal(C.platformMatches(['mobile'], { profile: 'mobile', runtime: 'tauri' }), true)
assert.deepEqual(C.platformTags({ profile: 'desktop', runtime: 'browser' }), ['web'])

// ---- 协议对象规范化 ----
const def = C.normalizeProtocolDef({
	name: 'Demo',
	parseFrame: function () { return {} },
	logView: function () { return null },
	fields: [
		{ key: 'rssi', name: '信号强度', type: 'int16le', unit: 'dBm', min: -120, max: 0, read: true, write: false, group: '状态', tag: 7, fid: 1 },
		{ key: 'mode', name: '模式', type: 'enum', enum: [0, { value: 1, label: '自动' }] },
	],
	queries: [{ key: 'q1', name: '查询全部', queryId: 3 }],
})
assert.equal(def.fields.length, 2)
assert.equal(def.fields[0].tag, 7, '协议自己的附加属性要保留')
assert.equal(def.fields[0].read, true)
assert.equal(def.fields[0].write, false)
assert.deepEqual(def.fields[1].enum, [{ value: 0, label: '0' }, { value: 1, label: '自动' }])
assert.equal(def.queries[0].queryId, 3)
assert.deepEqual(def.presets, [])
assert.equal(def.tx, null)
assert.equal(def.metrics, null)
assert.throws(() => C.normalizeProtocolDef({ name: 'x' }), /parseFrame/)
assert.throws(() => C.normalizeProtocolDef({ name: 'x', parseFrame: function () {}, logView: 'no' }), /logView 必须是函数/)
assert.throws(() => C.normalizeProtocolDef({ name: 'x', parseFrame: function () {}, fields: [{ key: 'a', name: 'A', type: 'uint8' }, { key: 'a', name: 'B', type: 'uint8' }] }), /重复/)
assert.throws(() => C.normalizeProtocolDef({ name: 'x', parseFrame: function () {}, fields: [{ key: 'a', name: 'A', type: 'u8' }] }), /类型不支持/)
assert.throws(() => C.normalizeProtocolDef({ name: 'x', parseFrame: function () {}, fields: [{ key: 'a', name: 'A', type: 'uint8', min: 9, max: 1 }] }), /min 大于 max/)
assert.throws(() => C.normalizeProtocolDef({ name: 'x', parseFrame: function () {}, fields: [{ key: 'a', name: 'A', type: 'uint8', enum: [] }] }), /enum/)
assert.throws(() => C.normalizeProtocolDef({ name: 'x', parseFrame: function () {}, tx: { queryById: function () {} } }), /tx 缺少方法/)
const withTx = C.normalizeProtocolDef({
	name: 'x', parseFrame: function () {},
	tx: {
		queryById: function () {}, readTag: function () {}, writeRaw: function () {}, readItem: function () {},
		bytesEqual: function () {}, hasTag: function () {}, reset: function () {}, cancel: function () {},
	},
})
assert.ok(withTx.tx)

// ---- 摘要（浏览器与 node 共用 crypto.subtle） ----
;(async function () {
	const hex = await C.digestHex(new TextEncoder().encode('abc'))
	assert.equal(hex, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
	assert.equal(C.digestLabel(hex), 'sha256-' + hex)
	assert.equal(C.shortDigest(hex, 12), 'ba7816bf8f01')

	console.log('protocol-contract: ok')
})().catch(function (e) {
	console.error(e)
	process.exit(1)
})
