// Run: node tests/test-flow.cjs — synthetic data only.
// 覆盖测试流程引擎 js/test-flow.js 的纯逻辑：步骤规范化与校验、{n} 替换、批量 / 随机生成(seed 可复现)、
// 值解码与回读比对、执行(顺序 / 延时 / 超时 / 重试 / 失败策略 / 写后回读 / 恢复原值)、统计与导出。
const assert = require('node:assert/strict')
const T = require('../js/test-flow.js')

// ---- 步骤规范化：默认值、范围夹取、必填项 ----
{
	const f = T.normalizeFlow({
		name: 'x',
		steps: [
			{ kind: 'read', field: 'a' },
			{ kind: 'write', field: 'a', value: 3, delayAfterMs: -5, timeoutMs: 1, retries: 99 },
			{ kind: 'wait', delayAfterMs: 120 },
			{ kind: 'send-raw', raw: 'AA BB' },
		],
	})
	assert.equal(f.steps.length, 4)
	assert.equal(f.steps[0].delayAfterMs, T.DEFAULTS.delayAfterMs, '省略的延时取全局默认')
	assert.equal(f.steps[1].value, '3', '值统一成字符串')
	assert.equal(f.steps[1].delayAfterMs, 0, '负延时夹到 0')
	assert.equal(f.steps[1].timeoutMs, 200, '超时下限 200ms')
	assert.equal(f.steps[1].retries, 5, '重试上限 5')
	assert.equal(f.steps[2].field, '', 'wait 不需要字段')
	assert.deepEqual(f.defaults, { delayAfterMs: 200, timeoutMs: 5000, retries: 0, onFailure: 'continue', restoreOriginals: true })
	assert.throws(() => T.normalizeStep({ kind: 'nope' }, 0), /类型不支持/)
	assert.throws(() => T.normalizeStep({ kind: 'read' }, 0), /缺少字段/)
	assert.throws(() => T.normalizeStep({ kind: 'send-raw' }, 0), /原始发送/)
	assert.equal(T.normalizeFlow({}).name, '未命名流程')
	assert.equal(T.normalizeFlow({ defaults: { onFailure: 'stop' } }).defaults.onFailure, 'stop')
	assert.equal(T.normalizeFlow({ defaults: { onFailure: 'whatever' } }).defaults.onFailure, 'continue', '未知失败策略回落到继续')
}

// ---- {n} 计数变量 ----
{
	assert.equal(T.substituteVars('{n}', { n: 7 }), '7')
	assert.equal(T.substituteVars('A{n}B{n}', { n: 2 }), 'A2B2')
	assert.equal(T.substituteVars('{n}-{missing}', { n: 1 }), '1-{missing}', '未知变量原样保留')
	assert.equal(T.substituteVars(null, { n: 1 }), '')
}

// ---- 值解码与比对 ----
const bcdField = { key: 'b', type: 'bcd', fillLen: 4 }
const asciiField = { key: 's', type: 'ascii', fillLen: 6 }
{
	// BCD 小端：00012345 → 45 23 01 00
	assert.equal(T.decodeFieldBytes([0x45, 0x23, 0x01, 0x00], bcdField), '12345')
	assert.ok(T.sameValue('12345', '00012345', bcdField), 'BCD 去前导零后相等')
	assert.equal(T.decodeFieldBytes([0x61, 0x62, 0x63, 0x00, 0x00, 0x00], asciiField), 'abc', 'ASCII 到第一个 0x00 为止')
	assert.ok(T.sameValue(T.decodeFieldBytes([0x61, 0x62, 0x63, 0x00], asciiField), 'abc', asciiField))
	assert.ok(!T.sameValue('abc', 'abd', asciiField))
	assert.equal(T.decodeFieldBytes([0x05], { key: 'u', type: 'uint8' }), 5)
	assert.equal(T.decodeFieldBytes([0xff, 0xff], { key: 'i', type: 'int16le' }), -1)
	assert.ok(T.sameValue('7', 7, { key: 'u', type: 'uint8' }))
	assert.deepEqual(T.parseHex('aa bb'), [0xaa, 0xbb])
	assert.equal(T.parseHex('aab'), null, '奇数位 HEX 不合法')
	assert.equal(T.hexOf([0x0a, 0xff]), '0A FF')
}

