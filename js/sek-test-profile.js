// 内置 SEK 协议的字段目录、查询目录与测试执行器（v1 契约里的 fields / queries / buildRead / buildWrite /
// matchResponse / metrics / tx）。随机读写与批量配置从这里取数据与执行接口，不再各自写死 tag→查询映射。
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

	// ---------- 字段目录 ----------
	// 附加属性 tag / fid / step 是 SEK 自己的寻址信息，宿主只认 key/name/type/min/max/enum/read/write/group
	const FIELDS = [
		{ key: 'rw-t3-0', name: '过流告警阈值', group: '告警阈值', type: 'uint32le', min: 1, max: 50000, tag: 3, fid: 0 },
		{ key: 'rw-t3-1', name: '持续过流告警时间', group: '告警阈值', type: 'uint8', min: 1, max: 120, tag: 3, fid: 1 },
		{ key: 'rw-t3-2', name: '反流告警阈值', group: '告警阈值', type: 'uint32le', min: 1, max: 5000, tag: 3, fid: 2 },
		{ key: 'rw-t3-3', name: '持续反流告警时间', group: '告警阈值', type: 'uint8', min: 1, max: 120, tag: 3, fid: 3 },
		{ key: 'rw-t3-4', name: '电压告警阈值', group: '告警阈值', type: 'uint16le', min: 0, max: 400, tag: 3, fid: 4 },
		{ key: 'rw-t3-9', name: '上报频率', group: '上报', type: 'uint16le', min: 30, max: 1440, step: 30, tag: 3, fid: 9 },
		{ key: 'rw-t3-10', name: '上报重发次数', group: '上报', type: 'uint8', min: 0, max: 4, tag: 3, fid: 10 },
		{ key: 'rw-t3-11', name: '上报重发间隔', group: '上报', type: 'uint8', min: 1, max: 60, tag: 3, fid: 11 },
		{ key: 'rw-t3-12', name: '数据采样间隔', group: '上报', type: 'uint16le', min: 30, max: 1440, step: 30, tag: 3, fid: 12 },
		{ key: 'rw-t3-14', name: '密集采样起始小时', group: '采样', type: 'uint8', min: 0, max: 23, tag: 3, fid: 14 },
		{ key: 'rw-t3-15', name: '密集采样间隔', group: '采样', type: 'uint8', min: 5, max: 60, step: 5, tag: 3, fid: 15 },
		{ key: 'rw-t3-18', name: '水表口径', group: '计量', type: 'enum', enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], tag: 3, fid: 18 },
		{ key: 'rw-t3-22', name: '维护上报频率', group: '上报', type: 'uint16le', min: 1440, max: 10080, step: 1440, tag: 3, fid: 22 },
		{ key: 'rw-t3-28', name: '脉冲形式', group: '计量', type: 'enum', enum: [0, 1, 2, 3, 4, 5, 8, 9], tag: 3, fid: 28 },
		{ key: 'rw-t3-29', name: '基准水量', group: '计量', type: 'enum', enum: [0, 1, 2, 3, 4, 5, 6], tag: 3, fid: 29 },
		{ key: 'rw-t3-30', name: '基表整数位数', group: '计量', type: 'uint8', min: 4, max: 8, tag: 3, fid: 30 },
		{ key: 'rw-t3-32', name: '设备校时类型', group: '维护', type: 'enum', enum: [0, 1], tag: 3, fid: 32 },
		{ key: 'rw-t3-34', name: '机电分离状态', group: '维护', type: 'enum', enum: [0, 1], tag: 3, fid: 34 },
		{ key: 'rw-t3-38', name: '计量模组开关', group: '维护', type: 'enum', enum: [0, 1], tag: 3, fid: 38 },
		{ key: 'rw-t3-40', name: '维护平台连接模式', group: '维护', type: 'enum', enum: [0, 1], tag: 3, fid: 40 },
		{ key: 'rw-t3-41', name: '用水量功能超时', group: '维护', type: 'uint16le', min: 0, max: 3600, tag: 3, fid: 41 },
	]

	// 整包查询用例（随机读写测试里的「查询」步骤）
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

	// ---------- 值编码 ----------
	function numToBytes(val, type) {
		switch (type) {
			case 'uint32le':
				return [val & 0xff, (val >>> 8) & 0xff, (val >>> 16) & 0xff, (val >>> 24) & 0xff]
			case 'uint16le':
				return [val & 0xff, (val >>> 8) & 0xff]
			case 'uint8':
			case 'enum':
				return [val & 0xff]
			default:
				return []
		}
	}
	function bytesToNum(bytes, type) {
		if (!bytes || !bytes.length) return null
		switch (type) {
			case 'uint32le':
				return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0
			case 'uint16le':
				return (bytes[0] | (bytes[1] << 8)) & 0xffff
			case 'uint8':
			case 'enum':
				return bytes[0] & 0xff
			default:
				return null
		}
	}

	// ---------- 契约钩子（P3 的测试流程引擎与曲线面板按这些字段工作） ----------
	function buildRead(field) {
		const tag = field && field.tag
		const queryId = queryIdForTag(tag)
		if (queryId == null) return null
		return { op: 'query', queryId: queryId, tag: tag, expectFunc: 0x83 }
	}
	function buildWrite(field, value) {
		if (!field || field.tag == null || field.fid == null) throw new Error('字段缺少写入地址')
		const bytes = numToBytes(value, field.type === 'enum' ? 'enum' : field.type)
		if (!bytes.length) throw new Error('字段类型不支持写入：' + field.type)
		return { op: 'write', tag: field.tag, fid: field.fid, bytes: bytes, expectFunc: 0x81 }
	}
	function matchResponse(frame, request) {
		if (!frame || frame.dir !== 'up') return false
		const req = request || {}
		if (req.expectFunc != null && tx0.funcValue(frame) !== req.expectFunc) return false
		// 写应答 Tag11=0 表示处理中：继续等下一帧
		if (req.op === 'write' && tx0.tag11Result(frame) === 0) return false
		return true
	}
	function metrics(frame) {
		if (!frame || !frame.tlv) return []
		const out = []
		FIELDS.forEach(function (f) {
			if (!tx0.hasTag(frame, f.tag)) return
			const it = tx0.findTlvItem(frame, f.tag, f.fid)
			if (!it || !it.raw) return
			const v = bytesToNum(it.raw, f.type)
			if (v == null) return
			out.push({ key: f.key, value: v })
		})
		return out
	}

	// ---------- 测试执行器：随机读写 / 批量配置只调这些动词，不碰 SEK 帧格式 ----------
	function timeoutOf(opts) {
		return (opts && opts.timeoutMs) || 5000
	}
	function queryById(queryId, opts) {
		return tx0.sendAndWait({
			buildOpts: { funcCode: '0x03', tlv: [{ tag: 10, items: [{ id: queryId, value: [] }] }] },
			expectFunc: 0x83,
			timeoutMs: timeoutOf(opts),
		})
	}
	function writeRaw(entry, opts) {
		return tx0.sendAndWait({
			buildOpts: { funcCode: '0x01', tlv: [{ tag: entry.tag, items: [{ id: entry.id, value: entry.bytes }] }] },
			expectFunc: 0x81,
			timeoutMs: timeoutOf(opts),
		})
	}
	function readItem(frame, tag, id) {
		const it = tx0.findTlvItem(frame, tag, id)
		return it && it.raw ? Array.prototype.slice.call(it.raw) : null
	}
	// 一次整包查询取回该 tag 下全部字段的原始字节（随机读写按 tag 缓存，避免每步都重新查询）
	async function readTag(tag, opts) {
		const queryId = queryIdForTag(tag)
		if (queryId == null) return null
		const res = await queryById(queryId, opts)
		const values = {}
		FIELDS.forEach(function (f) {
			if (f.tag !== tag) return
			const bytes = readItem(res.frame, tag, f.fid)
			if (bytes) values[f.key] = bytes
		})
		return { frame: res.frame, raw: res.raw, values: values }
	}

	const tx = {
		queryById: queryById,
		readTag: readTag,
		writeRaw: writeRaw,
		readItem: readItem,
		bytesEqual: function (a, b) { return tx0.bytesEqual(a, b) },
		hasTag: function (frame, tag) { return tx0.hasTag(frame, tag) },
		reset: function () { tx0.clearBuffer() },
		cancel: function (reason) { tx0.cancelAll(reason) },
	}

	Protocols.extend('sek', {
		fields: FIELDS,
		queries: QUERIES,
		buildRead: buildRead,
		buildWrite: buildWrite,
		matchResponse: matchResponse,
		metrics: metrics,
		tx: tx,
	})

	root.SEKTestProfile = {
		fields: FIELDS,
		queries: QUERIES,
		queryIdForTag: queryIdForTag,
		numToBytes: numToBytes,
		bytesToNum: bytesToNum,
	}
})(typeof window !== 'undefined' ? window : globalThis)
