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

	// ---- 7. 回修 2：estimateSize 有界遍历 + 宿主事件限流 ----
	{
		const huge = new Array(2000000).fill(0)
		assert.equal(Rpc.estimateSize(huge, 1000), Infinity, '大数组不能先整体压栈')
		assert.ok(Rpc.estimateSize({ a: [1, 2, 3] }, 1000) < 1000)
		let ev = Rpc.newEventState()
		for (let i = 0; i < Rpc.EVENT_LIMITS.maxEventsPerWindow; i++) {
			const a = Rpc.eventAdmission(ev, 1000, Rpc.EVENT_LIMITS)
			assert.equal(a.ok, true)
			ev = a.state
		}
		const denied = Rpc.eventAdmission(ev, 1000, Rpc.EVENT_LIMITS)
		assert.equal(denied.ok, false)
		assert.equal(denied.state.dropped, 1)
		assert.equal(denied.report, 1, '本窗口第一次丢弃要立刻上报')
		const next = Rpc.eventAdmission(denied.state, 1000 + Rpc.EVENT_LIMITS.windowMs, Rpc.EVENT_LIMITS)
		assert.equal(next.ok, true)
		assert.equal(next.report, 0, '已上报过的计数不能重复报')
		assert.equal(next.state.dropped, 0)
		// 一个窗口里多次丢弃：首报 1，窗口切换补报剩余
		let ev2 = Rpc.newEventState()
		for (let i = 0; i < Rpc.EVENT_LIMITS.maxEventsPerWindow; i++) ev2 = Rpc.eventAdmission(ev2, 1000, Rpc.EVENT_LIMITS).state
		for (let i = 0; i < 5; i++) ev2 = Rpc.eventAdmission(ev2, 1000, Rpc.EVENT_LIMITS).state
		const roll = Rpc.eventAdmission(ev2, 1000 + Rpc.EVENT_LIMITS.windowMs, Rpc.EVENT_LIMITS)
		assert.equal(roll.report, 4, '剩余丢弃数在窗口切换时补报')
	}

	// ---- 8. 回修 2：普通 claim.close 不置 cancelled，同一声明可重新 open ----
	function makeClaimPort() {
		const port = {
			openCalls: 0, closeCalls: 0, writable: { getWriter: () => ({ write: async () => {}, releaseLock() {} }) },
			open() { this.openCalls++; return Promise.resolve() },
			close() { this.closeCalls++; return Promise.resolve() },
		}
		port.readable = {
			getReader() {
				let cancel
				const pending = new Promise((resolve, reject) => { cancel = () => reject(new Error('cancelled')) })
				return { read: () => pending, cancel: async () => { cancel() }, releaseLock() {} }
			},
		}
		return port
	}
	function newClaimHost() {
		return loadApi({
			SerialHub: { allPhys: () => [], getPort: () => null, isOpen: () => false, isOpening: () => false, isVisible: () => true },
			serialPortClaims: { claim: () => 'c1', release: () => {}, list: () => [], ownerOf: () => null },
		})
	}
	{
		const host = newClaimHost()
		const box = fakeCtx()
		const port = makeClaimPort()
		await host.PluginApi.call('claim.acquire', { portKey: host.PluginApi.keyOfPort(port) }, box.ctx)
		await host.PluginApi.call('claim.open', { claimId: 'c1' }, box.ctx)
		assert.equal(box.recs.get('c1').open, true)
		await host.PluginApi.call('claim.close', { claimId: 'c1' }, box.ctx)
		const rec = box.recs.get('c1')
		assert.equal(rec.cancelled, false, '普通关闭不能把声明永久作废')
		assert.equal(port.closeCalls, 1)
		await host.PluginApi.call('claim.open', { claimId: 'c1' }, box.ctx)
		assert.equal(port.openCalls, 2, '同一声明可重新打开')
	}

	// ---- 9. 回修 2：closeClaims 等在飞 claim.write 结束后才关端口 ----
	{
		const host = newClaimHost()
		const box = fakeCtx()
		const port = makeClaimPort()
		let resolveWrite
		port.writable = { getWriter: () => ({ write: () => new Promise((r) => { resolveWrite = r }), releaseLock() {} }) }
		await host.PluginApi.call('claim.acquire', { portKey: host.PluginApi.keyOfPort(port) }, box.ctx)
		await host.PluginApi.call('claim.open', { claimId: 'c1' }, box.ctx)
		const writing = host.PluginApi.call('claim.write', { claimId: 'c1', bytes: [1, 2, 3] }, box.ctx)
		await new Promise((r) => setTimeout(r, 0))
		const closing = host.PluginApi.closeClaims(box.ctx, { cancelled: true })
		await new Promise((r) => setTimeout(r, 30))
		assert.equal(port.closeCalls, 0, '写流还被锁着时不能关端口')
		resolveWrite()
		await writing
		const failures = await closing
		assert.equal(failures.length, 0)
		assert.equal(port.closeCalls, 1)
		assert.equal(box.recs.size, 0)
	}

	// ---- 10. 回修 3：状态/数据事件分类、有界大对象、同步协议契约、closing 拒绝写入 ----
	{
		assert.equal(Rpc.isStateEvent('device.lane'), true)
		assert.equal(Rpc.isStateEvent('claim.state'), true)
		assert.equal(Rpc.isStateEvent('theme-change'), true)
		assert.equal(Rpc.isStateEvent('serial.rx'), false)
		assert.equal(Rpc.isDataEvent('protocol.frame'), true)
		assert.equal(Rpc.isDataEvent('device.ble'), true)
		const p1 = Rpc.coalesceState({}, 'device.lane', { sid: 'A', state: 'connected' })
		const p2 = Rpc.coalesceState(p1, 'device.lane', { sid: 'A', state: 'disconnected' })
		assert.deepEqual(Object.keys(p2), ['device.lane:A'])
		assert.equal(p2['device.lane:A'].name, 'device.lane')
		assert.equal(p2['device.lane:A'].payload.state, 'disconnected', '同一 lane 只保留最新')
		// A / B 双路各自最新，不能互相覆盖
		const both = Rpc.coalesceState(p2, 'device.lane', { sid: 'B', state: 'connected' })
		assert.deepEqual(Object.keys(both).sort(), ['device.lane:A', 'device.lane:B'])
		assert.equal(both['device.lane:A'].payload.state, 'disconnected')
		// device.ports 是「列表已变化，请重新查询」的单一通知，不带增量
		const ports1 = Rpc.coalesceState({}, 'device.ports', { changed: true })
		const ports2 = Rpc.coalesceState(ports1, 'device.ports', { changed: true })
		assert.deepEqual(Object.keys(ports2), ['device.ports'])
		assert.deepEqual(ports2['device.ports'].payload, { changed: true })
		assert.equal(Rpc.stateEventKey('claim.state', { pluginId: 'p1' }), 'claim.state:p1')
		assert.equal(Rpc.stateEventKey('app.busy', { busyId: 'b1' }), 'app.busy:b1')
		let ss = Rpc.newStateEventState()
		const first = Rpc.stateEventPlan(ss, 1000, Rpc.EVENT_LIMITS)
		assert.equal(first.immediate, true)
		ss = first.state
		assert.equal(Rpc.stateEventPlan(ss, 1100, Rpc.EVENT_LIMITS).immediate, false, '窗口内合并')
		const roll = Rpc.stateEventPlan(ss, 1000 + Rpc.EVENT_LIMITS.windowMs, Rpc.EVENT_LIMITS)
		assert.equal(roll.immediate, true)
		assert.equal(roll.flush, true, '窗口切换补发')

		// 大对象：for…in 计步，不先 Object.keys 全量枚举
		const big = {}
		for (let i = 0; i < 200000; i++) big['k' + i] = 'x'
		assert.equal(Rpc.estimateSize(big, 1000), Infinity, '大对象不能先枚举完再判预算')
	}

	// 注册层 + 调用前双重拒绝 async 协议实现
	{
		const Contract = require('../js/protocol-contract.js')
		let called = 0
		const def = { name: 'x', parseFrame: async function () { called++; return 1 } }
		assert.equal(Contract.isAsyncFunction(def.parseFrame), true)
		const host = loadApi({
			DeviceDockContract: Contract,
			SerialHub: { isVisible: () => true },
			serialLanes: { protocolOf: () => 'sek', protocolName: () => 'SEK', callInIsolatedLane: (sid, fn) => fn() },
			DeviceDockProtocols: { get: () => def },
		})
		await assert.rejects(
			() => host.PluginApi.call('protocol.call', { lane: 'S', fn: 'parseFrame', args: [] }, {}),
			(e) => e.code === 'unsupported_async'
		)
		assert.equal(called, 0, '异步实现必须在调用之前就被拒绝，不能先跑起来')
	}

	// claim.close 一开始就置 closing，等待在飞写入期间拒绝新 claim.write
	{
		const host = newClaimHost()
		const box = fakeCtx()
		const port = makeClaimPort()
		let resolveWrite
		port.writable = { getWriter: () => ({ write: () => new Promise((r) => { resolveWrite = r }), releaseLock() {} }) }
		await host.PluginApi.call('claim.acquire', { portKey: host.PluginApi.keyOfPort(port) }, box.ctx)
		await host.PluginApi.call('claim.open', { claimId: 'c1' }, box.ctx)
		const writing = host.PluginApi.call('claim.write', { claimId: 'c1', bytes: [1] }, box.ctx)
		await new Promise((r) => setTimeout(r, 0))
		const closing = host.PluginApi.call('claim.close', { claimId: 'c1' }, box.ctx)
		await new Promise((r) => setTimeout(r, 0))
		await assert.rejects(
			() => host.PluginApi.call('claim.write', { claimId: 'c1', bytes: [2] }, box.ctx),
			(e) => e.code === 'closing'
		)
		resolveWrite()
		await writing
		await closing
		assert.equal(box.recs.get('c1').closing, false, '普通关闭成功后清除 closing')
	}

	console.log('plugin-host-fixes: ok')
})().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
