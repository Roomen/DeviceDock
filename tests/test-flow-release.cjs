// Run: node tests/test-flow-release.cjs — synthetic data only.
// 回修 7 · 4：故障占用（写永不兑现）的手动释放——沿现有关闭路径关端口并确认，清掉旧写任务，再解锁。
// 按锚点截取 test-flow-panel.js 的 stopAll，配假 DOM / 假串口 / 假 serialLanes（真实入口，不是纯函数）。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const file = fs.readFileSync(path.join(__dirname, '../js/test-flow-panel.js'), 'utf8')
// 锚点：2d12755 里是同步的 `function stopAll()`，新代码是 `async function stopAll()`；都从函数头切到 canReadBack
const head = file.search(/\t(async )?function stopAll\(\) \{/)
assert.ok(head > 0, 'stopAll 锚点存在')
const src = file.slice(head, file.indexOf('\tfunction canReadBack(proto, field) {'))
assert.ok(/function stopAll/.test(src), '切出的 stopAll 源码非空')

function makeWorld(opts) {
	const o = opts || {}
	const pump = {
		buf: [], waiters: [], late: 0, writeUnclosed: true,
		writeTask: o.writeTask || null,
		unclosedTask: o.unclosedTask || null,
	}
	let running = true
	let flowTxToken = o.flowTxToken || 'txn-flow-7'
	let runAllGen = 7
	const el = { start: { disabled: true }, stop: { disabled: false }, status: { textContent: '', className: '' }, log: null, results: null }
	const calls = { cancelWaiters: [], close: [], forceRelease: [], status: [] }
	const ctx = {
		pump: pump,
		running: running,
		flowTxToken: flowTxToken,
		runAllGen: runAllGen,
		el: el,
		isProtoSupported: () => true,
		cancelWaiters: function (reason) { calls.cancelWaiters.push(reason) },
		setStatus: function (text, cls) { calls.status.push(text); el.status.textContent = text },
		serialApi: {
			getActiveSendSid: () => 'S',
			forceReleaseTransaction: function (owner, token) { calls.forceRelease.push([owner, token]); return true },
		},
		serialLanes: {
			close: function (sid) { calls.close.push(sid); return o.closeResult || Promise.resolve({ ok: true }) },
		},
		logLine: function () {},
	}
	ctx.window = { serialApi: ctx.serialApi, serialLanes: ctx.serialLanes }
	ctx.cancelWaiters = ctx.cancelWaiters
	ctx.setStatus = ctx.setStatus
	ctx.logLine = ctx.logLine
	vm.createContext(ctx)
	vm.runInContext(src + '\nglobalThis.api = { stopAll, get state() { return { running: running, flowTxToken: flowTxToken, writeTask: pump.writeTask, writeUnclosed: pump.writeUnclosed, unclosedTask: pump.unclosedTask } }, get calls() { return calls } }', ctx)
	return { ctx: ctx, api: ctx.api, pump: pump, calls: calls, el: el }
}

;(async function () {
	// 旧写永不兑现（writeTask 挂起不落）：手动释放 = 关端口（确认）→ 清任务 → 解锁
	{
		const never = new Promise(function () {})
		const w = makeWorld({ writeTask: never, unclosedTask: never })
		await w.api.stopAll()
		assert.deepEqual(w.calls.close, ['S'], '沿现有关闭路径关闭该路端口')
		assert.equal(w.pump.writeTask, null, '旧写任务按执行代次清掉（2d12755 保留 → 新一轮再进故障）')
		assert.equal(w.pump.unclosedTask, null, 'unclosedTask 一并清掉')
		assert.equal(w.pump.writeUnclosed, false, '故障占用解除')
		assert.deepEqual(w.calls.forceRelease, [['flow', 'txn-flow-7']], '按归属与令牌解锁')
		assert.equal(w.api.state.running, false, '面板回到可用状态')
	}

	// 关闭失败：保持故障占用（不解锁、不清任务）
	{
		const w = makeWorld({ writeTask: new Promise(function () {}), closeResult: Promise.resolve({ ok: false, code: 'close_failed', message: '串口未确认释放' }) })
		await w.api.stopAll()
		assert.equal(w.pump.writeTask !== null || w.pump.writeUnclosed, true, '关闭失败保持占用')
		assert.deepEqual(w.calls.forceRelease, [], '关闭失败不解锁')
		assert.ok(w.el.status.textContent.indexOf('保持占用') !== -1, '有提示')
	}

	console.log('test-flow-release: ok')
})().catch(function (e) { console.error(e); process.exit(1) })
