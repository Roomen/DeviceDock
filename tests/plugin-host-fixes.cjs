// Run: node tests/plugin-host-fixes.cjs — 全部用合成对象，不连真串口、不发网络请求。
// 覆盖回修 1 的页面侧：RPC 限额与准入、同版本重装的信任键、协议调用换入隔离 lane、
// BLE 扫描清理在启动前登记、导出与存储限额、停用时串口在飞打开/读循环/关闭的异步收尾。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const Rpc = require('../js/plugin-rpc.js')
const apiSrc = fs.readFileSync(path.join(__dirname, '../js/plugin-api.js'), 'utf8')

function loadApi(extra) {
	const ctx = Object.assign({
		console, setTimeout, clearTimeout, JSON, Math, Date, Uint8Array, Error, Map, Set,
		atob: (s) => Buffer.from(s, 'base64').toString('binary'),
		Blob: class { constructor(parts) { this.parts = parts } },
		URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
		document: {
			createElement: () => ({ style: {}, href: '', download: '', click() {}, remove() {} }),
			body: { appendChild() {} },
		},
		DeviceDockPluginRpc: Rpc,
	}, extra || {})
	ctx.window = ctx
	ctx.globalThis = ctx
	vm.runInNewContext(apiSrc, ctx)
	return ctx
}

function fakeCtx() {
	const recs = new Map()
	const events = []
	const teardowns = []
	const ctx = {
		id: 'hello', name: 'Hello 示例', version: '1.0.0', capabilities: Rpc.CAPABILITIES.slice(),
		send: (name, payload) => events.push({ name, payload }),
		theme: () => Rpc.themePayload('light', {}),
		onTeardown: (fn) => teardowns.push(fn),
		claim: (id) => {
			const rec = {
				id, ctx, port: null, open: false, reading: false, reader: null, mode: 'exclusive',
				openTask: null, readTask: null, portOpened: false, portClosed: false, cancelled: false,
			}
			recs.set(id, rec)
			return rec
		},
		claimRecord: (id) => recs.get(String(id || '')) || null,
		dropClaim: (id) => recs.delete(id),
		claims: () => Array.from(recs.values()),
		busyAcquire: () => 'b1', busyRelease: () => true,
	}
	return { ctx, recs, events, teardowns }
}

// ---- 1. RPC 消息 / 参数大小与在飞 / 速率准入 ----
{
	const big = { __devicedock: 1, id: 'r1', method: 'app.theme', params: { blob: 'x'.repeat(300 * 1024) } }
	const tooBig = Rpc.validateRequest(big)
	assert.equal(tooBig.ok, false)
	assert.equal(tooBig.error.code, 'too_large')
	assert.equal(Rpc.estimateSize({ a: 'x'.repeat(1000) }, 500), Infinity)
	assert.ok(Rpc.estimateSize({ a: 'x'.repeat(10) }, 500) < 500)

	const ok = Rpc.validateRequest({ __devicedock: 1, id: 'r2', method: 'app.theme' })
	assert.equal(ok.ok, true)

	const small = Rpc.LIMITS
	let s = Rpc.newAdmissionState()
	for (let i = 0; i < small.maxInflight; i++) {
		const a = Rpc.admission(s, 1000, small)
		assert.equal(a.ok, true)
		s = a.state
	}
	const blockedByInflight = Rpc.admission(s, 1000, small)
	assert.equal(blockedByInflight.ok, false)
	assert.equal(blockedByInflight.error.code, 'rate_limited')
	s = Rpc.releaseInflight(s)
	assert.equal(s.inflight, small.maxInflight - 1)

	// 速率窗口：同一秒内超过上限就拒绝，进入下一秒重新计数
	let r = Rpc.newAdmissionState()
	for (let i = 0; i < small.maxRequestsPerWindow; i++) {
		r = Rpc.admission(r, 5000, small).state
		r = Rpc.releaseInflight(r)
	}
	assert.equal(Rpc.admission(r, 5000, small).ok, false)
	assert.equal(Rpc.admission(r, 5000 + small.windowMs, small).ok, true)
}