// ---- 随机生成：seed 可复现、值在量程内、写步骤不固定值 ----
const fields = [
	{ key: 'u8', name: 'U8', type: 'uint8', min: 1, max: 9, read: true, write: true },
	{ key: 'en', name: 'EN', type: 'enum', enum: [{ value: 1, label: 'A' }, { value: 3, label: 'B' }], read: true, write: true },
	{ key: 'ro', name: 'RO', type: 'uint8', min: 0, max: 9, read: true, write: false },
]
const queries = [{ key: 'q1', name: '查询', queryId: 1 }]
{
	const a = T.randomPlan({ seed: 42, count: 20, fields: fields, queries: queries })
	const b = T.randomPlan({ seed: 42, count: 20, fields: fields, queries: queries })
	const c = T.randomPlan({ seed: 43, count: 20, fields: fields, queries: queries })
	assert.deepEqual(a.steps.map(s => s.kind + ':' + s.field), b.steps.map(s => s.kind + ':' + s.field), '同 seed 同序列')
	assert.notDeepEqual(a.steps.map(s => s.kind + ':' + s.field), c.steps.map(s => s.kind + ':' + s.field), '不同 seed 不同序列')
	assert.ok(a.steps.length >= 20, '步数不少于要求')
	assert.ok(a.steps.every(s => s.kind !== 'write' || s.field !== 'ro'), '只读字段不会被随机写')
	assert.ok(a.steps.every(s => s.kind !== 'write' || s.randomValue), '随机写的值在运行时生成')
	assert.ok(a.steps.some(s => s.kind === 'verify'), '末尾有回读抽检')

	const rng = T.mulberry32(7)
	for (let i = 0; i < 50; i++) {
		const v = T.pickRandomValue(rng, fields[0])
		assert.ok(v >= 1 && v <= 9, '数值在量程内：' + v)
	}
	const rng2 = T.mulberry32(7)
	for (let i = 0; i < 20; i++) {
		const v = T.pickRandomValue(rng2, fields[1])
		assert.ok([1, 3].indexOf(v) !== -1, '枚举值只取枚举项')
	}
	const rng3 = T.mulberry32(1)
	const nv = T.newValueFor(rng3, fields[0], 5)
	assert.notEqual(nv, 5, '随机值不等于当前值')
	assert.equal(T.newValueFor(T.mulberry32(2), { key: 'x', type: 'uint8', min: 3, max: 3 }, 3), null, '只有一个取值时取不到新值')
	assert.ok(/^\d+$/.test(T.pickRandomValue(T.mulberry32(3), { key: 'b', type: 'bcd', fillLen: 3 })), 'BCD 生成纯数字')
}

// ---- 校验 ----
{
	const ok = T.normalizeFlow({ steps: [{ kind: 'write', field: 'u8', value: '5' }, { kind: 'read', field: 'u8' }] })
	assert.deepEqual(T.validateFlow(ok, fields), [])
	const bad = T.normalizeFlow({
		steps: [
			{ kind: 'write', field: 'nope', value: '1' },
			{ kind: 'write', field: 'ro', value: '1' },
			{ kind: 'write', field: 'u8', value: '99' },
			{ kind: 'write', field: 'en', value: '2' },
			{ kind: 'send-raw', raw: 'XYZ' },
		],
	})
	const errors = T.validateFlow(bad, fields)
	assert.equal(errors.length, 5)
	assert.match(errors[0].message, /字段不存在/)
	assert.match(errors[1].message, /不可写/)
	assert.match(errors[2].message, /大于上限/)
	assert.match(errors[3].message, /不在可选值内/)
	assert.match(errors[4].message, /HEX 不合法/)
	assert.equal(T.validateFlow(T.normalizeFlow({}), fields)[0].message, '流程没有步骤')
	// send-raw 的查询步骤按 flow.queries 找，没带目录时报不存在
	const qFlow = T.normalizeFlow({ steps: [{ kind: 'send-raw', query: 'q1' }], queries: queries })
	assert.deepEqual(T.validateFlow(qFlow, fields), [])
	const qMissing = T.validateFlow(T.normalizeFlow({ steps: [{ kind: 'send-raw', query: 'q1' }] }), fields)
	assert.match(qMissing[0].message, /查询用例不存在/)
	const bcdBad = T.validateFlow(T.normalizeFlow({ steps: [{ kind: 'write', field: 'bcd3', value: '12ab' }] }), [{ key: 'bcd3', name: 'B', type: 'bcd', fillLen: 3, write: true }])
	assert.match(bcdBad[0].message, /纯数字/)
	// 随机写的值在运行时生成：空值不算校验错误
	const randOk = T.validateFlow(T.normalizeFlow({ steps: [{ kind: 'write', field: 'bcd3', value: '', randomValue: true }] }), [{ key: 'bcd3', name: 'B', type: 'bcd', fillLen: 3, write: true }])
	assert.deepEqual(randOk, [], 'randomValue 步骤跳过静态值校验')
}

