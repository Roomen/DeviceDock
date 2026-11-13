// Run: node tests/test-flow-release.cjs — synthetic data only.
// 回修 7/8 · 故障占用（写永不兑现）的手动释放：关闭门控与事务释放都来自 js/common.js 的真实源码切片。
// 按锚点截取 test-flow-panel.js 的 stopAll，配假 DOM / 假串口（真实入口，不是纯函数）。
require('./i18n-env.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const panelFile = fs.readFileSync(path.join(__dirname, '../js/test-flow-panel.js'), 'utf8')
const commonFile = fs.readFileSync(path.join(__dirname, '../js/common.js'), 'utf8')
const head = panelFile.search(/\t(async )?function stopAll\(\) \{/)
assert.ok(head > 0, 'stopAll 锚点存在')
const panelSrc = panelFile.slice(head, panelFile.indexOf('\tfunction canReadBack(proto, field) {'))
assert.ok(/releaseFaultyHold|function stopAll/.test(panelSrc), '切出的释放源码非空')
assert.ok(/function stopAll/.test(panelSrc), '切出的 stopAll 源码非空')

// common.js 真实切片：钉扎（含严格令牌）、手动释放、关闭门控 laneBlockReason
const section = (a, b) => {
	const from = commonFile.indexOf(a)
	const to = commonFile.indexOf(b, from)
	assert.ok(from > 0 && to > from, '锚点切片失败：' + a)
	return commonFile.slice(from, to)
}
const gateSrc = section('\tfunction laneBlockReason(sid, port) {', '\tasync function closeLane(sid, opts) {')
const physSrc = section('\tfunction physicalSid(sid) {', '\t// 接收流异常先尝试重建')
const pinSrc = 'function pinSession(sid, owner, token) ' + section('\t\tpinSession(sid, owner, token) {', '\t\tunpinSession(token) {').slice(section('\t\tpinSession(sid, owner, token) {', '\t\tunpinSession(token) {').indexOf('{')).trim().replace(/,$/, '')
const unpinSrc = 'function unpinSession(token) ' + section('\t\tunpinSession(token) {', '\t\t// 手动释放事务占用').slice(section('\t\tunpinSession(token) {', '\t\t// 手动释放事务占用').indexOf('{')).trim().replace(/,$/, '')
const forceSrc = 'function forceReleaseTransaction(owner, token) ' + section('\t\tforceReleaseTransaction(owner, token) {', '\t\tisPinned() {').slice(section('\t\tforceReleaseTransaction(owner, token) {', '\t\tisPinned() {').indexOf('{')).trim().replace(/,$/, '')

function makeWorld(opts) {
	const o = opts || {}
	const pump = {
		buf: [], waiters: [], late: 0, writeUnclosed: true,
		writeTask: o.writeTask || null,
		unclosedTask: o.unclosedTask || null,
		releasing: null,
	}
	const el = { start: { disabled: true }, stop: { disabled: false }, status: { textContent: '', className: '' }, log: null, results: null }
	const calls = { cancelWaiters: [], close: [], status: [] }
	const errors = []
	// 真实门控用到的上下文：单路、当前主发口物理 S、可见、无其它占用
	const sessions = { S: { open: true, opening: false, releaseFailed: false }, A: { open: true, opening: false, releaseFailed: false }, B: { open: true, opening: false, releaseFailed: false } }
	const hub = {
		mode: o.mode || 'single',
		activePhys: o.activePhys || 'S',
		activeSendPhys: function () { return hub.activePhys },
		uiSid: sid => (hub.mode === 'single' && sid === 'A' ? 'S' : sid), // 单路下 UI 的 A 映射到物理 S（与真实 SerialHub.uiSid 一致）
		isVisible: () => true,
		isOpening: sid => sessions[sid].opening,
		isOpen: sid => sessions[sid].open,
		_sess: sid => sessions[sid],
	}
	const ctx = {
		pump: pump,
		SerialHub: hub,
		window: {},
		el: el,
		laneMoving: false,
		platformHasSid: () => true,
		lanePortOwner: () => null,
		portConflictMsg: () => 'synthetic conflict',
		addLogErr: (msg) => errors.push(msg),
		isProtoSupported: () => true,
		cancelWaiters: function (reason) { calls.cancelWaiters.push(reason) },
		setStatus: function (text, cls) { calls.status.push(text); el.status.textContent = text },
		logLine: function () {},
		// 关闭替身：先过真实门控 laneBlockReason（钉扎期间返回 transaction_pinned），放行后才真的关
		closePort: function (sid) { calls.close.push(sid); sessions[sid].open = false; return { ok: true, changed: true, open: false } },
	}
	ctx.serialLanes = {
		// 与真实 closeLane 前两步一致：uiSid 映射 → laneBlockReason（钉扎期间返回 transaction_pinned）
		close: function (sid) {
			const target = hub.uiSid(sid)
			const block = ctx.laneBlockReason(target, null)
			if (block) return Promise.resolve({ ok: false, code: block.code, message: block.message })
			if (o.closeGate) {
				// 关闭挂起：第一次交由测试控制兑现时机（之后按 closeResult 走）
				const gate = o.closeGate
				o.closeGate = null
				return gate.then(function () { return ctx.closePort(target) }, function () { return { ok: false, code: 'close_failed', message: '串口未确认释放' } })
			}
			return Promise.resolve(ctx.closePort(target))
		},
	}
	ctx.window.serialLanes = ctx.serialLanes
	ctx.serialApi = ctx.window.serialApi = {
		isPinned: function () { return ctx.pinSid != null },
		getActiveSendSid: function () { return hub.activePhys === 'S' ? 'A' : hub.activePhys },
		pinSession: function (sid, owner, token) { return ctx.pinSession(sid, owner, token) },
		unpinSession: function (token) { return ctx.unpinSession(token) },
		forceReleaseTransaction: function (owner, token) { return ctx.forceReleaseTransaction(owner, token) },
	}
	// 旧版 stopAll（26ef690）会用到 runAllGen：给它一个初值，让同一份测试能跑新旧两版
	ctx.runAllGen = 0
	ctx.running = true
	ctx.pinSid = null
	ctx.pinOwner = ''
	ctx.pinDepth = 0
	ctx.pinToken = null
	ctx.pinTokenSeq = 0
	ctx.setStatus = ctx.setStatus
	ctx.cancelWaiters = ctx.cancelWaiters
	ctx.logLine = ctx.logLine
	vm.createContext(ctx)
	vm.runInContext(physSrc + '\n' + gateSrc + '\n' + pinSrc + '\n' + unpinSrc + '\n' + forceSrc + '\n' + panelSrc + '\nglobalThis.api = { stopAll, pinSession, forceReleaseTransaction, setToken: function (t) { flowTxToken = t }, setStopDisabled: function (v) { el.stop.disabled = v }, get state() { return { running: running, flowTxToken: flowTxToken, writeTask: pump.writeTask, writeUnclosed: pump.writeUnclosed, unclosedTask: pump.unclosedTask, faultSid: pump.faultSid, pinSid: pinSid, pinOwner: pinOwner, pinToken: pinToken } }, get calls() { return calls } }', ctx)
	// 与 runAll 一致：钉扎当前主发路（单路下 UI 的 A → 物理 S），面板持有这个令牌
	const token = ctx.api.pinSession(hub.activePhys, 'flow')
	assert.ok(token, '钉扎成功')
	ctx.api.setToken(token)
	// 与 settleWriteTask 一致：进入故障终态时记下当次的物理路（26ef690 没有这个字段，测试自行补）
	if (o.faultSid !== false) pump.faultSid = o.faultSid || hub.activePhys
	ctx.initialToken = token
	ctx.hub = hub
	return { ctx: ctx, api: ctx.api, pump: pump, calls: calls, el: el, errors: errors, token: token, sessions: sessions, hub: hub }
}

;(async function () {
	// 旧写永不兑现（writeTask 挂起不落）：手动释放 = 关端口（真实门控放行）→ 清任务 → 解锁
	{
		const never = new Promise(function () {})
		const w = makeWorld({ writeTask: never, unclosedTask: never })
		assert.equal(w.ctx.pinSid, 'S', '前置：钉扎在物理 S 上')
		await w.api.stopAll()
		assert.deepEqual(w.calls.close, ['S'], '经真实门控后沿关闭路径关闭该路端口')
		assert.equal(w.ctx.pinSid, null, '按归属与令牌解锁')
		assert.equal(w.pump.writeTask, null, '旧写任务清掉（26ef690 保留 → 新一轮再进故障）')
		assert.equal(w.pump.unclosedTask, null, 'unclosedTask 一并清掉')
		assert.equal(w.pump.writeUnclosed, false, '故障占用解除')
		assert.equal(w.api.state.running, false, '面板回到可用状态')
		assert.ok(w.el.status.textContent.indexOf('已手动释放') !== -1, '有成功提示：' + w.el.status.textContent)
	}

	// 关闭始终失败（例如端口被占用）：保持故障占用（不解锁、不清任务）并提示
	{
		const w = makeWorld({ writeTask: new Promise(function () {}) })
		w.ctx.closePort = function () { return { ok: false, code: 'close_failed', message: '串口未确认释放' } }
		await w.api.stopAll()
		assert.equal(w.pump.writeUnclosed, true, '关闭失败保持占用')
		assert.ok(w.pump.writeTask !== null, '旧写任务不清')
		assert.ok(w.el.status.textContent.indexOf('保持占用') !== -1, '有提示：' + w.el.status.textContent)
	}

	// 回修 9 · 2：故障在 A、之后主发路切到 B，再点停止 → 只关 A，B 不动
	{
		const w = makeWorld({ mode: 'dual', activePhys: 'A', writeTask: new Promise(function () {}) })
		assert.equal(w.api.state.pinSid, 'A', '前置：钉扎在物理 A')
		assert.equal(w.pump.faultSid, 'A', '前置：故障路记为 A')
		// 用户把主发路切到 B（不切钉扎：钉扎锁住主发口，这里模拟切换后的状态）
		w.hub.activePhys = 'B'
		await w.api.stopAll()
		assert.deepEqual(w.calls.close, ['A'], '只尝试关闭故障路 A（26ef690 会去关当前主发路 B）')
		assert.equal(w.sessions.B.open, true, 'B 路不被关闭')
		assert.equal(w.sessions.A.open, false, 'A 路已关闭')
		assert.equal(w.pump.faultSid, null, '成功释放后清掉故障路')
		assert.equal(w.api.state.pinSid, null, '解锁')
	}

	// 回修 9 · 1：关闭始终失败 → 提示「保持占用」必须与实际一致：钉扎仍在、属 flow、令牌非空
	{
		const w = makeWorld({ writeTask: new Promise(function () {}) })
		w.ctx.closePort = function () { return { ok: false, code: 'close_failed', message: '串口未确认释放' } }
		await w.api.stopAll()
		assert.equal(w.api.state.pinSid, 'S', '钉扎仍在（26ef690 会解掉钉扎却说保持占用）')
		assert.equal(w.api.state.pinOwner, 'flow', '占用归属仍是 flow')
		assert.ok(w.api.state.pinToken, '面板拿回了非空令牌')
		assert.equal(w.pump.writeUnclosed, true, '故障占用保持')
		assert.ok(w.el.status.textContent.indexOf('保持占用') !== -1, '提示与实际一致')
	}

	// 回修 10：关闭挂起期间连点两次停止 → 只发起一次关闭；首次失败后占用与令牌一致；再点能成功
	{
		const w = makeWorld({ writeTask: new Promise(function () {}) })
		let resolveGate
		const gate = new Promise(function (resolve) { resolveGate = resolve })
		// 第一次关闭挂起，之后由 closePort 的替身返回失败
		w.ctx.closePort = function () { return { ok: false, code: 'close_failed', message: '串口未确认释放' } }
		w.ctx.serialLanes.close = function (sid) {
			const target = w.hub.uiSid(sid)
			const block = w.ctx.laneBlockReason(target, null)
			if (block) return Promise.resolve({ ok: false, code: block.code, message: block.message })
			if (w.ctx.__gateUsed) return Promise.resolve(w.ctx.closePort(target))
			w.ctx.__gateUsed = true
			w.calls.close.push(target)
			return gate.then(function () { return w.ctx.closePort(target) }, function () { return w.ctx.closePort(target) })
		}
		const first = w.api.stopAll()
		const second = w.api.stopAll()
		await new Promise(function (r) { setTimeout(r, 10) }) // 让第一次关端口走到挂起
		assert.equal(w.calls.close.length, 1, '关闭挂起期间只发起一次关闭（fbcf1c9 会发起两次）')
		assert.equal(w.el.stop.disabled, true, '释放期间停止键禁用')
		assert.ok(w.pump.releasing, '释放中共享同一份 Promise')
		let sameRelease = 'pending'
		second.then(function (v) { sameRelease = v })
		resolveGate()
		await first
		assert.equal(sameRelease, await first, '第二次点击复用同一份释放（同一结果）')
		await new Promise(function (r) { setTimeout(r, 10) })
		assert.equal(w.calls.close.length, 1, '首次仍只有一次关闭')
		assert.notEqual(w.api.state.pinSid, null, '首次失败后占用仍在（提示与状态一致）')
		assert.equal(w.api.state.pinToken, w.api.state.flowTxToken, '面板持有的令牌就是真实的 pinToken（fbcf1c9 会清成 null）')
		assert.ok(w.api.state.flowTxToken, '令牌非空')
		// 再点一次：这次关闭成功，占用释放
		delete w.ctx.__gateUsed
		w.ctx.closePort = function (sid) { w.calls.close.push(sid); w.sessions[sid].open = false; return { ok: true, changed: true, open: false } }
		// 端口仍被钉扎挡住：先把钉扎解除给关闭让路（真实路径里由 forceReleaseTransaction 完成）
		w.ctx.pinSid = null
		w.ctx.pinDepth = 0
		await w.api.stopAll()
		assert.equal(w.pump.writeUnclosed, false, '再次点击后成功释放')
		assert.equal(w.api.state.running, false, '面板回到可用状态')
	}

	console.log('test-flow-release: ok')
})().catch(function (e) { console.error(e); process.exit(1) })