// ---- 2. 同版本重装：包摘要 / 能力集合变化必须销毁旧 iframe ----
{
	const base = { version: '1.0.0', entry: 'index.html', packageSha256: 'a'.repeat(64), capabilities: ['app'] }
	assert.equal(Rpc.pluginChanged(base, Object.assign({}, base)), false)
	assert.equal(Rpc.pluginChanged(base, Object.assign({}, base, { packageSha256: 'b'.repeat(64) })), true, '同版本换了包')
	assert.equal(Rpc.pluginChanged(base, Object.assign({}, base, { capabilities: ['app', 'serial.io'] })), true, '同包但能力增加')
	const two = Object.assign({}, base, { capabilities: ['app', 'serial.io'] })
	assert.equal(Rpc.pluginChanged(two, Object.assign({}, two, { capabilities: ['serial.io', 'app'] })), false, '能力顺序不算变化')
	assert.equal(Rpc.pluginChanged(base, Object.assign({}, base, { version: '1.0.1' })), true)
	assert.equal(Rpc.pluginChanged(base, Object.assign({}, base, { entry: 'main.html' })), true)
	assert.equal(Rpc.pluginChanged(null, base), true)
}

// ---- 3. 协议调用换入该路协议 + 一次性隔离会话 ----
;(async function () {
	let host = null
	const laneLog = []
	const protoDef = {
		name: 'SEK',
		parseFrame: function (bytes) { laneLog.push('proto:' + host._activeProtocol); return { ok: true, bytes: bytes } },
	}
	host = loadApi({
		_activeProtocol: 'top-level',
		SerialHub: { isVisible: () => true, allPhys: () => ['S', 'A', 'B'], getPort: () => null, isOpen: () => false, isOpening: () => false },
		serialLanes: {
			protocolOf: (sid) => sid === 'A' ? 'sek' : 'cjt188',
			protocolName: () => 'SEK',
			callInIsolatedLane: (sid, fn) => {
				laneLog.push('enter:' + sid)
				const prev = host._activeProtocol
				host._activeProtocol = sid === 'A' ? 'sek' : 'cjt188'
				try { return fn() } finally { host._activeProtocol = prev; laneLog.push('exit') }
			},
		},
		DeviceDockProtocols: { get: (id) => id === 'sek' ? protoDef : null },
	})
	const res = await host.PluginApi.call('protocol.call', { lane: 'A', fn: 'parseFrame', args: [[1, 2, 3]] }, {})
	assert.deepEqual(res, { ok: true, bytes: [1, 2, 3] })
	assert.deepEqual(laneLog, ['enter:A', 'proto:sek', 'exit'], '协议函数必须跑在该路的隔离上下文里')
	assert.equal(host._activeProtocol, 'top-level', '调用结束必须还原全局协议')
	// 没有隔离入口时宁可报错，也不能不加隔离直接调用（避免污染 skSession）
	const noLane = loadApi({
		SerialHub: { isVisible: () => true },
		serialLanes: { protocolOf: () => 'sek', protocolName: () => 'SEK' },
		DeviceDockProtocols: { get: () => protoDef },
	})
	await assert.rejects(
		() => noLane.PluginApi.call('protocol.call', { lane: 'S', fn: 'parseFrame', args: [] }, {}),
		(e) => e.code === 'unsupported'
	)

	// ---- 4. BLE 扫描清理回调必须在启动前登记，并等扫描任务真实收尾 ----
	let resolveScan
	const scanTask = new Promise((r) => { resolveScan = r })
	let scanStarted = 0, stopCalls = 0
	const ble = {
		scan: (cb) => { scanStarted++; cb({ deviceId: 'd1' }); return scanTask },
		stopScan: () => { stopCalls++; resolveScan(); return Promise.resolve() },
	}
	const scanHost = loadApi({ AppPlatform: { service: (n) => n === 'computer-ble' ? ble : null } })
	const scanCtx = fakeCtx()
	const scanResult = await scanHost.PluginApi.call('device.bleScan', { start: true }, scanCtx.ctx)
	assert.equal(scanResult.scanning, true)
	assert.equal(scanStarted, 1)
	assert.equal(scanCtx.teardowns.length, 1, '旧实现等 await ble.scan() 之后才登记 teardown，扫描期间停用会漏掉')
	assert.ok(scanCtx.events.some((e) => e.name === 'device.ble'))
	await scanCtx.teardowns[0]()
	assert.equal(stopCalls, 1, '停用时必须调用 stopScan')
	// 扫描任务已被 stopScan 兑现，teardown 的 Promise 能正常结束
	const stopResult = await scanHost.PluginApi.call('device.bleScan', { start: false }, scanCtx.ctx)
	assert.equal(stopResult.scanning, false)

	// ---- 5. 导出 / 存储限额：超大 base64 不能整段解码 ----
	const fileHost = loadApi({})
	await assert.rejects(
		() => fileHost.PluginApi.call('app.saveFile', { base64: 'A'.repeat(Rpc.LIMITS.maxExportChars + 1) }, {}),
		(e) => e.code === 'too_large'
	)
	const storageHost = loadApi({ AppPlatform: { service: () => ({ storageSet: () => { throw new Error('不应到达 IPC') } }) } })
	await assert.rejects(
		() => storageHost.PluginApi.call('app.storageSet', { key: 'k', value: { blob: 'x'.repeat(70 * 1024) } }, fakeCtx().ctx),
		(e) => e.code === 'too_large'
	)

	// ---- 6. 停用时串口异步收尾：打开途中停用 / 读循环 / 关闭失败保留占用 ----
	function makePort(closeImpl) {
		return {
			openCalls: 0, closeCalls: 0, readerCreated: 0,
			openGate: null,
			readable: { getReader() { this.owner.readerCreated++; return { read: () => new Promise(() => {}), cancel: async () => {}, releaseLock() {} } } },
			open() {
				this.openCalls++
				this.openGate = this.openGate || {}
				this.openGate.p = new Promise((r) => { this.openGate.resolve = r })
				return this.openGate.p
			},
			close() { this.closeCalls++; return closeImpl ? closeImpl() : Promise.resolve() },
		}
	}
	const registry = new Map()
	const port = makePort()
	port.readable.owner = port
	const claimHost = loadApi({
		SerialHub: { allPhys: () => ['S', 'A', 'B'], getPort: () => null, isOpen: () => false, isOpening: () => false, isVisible: () => true },
		serialPortClaims: {
			claim: (p) => { registry.set('c1', p); return 'c1' },
			release: (id) => registry.delete(id),
			list: () => [],
			ownerOf: () => null,
		},
	})
	const ctxBox = fakeCtx()
	const portKey = claimHost.PluginApi.keyOfPort(port)
	await claimHost.PluginApi.call('claim.acquire', { portKey, mode: 'exclusive' }, ctxBox.ctx)
	const opening = claimHost.PluginApi.call('claim.open', { claimId: 'c1' }, ctxBox.ctx)
	// 停用发生在 open() 途中：closeClaims 必须等打开收尾、关掉口、注销声明
	const closing = claimHost.PluginApi.closeClaims(ctxBox.ctx)
	port.openGate.resolve()
	await assert.rejects(() => opening, (e) => e.code === 'not_found')
	const closed = await closing
	assert.equal(closed.length, 0, '关闭成功时没有失败项')
	assert.equal(port.closeCalls, 1, '打开途中停用也要关闭刚打开的口')
	assert.equal(port.readerCreated, 0, '停用后不能再启动读循环')
	assert.equal(registry.size, 0, '关闭成功后注销占用声明')
	assert.equal(ctxBox.recs.size, 0)

	// 关闭失败：占用声明与记录都保留，供 busy 源继续阻断应用更新
	const port2 = makePort(() => Promise.reject(new Error('设备忙')))
	port2.readable.owner = port2
	const host2 = loadApi({
		SerialHub: { allPhys: () => [], getPort: () => null, isOpen: () => false, isOpening: () => false, isVisible: () => true },
		serialPortClaims: {
			claim: (p) => { registry.set('c2', p); return 'c2' },
			release: (id) => registry.delete(id),
			list: () => [], ownerOf: () => null,
		},
	})
	const box2 = fakeCtx()
	const key2 = host2.PluginApi.keyOfPort(port2)
	await host2.PluginApi.call('claim.acquire', { portKey: key2 }, box2.ctx)
	const rec2 = box2.recs.get('c2')
	rec2.portOpened = true
	rec2.open = true
	const failures = await host2.PluginApi.closeClaims(box2.ctx)
	assert.equal(failures.length, 1)
	assert.match(failures[0].message, /设备忙/)
	assert.equal(registry.size, 1, '关闭失败时占用声明不注销')
	assert.equal(box2.recs.size, 1, '关闭失败时记录保留，应用更新继续被阻挡')

	console.log('plugin-host-fixes: ok')
})().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
