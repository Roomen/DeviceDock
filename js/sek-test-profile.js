// 内置 SEK 协议的字段目录、查询目录与契约钩子（fields / queries / metrics / buildRead / buildWrite /
// matchResponse / readField / buildQuery / session）。测试流程引擎与曲线面板只经这些钩子工作，
// 引擎里不写任何 SEK 帧格式。
// 加载顺序：js/common.js 先注册 sek 的基本解析函数，js/sek-transaction.js 提供 sekTx，
// 本文件随后用 DeviceDockProtocols.extend 把测试相关部分补进同一个协议对象。
;(function (root) {
	'use strict'

	const Protocols = root.DeviceDockProtocols
	if (!Protocols || !Protocols.has('sek')) return
	const tx0 = root.sekTx
	if (!tx0) {
		console.warn('sek-test-profile: sekTx 未加载')
		return
	}

	// ---------- 类型编解码 ----------
	// 只覆盖契约里声明的字段类型；附加属性 tag / fid / source / scale / fillLen / options 是 SEK 自己的寻址信息，
	// 宿主只认 key / name / type / unit / min / max / step / enum / read / write / group / chart。
	function numToBytes(val, type) {
		const n = Number(val)
		switch (type) {
			case 'uint32le': return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
			case 'int32le': { const b = numToBytes(n >>> 0, 'uint32le'); return b }
			case 'uint16le': return [n & 0xff, (n >>> 8) & 0xff]
			case 'int16le': { const u = n & 0xffff; return [u & 0xff, (u >>> 8) & 0xff] }
			case 'uint8':
			case 'int8':
			case 'enum':
			case 'bool': return [n & 0xff]
			default: return []
		}
	}
	function bytesToNum(bytes, type) {
		if (!bytes || !bytes.length) return null
		switch (type) {
			case 'uint32le':
				return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0
			case 'int32le':
				return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
			case 'uint16le':
				return (bytes[0] | (bytes[1] << 8)) & 0xffff
			case 'int16le':
				return ((bytes[0] | (bytes[1] << 8)) << 16) >> 16
			case 'uint8':
			case 'enum':
				return bytes[0] & 0xff
			case 'int8':
				return (bytes[0] << 24) >> 24
			case 'bool':
				return bytes[0] ? 1 : 0
			default:
				return null
		}
	}
	// BCD 小端：数字串从末尾两位一字节(低位在前)，不足 len 补 0x00，超长报错(不截断)
	function bcdLeBytes(digitStr, len) {
		let digits = String(digitStr == null ? '' : digitStr).replace(/\D/g, '')
		if (digits === '') digits = '0'
		if (digits.length % 2 !== 0) digits = '0' + digits
		const bytes = []
		for (let i = digits.length - 2; i >= 0; i -= 2) {
			const hi = digits.charCodeAt(i) - 48
			const lo = digits.charCodeAt(i + 1) - 48
			bytes.push(((hi & 0xf) << 4) | (lo & 0xf))
		}
		if (len && bytes.length > len) throw new Error('数值 ' + digitStr + ' 超出字段长度上限(' + len + ' 字节)')
		while (len && bytes.length < len) bytes.push(0x00)
		return bytes
	}
	function bcdToDigits(bytes) {
		let digits = ''
		for (let i = bytes.length - 1; i >= 0; i--) {
			digits += String((bytes[i] >> 4) & 0xf) + String(bytes[i] & 0xf)
		}
		digits = digits.replace(/^0+(?=\d)/, '')
		return digits === '' ? '0' : digits
	}
	function asciiToBytes(s, fillLen) {
		const str = s == null ? '' : String(s)
		const bytes = []
		const n = fillLen != null ? Math.min(str.length, fillLen) : str.length
		for (let i = 0; i < n; i++) bytes.push(str.charCodeAt(i) & 0xff)
		if (fillLen != null) {
			while (bytes.length < fillLen) bytes.push(0x00)
		}
		return bytes
	}
	function asciiFromBytes(bytes) {
		let s = ''
		for (let i = 0; i < bytes.length; i++) {
			if (bytes[i] === 0) break
			s += String.fromCharCode(bytes[i])
		}
		return s
	}

	// ---------- 字段目录 ----------
	// 附加属性 tag / fid 是 SEK 的寻址信息；scale 是显示换算（'base' 表示乘基准水量），chart 标默认上曲线。
	// 只读字段来自 SK_TAGS 里单位明确的数值项，写字段由下行预设(0x01 + 单值 param)派生，与旧批量配置的清单一致。
	const FIELDS = [
		// 终端参数（可读写）
		{ key: 'rw-t3-0', name: '过流告警阈值', group: '告警阈值', type: 'uint32le', min: 1, max: 50000, unit: 'L/h', tag: 3, fid: 0 },
		{ key: 'rw-t3-1', name: '持续过流告警时间', group: '告警阈值', type: 'uint8', min: 1, max: 120, unit: '分钟', tag: 3, fid: 1 },
		{ key: 'rw-t3-2', name: '反流告警阈值', group: '告警阈值', type: 'uint32le', min: 1, max: 5000, unit: 'L/h', tag: 3, fid: 2 },
		{ key: 'rw-t3-3', name: '持续反流告警时间', group: '告警阈值', type: 'uint8', min: 1, max: 120, unit: '分钟', tag: 3, fid: 3 },
		// unit 保持原始编码单位 0.01V（写入按原始值）；metrics 出点换算成 V 并带 displayUnit
		{ key: 'rw-t3-4', name: '电压告警阈值', group: '告警阈值', type: 'uint16le', min: 0, max: 400, unit: '0.01V', scale: 0.01, displayUnit: 'V', tag: 3, fid: 4 },
		{ key: 'rw-t3-9', name: '上报频率', group: '上报', type: 'uint16le', min: 30, max: 1440, step: 30, unit: '分钟', tag: 3, fid: 9 },
		{ key: 'rw-t3-10', name: '上报重发次数', group: '上报', type: 'uint8', min: 0, max: 4, tag: 3, fid: 10 },
		{ key: 'rw-t3-11', name: '上报重发间隔', group: '上报', type: 'uint8', min: 1, max: 60, unit: '分钟', tag: 3, fid: 11 },
		{ key: 'rw-t3-12', name: '数据采样间隔', group: '上报', type: 'uint16le', min: 30, max: 1440, step: 30, unit: '分钟', tag: 3, fid: 12 },
		{ key: 'rw-t3-14', name: '密集采样起始小时', group: '采样', type: 'uint8', min: 0, max: 23, tag: 3, fid: 14 },
		{ key: 'rw-t3-15', name: '密集采样间隔', group: '采样', type: 'uint8', min: 5, max: 60, step: 5, unit: '分钟', tag: 3, fid: 15 },
		{ key: 'rw-t3-18', name: '水表口径', group: '计量', type: 'enum', enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], tag: 3, fid: 18 },
		{ key: 'rw-t3-22', name: '维护上报频率', group: '上报', type: 'uint16le', min: 1440, max: 10080, step: 1440, unit: '分钟', tag: 3, fid: 22 },
		{ key: 'rw-t3-28', name: '脉冲形式', group: '计量', type: 'enum', enum: [0, 1, 2, 3, 4, 5, 8, 9], tag: 3, fid: 28 },
		{ key: 'rw-t3-29', name: '基准水量', group: '计量', type: 'enum', enum: [0, 1, 2, 3, 4, 5, 6], tag: 3, fid: 29 },
		{ key: 'rw-t3-30', name: '基表整数位数', group: '计量', type: 'uint8', min: 4, max: 8, tag: 3, fid: 30 },
		{ key: 'rw-t3-32', name: '设备校时类型', group: '维护', type: 'enum', enum: [0, 1], tag: 3, fid: 32 },
		{ key: 'rw-t3-34', name: '机电分离状态', group: '维护', type: 'enum', enum: [0, 1], tag: 3, fid: 34 },
		{ key: 'rw-t3-38', name: '计量模组开关', group: '维护', type: 'enum', enum: [0, 1], tag: 3, fid: 38 },
		{ key: 'rw-t3-40', name: '维护平台连接模式', group: '维护', type: 'enum', enum: [0, 1], tag: 3, fid: 40 },
		{ key: 'rw-t3-41', name: '用水量功能超时', group: '维护', type: 'uint16le', min: 0, max: 3600, unit: '秒', tag: 3, fid: 41 },

		// 核心数据（只读，曲线上默认显示）
		{ key: 'm-flow-total', name: '当前实时累计流量', group: '核心数据', type: 'uint32le', unit: 'L', scale: 'base', chart: true, write: false, tag: 2, fid: 9 },
		{ key: 'm-flow-frozen', name: '冻结累计流量', group: '核心数据', type: 'uint32le', unit: 'L', scale: 'base', write: false, tag: 2, fid: 0 },
		{ key: 'm-batt-comm', name: '通信电池电压', group: '核心数据', type: 'uint16le', unit: 'V', scale: 0.01, chart: true, write: false, tag: 2, fid: 10 },
		{ key: 'm-batt-meter', name: '计量电池电压', group: '核心数据', type: 'uint16le', unit: 'V', scale: 0.01, chart: true, write: false, tag: 2, fid: 15 },
		{ key: 'm-water-temp', name: '当前水温', group: '核心数据', type: 'int16le', unit: '℃', scale: 0.1, chart: true, write: false, tag: 2, fid: 3 },
		{ key: 'm-pressure', name: '日最高水压', group: '核心数据', type: 'uint16le', unit: 'kPa', write: false, tag: 2, fid: 7 },
		{ key: 'm-batt-comm-pct', name: '通讯电池电量', group: '核心数据', type: 'uint8', unit: '%', write: false, tag: 2, fid: 30 },

		// 帧头信号（不在 TLV 里，metrics 直接读解析结果）
		{ key: 'm-rsrp', name: '信号强度 RSRP', group: '信号', type: 'int16le', unit: 'dBm', chart: true, read: false, write: false, source: 'frame', field: '信号强度RSRP' },
		{ key: 'm-snr', name: '信噪比 SNR', group: '信号', type: 'int16le', unit: 'dB', chart: true, read: false, write: false, source: 'frame', field: '信噪比SNR' },
		{ key: 'm-csq', name: '信号质量 CSQ', group: '信号', type: 'uint8', chart: true, read: false, write: false, source: 'frame', field: '信号质量CSQ' },
		{ key: 'm-ecl', name: '覆盖等级 ECL', group: '信号', type: 'uint8', read: false, write: false, source: 'frame', field: '覆盖等级ECL' },
	]

	// 写字段从下行预设派生：旧批量配置的清单就是「0x01 且带单值 param」的预设，这里用同一判据，不另抄一份
	const WRITABLE_PRESET_TYPES = { bcd: 1, ascii: 1, enum: 1, uint8: 1, uint16le: 1, uint32le: 1 }
	function presetWriteFields() {
		const out = []
		const presets = Array.isArray(root.SK_DOWN_PRESETS) ? root.SK_DOWN_PRESETS : []
		presets.forEach(function (g) {
			;(g.items || []).forEach(function (it) {
				const p = it.param
				if (it.func !== '0x01' || !p || !WRITABLE_PRESET_TYPES[p.type]) return
				const blk = (it.tlv || [])[0]
				const item = blk && blk.items && blk.items[0]
				if (!blk || !item) return
				const field = {
					key: 'w-t' + blk.tag + '-' + item.id + '-' + p.type,
					name: it.name,
					group: it.group || '参数设置',
					type: p.type,
					read: true,
					write: true,
					tag: blk.tag,
					fid: item.id,
					preset: it.name,
				}
				if (it.desc) field.desc = it.desc
				if (p.fillLen) field.fillLen = p.fillLen
				if (p.default != null && p.default !== '') field.defaultValue = String(p.default)
				if (p.type === 'enum' && p.options) {
					field.enum = Object.keys(p.options).map(function (k) {
						return { value: Number(k), label: p.options[k] }
					})
				}
				if (p.type === 'uint8') field.max = 0xff
				if (p.type === 'uint16le') field.max = 0xffff
				if (p.type === 'uint32le') field.max = 0xffffffff
				out.push(field)
			})
		})
		return out
	}
	// 字段目录去重：派生字段与手写字段指向同一设备地址（tag+fid 相同）时只保留手写的那份
	//（手写目录带单位 / 量程 / 分组 / 曲线标记，更完整）；派生字段之间同地址的也只留第一个
	const WRITE_FIELDS = (function () {
		const seen = {}
		FIELDS.forEach(function (f) { seen[f.tag + '-' + f.fid] = true })
		const out = []
		presetWriteFields().forEach(function (f) {
			const k = f.tag + '-' + f.fid
			if (seen[k]) return
			seen[k] = true
			out.push(f)
		})
		return out
	})()
	const ALL_FIELDS = FIELDS.concat(WRITE_FIELDS)

	// 随机读写白名单：目录默认 random:false，只有下面这些字段显式放行——可读回、可恢复，
	// 写错不会断链（通信 / 平台连接 / 加密 / 标识 / 时钟都不在列）、也不会驱动执行机构（阀 / 开关 / 电源）。
	// 按地址黑名单会漏（如「维护平台连接模式」），所以反着来。契约层缺省仍是 true（外部协议行为不变），
	// 随机生成器永远跳过 random:false；批量配置不受影响，仍可手动选任何字段
	const RANDOM_WHITELIST = {}
	;[
		'rw-t3-0',  // 过流告警阈值：告警线，写错只改告警行为，可回读恢复
		'rw-t3-1',  // 持续过流告警时间：同上
		'rw-t3-2',  // 反流告警阈值：同上
		'rw-t3-3',  // 持续反流告警时间：同上
		'rw-t3-4',  // 电压告警阈值：同上
		'rw-t3-9',  // 上报频率：上报周期
		'rw-t3-10', // 上报重发次数：上报参数
		'rw-t3-11', // 上报重发间隔：上报参数
		'rw-t3-12', // 数据采样间隔：采样周期
		'rw-t3-14', // 密集采样起始小时：采样周期
		'rw-t3-15', // 密集采样间隔：采样周期
		'rw-t3-22', // 维护上报频率：上报周期
		// 只读 metrics 字段：随机读步骤可以读它们（无写入语义，永远可恢复——本来就不写）
		'm-flow-total',   // 当前实时累计流量（只读）
		'm-flow-frozen',  // 冻结累计流量（只读）
		'm-batt-comm',    // 通信电池电压（只读）
		'm-batt-meter',   // 计量电池电压（只读）
		'm-water-temp',   // 当前水温（只读）
		'm-pressure',     // 日最高水压（只读）
		'm-batt-comm-pct',// 通讯电池电量（只读）
	].forEach(function (k) { RANDOM_WHITELIST[k] = true })
	ALL_FIELDS.forEach(function (f) { f.random = !!RANDOM_WHITELIST[f.key] })

	// 整包查询用例（随机读写里的「查询」步骤）
	const QUERIES = [
		{ key: 'q-base', name: '查询基础数据', queryId: 1, expectTag: 1 },
		{ key: 'q-core', name: '查询核心数据', queryId: 2, expectTag: 2 },
		{ key: 'q-param', name: '查询终端参数', queryId: 3, expectTag: 3 },
		{ key: 'q-alarm', name: '查询告警数据', queryId: 4, expectTag: 4 },
		{ key: 'q-run', name: '查询运行信息', queryId: 7, expectTag: 91 },
		{ key: 'q-up', name: '查询上行信息', queryId: 8, expectTag: 92 },
	]

	// tag → 整包查询 queryId；不在表内的 tag 不能单独回读（批量配置据此跳过回读）
	const QUERY_ID_BY_TAG = {
		1: 1, 2: 2, 3: 3, 4: 4,
		30: 30, 31: 31, 32: 10, 33: 11, 34: 13, 35: 35, 36: 15, 37: 18, 38: 22,
		91: 7, 92: 8,
	}

	function queryIdForTag(tag) {
		const q = QUERY_ID_BY_TAG[tag]
		return q == null ? null : q
	}

	// ---------- 契约钩子 ----------
	// buildRead / buildWrite / buildQuery 返回 { bytes, request }：bytes 是整帧下行字节，request 是给
	// matchResponse 的不透明凭证。宿主只负责发 bytes、等应答、拿 request 去匹配，不认识任何帧格式。
	// 凭证里带帧序号：超时请求的迟到应答（序号对不上）不会成为下一条请求的结果或恢复原值
	function frameFor(buildOpts, request) {
		const built = tx0.buildDown(buildOpts)
		request.seq = built.seq
		return { bytes: built.frame, request: request }
	}
	function buildRead(field) {
		const tag = field && field.tag
		const queryId = queryIdForTag(tag)
		if (queryId == null) return null
		return frameFor(
			{ funcCode: '0x03', tlv: [{ tag: 10, items: [{ id: queryId, value: [] }] }] },
			{ op: 'query', queryId: queryId, tag: tag, expectFunc: 0x83 }
		)
	}
	function buildWrite(field, value) {
		if (!field || field.tag == null || field.fid == null) throw new Error('字段缺少写入地址')
		let bytes = null
		if (field.type === 'bcd') {
			const raw = String(value == null ? '' : value).trim()
			if (!/^[0-9]+$/.test(raw)) throw new Error(field.name + ' 须为纯数字')
			bytes = bcdLeBytes(raw, field.fillLen || 8)
		} else if (field.type === 'ascii') {
			bytes = asciiToBytes(value, field.fillLen)
		} else if (field.type === 'enum' || field.type === 'bool') {
			const n = Number(value)
			if (!Number.isFinite(n)) throw new Error(field.name + ' 的取值非法：' + value)
			bytes = [n & 0xff]
		} else {
			const n = Number(value)
			if (!Number.isFinite(n) || n < 0) throw new Error(field.name + ' 须为不小于 0 的数值')
			bytes = numToBytes(n, field.type)
			if (!bytes.length) throw new Error('字段类型不支持写入：' + field.type)
		}
		return frameFor(
			{ funcCode: '0x01', tlv: [{ tag: field.tag, items: [{ id: field.fid, value: bytes }] }] },
			{ op: 'write', tag: field.tag, fid: field.fid, bytes: bytes, expectFunc: 0x81 }
		)
	}
	function buildQuery(query) {
		if (!query || query.queryId == null) return null
		return frameFor(
			{ funcCode: '0x03', tlv: [{ tag: 10, items: [{ id: query.queryId, value: [] }] }] },
			{ op: 'query', queryId: query.queryId, expectTag: query.expectTag, expectFunc: 0x83 }
		)
	}
	// 返回 false 表示「不是这条请求的应答，继续等」；true 表示成功；{ ok:false } 表示失败应答。
	// 帧序号必须与请求一致：设备应答会带回请求的序号，超时请求的迟到应答在这里被隔离
	function matchResponse(frame, request) {
		if (!frame || frame.dir !== 'up') return false
		const req = request || {}
		if (req.expectFunc != null && tx0.funcValue(frame) !== req.expectFunc) return false
		if (req.seq != null) {
			const fs = tx0.frameSeq(frame)
			if (fs != null && fs !== (req.seq & 0xffff)) return false
		}
		if (req.op === 'query') {
			if (req.expectTag != null && !tx0.hasTag(frame, req.expectTag)) {
				return { ok: false, message: '响应无 Tag' + req.expectTag }
			}
			return true
		}
		const r11 = tx0.tag11Result(frame)
		if (r11 === 0) return false
		if (r11 == null || r11 === 1) return true
		const names = (root.SK_RESULT_CODES && root.SK_RESULT_CODES.Tag11) || {}
		return {
			ok: false,
			code: r11,
			// 2 无法解析 / 3 超范围：设备不支持这个字段，按「不支持」记，不算失败
			unsupported: r11 === 2 || r11 === 3,
			message: '写应答失败 Tag11=' + r11 + '(' + (names[r11] || '?') + ')',
		}
	}
	// 应答帧里取该字段的原始字节（回读比对用）；帧头信号没有 TLV，不在这里取
	function readField(frame, field) {
		if (!frame || !field || field.tag == null) return null
		const it = tx0.findTlvItem(frame, field.tag, field.fid)
		return it && it.raw ? Array.prototype.slice.call(it.raw) : null
	}

	// 会话钩子：连设备前的连通检查、长时间空闲时的保活。属于协议会话层，引擎只负责发与等
	const session = {
		idleMs: 20000,
		keepaliveTimeoutMs: 4000,
		prepare: function () {
			return buildQuery(QUERIES[0])
		},
		keepalive: function () {
			return buildQuery(QUERIES[0])
		},
	}

	// ---------- metrics：曲线上每个数值点 ----------
	// 只认能算准的：帧头信号直接取解析结果，TLV 数值按类型解码并按 scale 换算（'base' = 乘基准水量）
	function scaleOf(field) {
		if (field.scale === 'base') {
			const sess = root.skSession
			const base = sess && typeof sess.baseLiters === 'number' ? sess.baseLiters : 1
			return base || 1
		}
		return typeof field.scale === 'number' ? field.scale : 1
	}
	function metrics(frame) {
		if (!frame) return []
		const out = []
		ALL_FIELDS.forEach(function (f) {
			if (f.source === 'frame') {
				const v = frame.fields ? frame.fields[f.field] : null
				const n = v && typeof v === 'object' ? v.value : v
				if (n == null || typeof n !== 'number' || !Number.isFinite(n)) return
				out.push({ key: f.key, value: n })
				return
			}
			if (f.tag == null || !frame.tlv) return
			const it = tx0.findTlvItem(frame, f.tag, f.fid)
			if (!it || !it.raw) return
			const raw = bytesToNum(it.raw, f.type)
			if (raw == null) return
			// 点可带可选 unit：fields.unit 是原始编码单位（如 0.01V）时，给出换算后的显示单位
			const point = { key: f.key, value: raw * scaleOf(f) }
			if (f.displayUnit) point.unit = f.displayUnit
			out.push(point)
		})
		return out
	}

	// ---------- 值解码（回读比对；与 buildWrite 的编码对称） ----------
	function decodeValue(bytes, field) {
		if (!bytes || !bytes.length || !field) return null
		if (field.type === 'bcd') return bcdToDigits(bytes)
		if (field.type === 'ascii') return asciiFromBytes(bytes)
		return bytesToNum(bytes, field.type)
	}

	Protocols.extend('sek', {
		fields: ALL_FIELDS,
		queries: QUERIES,
		buildRead: buildRead,
		buildWrite: buildWrite,
		buildQuery: buildQuery,
		matchResponse: matchResponse,
		readField: readField,
		metrics: metrics,
		session: session,
	})

	root.SEKTestProfile = {
		fields: ALL_FIELDS,
		writeFields: WRITE_FIELDS,
		queries: QUERIES,
		queryIdForTag: queryIdForTag,
		numToBytes: numToBytes,
		bytesToNum: bytesToNum,
		bcdLeBytes: bcdLeBytes,
		bcdToDigits: bcdToDigits,
		asciiToBytes: asciiToBytes,
		asciiFromBytes: asciiFromBytes,
		decodeValue: decodeValue,
	}
})(typeof window !== 'undefined' ? window : globalThis)
