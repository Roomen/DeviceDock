// 协议注册表的唯一存储与查询入口（内置协议与外部协议走同一条规范化路径）。
// 契约校验在 js/protocol-contract.js；这里只管「谁注册了什么、属于哪个组、哪些外部协议还在加载」。
// 内置协议用 register(id, def)；外部包用 registerExternal(sourceKey, protoId, def, meta)，
// 实际 id 是 <来源键>/<协议 id>，下拉框按组（内置 / 每个来源一组）呈现。
// 晚注册 / 卸载会派发 document 上的 protocol-registry-change，顶栏下拉与来源面板据此刷新。
;(function (root) {
	'use strict'

	const Contract = root.DeviceDockContract
	if (!Contract) throw new Error('protocol-registry: protocol-contract.js 未加载')

	// 与 common.js 共用的存储对象（common.js 里有 getActiveProtocol 直接读它）
	const store = root._protocols || (root._protocols = {})
	const entries = {}
	// 已启用、但字节还没加载完的外部协议 id；启动时先登记，避免 common.js 的「未知协议回退 SEK」把它们清掉
	const expected = {}
	const listeners = []
	let order = 0

	function doc() { return root.document || null }
	function dispatch() {
		listeners.slice().forEach(function (fn) {
			try { fn() } catch (e) { console.warn('protocol-registry 监听器出错', e) }
		})
		const d = doc()
		if (d && d.dispatchEvent) d.dispatchEvent(new CustomEvent('protocol-registry-change'))
	}
	function metaOf(meta) {
		const m = meta || {}
		const builtin = m.builtin !== false && !m.source
		return {
			builtin: builtin,
			source: builtin ? '' : String(m.source || ''),
			sourceName: builtin ? '' : String(m.sourceName || m.source || ''),
			packageId: String(m.packageId || ''),
			version: String(m.version || ''),
			digest: String(m.digest || ''),
		}
	}
	function register(id, impl, meta) {
		if (!id || typeof id !== 'string') throw new Error('registerProtocol: id 无效')
		const def = Contract.normalizeProtocolDef(impl)
		const m = metaOf(meta)
		entries[id] = { id: id, raw: impl, def: def, meta: m, seq: order++ }
		store[id] = def
		delete expected[id]
		dispatch()
		return def
	}
	function registerExternal(sourceKey, protocolId, impl, meta) {
		const id = Contract.namespaceId(sourceKey, protocolId)
		return register(id, impl, Object.assign({}, meta, { builtin: false, source: sourceKey }))
	}
	// 内置协议模块晚于注册点补充字段目录 / 测试执行器时用（例如 SEK 的 js/sek-test-profile.js）
	function extend(id, patch) {
		const entry = entries[id]
		if (!entry) return null
		return register(id, Object.assign({}, entry.raw, patch || {}), entry.meta)
	}
	function unregister(id) {
		if (!entries[id]) return false
		delete entries[id]
		delete store[id]
		dispatch()
		return true
	}
	function get(id) {
		const entry = entries[id]
		return entry ? entry.def : (store[id] || null)
	}
	function has(id) { return !!entries[id] }
	function meta(id) {
		const entry = entries[id]
		return entry ? Object.assign({}, entry.meta) : null
	}
	function ids() { return Object.keys(entries) }
	// 下拉框分组：内置一组，每个来源一组（来源按名称排序，内置永远第一）
	function groups() {
		const builtin = []
		const bySource = {}
		Object.keys(entries).forEach(function (id) {
			const e = entries[id]
			const item = { id: id, name: e.def.name || id }
			if (e.meta.builtin) { builtin.push(item); return }
			const key = e.meta.source || 'external'
			if (!bySource[key]) bySource[key] = { label: e.meta.sourceName || key, items: [] }
			bySource[key].items.push(item)
		})
		const out = []
		if (builtin.length) out.push({ label: '内置', items: builtin })
		Object.keys(bySource).sort(function (a, b) { return bySource[a].label.localeCompare(bySource[b].label) }).forEach(function (k) {
			out.push(bySource[k])
		})
		return out
	}
	// 外部协议字节还在加载：先登记 id，别让「未知协议回退 SEK」提前把它清掉
	function expect(id) {
		if (!id || entries[id]) return
		expected[id] = true
	}
	function isPending(id) { return !!expected[id] }
	function settle(id) { delete expected[id] }
	function isKnownOrPending(id) { return !!entries[id] || !!expected[id] }
	function pendingIds() { return Object.keys(expected) }
	function onChange(fn) {
		if (typeof fn !== 'function') return function () {}
		listeners.push(fn)
		return function () {
			const i = listeners.indexOf(fn)
			if (i !== -1) listeners.splice(i, 1)
		}
	}

	const api = {
		register: register,
		registerExternal: registerExternal,
		extend: extend,
		unregister: unregister,
		get: get,
		has: has,
		meta: meta,
		ids: ids,
		groups: groups,
		expect: expect,
		isPending: isPending,
		settle: settle,
		isKnownOrPending: isKnownOrPending,
		pendingIds: pendingIds,
		onChange: onChange,
	}
	root.DeviceDockProtocols = api
})(typeof window !== 'undefined' ? window : globalThis)
