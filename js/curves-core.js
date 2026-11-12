// 曲线面板的纯逻辑：按「路 / 字段」的环形时间序列、实时帧抽取(按路缓冲 + findFrame)、按单位分轴、对齐与 CSV。
// 浏览器侧 js/curves.js 负责接实时帧与派发事件，js/curves-panel.js 负责画图；这里不碰 DOM，可在 node 里跑。
// 历史日志重放不经过这里(只有实时帧进来)：重放会按行序重跑一遍解析，把几天前的数据点塞回曲线既没有时间意义，
// 也会在分批重渲时把实时序列冲掉。
;(function (root) {
	'use strict'

	const DEFAULT_CAPACITY = 5000
	const CAP_MIN = 100
	const CAP_MAX = 50000
	const MAX_BUFFER = 65536
	const MAX_AXES = 2

	function clampCapacity(v) {
		const n = Math.floor(Number(v))
		if (!Number.isFinite(n)) return DEFAULT_CAPACITY
		return Math.min(CAP_MAX, Math.max(CAP_MIN, n))
	}

	function seriesKey(sid, key) {
		return sid + '\u0000' + key
	}

	// 每个 (路, 字段) 一条序列；超过容量从最早的点丢，数组实现 + 每次裁掉超出的头部。
	// 时间戳由调用方给(实时帧到达时间)，同一时刻的多帧按到达顺序各记一点。
	function createStore(opts) {
		let capacity = clampCapacity(opts && opts.capacity)
		const map = new Map()

		function trim(s) {
			const over = s.t.length - capacity
			if (over > 0) {
				s.t.splice(0, over)
				s.v.splice(0, over)
			}
		}
		function ensure(sid, key, meta) {
			const k = seriesKey(sid, key)
			let s = map.get(k)
			if (!s) {
				s = { sid: sid, key: key, name: key, unit: '', chart: false, t: [], v: [] }
				map.set(k, s)
			}
			if (meta) {
				if (meta.name) s.name = meta.name
				s.unit = meta.unit || ''
				s.chart = !!meta.chart
			}
			return s
		}

		const api = {
			capacity: function () { return capacity },
			setCapacity: function (v) {
				capacity = clampCapacity(v)
				map.forEach(trim)
				return capacity
			},
			// points: [{ key, value }]，非数值点直接丢掉(协议给了 NaN / null 时不要画成 0)
			ingest: function (sid, ts, points, metaOf) {
				const added = []
				;(points || []).forEach(function (p) {
					if (!p || p.key == null) return
					const value = Number(p.value)
					if (!Number.isFinite(value)) return
					const s = ensure(sid, String(p.key), metaOf ? metaOf(p.key) : null)
					s.t.push(ts)
					s.v.push(value)
					trim(s)
					added.push(s)
				})
				return added
			},
			get: function (sid, key) { return map.get(seriesKey(sid, key)) || null },
			keys: function (sid) {
				const out = []
				map.forEach(function (s) { if (!sid || s.sid === sid) out.push(s.key) })
				return out
			},
			list: function (sid) {
				const out = []
				map.forEach(function (s) { if (!sid || s.sid === sid) out.push(s) })
				return out
			},
			size: function () { return map.size },
			clear: function (sid) {
				if (!sid) { map.clear(); return }
				Array.from(map.keys()).forEach(function (k) {
					if (map.get(k).sid === sid) map.delete(k)
				})
			},
		}
		return api
	}

	// 实时帧抽取：按路攒字节，用该路协议的 findFrame 切出完整帧，跨块的残帧留在缓冲里等下一块。
	// 缓冲有上限：一直收不到完整帧时丢掉最早的字节，不能让它无限涨。
	function createFramePump(io) {
		const o = io || {}
		const maxBuffer = o.maxBuffer || MAX_BUFFER
		let buf = []
		return {
			size: function () { return buf.length },
			reset: function () { buf = [] },
			push: function (bytes) {
				const out = []
				if (!bytes || !bytes.length) return out
				for (let i = 0; i < bytes.length; i++) buf.push(bytes[i] & 0xff)
				if (buf.length > maxBuffer) buf.splice(0, buf.length - maxBuffer)
				let guard = 0
				while (buf.length && guard++ < 256) {
					const u8 = Uint8Array.from(buf)
					let found = null
					if (typeof o.findFrame === 'function') {
						try { found = o.findFrame(u8) } catch (e) { found = null }
					}
					if (!found || !found.found || !(found.length > 0)) break
					const start = found.offset || 0
					const consume = Math.min(buf.length, start + found.length)
					const raw = found.frame || u8.subarray(start, consume)
					buf.splice(0, consume)
					let parsed = found.parse || null
					if (!parsed && typeof o.parseFrame === 'function') {
						try { parsed = o.parseFrame(raw) } catch (e) { parsed = null }
					}
					if (parsed) out.push({ frame: parsed, raw: raw })
				}
				return out
			},
		}
	}

	// 按单位分 Y 轴：一个单位一根轴，最多两根；第三根起整组丢掉(返回的 droppedUnits 供界面提示)
	function groupAxes(items, unitOf) {
		const axes = []
		const byUnit = new Map()
		const droppedUnits = []
		;(items || []).forEach(function (it) {
			const unit = (unitOf ? unitOf(it) : '') || ''
			let axis = byUnit.get(unit)
			if (!axis) {
				if (axes.length >= MAX_AXES) {
					if (droppedUnits.indexOf(unit) === -1) droppedUnits.push(unit)
					return
				}
				axis = { unit: unit, items: [] }
				byUnit.set(unit, axis)
				axes.push(axis)
			}
			axis.items.push(it)
		})
		return { axes: axes, droppedUnits: droppedUnits }
	}

	// 多条序列按时间戳并集对齐，缺的地方补 null(uPlot 会断开线段，不会画成 0)
	function alignSeries(list) {
		const seen = new Set()
		const times = []
		list.forEach(function (s) {
			for (let i = 0; i < s.t.length; i++) {
				const t = s.t[i]
				if (seen.has(t)) continue
				seen.add(t)
				times.push(t)
			}
		})
		times.sort(function (a, b) { return a - b })
		const cols = list.map(function (s) {
			const col = new Array(times.length).fill(null)
			let i = 0
			for (let n = 0; n < times.length; n++) {
				const t = times[n]
				while (i < s.t.length && s.t[i] < t) i++
				if (i < s.t.length && s.t[i] === t) {
					col[n] = s.v[i]
					i++
				}
			}
			return col
		})
		return { t: times, cols: cols }
	}

	function csvCell(v) {
		const s = v == null ? '' : String(v)
		if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
		return s
	}

	// opts.laneName(sid) / opts.formatTime(ts)：表头与首列由界面给，纯逻辑只负责对齐
	function toCSV(list, opts) {
		const o = opts || {}
		const aligned = alignSeries(list)
		const head = ['time'].concat(list.map(function (s) {
			const unit = s.unit ? ' (' + s.unit + ')' : ''
			const lane = o.laneName ? o.laneName(s.sid) + ' ' : ''
			return lane + (s.name || s.key) + unit
		}))
		const rows = [head.map(csvCell).join(',')]
		for (let n = 0; n < aligned.t.length; n++) {
			const row = [o.formatTime ? o.formatTime(aligned.t[n]) : String(aligned.t[n])]
			for (let c = 0; c < aligned.cols.length; c++) {
				const v = aligned.cols[c][n]
				row.push(v == null ? '' : String(v))
			}
			rows.push(row.map(csvCell).join(','))
		}
		return rows.join('\n')
	}

	// 读数用等宽数字：整数原样，小数最多三位并去掉尾零
	function formatNumber(v) {
		const n = Number(v)
		if (v == null || !Number.isFinite(n)) return '—'
		if (Number.isInteger(n)) return String(n)
		const abs = Math.abs(n)
		const digits = abs >= 100 ? 1 : abs >= 1 ? 2 : 3
		return n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')
	}

	// ---------- 时间换算：序列内部存毫秒；uPlot 的 time 轴按「秒」解释，界面显示一律 24 小时制本地时间 ----------
	const DAY_MS = 86400000
	function pad2(n) { return (n < 10 ? '0' : '') + n }
	// HH:mm:ss（24 小时制本地时间）
	function formatClock(ms) {
		const d = new Date(ms)
		if (isNaN(d.getTime())) return '—'
		return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
	}
	// 悬停读数：跨度不满一天只显示 HH:mm:ss，跨天补日期
	function formatHoverTime(ms, spanMs) {
		if (isNaN(ms) || ms == null) return '—'
		if (!(spanMs >= DAY_MS)) return formatClock(ms)
		const d = new Date(ms)
		return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + formatClock(ms)
	}
	// 横轴刻度：跨度不满一天 HH:mm:ss（秒级对齐时刻同样成立），跨天显示「月-日 时:分」
	function formatAxisTime(ms, spanMs) {
		if (isNaN(ms) || ms == null) return ''
		if (!(spanMs >= DAY_MS)) return formatClock(ms)
		const d = new Date(ms)
		return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
	}

	const lib = {
		DEFAULT_CAPACITY: DEFAULT_CAPACITY,
		CAP_MIN: CAP_MIN,
		CAP_MAX: CAP_MAX,
		MAX_AXES: MAX_AXES,
		clampCapacity: clampCapacity,
		seriesKey: seriesKey,
		createStore: createStore,
		createFramePump: createFramePump,
		groupAxes: groupAxes,
		alignSeries: alignSeries,
		toCSV: toCSV,
		formatNumber: formatNumber,
		DAY_MS: DAY_MS,
		formatClock: formatClock,
		formatHoverTime: formatHoverTime,
		formatAxisTime: formatAxisTime,
	}

	if (typeof module !== 'undefined' && module.exports) module.exports = lib
	if (root) root.SerialCurvesCore = lib
})(typeof window !== 'undefined' ? window : globalThis)