// ---- 执行：假设备 + 假串口 ----
function makeDevice(initial) {
	const store = new Map(Object.entries(initial || {}))
	return {
		store,
		readBytes: function (field) {
			if (!store.has(field.key)) return null
			const v = store.get(field.key)
			if (field.type === 'bcd') {
				const digits = String(v).padStart((field.fillLen || 2) * 2, '0')
				const out = []
				for (let i = digits.length - 2; i >= 0; i -= 2) out.push((Number(digits[i]) << 4) | Number(digits[i + 1]))
				return out
			}
			if (field.type === 'ascii') {
				const out = []
				for (let i = 0; i < (field.fillLen || 4); i++) out.push(i < String(v).length ? String(v).charCodeAt(i) : 0)
				return out
			}
			if (field.type === 'uint16le') return [v & 0xff, (v >> 8) & 0xff]
			return [v & 0xff]
		},
		write: function (field, value) {
			store.set(field.key, value)
		},
	}
}

function makeIo(opts) {
	const o = opts || {}
	const device = o.device
	let clock = 0
	const log = []
	const sleeps = []
	const sends = []
	let stop = false
	const io = {
		now: function () { return clock },
		sleep: function (ms) { sleeps.push(ms); clock += ms; return Promise.resolve() },
		isOpen: function () { return o.open === false ? false : true },
		shouldStop: function () { return stop },
		fields: o.fields || fields,
		queries: o.queries || queries,
		session: o.session || null,
		vars: o.vars || {},
		buildRead: function (f) { return { bytes: [0x10], request: { op: 'read', field: f.key } } },
		buildWrite: function (f, v) { return { bytes: [0x20], request: { op: 'write', field: f.key, value: v } } },
		buildQuery: function (q) { return { bytes: [0x30], request: { op: 'query', key: q.key } } },
		readField: function (frame, f) { return frame.bytes },
		send: function (bytes, request, timeoutMs) {
			sends.push({ request: request, timeoutMs: timeoutMs })
			const plan = o.plan ? o.plan(request, sends.length) : null
			if (plan === 'timeout') {
				clock += timeoutMs
				const e = new Error('等待响应超时(' + timeoutMs + 'ms)')
				e.timeout = true
				return Promise.reject(e)
			}
			if (plan && plan.unsupported) {
				const e = new Error('设备不支持')
				e.unsupported = true
				return Promise.reject(e)
			}
			const field = (o.fields || fields).filter(function (f) { return f.key === request.field })[0]
			if (request.op === 'write' && field) device.write(field, request.value)
			const data = field ? device.readBytes(field) : [0x01]
			return Promise.resolve({ frame: { bytes: data, raw: data }, raw: data, tx: data })
		},
		log: function (level, msg) { log.push(level + ': ' + msg) },
		onStep: function (r) { (o.steps || (o.steps = [])).push(r) },
		stop: function () { stop = true },
		ref: { log: log, sleeps: sleeps, sends: sends },
	}
	return io
}

async function runFlow(flow, io) {
	return await T.run(flow, io)
}

