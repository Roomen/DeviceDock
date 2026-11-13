// Run: node tests/plugin-claim-rx.cjs — 全部合成数据，不连真串口。
// 覆盖 claim.rx 合批（gen / seq / offset）、背压（在途 4 批 + claim.ack）、
// 8 MiB 缓冲与单块超限（截前缀、claim.gap 报告）、关闭途中兑现的读块不丢、
// claim.gap 不受数据事件配额、claim.ack 免 RPC 配额且旧 gen / 未知 claim 被忽略、
// close→open 后 gen +1 且 seq / offset 重新起算、SDK 自动 ack。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const Rpc = require('../js/plugin-rpc.js')
const apiSrc = fs.readFileSync(path.join(__dirname, '../js/plugin-api.js'), 'utf8')
const sdkSrc = fs.readFileSync(path.join(__dirname, '../sdk/devicedock-plugin.js'), 'utf8')

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
				closing: false, closingTask: null, writeTask: null, rx: null, gen: 0,
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

// 打开一个 claim 的“新 gen”（不经过真串口）：与 openClaim 成功后的动作一致
function openGen(Api, rec) {
	rec.gen = (rec.gen || 0) + 1
	rec.rxSeq = 0
	rec.rxOffset = 0
	rec.rx = null
	return rec.gen
}

