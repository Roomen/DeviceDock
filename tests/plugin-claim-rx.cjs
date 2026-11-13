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

// 打开一个 claim 的「新 gen」（不经过真串口）：与 openClaim 成功后的动作一致
function openGen(Api, rec) {
	rec.gen = (rec.gen || 0) + 1
	rec.rxOffset = 0
	rec.rx = null
	rec.gens = rec.gens || {}
	rec.gens[rec.gen] = { rxSeq: 0, ackedSeq: 0, offset: 0 }
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
		// 缺口先排队（每 claim 至多一条待发缺口），下一次 flush 时才随批次一起发出
		assert.equal(gapEvents(box.events).length, 0, '缺口先排队')
		assert.ok(Api._pendingClaimGap(rec), '待发缺口已登记')
		const pending = Api._pendingClaimGap(rec)
		assert.equal(pending.offset, 0)
		assert.equal(pending.bytes, over)
		assert.equal(pending.reason, 'overflow')
		Api._flushClaimRx(rec)
		const gaps = gapEvents(box.events)
		assert.equal(gaps.length, 1, '空缓冲时的单块超限也要报告')
		assert.equal(gaps[0].payload.claimId, 'claim-big-chunk')
		assert.equal(gaps[0].payload.gen, 1)
		assert.equal(gaps[0].payload.offset, 0, '被丢的是流的最开头')
		assert.equal(gaps[0].payload.bytes, over, '报告实际丢弃字节数')
		assert.equal(gaps[0].payload.reason, 'overflow')
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
		assert.equal(gapEvents(box.events).length, 0, '缺口先排队，flush 时才发')
		Api._flushClaimRx(rec)
		const gaps = gapEvents(box.events)
		assert.equal(gaps.length, 1)
		assert.equal(gaps[0].payload.bytes, 1024)
		assert.equal(gaps[0].payload.offset, 0)
		assert.equal(gaps[0].payload.reason, 'overflow')
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
		assert.equal(Api._claimInflight(rec), 4, 'inflight = 各 gen (rxSeq - ackedSeq) 之和')
		// 第 5 批：在途已满 → 不发送，数据留在缓冲
		one.fill(9)
		Api._appendClaimRx(rec, one)
		Api._flushClaimRx(rec)
		assert.equal(rxEvents(box.events).length, 4, '在途 4 批时停止发送')
		assert.equal(rec.rx.bytes, CLAIM_RX_FLUSH_BYTES, '数据留在缓冲里')
		// 未 ack 继续灌：先补到刚好 8 MiB，这一步不应产生缺口
		const rest = new Uint8Array(CLAIM_RX_MAX_BYTES - CLAIM_RX_FLUSH_BYTES)
		rest.fill(1)
		Api._appendClaimRx(rec, rest)
		assert.equal(gapEvents(box.events).length, 0, '补满到 8 MiB 不算缺口')
		// 再灌 256 KiB → 缓冲溢出，缺口排队（flush 时才发）
		const overflow = new Uint8Array(CLAIM_RX_FLUSH_BYTES)
		overflow.fill(2)
		Api._appendClaimRx(rec, overflow)
		assert.equal(Api._pendingClaimGap(rec).bytes, CLAIM_RX_FLUSH_BYTES, '缺口已排队')
		assert.equal(rec.rx.bytes <= CLAIM_RX_MAX_BYTES, true, '缓冲不超上限')
		// ack 到第 2 批 → ackedSeq=2、inflight=2，缺口+缓冲数据立刻继续发
		const gapBytes = Api._pendingClaimGap(rec).bytes
		assert.equal(Api._ackClaimRx(rec, 1, 2), true)
		assert.equal(rec.gens[1].ackedSeq, 2)
		assert.equal(Api._claimInflight(rec), 3, 'ack 后先发 gap 再发一批 → 3')
		const gaps = gapEvents(box.events)
		assert.equal(gaps.length, 1, 'ack 触发时把待发缺口发出去')
		assert.equal(gaps[0].payload.reason, 'overflow')
		assert.equal(gaps[0].payload.claimId, 'claim-bp')
		const sent = rxEvents(box.events)
		assert.equal(sent.length, 5, 'ack 之后继续发送')
		assert.equal(sent[4].payload.seq, 5)
		assert.equal(sent[4].payload.offset, 4 * CLAIM_RX_FLUSH_BYTES + gapBytes, 'offset 体现缺口（含被丢字节）')
	}

	// ---- 5b. 缺口合并：连续丢弃只留一条待发缺口，offset 保留首次起点 ----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-gap-merge')
		openGen(Api, rec)
		// 先在途占满 4 批，让缓冲只能靠丢弃腾地方
		const chunk = new Uint8Array(CLAIM_RX_MAX_BYTES)
		chunk.fill(1)
		Api._appendClaimRx(rec, chunk)
		for (let i = 0; i < 8; i++) {
			const more = new Uint8Array(1024)
			more.fill(i)
			Api._appendClaimRx(rec, more)
		}
		const pending = Api._pendingClaimGap(rec)
		assert.ok(pending, '有且只有一条待发缺口')
		assert.equal(pending.offset, 0, 'offset 保留首次丢弃起点')
		assert.equal(pending.bytes, 8 * 1024, '连续丢弃累加进同一条缺口')
		assert.equal(gapEvents(box.events).length, 0, '仍未发送（等 flush / 定时器）')
		// reason 不同：先发旧的再开新的
		Api._queueClaimGap(rec, 999, 5, 'closing')
		const sentGaps = gapEvents(box.events)
		assert.equal(sentGaps.length, 1, 'reason 变化时先发旧的')
		assert.equal(sentGaps[0].payload.reason, 'overflow')
		assert.equal(Api._pendingClaimGap(rec).reason, 'closing', '新的缺口换 reason')
		assert.equal(Api._pendingClaimGap(rec).bytes, 5)
		// 定时器与缺口一起被清掉，不空转
		Api._disposeClaimRx(rec, { discard: true })
		assert.equal(rec.rx, null)
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
		assert.equal(Api._claimInflight(rec), 1)
		assert.equal(Api._ackClaimRx(rec, 2, 1), false, '旧 gen 被忽略')
		assert.equal(Api._claimInflight(rec), 1, '状态不变')
		assert.equal(Api._ackClaimRx(rec, 1, 5), false, '超前 seq 被忽略')
		assert.equal(Api._claimInflight(rec), 1)
		assert.equal(Api._ackClaimRx(rec, 1, 1), true)
		assert.equal(Api._claimInflight(rec), 0)
		assert.equal(rec.gens[1], undefined, '该 gen 全部确认后条目被删除')
		// 重复 / 旧 ack 不再改变任何状态
		assert.equal(Api._ackClaimRx(rec, 1, 1), false, '重复 ack 被忽略（gen 条目已删除）')
		assert.equal(Api._claimInflight(rec), 0)
		assert.equal(Api._ackClaimRx(null, 1, 1), false, '未知 claim 被忽略')

		// 重复 / 旧 ack 不能提前释放在途：发 4 批后 ack 到 2，再重复 ack 2 不再变化
		const box2 = fakeCtx()
		const rec2 = box2.ctx.claim('claim-ack2')
		openGen(Api, rec2)
		const buf = new Uint8Array(CLAIM_RX_FLUSH_BYTES)
		for (let i = 0; i < 4; i++) { buf.fill(i); Api._appendClaimRx(rec2, buf); Api._flushClaimRx(rec2) }
		assert.equal(Api._claimInflight(rec2), 4)
		assert.equal(Api._ackClaimRx(rec2, 1, 2), true)
		assert.equal(Api._claimInflight(rec2), 2, 'inflight 按 gen 记账')
		assert.equal(Api._ackClaimRx(rec2, 1, 2), false, '重复 ack 不前进')
		assert.equal(Api._claimInflight(rec2), 2, '重复 ack 不改变 inflight')
		assert.equal(Api._ackClaimRx(rec2, 1, 1), false, '旧 ack（更小 seq）被忽略')
		assert.equal(Api._claimInflight(rec2), 2)
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

	// ---- 10. SDK：自动 ack、同 claim 串行、抛错仍 ack 并报 onError ----
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
		const offFirst = sdk.claim.onRx(function (pkt) { got.push(pkt) })
		sdk.claim.onGap(function (g) { got.push({ gap: g }) })
		sdk._handleMessage({ data: Rpc.eventEnvelope('claim.rx', { claimId: 'c1', gen: 3, seq: 7, offset: 100, at: 1, bytes: new Uint8Array([1, 2, 3]) }) })
		await sdk._claimQueueDone('c1')
		assert.equal(got.length, 1)
		assert.ok(got[0].bytes instanceof Uint8Array, 'SDK 归一成 Uint8Array')
		assert.equal(got[0].gen, 3)
		assert.equal(got[0].seq, 7)
		assert.equal(got[0].offset, 100)
		const acks = () => sent.filter((m) => m && m.method === 'claim.ack')
		assert.equal(acks().length, 1, '回调结束后自动 ack')
		assert.equal(acks()[0].params.claimId, 'c1')
		assert.equal(acks()[0].params.gen, 3)
		assert.equal(acks()[0].params.seq, 7)

		// 串行测试只保留一个监听，避免同步监听先把 seq 都确认掉
		offFirst()
		// ---- 串行：同 claim 的批次必须依次执行，ack 也按序 ----
		const order = []
		let releaseEarly
		const slow = new Promise((r) => { releaseEarly = r })
		const offSlow = sdk.claim.onRx(function (pkt) {
			if (pkt.seq === 2) { order.push('start2'); return slow.then(function () { order.push('end2') }) }
			order.push('start' + pkt.seq)
			return Promise.resolve().then(function () { order.push('end' + pkt.seq) })
		})
		sdk._handleMessage({ data: Rpc.eventEnvelope('claim.rx', { claimId: 'c2', gen: 1, seq: 1, offset: 0, at: 1, bytes: new Uint8Array([1]) }) })
		sdk._handleMessage({ data: Rpc.eventEnvelope('claim.rx', { claimId: 'c2', gen: 1, seq: 2, offset: 1, at: 2, bytes: new Uint8Array([2]) }) })
		await sleep(10)
		// 第 1 批已完成并 ack；第 2 批的回调还在等 Promise，第 3 批（seq 3）不能开始
		assert.equal(order[0], 'start1')
		assert.equal(acks().filter((m) => m.params.claimId === 'c2').length, 1, '只 ack 了第 1 批')
		// 第二批先放行（模拟乱序完成的压力）：仍必须等第一批结束
		sdk._handleMessage({ data: Rpc.eventEnvelope('claim.rx', { claimId: 'c2', gen: 1, seq: 3, offset: 2, at: 3, bytes: new Uint8Array([3]) }) })
		await sleep(10)
		assert.equal(order.indexOf('start3'), -1, '第 2 批在等 Promise，第 3 批不能插队')
		releaseEarly()
		await sdk._claimQueueDone('c2')
		assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3'], '同 claim 串行且有序')
		const c2acks = acks().filter((m) => m.params.claimId === 'c2').map((m) => m.params.seq)
		assert.deepEqual(c2acks, [1, 2, 3], '按序 ack，累积确认只覆盖连续完成批次')
		offSlow()

		// ---- 抛错 / 拒绝：仍 ack（视为已消费），并调用 onError ----
		const errors = []
		sdk.setClaimErrorHandler(function (e, info) { errors.push({ message: String(e && e.message), seq: info && info.seq }) })
		const offThrow = sdk.claim.onRx(function (pkt) { if (pkt.seq === 4) throw new Error('boom-sync') })
		sdk._handleMessage({ data: Rpc.eventEnvelope('claim.rx', { claimId: 'c3', gen: 1, seq: 4, offset: 0, at: 1, bytes: new Uint8Array([1]) }) })
		await sdk._claimQueueDone('c3')
		assert.equal(errors.length, 1)
		assert.equal(errors[0].message, 'boom-sync')
		assert.equal(errors[0].seq, 4)
		assert.equal(acks().filter((m) => m.params.claimId === 'c3' && m.params.seq === 4).length, 1, '抛错仍 ack（视为已消费）')
		offThrow()
		const offReject = sdk.claim.onRx(function (pkt) { if (pkt.seq === 5) return Promise.reject(new Error('boom-async')) })
		sdk._handleMessage({ data: Rpc.eventEnvelope('claim.rx', { claimId: 'c3', gen: 1, seq: 5, offset: 1, at: 2, bytes: new Uint8Array([2]) }) })
		await sdk._claimQueueDone('c3')
		assert.equal(errors.length, 2)
		assert.equal(errors[1].message, 'boom-async')
		assert.equal(acks().filter((m) => m.params.claimId === 'c3' && m.params.seq === 5).length, 1, '拒绝仍 ack')
		offReject()

		// ---- ACK 即发即忘：不登记 pending（不产生等待响应的 Promise / 定时器）----
		{
			const before = sdk._pendingCount()
			sdk.claim.ack('c1', 3, 7)
			sdk.claim.ack('c1', 3, 8)
			assert.equal(sdk._pendingCount(), before, 'ACK 不登记 pending')
			assert.equal(sdk.claim.ack('c1', 3, 9), undefined, '公开 claim.ack 返回 undefined')
			const acksSent = sent.filter((m) => m && m.method === 'claim.ack')
			assert.equal(acksSent.length >= 3, true, 'ACK 仍然真的发出去了')
			assert.equal(acksSent[acksSent.length - 1].params.seq, 9)
			// 等一个超时窗口后仍无 pending（真的没有定时器在跑）
			await sleep(20)
			assert.equal(sdk._pendingCount(), before, '没有残留 pending')
		}

		// ---- gap 事件形状 ----
		sdk._handleMessage({ data: Rpc.eventEnvelope('claim.gap', { claimId: 'c1', gen: 3, offset: 200, bytes: 64, reason: 'overflow' }) })
		const gap = got.filter((g) => g.gap)[0].gap
		assert.equal(gap.claimId, 'c1')
		assert.equal(gap.gen, 3)
		assert.equal(gap.offset, 200)
		assert.equal(gap.bytes, 64)
		assert.equal(gap.reason, 'overflow')
	}


	// ---- 11. 截断后保留的尾部是独立拷贝（不引用超大底层缓冲）----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-copy')
		openGen(Api, rec)
		const over = 4096
		const huge = new Uint8Array(CLAIM_RX_MAX_BYTES + over)
		huge.fill(3)
		Api._appendClaimRx(rec, huge)
		const st = rec.rx
		assert.equal(st.chunks.length, 1, '只剩一块')
		const kept = st.chunks[0]
		assert.equal(kept.length, CLAIM_RX_MAX_BYTES)
		assert.ok(kept.buffer.byteLength <= CLAIM_RX_MAX_BYTES, '保留尾部是独立拷贝，底层缓冲不超过上限')
		assert.notEqual(kept.buffer, huge.buffer, '不再是原始大缓冲的视图')

		// 缓冲内切前缀同样不该继续引用原底层缓冲
		const box2 = fakeCtx()
		const rec2 = box2.ctx.claim('claim-copy2')
		openGen(Api, rec2)
		const roomy = new Uint8Array(CLAIM_RX_MAX_BYTES)
		roomy.fill(1)
		Api._appendClaimRx(rec2, roomy)
		const tail = roomy.slice(0, 1024) // 视图
		Api._appendClaimRx(rec2, new Uint8Array(4096))
		assert.ok(rec2.rx.chunks[0].buffer.byteLength <= CLAIM_RX_MAX_BYTES, '切前缀后的块也是独立拷贝')
	}

	// ---- 12. claim.ack 轻量校验：O(1)、不枚举对象、不再限流 ----
	{
		const ok = Rpc.validateAck({ __devicedock: 1, id: 'r1', method: 'claim.ack', params: { claimId: 'c1', gen: 1, seq: 2 } })
		assert.equal(ok.ok, true)
		assert.equal(ok.claimId, 'c1')
		assert.equal(Rpc.validateAck({ __devicedock: 1, id: 'r1', method: 'serial.write', params: {} }), null, '不是 ack 返回 null')
		// 多余键忽略即可（不做固定键白名单枚举）——取值本身 O(1)
		assert.equal(Rpc.validateAck({ __devicedock: 1, id: 'r1', method: 'claim.ack', params: { claimId: 'c1', gen: 1, seq: 2, extra: 'x' } }).ok, true, '多余 params 键被忽略')
		assert.equal(Rpc.validateAck({ __devicedock: 1, id: 'r1', method: 'claim.ack', params: { claimId: 'c1', gen: 1, seq: 2 }, extra: {} }).ok, true, '多余顶层键被忽略')
		// 畸形：非字符串 / 空 / 超长 claimId、非安全正整数 gen / seq、协议号不对、id 缺失
		const bad = [
			{ __devicedock: 1, id: 'r1', method: 'claim.ack', params: { claimId: 1, gen: 1, seq: 2 } },
			{ __devicedock: 1, id: 'r1', method: 'claim.ack', params: { claimId: '', gen: 1, seq: 2 } },
			{ __devicedock: 1, id: 'r1', method: 'claim.ack', params: { claimId: 'x'.repeat(65), gen: 1, seq: 1 } },
			{ __devicedock: 1, id: 'r1', method: 'claim.ack', params: { claimId: 'c1', gen: 0, seq: 2 } },
			{ __devicedock: 1, id: 'r1', method: 'claim.ack', params: { claimId: 'c1', gen: 1, seq: 1.5 } },
			{ __devicedock: 1, id: 'r1', method: 'claim.ack', params: { claimId: 'c1', gen: 1, seq: -3 } },
			{ __devicedock: 1, id: 'r1', method: 'claim.ack', params: { claimId: 'c1', gen: 1, seq: 2 ** 60 } },
			{ __devicedock: 1, id: 'r1', method: 'claim.ack', params: { claimId: 'c1', gen: 1 } },
			{ __devicedock: 2, id: 'r1', method: 'claim.ack', params: { claimId: 'c1', gen: 1, seq: 2 } },
			{ __devicedock: 1, id: '', method: 'claim.ack', params: { claimId: 'c1', gen: 1, seq: 2 } },
			{ __devicedock: 1, id: 'r1', method: 'claim.ack', params: 'not-an-object' },
		]
		bad.forEach((m, i) => assert.equal(Rpc.validateAck(m).ok, false, '畸形 ack #' + i + ' 必须被拒'))
		// O(1)：固定字段直读，不 Object.keys / 不遍历；5000 次很快
		const hugeAck = { __devicedock: 1, id: 'r1', method: 'claim.ack', params: { claimId: 'c1', gen: 1, seq: 2 } }
		let t0 = Date.now()
		for (let i = 0; i < 5000; i++) Rpc.validateAck(hugeAck)
		assert.ok(Date.now() - t0 < 2000, '轻量校验不做遍历，5000 次也很便宜')
		// 不再单独限流：失败会让收发停住，重复 / 不前进的 ACK 在 API 层被忽略
		assert.equal(Rpc.ACK_LIMITS, undefined, 'ACK 限流已删除')
		assert.equal(Rpc.ackAdmission, undefined)
		assert.equal(Rpc.newAckState, undefined)
	}

	// ---- 12b. 能力 / 归属：无 serial.claim 的 ack 被丢；别人的 claimId 无效 ----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-mine')
		openGen(Api, rec)
		Api._appendClaimRx(rec, new Uint8Array([1]))
		Api._flushClaimRx(rec)
		assert.equal(Api._claimInflight(rec), 1)
		// 别的插件的 claimId：ctx.claimRecord 只认本 view 的声明表
		const otherBox = fakeCtx()
		const res = await Api.call('claim.ack', { claimId: 'claim-mine', gen: 1, seq: 1 }, otherBox.ctx)
		assert.equal(res.ack, false, '别的插件的 claimId 无效')
		assert.equal(Api._claimInflight(rec), 1, '额度没被别人的 ack 释放')
		// 能力校验：没有 serial.claim 时 authorize 返回错误 → 宿主丢弃、不调用 API
		assert.equal(Rpc.authorize(['device.read'], 'claim.ack').code, 'capability_denied')
		assert.equal(Rpc.authorize(['serial.claim'], 'claim.ack'), null)
	}

	// ---- 13. 关闭时在途已满：不发数据，只发 closing 缺口 ----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-closing-full')
		openGen(Api, rec)
		const buf = new Uint8Array(CLAIM_RX_FLUSH_BYTES)
		for (let i = 0; i < CLAIM_RX_INFLIGHT_MAX; i++) { buf.fill(i); Api._appendClaimRx(rec, buf); Api._flushClaimRx(rec) }
		assert.equal(rxEvents(box.events).length, 4)
		assert.equal(Api._claimInflight(rec), 4, '在途已满')
		// 还有残留在缓冲里
		const rest = new Uint8Array(1024)
		rest.fill(7)
		Api._appendClaimRx(rec, rest)
		const beforeOffset = rec.rxOffset
		Api._disposeClaimRx(rec)
		const rx = rxEvents(box.events)
		assert.equal(rx.length, CLAIM_RX_INFLIGHT_MAX, '关闭不越过在途上限（不再强发第 5 批）')
		const gaps = gapEvents(box.events)
		assert.equal(gaps.length, 1, '残余并入 closing 缺口')
		assert.equal(gaps[0].payload.reason, 'closing')
		assert.equal(gaps[0].payload.bytes, 1024)
		assert.equal(gaps[0].payload.offset, beforeOffset, '缺口 offset 是残余起点')
		assert.equal(rec.rx, null)

		// 在途未满时：能发多少发多少，发得下就不产生 closing 缺口
		const box2 = fakeCtx()
		const rec2 = box2.ctx.claim('claim-closing-room')
		openGen(Api, rec2)
		Api._appendClaimRx(rec2, new Uint8Array([1, 2, 3]))
		Api._disposeClaimRx(rec2)
		assert.equal(rxEvents(box2.events).length, 1, '在途有空间时正常发残余')
		assert.equal(gapEvents(box2.events).length, 0, '没有缺口')
	}

	// ---- 14. 在途额度跨 gen 累计：旧 gen 未确认继续占额度，旧 gen 的 ack 能释放 ----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-gen-ack')
		openGen(Api, rec)
		const buf = new Uint8Array(CLAIM_RX_FLUSH_BYTES)
		Api._appendClaimRx(rec, buf)
		Api._flushClaimRx(rec)
		Api._appendClaimRx(rec, buf)
		Api._flushClaimRx(rec)
		assert.equal(Api._claimInflight(rec), 2, 'gen1 有 2 批在途')
		Api._disposeClaimRx(rec)
		openGen(Api, rec)
		assert.equal(rec.gen, 2)
		assert.equal(Api._claimInflight(rec), 2, '旧 gen 未确认的批次继续占用额度')
		// 新 gen 只能再发 2 批（总共 4）
		Api._appendClaimRx(rec, buf)
		Api._flushClaimRx(rec)
		assert.equal(Api._claimInflight(rec), 3)
		Api._appendClaimRx(rec, buf)
		Api._flushClaimRx(rec)
		assert.equal(Api._claimInflight(rec), 4)
		// 再灌不发（在途已满），且也不发缺口（本轮规则 4）
		Api._appendClaimRx(rec, buf)
		const beforeRx = rxEvents(box.events).length
		const beforeGap = gapEvents(box.events).length
		Api._flushClaimRx(rec)
		assert.equal(rxEvents(box.events).length, beforeRx, '在途满时不发数据')
		assert.equal(gapEvents(box.events).length, beforeGap, '在途满时也不发缺口')
		assert.equal(rec.rx.bytes, CLAIM_RX_FLUSH_BYTES, '数据留在缓冲')
		// 旧 gen 的 ack 生效并释放额度：腾出的 1 个名额立刻被缓冲里的数据用掉（这才是背压的意义）
		assert.equal(Api._ackClaimRx(rec, 1, 1), true, '旧 gen 的 ack 照样生效')
		assert.equal(Api._claimInflight(rec), 4, '释放的名额立刻被新 gen 的缓冲数据用掉')
		assert.equal(gapEvents(box.events).length, beforeGap, '这条路径不该产生缺口（缺口是 overflow/closing）')
		// 旧 gen 全部确认 → 条目删除，额度真正回到 3
		assert.equal(Api._ackClaimRx(rec, 1, 2), true)
		assert.equal(Api._claimInflight(rec), 3)
		assert.equal(rec.gens[1], undefined, '旧 gen 全部确认后条目删除')
		assert.equal(Api._ackClaimRx(rec, 1, 1), false, '已删除 gen 的 ack 被忽略')
	}

	// ---- 15. 关闭 → 打开循环：总在途始终 ≤ 4；旧 gen ack 释放额度 ----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-cycle')
		const buf = new Uint8Array(CLAIM_RX_FLUSH_BYTES)
		for (let cycle = 0; cycle < 3; cycle++) {
			openGen(Api, rec)
			for (let i = 0; i < 6; i++) {
				Api._appendClaimRx(rec, buf)
				Api._flushClaimRx(rec)
			}
			assert.ok(Api._claimInflight(rec) <= CLAIM_RX_INFLIGHT_MAX, 'cycle ' + cycle + ' 在途 ≤ 4')
			Api._disposeClaimRx(rec)
			assert.ok(Api._claimInflight(rec) <= CLAIM_RX_INFLIGHT_MAX, 'cycle ' + cycle + ' 关闭后仍 ≤ 4')
		}
		assert.equal(Api._claimInflight(rec), 4, '三轮共 12 批尝试，实际只放出 4 批')
		assert.equal(rxEvents(box.events).length, 4, '反复 open 不会突破上限')
		// 只有 gen1 真有已发批次（4 批）；gen2/3 的数据在关闭时都记成了 closing 缺口
		assert.equal(rec.gens[1].rxSeq, 4, 'gen1 发出 4 批')
		assert.equal(rec.gens[2].rxSeq, 0, 'gen2 一个都没发出去（额度已被 gen1 占满）')
		assert.equal(Api._ackClaimRx(rec, 1, 4), true, '旧 gen 的 ack 释放额度')
		assert.equal(Api._claimInflight(rec), 0)
		assert.equal(rec.gens[1], undefined, 'gen1 全部确认后删除')
		// gen2/3 没有未确认批次，ack 自然被忽略
		assert.equal(Api._ackClaimRx(rec, 2, 1), false)
	}

	// ---- 16. 在途已满 + 高频小块：缺口事件条数 ≤ 时长/16 ms + 1 ----
	{
		const box = fakeCtx()
		const rec = box.ctx.claim('claim-gap-rate')
		openGen(Api, rec)
		const buf = new Uint8Array(CLAIM_RX_FLUSH_BYTES)
		for (let i = 0; i < 4; i++) { Api._appendClaimRx(rec, buf); Api._flushClaimRx(rec) }
		assert.equal(Api._claimInflight(rec), 4)
		const started = Date.now()
		// 灌满缓冲并持续制造丢弃
		const fill = new Uint8Array(CLAIM_RX_MAX_BYTES - 0)
		Api._appendClaimRx(rec, fill)
		for (let i = 0; i < 2000; i++) {
			Api._appendClaimRx(rec, new Uint8Array(256))
			Api._flushClaimRx(rec)
		}
		await sleep(CLAIM_RX_WINDOW_MS * 4)
		const elapsed = Date.now() - started
		const gaps = gapEvents(box.events)
		const bound = Math.ceil(elapsed / CLAIM_RX_WINDOW_MS) + 2
		assert.ok(gaps.length <= bound, '缺口条数 ' + gaps.length + ' ≤ ' + bound + '（时长 ' + elapsed + 'ms）')
		// 可对账：所有缺口 bytes 之和 = 实际丢弃总量（每块 256 B）
		const totalGapBytes = gaps.reduce((a, g) => a + g.payload.bytes, 0)
		assert.ok(totalGapBytes >= 2000 * 256, '缺口字节覆盖全部丢弃')
		assert.equal(Api._pendingClaimGap(rec) === null || Api._pendingClaimGap(rec).bytes >= 0, true)
	}

	console.log('plugin-claim-rx: ok')
})().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
