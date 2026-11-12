// Run: node tests/test-flow.cjs — synthetic data only.
// 覆盖测试流程引擎 js/test-flow.js 的纯逻辑：步骤规范化与校验、{n} 替换、批量 / 随机生成(seed 可复现)、
// 值解码与回读比对、执行(顺序 / 延时 / 超时 / 重试 / 失败策略 / 写后回读 / 恢复原值)、统计与导出。
const assert = require('node:assert/strict')
const T = require('../js/test-flow.js')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')

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
	// 浮点（契约类型）与小端字节序
	assert.equal(T.decodeFieldBytes([0, 0, 0x80, 0x3f], { key: 'f', type: 'float32le' }), 1)
	assert.equal(T.decodeFieldBytes([0, 0, 0, 0, 0, 0, 0xf0, 0x3f], { key: 'd', type: 'float64le' }), 1)
	assert.equal(T.decodeFieldBytes([0, 0, 0xc0, 0x3f], { key: 'f', type: 'float32le' }), 1.5)
	// 字节数不够：返回 null，不能拿残缺字节凑出一个错值
	assert.equal(T.decodeFieldBytes([0x01, 0x02], { key: 'u', type: 'uint32le' }), null)
	assert.equal(T.decodeFieldBytes([0x01], { key: 'f', type: 'float32le' }), null)
	assert.equal(T.decodeFieldBytes([0x01], { key: 'd', type: 'float64le' }), null)
	assert.equal(T.decodeFieldBytes([0x01], { key: 'u', type: 'uint16le' }), null)
	assert.ok(T.sameValue('7', 7, { key: 'u', type: 'uint8' }))
	assert.deepEqual(T.parseHex('aa bb'), [0xaa, 0xbb])
	assert.equal(T.parseHex('aab'), null, '奇数位 HEX 不合法')
	assert.equal(T.hexOf([0x0a, 0xff]), '0A FF')
}

