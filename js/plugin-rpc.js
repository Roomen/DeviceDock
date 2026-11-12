// 插件 RPC 的纯逻辑：能力表、方法白名单、消息信封、主题载荷与左栏排序。
// 不碰 DOM、不碰串口，可在 node 里跑(tests/plugin-rpc.cjs)。API 实现在 js/plugin-api.js，
// 传输与生命周期在 js/plugin-host.js，插件端 SDK 在 sdk/devicedock-plugin.js。
//
// 权限模型：能力(manifest capabilities)是唯一的权限边界。宿主对**每一次**调用先查
// 「这个方法属于哪个能力」再查「本插件是否被授权」，未授权直接回错误，不做静默降级。
;(function (root) {
	'use strict'

	const PROTOCOL = 1
	// 与 Rust 侧 manifest.rs 的 CAPABILITIES 一一对应
	const CAPABILITIES = ['device.read', 'serial.io', 'serial.claim', 'protocol.read', 'log', 'app']

	// 人话说明：安装确认框、插件管理面板与文档共用这一份
	const CAPABILITY_TEXT = {
		'device.read': '读取设备与连接：串口列表（VID/PID/序列号/别名/占用者）、BLE 与经典蓝牙设备、各路连接状态与参数；接收热插拔与连接变化事件',
		'serial.io': '按路订阅收发的原始字节（带方向与时间戳），并向某一路写数据',
		'serial.claim': '声明独占或共享占用某个串口（宿主的选口、冲突提示与热插拔都认这个声明），并可打开被自己独占的口收发',
		'protocol.read': '读取各路当前协议与字段目录，调用解析 / 构帧 / 应答匹配，并订阅解析帧与 metrics',
		'log': '写日志行（带插件来源标记）、读最近日志、导出日志',
		'app': '主题与设计令牌、平台画像与版本、busy 源、插件私有存储、保存文件、页内对话框与通知',
	}

	// 方法表：宿主只认这里列出的名字，名字与能力一一对应
	const METHODS = {
		'device.listPorts': 'device.read',
		'device.listBle': 'device.read',
		'device.listClassic': 'device.read',
		'device.bleScan': 'device.read',
		'device.lanes': 'device.read',
		'serial.write': 'serial.io',
		'claim.acquire': 'serial.claim',
		'claim.release': 'serial.claim',
		'claim.list': 'serial.claim',
		'claim.open': 'serial.claim',
		'claim.close': 'serial.claim',
		'claim.write': 'serial.claim',
		'protocol.info': 'protocol.read',
		'protocol.call': 'protocol.read',
		'log.write': 'log',
		'log.recent': 'log',
		'log.export': 'log',
		'app.theme': 'app',
		'app.platform': 'app',
		'app.busyAcquire': 'app',
		'app.busyRelease': 'app',
		'app.storageGet': 'app',
		'app.storageSet': 'app',
		'app.storageRemove': 'app',
		'app.saveFile': 'app',
		'app.dialog': 'app',
		'app.notify': 'app',
	}

	// 宿主 → 插件的事件名(插件端订阅前不需要授权，内容本身来自已授权的方法)
	const EVENTS = ['ready', 'theme', 'theme-change', 'device.ports', 'device.lane', 'device.ble', 'device.ble-error', 'serial.rx', 'serial.tx', 'protocol.frame', 'claim.rx', 'claim.state', 'app.busy', 'events.dropped']

	const ERROR_TEXT = {
		bad_request: '请求格式不正确',
		capability_denied: '插件没有声明这项能力',
		unknown_method: '宿主不支持这个方法',
		not_found: '对象不存在',
		unsupported: '当前环境不支持',
		too_large: '数据超过上限',
		rate_limited: '插件请求过于频繁',
		closing: '串口正在关闭',
		unsupported_async: '不支持异步协议函数',
		internal: '宿主内部错误',
	}

	// 消息 / 在飞 / 速率上限：插件是第三方代码，高频调用或大消息不能拖垮宿主界面。
	// 估算大小时不拼大字符串，超过预算立即停止，避免「先分配 100MB 再拒绝」。
	// 事件分两类：状态事件（连接 / 断开 / 占用 / 主题 / 设备信息变化等）按类型合并为最新态
	// 并保证送达；数据流事件（串口字节、解析帧、BLE 广播）按配额限流，超额丢弃并报 events.dropped。
	const STATE_EVENTS = [
		'ready', 'theme', 'theme-change', 'device.ports', 'device.lane',
		'device.ble-error', 'claim.state', 'app.busy',
	]
	const DATA_EVENTS = ['serial.rx', 'serial.tx', 'protocol.frame', 'claim.rx', 'device.ble']
	function isStateEvent(name) { return STATE_EVENTS.indexOf(name) !== -1 }
	function isDataEvent(name) { return DATA_EVENTS.indexOf(name) !== -1 }
	// 纯函数：限流期间同一类型只保留最新一份，旧的直接被覆盖
	function coalesceState(pending, name, payload) {
		const out = Object.assign({}, pending || {})
		out[name] = payload
		return out
	}

	const LIMITS = {
		maxMessageChars: 256 * 1024,
		maxParamsChars: 128 * 1024,
		maxExportChars: 8 * 1024 * 1024,
		maxInflight: 8,
		maxRequestsPerWindow: 60,
		windowMs: 1000,
	}
	// 宿主 → 插件的事件也要限流：高频串口字节 / 解析帧不能无限 postMessage
	const EVENT_LIMITS = { maxEventsPerWindow: 120, windowMs: 1000 }
	// 有界遍历：节点数与字符数都受 budget 限制。大数组先只压入预算允许的少量元素，
	// 长度一超预算立即返回 Infinity，绝不把整个数组先压进栈。
	function estimateSize(value, budget) {
		let total = 0
		let steps = 0
		const stack = [value]
		while (stack.length) {
			if (++steps > budget) return Infinity
			const v = stack.pop()
			if (typeof v === 'string') total += v.length
			else if (v === null || v === undefined) total += 4
			else if (typeof v === 'number' || typeof v === 'boolean') total += 8
			else if (Array.isArray(v)) {
				total += 2
				const n = Math.min(v.length, budget)
				if (v.length > n) return Infinity
				for (let i = 0; i < n; i++) stack.push(v[i])
			} else if (typeof v === 'object') {
				// 不先 Object.keys 全量枚举：for…in 逐键计步，超预算立即停
				let keys = 0
				for (const k in v) {
					if (!Object.prototype.hasOwnProperty.call(v, k)) continue
					if (++keys > budget) return Infinity
					total += k.length + 4
					stack.push(v[k])
				}
			}
			if (total > budget) return Infinity
		}
		return total
	}
	// 状态事件走独立的合并窗口：不占数据流配额，也不产生 events.dropped 误报。
	// 窗口内同类型只保留最新，窗口切换或定时器到点后整批补发。
	function newStateEventState() { return { windowStart: 0 } }
	function stateEventPlan(state, now, limits) {
		const l = limits || EVENT_LIMITS
		const s = state || newStateEventState()
		if (now - (s.windowStart || 0) >= l.windowMs) {
			return { immediate: true, flush: true, state: { windowStart: now } }
		}
		return { immediate: false, flush: false, state: s }
	}

	function newEventState() {
		return { windowStart: 0, count: 0, dropped: 0, reported: 0 }
	}
	// 返回 report>0 时宿主应先发一条 events.dropped 计数事件（该事件本身不受限流）。
	// 本窗口第一次丢弃立刻报一次，窗口切换时再补报剩余计数，避免事件流突然静止时插件完全不知情。
	function eventAdmission(state, now, limits) {
		const l = limits || EVENT_LIMITS
		const s = state || newEventState()
		if (now - s.windowStart >= l.windowMs) {
			const report = s.dropped - s.reported
			return { ok: true, report: report > 0 ? report : 0, state: { windowStart: now, count: 1, dropped: 0, reported: 0 } }
		}
		if (s.count >= l.maxEventsPerWindow) {
			const dropped = s.dropped + 1
			const report = s.reported === 0 ? dropped - s.reported : 0
			return {
				ok: false,
				report: report,
				state: { windowStart: s.windowStart, count: s.count, dropped: dropped, reported: s.reported === 0 ? dropped : s.reported },
			}
		}
		return { ok: true, report: 0, state: { windowStart: s.windowStart, count: s.count + 1, dropped: s.dropped, reported: s.reported } }
	}
	function newAdmissionState() {
		return { windowStart: 0, windowCount: 0, inflight: 0 }
	}
	// 纯函数：给定每个插件实例的计数状态与当前时间，决定是否准入；准入即在飞 +1
	function admission(state, now, limits) {
		const l = limits || LIMITS
		const s = state || newAdmissionState()
		if (s.inflight >= l.maxInflight) {
			return { ok: false, state: s, error: { code: 'rate_limited', message: '同时在飞的插件请求过多' } }
		}
		if (now - s.windowStart >= l.windowMs) {
			return { ok: true, state: { windowStart: now, windowCount: 1, inflight: s.inflight + 1 } }
		}
		if (s.windowCount >= l.maxRequestsPerWindow) {
			return { ok: false, state: s, error: { code: 'rate_limited', message: '插件请求过于频繁，请稍后再试' } }
		}
		return { ok: true, state: { windowStart: s.windowStart, windowCount: s.windowCount + 1, inflight: s.inflight + 1 } }
	}
	function releaseInflight(state) {
		const s = state || newAdmissionState()
		return { windowStart: s.windowStart, windowCount: s.windowCount, inflight: Math.max(0, s.inflight - 1) }
	}

	function isObject(v) {
		return !!v && typeof v === 'object' && !Array.isArray(v)
	}

	// 插件 → 宿主：{ __devicedock: 1, id, method, params }
	function validateRequest(msg, opts) {
		const limits = (opts && opts.limits) || LIMITS
		if (!isObject(msg) || msg.__devicedock !== PROTOCOL) return { ok: false, error: { code: 'bad_request', message: ERROR_TEXT.bad_request } }
		if (estimateSize(msg, limits.maxMessageChars) > limits.maxMessageChars) {
			return { ok: false, error: { code: 'too_large', message: '插件请求消息超过 ' + limits.maxMessageChars + ' 字符' } }
		}
		if (typeof msg.id !== 'string' || !msg.id || msg.id.length > 64) return { ok: false, error: { code: 'bad_request', message: '请求缺少 id' } }
		if (typeof msg.method !== 'string' || !msg.method) return { ok: false, error: { code: 'bad_request', message: '请求缺少 method' } }
		const params = msg.params === undefined ? {} : msg.params
		if (!isObject(params)) return { ok: false, error: { code: 'bad_request', message: 'params 必须是对象' } }
		if (estimateSize(params, limits.maxParamsChars) > limits.maxParamsChars) {
			return { ok: false, error: { code: 'too_large', message: '插件请求参数超过 ' + limits.maxParamsChars + ' 字符' } }
		}
		return { ok: true, id: msg.id, method: msg.method, params: params }
	}

	function capabilityFor(method) {
		return Object.prototype.hasOwnProperty.call(METHODS, method) ? METHODS[method] : null
	}

	// 返回 null 表示可以执行，否则返回要回给插件的错误
	function authorize(grants, method) {
		const capability = capabilityFor(method)
		if (!capability) return { code: 'unknown_method', message: ERROR_TEXT.unknown_method + '：' + String(method) }
		if (!Array.isArray(grants) || grants.indexOf(capability) === -1) {
			return { code: 'capability_denied', message: '插件没有声明能力 ' + capability }
		}
		return null
	}

	function resultEnvelope(id, result) {
		return { __devicedock: PROTOCOL, id: id, result: result === undefined ? null : result }
	}
	function errorEnvelope(id, code, message) {
		return { __devicedock: PROTOCOL, id: id, error: { code: code || 'internal', message: message || ERROR_TEXT.internal } }
	}
	function eventEnvelope(name, payload) {
		return { __devicedock: PROTOCOL, event: name, payload: payload === undefined ? null : payload }
	}
	// 宿主 → 插件的事件信封(插件端 SDK 也认这个形状)
	function isEvent(msg) {
		return isObject(msg) && msg.__devicedock === PROTOCOL && typeof msg.event === 'string' && msg.id === undefined
	}
	// 插件 → 宿主的响应(当前协议里插件不主动回包，保留给将来的双向调用)
	function isEnvelope(msg) {
		return isObject(msg) && msg.__devicedock === PROTOCOL
	}

	// 主题载荷：light / dark + 设计令牌快照(:root 上的 CSS 变量)
	function themePayload(theme, tokens) {
		return { theme: theme === 'dark' ? 'dark' : 'light', tokens: isObject(tokens) ? tokens : {} }
	}

	// 能力清单(安装确认框、管理面板)
	function capabilitySummary(caps) {
		return (Array.isArray(caps) ? caps : []).map(function (id) {
			return { id: id, text: CAPABILITY_TEXT[id] || '未定义的能力：' + id }
		})
	}
	// 已加载的 iframe 是否必须整套重载：逐版本确认过的包摘要或授权集合一旦变化，
	// 旧代码不能继续用新能力表授权（同版本重装也是新的一次信任）
	function pluginChanged(a, b) {
		if (!a || !b) return true
		if (a.version !== b.version || a.entry !== b.entry) return true
		if ((a.packageSha256 || '') !== (b.packageSha256 || '')) return true
		const norm = function (v) { return (Array.isArray(v) ? v.slice().sort() : []).join('|') }
		return norm(a.capabilities) !== norm(b.capabilities)
	}
	// 版本之间的能力变化：更新确认要显示新增(更要注意)与移除
	function changedCapabilities(oldCaps, newCaps) {
		const a = Array.isArray(oldCaps) ? oldCaps : []
		const b = Array.isArray(newCaps) ? newCaps : []
		return {
			added: b.filter(function (c) { return a.indexOf(c) === -1 }),
			removed: a.filter(function (c) { return b.indexOf(c) === -1 }),
		}
	}

	// 左栏插件顺序：已存的顺序里还存在的先按原序，剩下的按传入顺序追加(新装的排最后)
	function orderPlugins(ids, saved) {
		const list = (Array.isArray(ids) ? ids : []).filter(function (id, i, all) { return typeof id === 'string' && all.indexOf(id) === i })
		const keep = (Array.isArray(saved) ? saved : []).filter(function (id) { return list.indexOf(id) !== -1 })
		return keep.concat(list.filter(function (id) { return keep.indexOf(id) === -1 }))
	}
	// 上移 / 下移一位(键盘可达：Alt+↑ / Alt+↓)
	function movePlugin(order, id, delta) {
		const list = orderPlugins(order, order)
		const from = list.indexOf(id)
		if (from === -1) return list
		const to = Math.max(0, Math.min(list.length - 1, from + (Number(delta) || 0)))
		if (to === from) return list
		list.splice(to, 0, list.splice(from, 1)[0])
		return list
	}
	// 拖到某个位置(from / to 都是当前顺序里的下标)
	function movePluginTo(order, from, to) {
		const list = orderPlugins(order, order)
		if (from < 0 || from >= list.length) return list
		const item = list.splice(from, 1)[0]
		list.splice(Math.max(0, Math.min(list.length, to)), 0, item)
		return list
	}

	// 串口 / 状态查询里按路过滤：只认当前模式可见的那几路
	function lanesForMode(mode) {
		return mode === 'dual' ? ['A', 'B'] : ['S']
	}

	// 字节参数校验：插件只能给 0..255 的数组或十六进制串，宿主不替它猜
	function toBytes(value, maxBytes) {
		const limit = maxBytes || 65536
		if (typeof value === 'string') {
			const text = value.replace(/[\s,]/g, '')
			if (!/^([0-9a-fA-F]{2})+$/.test(text)) return { ok: false, error: { code: 'bad_request', message: '十六进制串格式不对' } }
			if (text.length / 2 > limit) return { ok: false, error: { code: 'too_large', message: '数据超过 ' + limit + ' 字节' } }
			const out = []
			for (let i = 0; i < text.length; i += 2) out.push(parseInt(text.slice(i, i + 2), 16))
			return { ok: true, bytes: out }
		}
		if (Array.isArray(value)) {
			if (value.length > limit) return { ok: false, error: { code: 'too_large', message: '数据超过 ' + limit + ' 字节' } }
			const out = []
			for (let i = 0; i < value.length; i++) {
				const n = value[i]
				if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255) return { ok: false, error: { code: 'bad_request', message: '字节必须是 0..255 的整数' } }
				out.push(n)
			}
			return { ok: true, bytes: out }
		}
		return { ok: false, error: { code: 'bad_request', message: '数据必须是字节数组或十六进制串' } }
	}

	const lib = {
		PROTOCOL, CAPABILITIES, CAPABILITY_TEXT, METHODS, EVENTS, ERROR_TEXT,
		LIMITS, EVENT_LIMITS, STATE_EVENTS, DATA_EVENTS, isStateEvent, isDataEvent, coalesceState,
		estimateSize, newEventState, eventAdmission, newStateEventState, stateEventPlan,
		newAdmissionState, admission, releaseInflight,
		isObject, isEnvelope, isEvent, validateRequest, capabilityFor, authorize,
		resultEnvelope, errorEnvelope, eventEnvelope, themePayload, capabilitySummary,
		pluginChanged, changedCapabilities, orderPlugins, movePlugin, movePluginTo, lanesForMode, toBytes,
	}

	root.DeviceDockPluginRpc = lib
	if (typeof module !== 'undefined' && module.exports) module.exports = lib
})(typeof window !== 'undefined' ? window : globalThis)
