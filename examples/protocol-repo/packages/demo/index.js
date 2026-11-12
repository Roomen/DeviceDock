// DeviceDock 示例协议包（契约 v1）：一个 bundle 里放两个协议，演示「一个仓库可含多个协议」。
// 单文件 bundle：v1 不支持包内相对 import（Blob URL 无法解析相对路径），所有代码必须内联在这里。
// 宿主只调用 activate(host)，由它逐个 host.registerProtocol(def)；注册的 id 必须与 manifest.provides 完全一致。

function hex2(b) { return (b < 16 ? '0' : '') + (b & 0xff).toString(16).toUpperCase() }
function hexSpaced(bytes) {
	const out = []
	for (let i = 0; i < bytes.length; i++) out.push(hex2(bytes[i]))
	return out.join(' ')
}
function esc(s) {
	return String(s == null ? '' : s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function toBytes(value) {
	if (value instanceof Uint8Array) return value
	if (Array.isArray(value)) return Uint8Array.from(value)
	return new Uint8Array(0)
}

// ===================== 协议一：A5 LEN CMD DATA… XOR =====================
// A5 | LEN(1) | CMD(1) | DATA(LEN) | XOR(1，前 LEN+3 字节异或)
const A5_HEADER = 0xA5

function parseA5(bytes) {
	const raw = toBytes(bytes)
	const errors = []
	if (!raw.length || raw[0] !== A5_HEADER) {
		return { ok: false, fields: {}, errors: ['不是 A5 帧（首字节应为 0xA5）'] }
	}
	if (raw.length < 4) return { ok: false, fields: {}, errors: ['A5 帧太短，至少 4 字节'] }
	const len = raw[1]
	const cmd = raw[2]
	if (len > 32) return { ok: false, fields: {}, errors: ['A5 数据长度超过 32'] }
	const need = 4 + len
	if (raw.length < need) return { ok: false, fields: {}, errors: ['A5 帧不完整：需要 ' + need + ' 字节，实际 ' + raw.length] }
	let x = 0
	for (let i = 0; i < need - 1; i++) x ^= raw[i]
	const xorOk = (x & 0xff) === raw[need - 1]
	if (!xorOk) errors.push('异或校验不符：期望 ' + hex2(x & 0xff) + '，实际 ' + hex2(raw[need - 1]))
	const data = raw.subarray(3, 3 + len)
	return {
		ok: errors.length === 0,
		crcOk: xorOk,
		endOk: true,
		dir: cmd & 0x80 ? 'up' : 'down',
		raw: raw.subarray(0, need),
		frameOffset: 0,
		fields: {
			'帧头': '0xA5',
			'数据长度': String(len),
			'命令': '0x' + hex2(cmd),
			'数据': data.length ? hexSpaced(data) : '(无)',
			'异或校验': xorOk ? '✓' : '✗',
		},
		errors: errors,
		a5: { len: len, cmd: cmd, data: Array.from(data) },
	}
}

function formatA5(r) {
	const f = r.fields || {}
	let h = '<div class="sk-parse"><div class="sk-parse-bar">' + (r.ok ? '✓' : '✗') + '</div><table class="sk-parse-grid"><tbody>'
	const keys = Object.keys(f)
	for (let i = 0; i < keys.length; i += 3) {
		h += '<tr>'
		for (let j = 0; j < 3; j++) h += '<td class="sk-parse-hdr">' + (keys[i + j] ? esc(keys[i + j]) : '') + '</td>'
		h += '</tr><tr>'
		for (let j = 0; j < 3; j++) h += '<td>' + (keys[i + j] ? esc(f[keys[i + j]]) : '') + '</td>'
		h += '</tr>'
	}
	h += '</tbody></table>'
	;(r.errors || []).forEach(function (e) { h += '<div class="sk-parse-errors">' + esc(e) + '</div>' })
	return h + '</div>'
}

function logViewA5(r) {
	if (!r || !r.a5) return null
	const a5 = r.a5
	const m = {
		title: 'A5 帧',
		code: '0x' + hex2(a5.cmd),
		dir: r.dir,
		subject: { label: '命令', value: '0x' + hex2(a5.cmd) },
		badges: [],
		meta: [['数据长度', a5.len], ['数据', a5.data.length ? hexSpaced(a5.data) : '(无)']],
		notes: [],
		sections: [],
		errors: (r.errors || []).slice(),
	}
	m.badges.push(r.crcOk ? { text: '异或 ✓', kind: 'ok', title: '前 LEN+3 字节异或' } : { text: '异或 ✗', kind: 'bad', title: '校验字节不符' })
	if (a5.data.length) {
		const pairs = a5.data.map(function (b, i) { return ['字节 ' + i, '0x' + hex2(b)] })
		m.sections.push({ title: '数据域', pairs: pairs })
	}
	return m
}

function findA5(bytes) {
	const raw = toBytes(bytes)
	for (let i = 0; i + 4 <= raw.length; i++) {
		if (raw[i] !== A5_HEADER) continue
		const need = 4 + raw[i + 1]
		if (raw[i + 1] > 32 || i + need > raw.length) continue
		const sub = raw.subarray(i, i + need)
		const parsed = parseA5(sub)
		if (parsed.ok) return { found: true, offset: i, length: need, frame: sub, parse: parsed }
	}
	return null
}

// ===================== 协议二：Modbus RTU 只读 =====================
// 请求: 从站(1) 功能码(1) 起始寄存器(2,BE) 数量(2,BE) CRC(2,LE)
// 应答: 从站(1) 功能码(1) 字节数(1) 数据(n) CRC(2,LE)；异常应答: 从站 功能码|0x80 异常码 CRC(2)
function crc16(buf, len) {
	let crc = 0xFFFF
	for (let i = 0; i < len; i++) {
		crc ^= buf[i]
		for (let b = 0; b < 8; b++) crc = (crc & 1) ? ((crc >>> 1) ^ 0xA001) : (crc >>> 1)
	}
	return crc & 0xFFFF
}

const MODBUS_EXCEPTION = {
	1: '非法功能码', 2: '非法数据地址', 3: '非法数据值', 4: '从站设备故障',
	5: '确认（处理中）', 6: '从站设备忙', 8: '存储奇偶校验错误', 10: '网关路径不可用', 11: '网关目标无响应',
}

function parseModbus(bytes) {
	const raw = toBytes(bytes)
	const errors = []
	if (raw.length < 5) return { ok: false, fields: {}, errors: ['Modbus 帧至少 5 字节'] }
	const addr = raw[0]
	const func = raw[1]
	const crcCalc = crc16(raw, raw.length - 2)
	const crcGot = raw[raw.length - 2] | (raw[raw.length - 1] << 8)
	const crcOk = crcCalc === crcGot
	if (!crcOk) errors.push('CRC16 不符：期望 ' + hexSpaced([crcCalc & 0xff, (crcCalc >> 8) & 0xff]) + '，实际 ' + hexSpaced([raw[raw.length - 2], raw[raw.length - 1]]))
	const fields = { '从站地址': String(addr), '功能码': '0x' + hex2(func) }
	let dir = 'up'
	let regs = []
	if (func & 0x80) {
		const code = raw[2]
		fields['异常码'] = String(code) + (MODBUS_EXCEPTION[code] ? '（' + MODBUS_EXCEPTION[code] + '）' : '')
	} else if ((func === 0x03 || func === 0x04) && raw.length === 8) {
		dir = 'down'
		fields['起始寄存器'] = String((raw[2] << 8) | raw[3])
		fields['寄存器数量'] = String((raw[4] << 8) | raw[5])
	} else if (func === 0x03 || func === 0x04) {
		const count = raw[2]
		if (raw.length !== 5 + count) {
			errors.push('应答长度不符：字节数 ' + count + '，实际 ' + (raw.length - 5))
		} else if (count % 2 !== 0) {
			errors.push('应答字节数必须是偶数')
		} else {
			for (let i = 0; i < count; i += 2) regs.push((raw[3 + i] << 8) | raw[4 + i])
			fields['寄存器数量'] = String(regs.length)
			fields['寄存器值'] = regs.map(function (v, i) { return 'R' + i + '=' + v }).join(' ')
		}
	} else {
		errors.push('只演示功能码 0x03 / 0x04（读保持 / 输入寄存器）')
	}
	fields['CRC16'] = crcOk ? '✓' : '✗'
	return {
		ok: errors.length === 0,
		crcOk: crcOk,
		endOk: true,
		dir: dir,
		raw: raw,
		frameOffset: 0,
		fields: fields,
		errors: errors,
		mb: { addr: addr, func: func, regs: regs },
	}
}

function formatModbus(r) {
	const f = r.fields || {}
	let h = '<div class="sk-parse"><div class="sk-parse-bar">' + (r.ok ? '✓' : '✗') + '</div><table class="sk-parse-grid"><tbody>'
	const keys = Object.keys(f)
	for (let i = 0; i < keys.length; i += 3) {
		h += '<tr>'
		for (let j = 0; j < 3; j++) h += '<td class="sk-parse-hdr">' + (keys[i + j] ? esc(keys[i + j]) : '') + '</td>'
		h += '</tr><tr>'
		for (let j = 0; j < 3; j++) h += '<td>' + (keys[i + j] ? esc(f[keys[i + j]]) : '') + '</td>'
		h += '</tr>'
	}
	h += '</tbody></table>'
	;(r.errors || []).forEach(function (e) { h += '<div class="sk-parse-errors">' + esc(e) + '</div>' })
	return h + '</div>'
}

function logViewModbus(r) {
	if (!r || !r.mb) return null
	const mb = r.mb
	const exception = !!(mb.func & 0x80)
	const request = r.dir === 'down'
	const title = exception ? '异常应答' : (request ? '读寄存器请求' : (mb.func === 0x04 ? '读输入寄存器应答' : '读保持寄存器应答'))
	const m = {
		title: title,
		code: '0x' + hex2(mb.func),
		dir: r.dir,
		subject: { label: '从站', value: String(mb.addr) },
		badges: [],
		meta: [],
		notes: [],
		sections: [],
		errors: (r.errors || []).slice(),
	}
	m.badges.push(r.crcOk ? { text: 'CRC ✓', kind: 'ok', title: 'Modbus CRC16' } : { text: 'CRC ✗', kind: 'bad', title: 'CRC16 不符' })
	if (exception) m.badges.push({ text: '异常', kind: 'bad' })
	if (mb.regs.length) {
		m.sections.push({
			title: '寄存器',
			pairs: mb.regs.map(function (v, i) { return ['R' + i, String(v), '0x' + ((v >> 8) & 0xff ? hex2((v >> 8) & 0xff) + ' ' + hex2(v & 0xff) : hex2(v & 0xff))] }),
		})
	}
	const f = r.fields || {}
	;['起始寄存器', '寄存器数量', '异常码'].forEach(function (k) {
		if (f[k] != null) m.meta.push([k, f[k]])
	})
	return m
}

function findModbus(bytes) {
	const raw = toBytes(bytes)
	for (let i = 0; i + 5 <= raw.length; i++) {
		const func = raw[i + 1]
		if (!(func === 0x03 || func === 0x04 || func === 0x83 || func === 0x84)) continue
		let need
		if (func & 0x80) need = 5
		else if (raw.length - i === 8 && ((raw[i + 4] << 8) | raw[i + 5]) > 0) need = 8
		else need = 5 + raw[i + 2]
		if (need < 5 || i + need > raw.length) continue
		const sub = raw.subarray(i, i + need)
		const parsed = parseModbus(sub)
		if (parsed.ok) return { found: true, offset: i, length: need, frame: sub, parse: parsed }
	}
	return null
}

// ===================== 曲线演示：字段目录 + metrics =====================
// 协议只输出 fields（目录，含 chart 标记）与 metrics(frame)（数值点），画图由宿主统一做。
// 演示约定：上行帧（命令最高位为 1）数据域前 2 字节是 uint16 LE 电压 0.01V，接着 2 字节是 uint16 LE 瞬时流量 L/h。
const A5_FIELDS = [
	{ key: 'a5-voltage', name: 'A5 电压', group: '演示数据', type: 'uint16le', unit: '0.01V', min: 0, max: 65535, chart: true, read: false, write: false },
	{ key: 'a5-flow', name: 'A5 瞬时流量', group: '演示数据', type: 'uint16le', unit: 'L/h', min: 0, max: 65535, chart: true, read: false, write: false },
]
function metricsA5(frame) {
	if (!frame || !frame.a5 || frame.dir !== 'up') return []
	const d = frame.a5.data
	const out = []
	if (d.length >= 2) out.push({ key: 'a5-voltage', value: (d[0] | (d[1] << 8)) & 0xffff })
	if (d.length >= 4) out.push({ key: 'a5-flow', value: (d[2] | (d[3] << 8)) & 0xffff })
	return out
}

// ===================== 入口 =====================
export function activate(host) {
	host.registerProtocol({
		id: 'demo.a5frame',
		name: 'A5 帧演示',
		parseFrame: parseA5,
		formatFrame: formatA5,
		logView: logViewA5,
		findFrame: findA5,
		fields: A5_FIELDS,
		metrics: metricsA5,
		presets: [],
	})
	host.registerProtocol({
		id: 'demo.modbus-rtu',
		name: 'Modbus RTU（只读）',
		parseFrame: parseModbus,
		formatFrame: formatModbus,
		logView: logViewModbus,
		findFrame: findModbus,
		presets: [],
	})
}
