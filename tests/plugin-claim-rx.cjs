// Run: node tests/plugin-claim-rx.cjs — 全部合成数据，不连真串口。
// 覆盖：claim.rx 合批（高频小块合成一批、字节不丢不乱序、seq 递增）、
// 8 MiB 上界（丢最早并报 events.dropped{claimId,bytes}）、合批事件不受 120/s 数据事件限流、
// close 前刷出残余、iframe 销毁后不再发送。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const Rpc = require('../js/plugin-rpc.js')
const apiSrc = fs.readFileSync(path.join(__dirname, '../js/plugin-api.js'), 'utf8')

function loadApi() {
	const ctx = {
		console, setTimeout, clearTimeout, JSON, Math, Date, Uint8Array, Array, Object, Number, Error, Map, Set,
		atob: (s) => Buffer.from(s, 'base64').toString('binary'),
		Blob: class { constructor(parts) { this.parts = parts } },
		URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
		document: { createElement: () => ({ style: {}, click() {}, remove() {} }), body: { appendChild() {} } },
		DeviceDockPluginRpc: Rpc,
	}
	ctx.window = ctx
	ctx.globalThis = ctx
	vm.runInNewContext(apiSrc, ctx)
	return ctx
}

function fakeCtx() {
	const events = []
	const recs = new Map()
	const ctx = {
		id: 'power', name: '功耗分析', version: '1.0.0', capabilities: Rpc.CAPABILITIES.slice(),
		send: (name, payload) => events.push({ name, payload }),
		theme: () => Rpc.themePayload('light', {}),
		onTeardown: () => {},
		claim: (id) => {
			const rec = {
				id, ctx, port: null, open: false, reading: false, reader: null, mode: 'exclusive',
				openTask: null, readTask: null, portOpened: false, portClosed: false, cancelled: false,
				closing: false, closingTask: null, writeTask: null, rx: null,
			}
			recs.set(id, rec)
			return rec
		},
		claimRecord: (id) => recs.get(String(id || '')) || null,
		dropClaim: (id) => recs.delete(id),
		claims: () => Array.from(recs.values()),
		busyAcquire: () => 'b1', busyRelease: () => true,
	}
	return { ctx, events, recs }
}

