'use strict'
// 协议事务层(js/sek-transaction.js)常驻接收的回归：
// 没有事务在等时不扫描、缓冲有界；有事务在等时混在普通流量里的应答照样认出来，且找帧开销不随流量平方增长。
// 只用合成数据。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const src = function (f) { return fs.readFileSync(path.join(__dirname, '../js/' + f + '.js'), 'utf8') }

function makeWorld() {
	const receivers = []
	const scans = { sek: 0 }
	let writes = 0
	let pins = 0
	let lastWriteToken = null
	let wrongUnpin = false
	let writer = function () { return Promise.resolve() }
	const window = {
		registerProtocol() {},
		serialApi: {
			onReceive(cb) { receivers.push(cb) },
			isOpen() { return true },
			pinSession() { pins++; return 'txn-stub' },
			unpinSession(t) { if (t !== 'txn-stub') { wrongUnpin = true; return } pins-- },
			getActiveSendSid() { return 'S' },
			writeData(bytes, opts) { writes++; lastWriteToken = opts && opts.token; return writer(bytes) },
		},
	}
	const ctx = { window, Uint8Array, Float32Array, BigInt, TextDecoder, TextEncoder, console, setTimeout, clearTimeout, Date, performance,
		localStorage: { getItem() { return null }, setItem() {} },
		document: { getElementById() { return null }, addEventListener() {} } }
	vm.createContext(ctx)
	for (const f of ['parse-view', 'protocol-schema', 'protocol-crypto', 'protocol', 'sek-transaction']) {
		vm.runInContext(src(f), ctx)
	}
	// SEK 生命周期测试使用合成解析模型；真实 CRC/组帧由协议回归覆盖。
	ctx.skBuildDownFrame = function () { return new Uint8Array([1]) }
	ctx.skFindFrame = function (bytes) {
		scans.sek++
		const offset = bytes.indexOf(0xA9)
		if (offset < 0 || bytes.length - offset < 27) return { found: false }
		const frame = bytes.slice(offset, offset + 27)
		return { found: true, offset, length: 27, frame, parse: { dir: 'up', ok: true,
			fields: { '功能码': 0x81, '帧序号': frame[2] }, tlv: [{ tag: 11, items: [{ resultCode: frame[3] }] }] } }
	}
	return { window, scans, get writes() { return writes }, get pins() { return pins },
		get lastWriteToken() { return lastWriteToken }, get wrongUnpin() { return wrongUnpin },
		setWriter(fn) { writer = fn }, feed(bytes) { for (const cb of receivers) cb(bytes) } }
}

const line = '[12:34:56.789] [INFO] sensor z=1234 temp=25.3 ok\r\n'
const text = function (n) { return new Uint8Array(Buffer.from(line.repeat(Math.ceil(n / line.length))).subarray(0, n)) }
const cat = function (...parts) {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let o = 0
	for (const p of parts) { out.set(p, o); o += p.length }
	return out
}
const feedChunks = function (w, data, size) { for (let o = 0; o < data.length; o += size) w.feed(data.subarray(o, o + size)) }

;(async function () {
	{
		// 闲置：115200 满速文本 1 秒、1024B 一块，不能逐个候选找帧
		const w = makeWorld()
		feedChunks(w, text(11520), 1024)
		assert.deepEqual(w.scans, { sek: 0 }, '闲置普通流量不调用找帧器')

		// 回修 6 · 5：SEK 事务拿到令牌后，发送必须携带令牌（无令牌会被归属检查拦截）
		{
			const w2 = makeWorld()
			const opts = { timeoutMs: 500 }
			const p2 = w2.window.sekTx.sendAndWait(opts)
			w2.feed(new Uint8Array([0xA9, 0x9A, 1, 1, ...new Array(23).fill(0)]))
			await p2
			assert.equal(w2.lastWriteToken, 'txn-stub', 'SEK 事务发送携带事务令牌（5dbfab5 不传 → undefined）')
			assert.equal(w2.wrongUnpin, false, '成对的 unpin 带令牌')
		}
		// 有事务在等：应答混在文本里，前后都有噪声，照样认出
		const up = new Uint8Array([0xA9, 0x9A, 1, 1, ...new Array(23).fill(0)])
		const p = w.window.sekTx.waitFor(function (f) { return f.dir === 'up' }, 1000)
		feedChunks(w, cat(text(5000), up, text(5000)), 1024)
		const res = await p
		assert.deepEqual(Array.from(res.raw), Array.from(up))
		assert.ok(w.scans.sek < 30, '每块噪声只找一遍，不逐个失败候选重扫')

		// 应答在等待开始前刚到(尾巴里)也能认出
		w.feed(up)
		const late = await w.window.sekTx.waitFor(function (f) { return f.dir === 'up' }, 1000)
		assert.deepEqual(Array.from(late.raw), Array.from(up))

		// 应答被拆成多块
		const p2 = w.window.sekTx.waitFor(function (f) { return f.dir === 'up' }, 1000)
		feedChunks(w, cat(text(300), up), 7)
		assert.deepEqual(Array.from((await p2).raw), Array.from(up))
	}

	// 新请求必须等待新应答；公共被动等待仍保留接收先于等待的语义。
	{
		const w = makeWorld()
		const tx = w.window.sekTx
		const response = new Uint8Array([0xA9, 0x9A, 1, 1, ...new Array(23).fill(0)])
		const opts = { frame: new Uint8Array([1]), timeoutMs: 1000, match() { return true } }
		w.feed(response)
		assert.deepEqual(Array.from((await tx.waitFor(function () { return true }, 1000)).raw), Array.from(response))
		w.feed(response)
		let matched = false
		const p = tx.sendAndWait(opts).then(function (res) { matched = true; return res })
		await Promise.resolve()
		await Promise.resolve()
		assert.equal(matched, false, '不用发送前的旧应答完成新请求')
		w.feed(response)
		assert.deepEqual(Array.from((await p).raw), Array.from(response))
		assert.equal(w.pins, 0)

		// 同步写回快速应答：等待必须在写入前已经挂好。
		w.setWriter(function () { w.feed(response); return Promise.resolve() })
		assert.deepEqual(Array.from((await tx.sendAndWait(opts)).raw), Array.from(response))

		// 写失败只撤掉这笔等待，后续接收不能再触发旧匹配器。
		let oldMatches = 0
		w.setWriter(function () { return Promise.reject(new Error('synthetic write failure')) })
		await assert.rejects(tx.sendAndWait({ ...opts, match() { oldMatches++; return true } }), /synthetic write failure/)
		w.feed(response)
		assert.equal(oldMatches, 0)
		assert.equal(w.pins, 0)
		assert.equal(w.writes, 3)
		// 写操作还没完成时等待超时，拒绝已被观察，最终仍向调用方报告超时。
		w.setWriter(function () { return new Promise(resolve => setTimeout(resolve, 15)) })
		await assert.rejects(tx.sendAndWait({ ...opts, timeoutMs: 1 }), /超时/)
		assert.equal(w.pins, 0)

		let finishWrite
		w.setWriter(function () { return new Promise(resolve => { finishWrite = resolve }) })
		const canceled = tx.sendAndWait(opts)
		const canceledCheck = assert.rejects(canceled, /synthetic cancellation/)
		tx.cancelAll('synthetic cancellation')
		finishWrite()
		await canceledCheck
		assert.equal(w.pins, 0)
	}

	console.log('protocol-transactions: ok')
})().catch(function (e) { console.error(e); process.exit(1) })