// ---- 随机生成：seed 可复现、值在量程内、写步骤不固定值 ----
const fields = [
	{ key: 'u8', name: 'U8', type: 'uint8', min: 1, max: 9, read: true, write: true, random: true },
	{ key: 'en', name: 'EN', type: 'enum', enum: [{ value: 1, label: 'A' }, { value: 3, label: 'B' }], read: true, write: true, random: true },
	{ key: 'ro', name: 'RO', type: 'uint8', min: 0, max: 9, read: true, write: false, random: true },
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

	// 随机只进显式 random:true 的字段：缺省 / random:false / 非布尔一律排除
	{
		const mixed = [
			{ key: 'pwd', name: 'P', type: 'uint8', min: 0, max: 9, read: true, write: true, random: false },
			{ key: 'safe', name: 'S', type: 'uint8', min: 0, max: 9, read: true, write: true, random: true },
			{ key: 'unset', name: 'U', type: 'uint8', min: 0, max: 9, read: true, write: true },
			{ key: 'str', name: 'T', type: 'uint8', min: 0, max: 9, read: true, write: true, random: 'true' },
		]
		for (let seed = 1; seed <= 30; seed++) {
			const p = T.randomPlan({ seed: seed, count: 30, fields: mixed, queries: [] })
			assert.ok(p.steps.every(function (s) { return s.field === 'safe' }), '只有 random:true 的字段进随机计划 seed=' + seed)
			assert.ok(p.steps.length > 0, 'random:true 的字段确实被选中 seed=' + seed)
		}
		// 同一字段不连续出现
		const p2 = T.randomPlan({ seed: 11, count: 40, fields: fields, queries: queries })
		for (let i = 1; i < p2.steps.length; i++) {
			const prev = p2.steps[i - 1]
			const cur = p2.steps[i]
			assert.ok(!(prev.kind === 'write' && cur.kind === 'write' && prev.field === cur.field), '同一字段不连续写：' + cur.field)
		}
	}
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

	// ---- SEK 随机白名单：随机计划里的每个字段都必须在白名单内（30 个 seed）----
// SEK 字段目录在浏览器里组装，node 里用与 tools/protocol-fields-doc.mjs 相同的 stub 装载
{
	const sekTx = {
		buildDown: function () { return { frame: [], seq: 0, opts: {} } },
		funcValue: function () { return null },
		tag11Result: function () { return null },
		hasTag: function () { return false },
		findTlvItem: function () { return null },
		bytesEqual: function () { return false },
		clearBuffer: function () {},
		cancelAll: function () {},
	}
	let patch = null
	const window = { sekTx: sekTx }
	window.DeviceDockProtocols = {
		has: function () { return true },
		extend: function (id, p) { patch = p },
	}
	const ctx = vm.createContext({ window: window, console: console })
	ctx.globalThis = ctx
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/protocol-presets.js'), 'utf8'), ctx, { filename: 'protocol-presets.js' })
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/sek-test-profile.js'), 'utf8'), ctx, { filename: 'sek-test-profile.js' })
	assert.ok(patch && Array.isArray(patch.fields), 'sek-test-profile 产出 fields')
	const fields = patch.fields
	const whitelist = fields.filter(function (f) { return f.random === true })
	assert.ok(whitelist.length >= 19, 'SEK 白名单只有显式放行的字段（参数 + 只读 metrics）：' + whitelist.length)
	// 白名单里不允许出现链路 / 执行机构 / 标识 / 时钟 / 凭据类字段
	const bannedNames = ['连接模式', 'IP', 'APN', '表号', '密码', '密钥', '时钟', '时间参数', '启用标志', '阀门', '阀控', '开阀', '关阀', '休眠', '复位', '口径', '脉冲形式', '基准水量', '机电分离', '模组开关', '校时']
	whitelist.forEach(function (f) {
		bannedNames.forEach(function (word) {
			assert.ok(f.name.indexOf(word) === -1 && (f.key || '').indexOf(word) === -1, '白名单混入危险字段：' + f.key + ' ' + f.name + '（命中「' + word + '」）')
		})
		assert.notEqual(f.type, 'bcd', 'bcd 类（标识 / 表号）不进白名单：' + f.key)
		assert.notEqual(f.type, 'ascii', 'ascii 类（地址 / 凭据）不进白名单：' + f.key)
	})
	// 30 个 seed：随机计划里每个带字段的步骤都在白名单内（引擎过滤 random:false）
	for (let seed = 1; seed <= 30; seed++) {
		const p = T.randomPlan({ seed: seed, count: 30, fields: fields, queries: patch.queries || [] })
		p.steps.forEach(function (s) {
			if (!s.field) return
			const f = fields.filter(function (x) { return x.key === s.field })[0]
			assert.ok(f, '计划字段在目录内：' + s.field)
			assert.equal(f.random, true, '随机计划只出白名单字段：' + s.field + ' seed=' + seed)
		})
		// 回读步骤紧跟写步骤时必须指向同一字段
		for (let i = 1; i < p.steps.length; i++) {
			const prev = p.steps[i - 1]
			const cur = p.steps[i]
			if (cur.kind === 'verify' && prev.kind === 'write') {
				assert.equal(cur.field, prev.field, '紧跟写的回读必须同字段 seed=' + seed + ' i=' + i)
			}
		}
	}
	// 帧头信号字段（read:false）不会出现在计划里
	const planFieldsSeen = {}
	for (let seed = 1; seed <= 30; seed++) {
		const p = T.randomPlan({ seed: seed, count: 30, fields: fields, queries: patch.queries || [] })
		p.steps.forEach(function (s) { if (s.field) planFieldsSeen[s.field] = true })
	}
	Object.keys(planFieldsSeen).forEach(function (k) {
		const f = fields.filter(function (x) { return x.key === k })[0]
		assert.notEqual(f.read, false, 'read:false 的字段不进随机计划：' + k)
	})
}

	// 原值读不到就不写：步骤按原失败状态记录（含「未写入」），设备上的值不变
	{
		const device = makeDevice({ u8: 4 })
		const io = makeIo({ device: device, plan: function (req) { return req.op === 'read' ? 'timeout' : null } })
		const flow = T.normalizeFlow({ defaults: { restoreOriginals: false, delayAfterMs: 0 }, steps: [{ kind: 'write', field: 'u8', value: '9' }] })
		const report = await runFlow(flow, io)
		assert.equal(report.results[0].status, 'timeout')
		assert.match(report.results[0].reason, /未写入/)
		assert.equal(device.store.get('u8'), 4, '原值读不到时设备未被写入')
		// 设备未返回该字段：unsupported + 未写入
		const device2 = makeDevice({})
		const io2 = makeIo({ device: device2, plan: function () { return { unsupported: true } } })
		const report2 = await runFlow(T.normalizeFlow({ defaults: { restoreOriginals: false, delayAfterMs: 0 }, steps: [{ kind: 'write', field: 'u8', value: '9' }] }), io2)
		assert.equal(report2.results[0].status, 'unsupported')
		assert.match(report2.results[0].reason, /未写入/)
	}

	// 停止后不再重试：第一次超时置停止，重试循环立即收尾
	{
		let n = 0
		const io = makeIo({ device: makeDevice({ u8: 2 }), plan: function () { n++; return n === 1 ? 'timeout' : null } })
		io.shouldStop = function () { return n >= 1 }
		const flow = T.normalizeFlow({ defaults: { restoreOriginals: false, delayAfterMs: 0 }, steps: [{ kind: 'read', field: 'u8', retries: 3, timeoutMs: 500 }] })
		const report = await runFlow(flow, io)
		assert.equal(report.results[0].attempts, 1, '停止后不再重试')
		assert.equal(report.stopped, true)
	}

	// send-raw 的 expect 转成字节凭证（面板按原始响应字节匹配）
	{
		const captured = []
		const io = makeIo({ device: makeDevice({ u8: 1 }) })
		const rawSend = io.send
		io.send = function (bytes, request, timeoutMs) { captured.push(request); return rawSend(bytes, request, timeoutMs) }
		const flow = T.normalizeFlow({ defaults: { restoreOriginals: false, delayAfterMs: 0 }, steps: [{ kind: 'send-raw', raw: '01 02', expect: 'AA BB' }] })
		await runFlow(flow, io)
		assert.deepEqual(Array.from(captured[0].expectBytes), [0xaa, 0xbb], 'expect 转成字节放进凭证')
		// 非法期望 HEX 在校验阶段就被拒
		const bad = T.normalizeFlow({ steps: [{ kind: 'send-raw', raw: '0102', expect: 'XYZ' }] })
		const errors = T.validateFlow(bad, [])
		assert.ok(errors.some(function (e) { return /期望 HEX/.test(e.message) }), '非法期望 HEX 被校验拦下')
	}

	console.log('test-flow: ok')
})().catch(function (e) {
	console.error(e)
	process.exit(1)
})