const rxEvents = (events) => events.filter((e) => e.name === 'claim.rx')
const dropEvents = (events) => events.filter((e) => e.name === 'events.dropped')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async function () {
	const Api = loadApi().PluginApi
	const { CLAIM_RX_WINDOW_MS, CLAIM_RX_FLUSH_BYTES, CLAIM_RX_MAX_BYTES } = Api
	assert.equal(CLAIM_RX_WINDOW_MS, 16)
	assert.equal(CLAIM_RX_FLUSH_BYTES, 256 * 1024)
	assert.equal(CLAIM_RX_MAX_BYTES, 8 * 1024 * 1024)

	// ---- 1. 高频小块合成一批：字节不丢、不乱序、seq 递增、bytes 是 Uint8Array ----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-1')
		// 120 块 × 512 B = 61440 B，远小于 256 KiB 阈值 → 走 16 ms 时间窗合成一批
		for (let i = 0; i < 120; i++) {
			const chunk = new Uint8Array(512)
			chunk.fill(i & 0xff)
			// 每块用递增序号编码首字节，便于校验顺序
			chunk[0] = i & 0xff
			chunk[1] = (i >> 8) & 0xff
			if (Api._appendClaimRx(rec, chunk)) Api._flushClaimRx(rec)
			else Api._scheduleClaimFlush(rec)
		}
		assert.equal(rxEvents(box.events).length, 0, '阈值未到、时间窗未到时不发事件')
		await sleep(CLAIM_RX_WINDOW_MS + 30)
		const evs = rxEvents(box.events)
		assert.equal(evs.length, 1, '16 ms 内的 120 块应合成 1 条事件')
		const p = evs[0].payload
		assert.equal(p.claimId, 'claim-1')
		assert.equal(p.seq, 1, 'seq 从 1 开始')
		assert.ok(p.bytes instanceof Uint8Array, 'bytes 必须是 Uint8Array（不再 Array.from）')
		assert.equal(p.bytes.length, 120 * 512, '字节数不丢')
		for (let i = 0; i < 120; i++) {
			assert.equal(p.bytes[i * 512], i & 0xff, '第 ' + i + ' 块首字节（顺序）')
			assert.equal(p.bytes[i * 512 + 1], (i >> 8) & 0xff, '第 ' + i + ' 块次序')
		}
		assert.ok(p.at > 0, 'at 是本批第一块的到达时间')

		// 第二批：seq 递增
		Api._appendClaimRx(rec, new Uint8Array([9, 9]))
		Api._flushClaimRx(rec)
		const evs2 = rxEvents(box.events)
		assert.equal(evs2.length, 2)
		assert.equal(evs2[1].payload.seq, 2, 'seq 每个 claim 单调递增')
		assert.deepEqual(Array.from(evs2[1].payload.bytes), [9, 9])

		// 不同 claim 各自计数
		const rec2 = box.ctx.claim('claim-2')
		Api._appendClaimRx(rec2, new Uint8Array([1]))
		Api._flushClaimRx(rec2)
		const last = rxEvents(box.events).pop().payload
		assert.equal(last.claimId, 'claim-2')
		assert.equal(last.seq, 1, 'seq 按 claim 独立')
	}

	// ---- 2. 字节阈值：达到 256 KiB 立刻刷，不等 16 ms ----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-3')
		const chunk = new Uint8Array(CLAIM_RX_FLUSH_BYTES)
		chunk.fill(7)
		const needFlush = Api._appendClaimRx(rec, chunk)
		assert.equal(needFlush, true, '达到 256 KiB 阈值要立刻刷')
		Api._flushClaimRx(rec)
		assert.equal(rxEvents(box.events).length, 1)
		assert.equal(rxEvents(box.events)[0].payload.bytes.length, CLAIM_RX_FLUSH_BYTES)
	}

	// ---- 3. 8 MiB 上界：丢最早的字节并发 events.dropped{claimId,bytes} ----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-4')
		const big = new Uint8Array(CLAIM_RX_MAX_BYTES)
		for (let i = 0; i < big.length; i++) big[i] = i & 0xff
		Api._appendClaimRx(rec, big)
		assert.equal(dropEvents(box.events).length, 0, '刚好 8 MiB 时不丢')
		// 再追加 1024 B → 必须丢最早的 1024 B
		const extra = new Uint8Array(1024)
		extra.fill(0xAB)
		Api._appendClaimRx(rec, extra)
		const drops = dropEvents(box.events)
		assert.equal(drops.length, 1, '溢出要报 events.dropped')
		assert.equal(drops[0].payload.claimId, 'claim-4', 'dropped 事件要带 claimId')
		assert.equal(drops[0].payload.bytes, 1024, 'dropped 事件要带丢弃字节数')
		assert.ok(String(drops[0].payload.reason).indexOf('claim-rx-overflow') === 0)
		Api._flushClaimRx(rec)
		const p = rxEvents(box.events)[0].payload
		assert.equal(p.bytes.length, CLAIM_RX_MAX_BYTES, '缓冲仍在上界之内')
		// 丢掉的是最早的 1024 B：现在的首字节应是 1024 % 256 = 0
		assert.equal(p.bytes[0], 1024 & 0xff, '丢掉的是最早的字节')
		assert.equal(p.bytes[p.bytes.length - 1], 0xAB, '最新的字节保留')
	}

	// ---- 4. 合批事件不计入 120/s 数据事件配额 ----
	{
		assert.equal(Rpc.isBatchedEvent('claim.rx'), true)
		assert.ok(Rpc.DATA_EVENTS.indexOf('claim.rx') !== -1, '仍属于数据类事件（不走状态合并）')
		assert.equal(Rpc.isBatchedEvent('serial.rx'), false, '其它数据事件照旧限流')
		assert.deepEqual(Rpc.BATCHED_EVENTS, ['claim.rx'])
		// 纯函数层面：准入计数与 claim.rx 无关（宿主在 postEvent 里直接放行）
		let st = Rpc.newEventState()
		for (let i = 0; i < Rpc.EVENT_LIMITS.maxEventsPerWindow; i++) st = Rpc.eventAdmission(st, 1000, Rpc.EVENT_LIMITS).state
		assert.equal(Rpc.eventAdmission(st, 1000, Rpc.EVENT_LIMITS).ok, false, '普通数据事件在配额用尽后被拒')
	}

	// ---- 5. close 前刷出残余；discard 时直接丢弃 ----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-5')
		rec.port = { readable: null, writable: null, open: () => Promise.resolve(), close: () => Promise.resolve() }
		Api._appendClaimRx(rec, new Uint8Array([1, 2, 3]))
		assert.equal(rxEvents(box.events).length, 0)
		await Api.closeClaims(box.ctx, { cancelled: true })
		const evs = rxEvents(box.events)
		assert.equal(evs.length, 1, '关闭前要把残余刷出')
		assert.deepEqual(Array.from(evs[0].payload.bytes), [1, 2, 3])
		assert.equal(rec.rx, null, '定时器与缓冲随 claim 释放')

		const box2 = fakeCtx()
		const rec2 = box2.ctx.claim('claim-6')
		rec2.port = { readable: null, writable: null, open: () => Promise.resolve(), close: () => Promise.resolve() }
		Api._appendClaimRx(rec2, new Uint8Array([4, 5]))
		await Api.closeClaims(box2.ctx, { cancelled: true, discard: true })
		assert.equal(rxEvents(box2.events).length, 0, 'iframe 已销毁：残余直接丢弃，不发事件')
		assert.equal(rec2.rx, null, '仍然释放缓冲')

		// 定时器不会在 dispose 之后再发一条
		const box3 = fakeCtx()
		const rec3 = box3.ctx.claim('claim-7')
		Api._appendClaimRx(rec3, new Uint8Array([6]))
		Api._scheduleClaimFlush(rec3)
		// 插件仍在：dispose 会顺手把残余刷出（1 条），并清掉定时器
		Api._disposeClaimRx(rec3)
		assert.equal(rxEvents(box3.events).length, 1, 'dispose 刷出残余一次')
		await sleep(CLAIM_RX_WINDOW_MS + 30)
		assert.equal(rxEvents(box3.events).length, 1, 'dispose 后定时器不再补发第二条')
		assert.equal(rec3.rx, null, '缓冲已释放')
	}

	console.log('plugin-claim-rx: ok')
})().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
