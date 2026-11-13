// Run: node tests/test-flow-release.cjs — synthetic data only.
// 回修 7/8 · 故障占用（写永不兑现）的手动释放：关闭门控与事务释放都来自 js/common.js 的真实源码切片。
// 按锚点截取 test-flow-panel.js 的 stopAll，配假 DOM / 假串口（真实入口，不是纯函数）。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const panelFile = fs.readFileSync(path.join(__dirname, '../js/test-flow-panel.js'), 'utf8')
const commonFile = fs.readFileSync(path.join(__dirname, '../js/common.js'), 'utf8')
const head = panelFile.search(/\t(async )?function stopAll\(\) \{/)
assert.ok(head > 0, 'stopAll 锚点存在')
const panelSrc = panelFile.slice(head, panelFile.indexOf('\tfunction canReadBack(proto, field) {'))
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
	}
	const el = { start: { disabled: true }, stop: { disabled: false }, status: { textContent: '', className: '' }, log: null, results: null }
	const calls = { cancelWaiters: [], close: [], status: [] }
	const errors = []
	// 真实门控用到的上下文：单路、当前主发口物理 S、可见、无其它占用
	const sessions = { S: { open: true, opening: false, releaseFailed: false } }
	const hub = {
		mode: 'single',
		activeSendPhys: () => 'S',
		uiSid: sid => (sid === 'A' ? 'S' : sid), // 单路下 UI 的 A 映射到物理 S（与真实 SerialHub.uiSid 一致）
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
			return Promise.resolve(ctx.closePort(target))
		},
	}
	ctx.window.serialLanes = ctx.serialLanes
	ctx.serialApi = ctx.window.serialApi = {
		isPinned: function () { return ctx.pinSid != null },
		getActiveSendSid: function () { return 'A' },
		pinSession: function (sid, owner, token) { return ctx.pinSession(sid, owner, token) },
		unpinSession: function (token) { return ctx.unpinSession(token) },
		forceReleaseTransaction: function (owner, token) { return ctx.forceReleaseTransaction(owner, token) },
	}
	// 旧版 stopAll（26ef690）会用到 runAllGen：给它一个初值，让同一份测试能跑新旧两版
	ctx.runAllGen = 0
	ctx.pinSid = null
	ctx.pinOwner = ''
	ctx.pinDepth = 0
	ctx.pinToken = null
	ctx.pinTokenSeq = 0
	ctx.setStatus = ctx.setStatus
	ctx.cancelWaiters = ctx.cancelWaiters
	ctx.logLine = ctx.logLine
	vm.createContext(ctx)
	vm.runInContext(physSrc + '\n' + gateSrc + '\n' + pinSrc + '\n' + unpinSrc + '\n' + forceSrc + '\n' + panelSrc + '\nglobalThis.api = { stopAll, pinSession, forceReleaseTransaction, setToken: function (t) { flowTxToken = t }, get state() { return { running: running, flowTxToken: flowTxToken, writeTask: pump.writeTask, writeUnclosed: pump.writeUnclosed, unclosedTask: pump.unclosedTask } }, get calls() { return calls } }', ctx)
	const token = ctx.api.pinSession('A', 'flow')
	assert.ok(token, '单路 UI A 钉扎成功（解析为物理 S）')
	// 与 runAll 一致：面板持有的就是这次钉扎的令牌
	ctx.api.setToken(token)
	return { ctx: ctx, api: ctx.api, pump: pump, calls: calls, el: el, errors: errors, token: token, sessions: sessions }
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

	console.log('test-flow-release: ok')
})().catch(function (e) { console.error(e); process.exit(1) })
