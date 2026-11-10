// Adapted from Roomen/web-serial-debug dual-config.js, Apache-2.0. Pure normalization and application planning.
	const LANES = ['A', 'B']
	const DEFAULT_OPTIONS = {
		baudRate: 115200,
		dataBits: 8,
		stopBits: 1,
		parity: 'none',
		bufferSize: 1024,
		flowControl: 'none',
	}
	const PARITY = ['none', 'even', 'odd']
	const FLOW = ['none', 'hardware']
	const PARITY_ABBR = { none: 'N', even: 'E', odd: 'O' }
	const NAME_MAX = 24
	const LABEL_MAX = 8
	const PRESET_MAX = 50

	function parseJson(raw) {
		if (raw == null || raw === '') return null
		if (typeof raw !== 'string') return raw
		try { return JSON.parse(raw) } catch (e) { return null }
	}
	function isObj(v) {
		return !!v && typeof v === 'object' && !Array.isArray(v)
	}

	// 串口参数逐项校验：非法或缺失的项取 base(缺省为默认参数)，不让一项坏值连带整份作废
	function normalizeOptions(raw, base) {
		const b = Object.assign({}, DEFAULT_OPTIONS, isObj(base) ? base : {})
		const out = Object.assign({}, b)
		if (!isObj(raw)) return out
		const baud = parseInt(raw.baudRate, 10)
		if (baud > 0) out.baudRate = baud
		const db = parseInt(raw.dataBits, 10)
		if (db === 7 || db === 8) out.dataBits = db
		const sb = parseInt(raw.stopBits, 10)
		if (sb === 1 || sb === 2) out.stopBits = sb
		if (PARITY.indexOf(raw.parity) !== -1) out.parity = raw.parity
		const buf = parseInt(raw.bufferSize, 10)
		if (buf > 0 && buf <= 16777216) out.bufferSize = buf
		if (FLOW.indexOf(raw.flowControl) !== -1) out.flowControl = raw.flowControl
		return out
	}

	function sameOptions(a, b) {
		const x = normalizeOptions(a)
		const y = normalizeOptions(b)
		return Object.keys(DEFAULT_OPTIONS).every(function (k) { return x[k] === y[k] })
	}

	// 两路参数：新键 lanesRaw({A, B}) 优先；没有(或某一路缺)时用旧的双路共用键 legacyRaw 作初值，两路相同
	function migrateLaneOptions(lanesRaw, legacyRaw) {
		const lanes = parseJson(lanesRaw)
		const base = normalizeOptions(parseJson(legacyRaw))
		const out = {}
		LANES.forEach(function (sid) {
			out[sid] = isObj(lanes) && isObj(lanes[sid]) ? normalizeOptions(lanes[sid], base) : Object.assign({}, base)
		})
		return out
	}

	// 两路协议：新键没有时两路都取迁移前全局唯一的那个协议
	function migrateLaneProtocols(raw, fallbackId) {
		const v = parseJson(raw)
		const fb = typeof fallbackId === 'string' && fallbackId ? fallbackId : 'sek'
		const out = {}
		LANES.forEach(function (sid) {
			out[sid] = isObj(v) && typeof v[sid] === 'string' && v[sid] ? v[sid] : fb
		})
		return out
	}

	// 「115200 8-N-1」，与连接条参数摘要同一写法
	function paramsSummary(opts) {
		const o = normalizeOptions(opts)
		return o.baudRate + ' ' + o.dataBits + '-' + (PARITY_ABBR[o.parity] || 'N') + '-' + o.stopBits
	}

	function cleanName(name) {
		return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
	}
	function cleanLabel(label) {
		return String(label == null ? '' : label).trim().slice(0, LABEL_MAX)
	}

	function normalizeLane(raw) {
		const r = isObj(raw) ? raw : {}
		return {
			options: normalizeOptions(r.options),
			protocol: typeof r.protocol === 'string' && r.protocol ? r.protocol : 'sek',
			label: cleanLabel(r.label),
		}
	}

	function isSinglePreset(p) {
		return isObj(p) && p.kind === 'single'
	}
	// 预设里有哪几路：单路预设只有 S
	function presetLanes(p) {
		return isSinglePreset(p) ? ['S'] : LANES
	}
	// 单路只有一路，不存路标签
	function normalizeSingleLane(raw) {
		const l = normalizeLane(raw)
		l.label = ''
		return l
	}
	// cfg: { A: { options, protocol, label }, B: {...} }
	function makePreset(name, cfg) {
		const n = cleanName(name)
		if (!n) throw new Error('预设名称不能为空')
		const c = isObj(cfg) ? cfg : {}
		return { name: n, A: normalizeLane(c.A), B: normalizeLane(c.B) }
	}
	// lane: { options, protocol }
	function makeSinglePreset(name, lane) {
		const n = cleanName(name)
		if (!n) throw new Error('预设名称不能为空')
		return { name: n, kind: 'single', S: normalizeSingleLane(lane) }
	}

	// 存储格式 { v: 1, list: [...] }；坏项、空名、重名(保留先出现的)都丢掉
	function normalizePresets(raw) {
		const v = parseJson(raw)
		const arr = Array.isArray(v) ? v : (isObj(v) && Array.isArray(v.list) ? v.list : [])
		const out = []
		const seen = {}
		arr.forEach(function (p) {
			if (!isObj(p)) return
			const n = cleanName(p.name)
			if (!n || seen[n]) return
			seen[n] = true
			if (isSinglePreset(p)) out.push({ name: n, kind: 'single', S: normalizeSingleLane(p.S) })
			else out.push({ name: n, A: normalizeLane(p.A), B: normalizeLane(p.B) })
		})
		return out.slice(0, PRESET_MAX)
	}
	function serializePresets(list) {
		return JSON.stringify({ v: 1, list: normalizePresets(list) })
	}

	function indexOfName(list, name) {
		const n = cleanName(name)
		for (let i = 0; i < list.length; i++) if (list[i].name === n) return i
		return -1
	}

	// 同名覆盖(原位置不动)，否则追加到末尾
	function upsertPreset(list, preset) {
		const next = (list || []).slice()
		const i = indexOfName(next, preset.name)
		if (i !== -1) {
			next[i] = preset
			return { list: next, replaced: true }
		}
		if (next.length >= PRESET_MAX) throw new Error('预设最多 ' + PRESET_MAX + ' 个，请先删除不用的')
		next.push(preset)
		return { list: next, replaced: false }
	}

	function renamePreset(list, from, to) {
		const i = indexOfName(list, from)
		if (i === -1) throw new Error('预设不存在')
		const n = cleanName(to)
		if (!n) throw new Error('预设名称不能为空')
		const j = indexOfName(list, n)
		if (j !== -1 && j !== i) throw new Error('已有同名预设「' + n + '」')
		const next = list.slice()
		next[i] = Object.assign({}, next[i], { name: n })
		return next
	}

	function removePreset(list, name) {
		const i = indexOfName(list, name)
		if (i === -1) return list.slice()
		const next = list.slice()
		next.splice(i, 1)
		return next
	}

	// 当前配置是否与预设一致(菜单里标出正在用的那个)。标签空与默认「A路」「B路」视为相同；
	// 单路预设比 cur.S(单路，或双路下的主发路)，不比标签
	function presetMatches(preset, cur) {
		if (!preset || !cur) return false
		const single = isSinglePreset(preset)
		return presetLanes(preset).every(function (sid) {
			if (!isObj(cur[sid])) return false
			const p = normalizeLane(preset[sid])
			const c = normalizeLane(cur[sid])
			const lp = single ? '' : p.label || sid + '路'
			const lc = single ? '' : c.label || sid + '路'
			return sameOptions(p.options, c.options) && p.protocol === c.protocol && lp === lc
		})
	}

	// 套用计划：协议未注册(比如预设来自更新的版本)时保留该路当前协议并记下来；参数变了的路标出来，由调用方决定是否重连。
	// 单路预设只算 lanes.S，cur.S 是要套上的那一路的当前配置
	function planApply(preset, cur, isKnownProtocol) {
		const known = typeof isKnownProtocol === 'function' ? isKnownProtocol : function () { return true }
		const out = { lanes: {}, unknownProtocols: [] }
		presetLanes(preset).forEach(function (sid) {
			const p = normalizeLane(preset && preset[sid])
			const c = normalizeLane(cur && cur[sid])
			let protocol = p.protocol
			if (!known(protocol)) {
				out.unknownProtocols.push(protocol)
				protocol = c.protocol
			}
			out.lanes[sid] = {
				options: p.options,
				protocol: protocol,
				label: p.label,
				optionsChanged: !sameOptions(p.options, c.options),
				protocolChanged: protocol !== c.protocol,
			}
		})
		return out
	}

	const api = {
		LANES: LANES,
		DEFAULT_OPTIONS: DEFAULT_OPTIONS,
		NAME_MAX: NAME_MAX,
		normalizeOptions: normalizeOptions,
		sameOptions: sameOptions,
		migrateLaneOptions: migrateLaneOptions,
		migrateLaneProtocols: migrateLaneProtocols,
		paramsSummary: paramsSummary,
		makePreset: makePreset,
		makeSinglePreset: makeSinglePreset,
		isSinglePreset: isSinglePreset,
		presetLanes: presetLanes,
		normalizePresets: normalizePresets,
		serializePresets: serializePresets,
		upsertPreset: upsertPreset,
		renamePreset: renamePreset,
		removePreset: removePreset,
		presetMatches: presetMatches,
		planApply: planApply,
	}

export default api