;(async function () {
	// 顺序、延时、恢复原值
	{
		const device = makeDevice({ u8: 3, en: 1 })
		const io = makeIo({ device: device })
		const flow = T.normalizeFlow({
			name: 'batch',
			defaults: { delayAfterMs: 50 },
			steps: [
				{ kind: 'write', field: 'u8', value: '7', verify: true },
				{ kind: 'write', field: 'en', value: '3' },
				{ kind: 'read', field: 'u8' },
				{ kind: 'wait', delayAfterMs: 30 },
			],
		})
		assert.deepEqual(T.validateFlow(flow, fields), [])
		const report = await runFlow(flow, io)
		assert.equal(report.results.length, 4)
		assert.deepEqual(report.results.map(r => r.status), ['success', 'success', 'success', 'success'])
		assert.equal(report.results[2].readValue, 7, '读步骤带回读到的值')
		assert.ok(io.ref.sleeps.includes(30), 'wait 步骤真的等待')
		assert.ok(io.ref.sleeps.filter(x => x === 50).length >= 2, '每步后有全局延时')
		assert.deepEqual(report.stats.success, 4)
		assert.equal(report.stats.total, 4)
		assert.deepEqual(report.restore.restored.sort(), ['EN', 'U8'], '写过的字段恢复原值')
		assert.equal(device.store.get('u8'), 3, '设备上的值已恢复')
		assert.equal(device.store.get('en'), 1)
		assert.equal(report.stopped, false)
		assert.equal(report.fatal, '')
	}

	// 写后回读不一致 → mismatch；失败策略 stop 中断后续步骤
	{
		const device = makeDevice({ u8: 1 })
		const io = makeIo({
			device: device,
			plan: function (request) {
				if (request.op === 'write' && request.value === '9') return null
				return null
			},
		})
		// 设备忽略 9 的写入：写 9 后回读还是原值
		const realWrite = device.write
		device.write = function (f, v) { if (String(v) === '9') return; realWrite(f, v) }
		const flow = T.normalizeFlow({
			defaults: { onFailure: 'stop', restoreOriginals: false },
			steps: [
				{ kind: 'write', field: 'u8', value: '9', verify: true },
				{ kind: 'read', field: 'u8' },
			],
		})
		const report = await runFlow(flow, io)
		assert.equal(report.results.length, 1, '失败即停，后续步骤不跑')
		assert.equal(report.results[0].status, 'mismatch')
		assert.match(report.results[0].reason, /写后回读不一致/)
		assert.equal(report.stopped, true)
	}

	// 超时与重试：前两次超时，第三次成功；重试后只留一条结果
	{
		const device = makeDevice({ u8: 2 })
		let n = 0
		const io = makeIo({
			device: device,
			plan: function () { n++; return n <= 2 ? 'timeout' : null },
		})
		const flow = T.normalizeFlow({
			defaults: { restoreOriginals: false, delayAfterMs: 0 },
			steps: [{ kind: 'read', field: 'u8', retries: 2, timeoutMs: 1000 }],
		})
		const report = await runFlow(flow, io)
		assert.equal(report.results.length, 1, '重试不产生重复结果行')
		assert.equal(report.results[0].status, 'success')
		assert.equal(report.results[0].attempts, 3)
		assert.ok(report.results[0].durationMs >= 2000, '超时计入耗时')
	}

	// 一直超时 → timeout；失败策略 continue 继续跑后面的步骤
	{
		const device = makeDevice({ u8: 2 })
		const io = makeIo({ device: device, plan: function () { return 'timeout' } })
		const flow = T.normalizeFlow({
			defaults: { restoreOriginals: false, delayAfterMs: 0 },
			steps: [{ kind: 'read', field: 'u8', timeoutMs: 500 }, { kind: 'wait', delayAfterMs: 1 }],
		})
		const report = await runFlow(flow, io)
		assert.deepEqual(report.results.map(r => r.status), ['timeout', 'success'])
		assert.equal(report.stats.timeout, 1)
		assert.equal(report.stats.failed, 1)
	}

	// 设备不支持（2/3 应答 / 字段缺失）按 unsupported 记，不中断
	{
		const device = makeDevice({})
		const io = makeIo({ device: device, plan: function () { return { unsupported: true } } })
		const flow = T.normalizeFlow({
			defaults: { restoreOriginals: false, delayAfterMs: 0 },
			steps: [{ kind: 'read', field: 'u8' }, { kind: 'read', field: 'en' }],
		})
		const report = await runFlow(flow, io)
		assert.deepEqual(report.results.map(r => r.status), ['unsupported', 'unsupported'])
		assert.equal(report.stats.failed, 0, '不支持不算失败')
	}

	// 随机流程：值真的写进设备、seed 可复现、写后回读通过
	{
		// seed 10 在这份目录下有读 / 写 / 抽检交错，且含只读字段的读(会按 unsupported 记)
		const plan = T.randomPlan({ seed: 10, count: 8, fields: fields, queries: queries, verify: true })
		const flow = T.normalizeFlow({
			name: 'random', kind: 'random', seed: plan.seed, defaults: { delayAfterMs: 0, restoreOriginals: false },
			steps: plan.steps,
		})
		const deviceA = makeDevice({ u8: 1, en: 1 })
		const ioA = makeIo({ device: deviceA })
		const a = await runFlow(flow, ioA)
		const deviceB = makeDevice({ u8: 1, en: 1 })
		const ioB = makeIo({ device: deviceB })
		const b = await runFlow(flow, ioB)
		assert.deepEqual(
			a.results.map(r => r.kind + ':' + (r.written || '')),
			b.results.map(r => r.kind + ':' + (r.written || '')),
			'同 seed 写同样的随机值'
		)
		assert.ok(a.results.some(r => r.written), '随机写真的生成了值')
		assert.ok(a.results.every(r => ['success', 'skipped', 'unsupported'].indexOf(r.status) !== -1), '假设备下没有失败 / 超时')
		assert.equal(deviceA.store.get('u8'), deviceB.store.get('u8'))
	}

	// 会话钩子：prepare 失败即致命，后面的步骤不跑
	{
		const io = makeIo({ device: makeDevice({}), session: { prepare: function () { return { bytes: [1], request: { op: 'query' } } }, idleMs: 20000 } })
		io.send = function (bytes, request) {
			const e = new Error('等待响应超时(5000ms)')
			e.timeout = true
			return Promise.reject(e)
		}
		const flow = T.normalizeFlow({ steps: [{ kind: 'read', field: 'u8' }] })
		const report = await runFlow(flow, io)
		assert.equal(report.results.length, 0)
		assert.match(report.fatal, /连通检查失败/)
	}

	// 停止：shouldStop 为真时不再执行后续步骤，串口还开着就仍恢复原值
	{
		const device = makeDevice({ u8: 4 })
		const io = makeIo({ device: device })
		const flow = T.normalizeFlow({
			defaults: { delayAfterMs: 0 },
			steps: [{ kind: 'write', field: 'u8', value: '6' }, { kind: 'read', field: 'u8' }, { kind: 'read', field: 'en' }],
		})
		const orig = io.onStep
		io.onStep = function (r, i, total) { orig(r, i, total); if (i === 0) io.stop() }
		const report = await runFlow(flow, io)
		assert.equal(report.stopped, true)
		assert.equal(report.results.length, 1)
		assert.equal(device.store.get('u8'), 4, '停止后仍恢复了原值')
	}

	// 导出：JSON 有流程与统计，CSV 每步一行
	{
		const device = makeDevice({ u8: 1 })
		const io = makeIo({ device: device })
		const flow = T.normalizeFlow({ name: '导出', defaults: { restoreOriginals: false }, steps: [{ kind: 'read', field: 'u8' }] })
		const report = await runFlow(flow, io)
		const json = JSON.parse(T.toJSON(report))
		assert.equal(json.flow.name, '导出')
		assert.equal(json.stats.total, 1)
		assert.equal(json.results[0].status, 'success')
		const csv = T.toCSV(report).split('\n')
		assert.equal(csv[0].split(',')[0], 'index')
		assert.equal(csv.length, 2)
		assert.match(csv[1], /成功/)
	}

	console.log('test-flow: ok')
})().catch(function (e) {
	console.error(e)
	process.exit(1)
})