const rxEvents = (events) => events.filter((e) => e.name === 'claim.rx')
const gapEvents = (events) => events.filter((e) => e.name === 'claim.gap')
const dropEvents = (events) => events.filter((e) => e.name === 'events.dropped')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async function () {
	const Api = loadApi().PluginApi
	const { CLAIM_RX_WINDOW_MS, CLAIM_RX_FLUSH_BYTES, CLAIM_RX_MAX_BYTES, CLAIM_RX_INFLIGHT_MAX } = Api
	assert.equal(CLAIM_RX_WINDOW_MS, 16)
	assert.equal(CLAIM_RX_FLUSH_BYTES, 256 * 1024)
	assert.equal(CLAIM_RX_MAX_BYTES, 8 * 1024 * 1024)
	assert.equal(CLAIM_RX_INFLIGHT_MAX, 4)

	// ---- 1. 高频小块合成一批：字节不丢不乱序、seq / offset 正确、bytes 是 Uint8Array ----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-1')
		openGen(Api, rec)
		for (let i = 0; i < 120; i++) {
			const chunk = new Uint8Array(512)
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
		assert.equal(p.gen, 1, 'gen 从 1 起')
		assert.equal(p.seq, 1, 'seq 在同一 gen 内从 1 起')
		assert.equal(p.offset, 0, '第一批 offset 为 0')
		assert.ok(p.bytes instanceof Uint8Array, 'bytes 必须是 Uint8Array')
		assert.equal(p.bytes.length, 120 * 512, '字节数不丢')
		for (let i = 0; i < 120; i++) {
			assert.equal(p.bytes[i * 512], i & 0xff, '第 ' + i + ' 块首字节（顺序）')
			assert.equal(p.bytes[i * 512 + 1], (i >> 8) & 0xff, '第 ' + i + ' 块次序')
		}
		assert.ok(p.at > 0, 'at 是本批第一块的到达时间')

		// 第二批：seq +1，offset = 上一批 offset + 上一批长度
		Api._appendClaimRx(rec, new Uint8Array([9, 9]))
		Api._flushClaimRx(rec)
		const evs2 = rxEvents(box.events)
		assert.equal(evs2.length, 2)
		assert.equal(evs2[1].payload.seq, 2, 'seq 单调递增')
		assert.equal(evs2[1].payload.offset, evs2[0].payload.offset + evs2[0].payload.bytes.length, 'offset 连续')
		assert.deepEqual(Array.from(evs2[1].payload.bytes), [9, 9])

		// 不同 claim 各自计数（gen 也独立）
		const rec2 = box.ctx.claim('claim-2')
		openGen(Api, rec2)
		Api._appendClaimRx(rec2, new Uint8Array([1]))
		Api._flushClaimRx(rec2)
		const last = rxEvents(box.events).pop().payload
		assert.equal(last.claimId, 'claim-2')
		assert.equal(last.gen, 1)
		assert.equal(last.seq, 1, 'seq 按 claim 独立')
		assert.equal(last.offset, 0)
	}

	// ---- 2. 字节阈值：达到 256 KiB 立刻刷 ----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-3')
		openGen(Api, rec)
		const chunk = new Uint8Array(CLAIM_RX_FLUSH_BYTES)
		chunk.fill(7)
		assert.equal(Api._appendClaimRx(rec, chunk), true, '达到 256 KiB 阈值要立刻刷')
		Api._flushClaimRx(rec)
		assert.equal(rxEvents(box.events).length, 1)
		assert.equal(rxEvents(box.events)[0].payload.bytes.length, CLAIM_RX_FLUSH_BYTES)
	}

	// ---- 3. 单块 > 8 MiB：截掉前缀（保留最新），实际丢弃全部计入 claim.gap ----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-big-chunk')
		openGen(Api, rec)
		const over = 1024
		const big = new Uint8Array(CLAIM_RX_MAX_BYTES + over)
		for (let i = 0; i < big.length; i++) big[i] = i & 0xff
		Api._appendClaimRx(rec, big)
		const gaps = gapEvents(box.events)
		assert.equal(gaps.length, 1, '空缓冲时的单块超限也要报告')
		assert.equal(gaps[0].payload.claimId, 'claim-big-chunk')
		assert.equal(gaps[0].payload.gen, 1)
		assert.equal(gaps[0].payload.offset, 0, '被丢的是流的最开头')
		assert.equal(gaps[0].payload.bytes, over, '报告实际丢弃字节数')
		assert.equal(gaps[0].payload.reason, 'overflow')
		Api._flushClaimRx(rec)
		const p = rxEvents(box.events)[0].payload
		assert.equal(p.bytes.length, CLAIM_RX_MAX_BYTES, '缓冲恰为上限')
		assert.equal(p.offset, over, 'offset 已推进到丢弃之后')
		assert.equal(p.bytes[0], over & 0xff, '保留的是最新字节（前缀被截掉）')
		assert.equal(p.bytes[p.bytes.length - 1], (big.length - 1) & 0xff)
		assert.equal(dropEvents(box.events).length, 0, '不再用 events.dropped 表达 claim 丢弃')
	}

	// ---- 4. 缓冲溢出：丢最早、claim.gap 带起点、后续批次 offset 体现缺口 ----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-overflow')
		openGen(Api, rec)
		const big = new Uint8Array(CLAIM_RX_MAX_BYTES)
		for (let i = 0; i < big.length; i++) big[i] = i & 0xff
		Api._appendClaimRx(rec, big)
		assert.equal(gapEvents(box.events).length, 0, '刚好 8 MiB 时不丢')
		const extra = new Uint8Array(1024)
		extra.fill(0xAB)
		Api._appendClaimRx(rec, extra)
		const gaps = gapEvents(box.events)
		assert.equal(gaps.length, 1)
		assert.equal(gaps[0].payload.bytes, 1024)
		assert.equal(gaps[0].payload.offset, 0)
		assert.equal(gaps[0].payload.reason, 'overflow')
		Api._flushClaimRx(rec)
		const p = rxEvents(box.events)[0].payload
		assert.equal(p.bytes.length, CLAIM_RX_MAX_BYTES)
		assert.equal(p.offset, 1024, 'offset 含已丢弃的字节')
		assert.equal(p.bytes[0], 1024 & 0xff, '丢的是最早的字节')
		assert.equal(p.bytes[p.bytes.length - 1], 0xAB, '最新的字节保留')
	}

	// ---- 5. 背压：在途 4 批后停发、ack 恢复、未 ack 时缓冲满报 claim.gap ----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-bp')
		openGen(Api, rec)
		const one = new Uint8Array(CLAIM_RX_FLUSH_BYTES)
		// 发满 4 批（每批 256 KiB，走阈值路径）
		for (let i = 0; i < CLAIM_RX_INFLIGHT_MAX; i++) {
			one.fill(i)
			Api._appendClaimRx(rec, one)
			Api._flushClaimRx(rec)
		}
		assert.equal(rxEvents(box.events).length, 4, '已发 4 批')
		// 第 5 批：在途已满 → 不发送，数据留在缓冲
		one.fill(9)
		Api._appendClaimRx(rec, one)
		Api._flushClaimRx(rec)
		assert.equal(rxEvents(box.events).length, 4, '在途 4 批时停止发送')
		assert.equal(rec.rx.bytes, CLAIM_RX_FLUSH_BYTES, '数据留在缓冲里')
		// 未 ack 继续灌：缓冲涨到 8 MiB 后再来一块 → 丢最早并报 claim.gap
		// 先补到刚好 8 MiB（256 KiB 已在缓冲里），这一步不应产生缺口
		const rest = new Uint8Array(CLAIM_RX_MAX_BYTES - CLAIM_RX_FLUSH_BYTES)
		rest.fill(1)
		Api._appendClaimRx(rec, rest)
		assert.equal(gapEvents(box.events).length, 0, '补满到 8 MiB 不算缺口')
		const overflow = new Uint8Array(CLAIM_RX_FLUSH_BYTES)
		overflow.fill(2)
		Api._appendClaimRx(rec, overflow)
		const gaps = gapEvents(box.events)
		assert.equal(gaps.length, 1, '缓冲满时报告缺口')
		assert.equal(gaps[0].payload.reason, 'overflow')
		assert.equal(gaps[0].payload.claimId, 'claim-bp')
		assert.equal(rec.rx.bytes <= CLAIM_RX_MAX_BYTES, true, '缓冲不超上限')
		// ack 到第 2 批 → 在途降到 2，缓冲里的数据立刻继续发，offset 跳过被丢的字节
		const gapBytes = gaps[0].payload.bytes
		const gapOffset = gaps[0].payload.offset
		assert.equal(Api._ackClaimRx(rec, 1, 2), true)
		// ack 到 2 → 在途 4-2=2，随即因为缓冲还有数据又发了一批 → 3
		assert.equal(rec.rx.inflight, 3)
		const sent = rxEvents(box.events)
		assert.equal(sent.length, 5, 'ack 之后继续发送')
		assert.equal(sent[4].payload.seq, 5)
		assert.equal(sent[4].payload.offset, 4 * CLAIM_RX_FLUSH_BYTES + gapBytes, 'offset 体现缺口（含被丢字节）')
		assert.ok(sent[4].payload.offset > gapOffset)
	}

	// ---- 6. 关闭途中兑现的读块不丢（直接驱动 readClaim 的循环体语义）----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-closing-read')
		openGen(Api, rec)
		// 模拟：reader.read() 兑现了一块有效数据，同时关闭已经把 rec.reading 置 false
		rec.reading = false
		const value = new Uint8Array([1, 2, 3, 4])
		// readClaim 的新顺序：先入缓冲再判断退出
		if (value && value.length) Api._appendClaimRx(rec, value)
		assert.equal(rec.rx.bytes, 4, '已读到的数据必须入缓冲')
		// 关闭流程最后 force 刷残余
		Api._disposeClaimRx(rec)
		const evs = rxEvents(box.events)
		assert.equal(evs.length, 1, '关闭时刷出残余')
		assert.deepEqual(Array.from(evs[0].payload.bytes), [1, 2, 3, 4])
		assert.equal(rec.rx, null, '缓冲随 claim 释放')
	}

	// ---- 7. claim.gap 不受数据事件配额；claim.ack 免 RPC 配额 ----
	{
		assert.equal(Rpc.isDirectEvent('claim.rx'), true)
		assert.equal(Rpc.isDirectEvent('claim.gap'), true)
		assert.equal(Rpc.isDirectEvent('serial.rx'), false, '其它数据事件照旧限流')
		assert.deepEqual(Rpc.DIRECT_EVENTS, ['claim.rx', 'claim.gap'])
		assert.equal(Rpc.isQuotaExemptMethod('claim.ack'), true)
		assert.equal(Rpc.isQuotaExemptMethod('serial.write'), false)
		assert.equal(Rpc.METHODS['claim.ack'], 'serial.claim', 'claim.ack 归 serial.claim 能力')
		// 配额耗尽后普通数据事件被拒，但 DIRECT 判定仍为真（宿主直接放行）
		let st = Rpc.newEventState()
		for (let i = 0; i < Rpc.EVENT_LIMITS.maxEventsPerWindow; i++) st = Rpc.eventAdmission(st, 1000, Rpc.EVENT_LIMITS).state
		assert.equal(Rpc.eventAdmission(st, 1000, Rpc.EVENT_LIMITS).ok, false)
		assert.equal(Rpc.isDirectEvent('claim.gap'), true)
	}

	// ---- 8. claim.ack：旧 gen / 未知 claim / 超前 seq 被忽略 ----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-ack')
		openGen(Api, rec)
		Api._appendClaimRx(rec, new Uint8Array([1]))
		Api._flushClaimRx(rec)
		assert.equal(rec.rx.inflight, 1)
		assert.equal(Api._ackClaimRx(rec, 2, 1), false, '旧 gen 被忽略')
		assert.equal(rec.rx.inflight, 1, '状态不变')
		assert.equal(Api._ackClaimRx(rec, 1, 5), false, '超前 seq 被忽略')
		assert.equal(rec.rx.inflight, 1)
		assert.equal(Api._ackClaimRx(rec, 1, 1), true)
		assert.equal(rec.rx.inflight, 0)
		assert.equal(Api._ackClaimRx(null, 1, 1), false, '未知 claim 被忽略')
		// RPC 层也是「忽略不报错」
		const res = await Api.call('claim.ack', { claimId: 'nope', gen: 9, seq: 3 }, box.ctx)
		assert.equal(res.ack, false, '未知 claim 的 ack 只回 ack:false，不报错')
	}

	// ---- 9. close → open：gen +1，seq / offset 重新起算 ----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-gen')
		openGen(Api, rec)
		Api._appendClaimRx(rec, new Uint8Array([1, 2]))
		Api._flushClaimRx(rec)
		assert.equal(rxEvents(box.events).pop().payload.gen, 1)
		// close（模拟 openClaim 里的重置路径）
		Api._disposeClaimRx(rec)
		openGen(Api, rec)
		assert.equal(rec.gen, 2, 'gen 跨 open 递增')
		Api._appendClaimRx(rec, new Uint8Array([7]))
		Api._flushClaimRx(rec)
		const p = rxEvents(box.events).pop().payload
		assert.equal(p.gen, 2, '新 gen')
		assert.equal(p.seq, 1, 'seq 在新 gen 内重新起算')
		assert.equal(p.offset, 0, 'offset 在新 gen 内归零')
	}

	// ---- 10. SDK 自动 ack（假宿主）----
	{
		const sent = []
		const fakeWin = {
			document: { documentElement: { setAttribute() {}, getAttribute() { return null }, style: { setProperty() {} } } },
			__DEVICEDOCK_HOST_TARGET__: { postMessage: (msg) => sent.push(msg) },
			addEventListener() {},
		}
		const ctx = { console, setTimeout, clearTimeout, JSON, Math, Date, Uint8Array, Array, Object, Number, Error, Map, Set, Promise, fakeWin }
		ctx.window = ctx
		ctx.globalThis = ctx
		ctx.parent = fakeWin.__DEVICEDOCK_HOST_TARGET__
		vm.runInNewContext(sdkSrc, ctx)
		const sdk = ctx.DeviceDockPlugin
		const got = []
		sdk.claim.onRx(function (pkt) { got.push(pkt) })
		sdk.claim.onGap(function (g) { got.push({ gap: g }) })
		sdk._handleMessage({ data: Rpc.eventEnvelope('claim.rx', { claimId: 'c1', gen: 3, seq: 7, offset: 100, at: 1, bytes: new Uint8Array([1, 2, 3]) }) })
		assert.equal(got.length, 1)
		assert.ok(got[0].bytes instanceof Uint8Array, 'SDK 归一成 Uint8Array')
		assert.equal(got[0].gen, 3)
		assert.equal(got[0].seq, 7)
		assert.equal(got[0].offset, 100)
		const acks = sent.filter((m) => m && m.method === 'claim.ack')
		assert.equal(acks.length, 1, '回调结束后自动 ack')
		assert.equal(acks[0].params.claimId, 'c1')
		assert.equal(acks[0].params.gen, 3)
		assert.equal(acks[0].params.seq, 7)
		// 异步回调：Promise 结束后再 ack
		sdk.claim.onGap(function () {})
		let releaseAck
		const p = new Promise((r) => { releaseAck = r })
		const off = sdk.claim.onRx(function () { return p })
		sdk._handleMessage({ data: Rpc.eventEnvelope('claim.rx', { claimId: 'c1', gen: 3, seq: 8, offset: 103, at: 2, bytes: new Uint8Array([4]) }) })
		await sleep(10)
		// 第一个监听是同步的（它收到 seq 8 后立刻 ack），异步那位还没 ack
		const ackSeq = () => sent.filter((m) => m && m.method === 'claim.ack' && m.params.seq === 8).length
		assert.equal(ackSeq(), 1, 'Promise 未结束前异步监听不 ack')
		releaseAck()
		await sleep(10)
		assert.equal(ackSeq(), 2, 'Promise 结束后补 ack')
		off()
		// gap 事件形状
		sdk._handleMessage({ data: Rpc.eventEnvelope('claim.gap', { claimId: 'c1', gen: 3, offset: 200, bytes: 64, reason: 'overflow' }) })
		const gap = got.filter((g) => g.gap)[0].gap
		assert.equal(gap.claimId, 'c1')
		assert.equal(gap.gen, 3)
		assert.equal(gap.offset, 200)
		assert.equal(gap.bytes, 64)
		assert.equal(gap.reason, 'overflow')
	}

	console.log('plugin-claim-rx: ok')
})().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
