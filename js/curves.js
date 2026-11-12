// 曲线采集：每路收到的实时帧经该路协议的 metrics(frame) 转成数值点，按「路 / 字段」存时间序列。
// 采集入口 window.SerialMetrics.ingest(sid, bytes) 由 common.js 的 addLog 在按路上下文(inLiveLane)里同步调用：
// 换入换出由 common.js 负责，这里不得 await、不得自己切协议，也不收历史重放帧。
// 面板 js/curves-panel.js 只读这里的 store 并监听 document 上的 serial-curves 事件。
;(function (root) {
	'use strict'

	const Core = root.SerialCurvesCore
	if (!Core) {
		console.warn('curves: curves-core.js 未加载')
		return
	}

	const STORE_KEY = 'serialCurvesModern'
	const NOTIFY_MS = 150

	let capacity = Core.DEFAULT_CAPACITY
	let selected = null
	let paused = false
	try {
		const st = JSON.parse(root.localStorage.getItem(STORE_KEY) || 'null')
		if (st && typeof st === 'object') {
			if (st.capacity != null) capacity = Core.clampCapacity(st.capacity)
			if (Array.isArray(st.selected)) {
				selected = st.selected.filter(function (x) { return typeof x === 'string' })
			}
		}
	} catch (e) { /* 存储不可用就只用默认值 */ }

	const store = Core.createStore({ capacity })
	// 每路一个帧缓冲；协议换了就丢掉残帧(上一协议的半帧不能拼进新协议)
	const pumps = {}
	let notifyTimer = null
	const listeners = []

	function persist() {
		try {
			root.localStorage.setItem(STORE_KEY, JSON.stringify({ capacity: capacity, selected: selected || [] }))
		} catch (e) { /* 忽略存储失败 */ }
	}

	function fieldIndex(proto) {
		const map = new Map()
		const fields = proto && Array.isArray(proto.fields) ? proto.fields : []
		fields.forEach(function (f) {
			if (!f || f.key == null) return
			map.set(String(f.key), { name: f.name || String(f.key), unit: f.unit || '', chart: !!f.chart })
		})
		return map
	}

	function parseOpts() {
		const api = root.serialApi
		if (api && typeof api.getParseOpts === 'function') {
			try { return api.getParseOpts() } catch (e) { /* */ }
		}
		return {}
	}

	function makePump() {
		return Core.createFramePump({
			findFrame: function (u8) {
				return typeof root.skFindFrame === 'function' ? root.skFindFrame(u8, parseOpts()) : null
			},
			parseFrame: function (raw) {
				return typeof root.skParseFrame === 'function' ? root.skParseFrame(raw, parseOpts()) : null
			},
		})
	}

	function pumpFor(sid) {
		const pid = root._activeProtocol || ''
		let slot = pumps[sid]
		if (!slot || slot.pid !== pid) {
			slot = pumps[sid] = { pid: pid, pump: makePump() }
		}
		return slot.pump
	}

	function notify() {
		if (notifyTimer != null) return
		notifyTimer = root.setTimeout(function () {
			notifyTimer = null
			listeners.slice().forEach(function (fn) {
				try { fn() } catch (e) { console.warn('曲线监听器出错', e) }
			})
			const d = root.document
			if (d && d.dispatchEvent) d.dispatchEvent(new CustomEvent('serial-curves'))
		}, NOTIFY_MS)
	}

	// 在按路上下文里同步跑：协议、解析函数与 _activeProtocol 都已经是这一路的
	function ingest(sid, bytes) {
		if (paused || !bytes || !bytes.length) return
		const proto = typeof root.getActiveProtocol === 'function' ? root.getActiveProtocol() : null
		if (!proto || typeof proto.metrics !== 'function') return
		const frames = pumpFor(sid).push(bytes)
		if (!frames.length) return
		const fields = fieldIndex(proto)
		const ts = Date.now()
		let added = 0
		frames.forEach(function (f) {
			let points = null
			try { points = proto.metrics(f.frame) } catch (e) { points = null }
			if (!points || !points.length) return
			store.ingest(sid, ts, points, function (key) {
				return fields.get(String(key)) || null
			})
			added += points.length
		})
		if (added) notify()
	}

	function lanes() {
		const hub = root.SerialHub
		return hub && hub.mode === 'dual' ? ['A', 'B'] : ['S']
	}

	function laneName(sid) {
		const hub = root.SerialHub
		if (sid === 'A' && hub && typeof hub.getLabelA === 'function') return hub.getLabelA()
		if (sid === 'B' && hub && typeof hub.getLabelB === 'function') return hub.getLabelB()
		return sid === 'S' ? '单路' : sid
	}

	// 面板要的字段目录：按这一路当前协议读注册表(不在实时上下文里，不能读 _activeProtocol)
	function fieldsFor(sid) {
		const id = typeof root.protocolIdForSid === 'function' ? root.protocolIdForSid(sid) : 'sek'
		const reg = root.DeviceDockProtocols
		const proto = reg && typeof reg.get === 'function' ? reg.get(id) : null
		const fields = proto && Array.isArray(proto.fields) ? proto.fields : []
		return fields.filter(function (f) { return f && f.key != null }).map(function (f) {
			return {
				key: String(f.key),
				name: f.name || String(f.key),
				unit: f.unit || '',
				chart: !!f.chart,
				hasMetrics: !!(proto && typeof proto.metrics === 'function'),
			}
		})
	}

	function protoName(sid) {
		const id = typeof root.protocolIdForSid === 'function' ? root.protocolIdForSid(sid) : ''
		const reg = root.DeviceDockProtocols
		const proto = reg && typeof reg.get === 'function' ? reg.get(id) : null
		return proto && proto.name ? proto.name : (id || '—')
	}

	const api = {
		store: store,
		lanes: lanes,
		laneName: laneName,
		fieldsFor: fieldsFor,
		protoName: protoName,
		isPaused: function () { return paused },
		setPaused: function (v) {
			paused = !!v
			notify()
			return paused
		},
		clear: function (sid) {
			store.clear(sid)
			notify()
		},
		capacity: function () { return capacity },
		setCapacity: function (v) {
			capacity = store.setCapacity(v)
			persist()
			notify()
			return capacity
		},
		// 面板的字段选择：'<路>|<key>'，null 表示还没选过(面板按 chart:true 出默认值)
		selected: function () { return selected ? selected.slice() : null },
		setSelected: function (list) {
			selected = (list || []).filter(function (x) { return typeof x === 'string' })
			persist()
			return selected.slice()
		},
		onChange: function (fn) {
			if (typeof fn !== 'function') return function () {}
			listeners.push(fn)
			return function () {
				const i = listeners.indexOf(fn)
				if (i !== -1) listeners.splice(i, 1)
			}
		},
	}

	root.SerialCurves = api
	// common.js 的实时日志路径只认这个入口
	root.SerialMetrics = { ingest: ingest }
})(typeof window !== 'undefined' ? window : globalThis)
