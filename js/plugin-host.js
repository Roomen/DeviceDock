// 客户端插件宿主（仅桌面客户端）：左栏「插件」目录、插件页面（sandbox iframe）、postMessage RPC、主题推送、
// busy 源与生命周期。网页版 / 移动端没有 AppPlatform.service('plugins')，本文件立即返回，不留任何入口或监听。
//
// 隔离：插件 UI 在 sandbox="allow-scripts" 的 iframe 里（不给 allow-same-origin），src 走 ddplugin:// 自定义协议，
// 与宿主页面不同源；插件只能用 postMessage 调宿主 API，能力白名单在 js/plugin-rpc.js 里逐次校验。
// 停用 / 卸载 / 刷新：销毁 iframe、释放插件声明的串口、注销 busy 源，不留下看不见的订阅。
;(function (root) {
	'use strict'
	const P = root.AppPlatform
	if (!P || !P.has || !P.has('plugins')) return
	const svc = P.service('plugins')
	if (!svc) return
	const Rpc = root.DeviceDockPluginRpc
	const Api = root.PluginApi
	if (!Rpc || !Api || !root.document) return

	const doc = root.document
	const ORDER_KEY = 'pluginOrderV1'
	const VIEW_PREFIX = 'view-plugin-'
	// 主题令牌快照的兜底名单：拿不到全部自定义属性时只推这些(P1.5 的核心令牌)
	const FALLBACK_TOKENS = [
		'--bg-body', '--bg-surface', '--bg-surface-hover', '--bg-code', '--bg-elevated',
		'--text-primary', '--text-secondary', '--text-muted', '--border-color', '--border-strong',
		'--accent', '--accent-light', '--accent-fg', '--success', '--warning', '--danger',
		'--ch-a', '--ch-b', '--ch-s', '--font-sans', '--font-mono',
		'--fs-micro', '--fs-small', '--fs-body', '--fs-body-lg', '--fs-title', '--fs-figure', '--fs-page',
		'--radius-sm', '--radius', '--radius-lg', '--ctl-h', '--ctl-h-sm', '--shadow-sm', '--shadow-md',
	]

	let plugins = []
	let order = []
	const views = new Map()
	let railBox = null
	let dragId = ''
	let dropTarget = null
	let byteTapInstalled = false
	let started = false

	function mk(tag, cls, text) {
		const el = doc.createElement(tag)
		if (cls) el.className = cls
		if (text != null) el.textContent = text
		return el
	}
	function toast(text) {
		if (root.serialLanes && root.serialLanes.toast) root.serialLanes.toast(text)
	}
	function loadOrder() {
		try {
			const raw = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]')
			order = Array.isArray(raw) ? raw.filter(function (id) { return typeof id === 'string' }) : []
		} catch (e) { order = [] }
	}
	function saveOrder() {
		try { localStorage.setItem(ORDER_KEY, JSON.stringify(order)) } catch (e) {}
	}
	function viewIdOf(id) {
		return VIEW_PREFIX + String(id).replace(/[^a-z0-9.-]/gi, '-')
	}
	function byId(id) {
		for (let i = 0; i < plugins.length; i++) if (plugins[i].id === id) return plugins[i]
		return null
	}
	// 只有「启用 + 当前系统支持 + manifest 没问题」的插件才出现在左栏与视图里
	function visible() {
		return plugins.filter(function (p) { return p.enabled && p.supported && !p.error })
	}

	// ---------- ddplugin:// 地址 ----------
	let basePrefix = ''
	function pluginBase() {
		if (basePrefix) return basePrefix
		let probe = ''
		try {
			if (root.__TAURI__ && root.__TAURI__.core && root.__TAURI__.core.convertFileSrc) probe = String(root.__TAURI__.core.convertFileSrc('__probe__', 'ddplugin'))
		} catch (e) { probe = '' }
		const at = probe.indexOf('__probe__')
		// Windows / Android 是 http://ddplugin.localhost/，macOS 与 Linux 是 ddplugin://localhost/，由壳给出，不在这里按平台名分支
		basePrefix = at !== -1 ? probe.slice(0, at) : 'ddplugin://localhost/'
		return basePrefix
	}
	function pluginUrl(plugin, rel) {
		const path = String(rel || '').split('/').map(encodeURIComponent).join('/')
		return pluginBase() + encodeURIComponent(plugin.id) + '/' + encodeURIComponent(plugin.version) + '/' + path
	}

	// ---------- 主题 ----------
	function readTokens() {
		const tokens = {}
		const el = doc.documentElement
		if (el && root.getComputedStyle) {
			const computed = root.getComputedStyle(el)
			for (let i = 0; i < computed.length; i++) {
				const name = computed[i]
				if (name && name.indexOf('--') === 0) tokens[name] = String(computed.getPropertyValue(name)).trim()
			}
		}
		if (Object.keys(tokens).length < 10) {
			FALLBACK_TOKENS.forEach(function (name) {
				if (!tokens[name]) tokens[name] = String(root.getComputedStyle ? root.getComputedStyle(el).getPropertyValue(name) : '').trim()
			})
		}
		return tokens
	}
	function themeState() {
		return Rpc.themePayload(doc.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light', readTokens())
	}
	function pushTheme() {
		const payload = themeState()
		views.forEach(function (view) {
			if (view.ready) post(view, Rpc.eventEnvelope('theme-change', payload))
		})
	}

	// ---------- 视图与 iframe ----------
	function ensureView(plugin) {
		let view = views.get(plugin.id)
		if (view) return view
		const el = mk('div', 'app-view plugin-view')
		el.id = viewIdOf(plugin.id)
		el.dataset.plugin = plugin.id
		const iframe = doc.createElement('iframe')
		iframe.className = 'plugin-frame'
		// 关键：不给 allow-same-origin，插件文档是 opaque origin，拿不到宿主的 DOM / cookie / 存储
		iframe.setAttribute('sandbox', 'allow-scripts')
		iframe.setAttribute('referrerpolicy', 'no-referrer')
		iframe.setAttribute('title', plugin.name + '（插件）')
		el.appendChild(iframe)
		const host = doc.getElementById('views')
		if (!host) return null
		host.appendChild(el)
		view = {
			plugin: plugin, el: el, iframe: iframe, ready: false, closed: false,
			claims: new Map(), busy: new Map(), busySeq: 0, teardowns: [], ctx: null,
		}
		view.ctx = makeContext(view)
		iframe.addEventListener('load', function () {
			if (view.closed) return
			view.ready = true
			post(view, Rpc.eventEnvelope('ready', Object.assign({
				plugin: { id: plugin.id, name: plugin.name, version: plugin.version },
				platform: platformInfo(),
			}, themeState())))
		})
		// 自定义协议加载失败（包被停用、文件校验失败）时不弹浏览器错误页：换成宿主自己的提示
		iframe.addEventListener('error', function () { failView(view, '插件页面加载失败') })
		iframe.src = pluginUrl(plugin, plugin.entry)
		views.set(plugin.id, view)
		ensureByteTap()
		return view
	}
	function failView(view, text) {
		if (view.closed || view.failed) return
		view.failed = true
		const box = mk('div', 'plugin-fallback')
		box.appendChild(mk('div', 'plugin-fallback-title', text))
		box.appendChild(mk('div', 'plugin-fallback-text', '可在「配置 → 插件」里重新安装或停用它。'))
		view.el.appendChild(box)
	}
	function destroyView(id) {
		const view = views.get(id)
		if (!view) return
		view.closed = true
		view.teardowns.forEach(function (fn) { try { fn() } catch (e) {} })
		view.teardowns = []
		view.claims.forEach(function (rec) { try { rec.reading = false; if (rec.port && rec.open) rec.port.close().catch(function () {}) } catch (e) {} })
		view.claims.clear()
		view.busy.clear()
		if (root.serialPortClaims && root.serialPortClaims.releasePlugin) root.serialPortClaims.releasePlugin(id)
		view.iframe.removeAttribute('src')
		view.el.remove()
		views.delete(id)
	}
	function platformInfo() {
		return {
			os: P.os, runtime: P.runtime, profile: P.profile, lanes: P.lanes,
			version: root.APP_VERSION || '',
		}
	}
	function post(view, msg) {
		if (!view || view.closed || !view.iframe.contentWindow) return
		try { view.iframe.contentWindow.postMessage(msg, '*') } catch (e) {}
	}

	function makeContext(view) {
		const plugin = view.plugin
		const ctx = {
			id: plugin.id, name: plugin.name, version: plugin.version, capabilities: plugin.capabilities || [],
			send: function (name, payload) { post(view, Rpc.eventEnvelope(name, payload)) },
			theme: themeState,
			onTeardown: function (fn) { if (typeof fn === 'function') view.teardowns.push(fn) },
			claim: function (claimId) {
				const rec = { id: claimId, ctx: ctx, port: null, open: false, reading: false, reader: null, mode: 'exclusive' }
				view.claims.set(claimId, rec)
				return rec
			},
			claimRecord: function (claimId) { return view.claims.get(String(claimId || '')) || null },
			dropClaim: function (claimId) { view.claims.delete(claimId) },
			claims: function () { return Array.from(view.claims.values()) },
			busyAcquire: function (label) {
				const id = 'busy-' + (++view.busySeq)
				view.busy.set(id, label)
				return id
			},
			busyRelease: function (id) { return view.busy.delete(String(id || '')) },
		}
		return ctx
	}

	// ---------- RPC ----------
	function viewBySource(source) {
		let found = null
		views.forEach(function (view) {
			if (found || view.closed) return
			if (view.iframe.contentWindow === source) found = view
		})
		return found
	}
	async function onMessage(event) {
		const view = viewBySource(event.source)
		if (!view || view.closed) return
		const data = event.data
		const req = Rpc.validateRequest(data)
		if (!req.ok) {
			// 请求本身不合法：能取到 id 就回错误，取不到就静默丢弃（插件写坏了不该拖垮宿主）
			const id = data && typeof data.id === 'string' ? data.id : ''
			if (id) post(view, Rpc.errorEnvelope(id, req.error.code, req.error.message))
			return
		}
		const denied = Rpc.authorize(view.plugin.capabilities || [], req.method)
		if (denied) {
			post(view, Rpc.errorEnvelope(req.id, denied.code, denied.message))
			return
		}
		try {
			const result = await Api.call(req.method, req.params, view.ctx)
			post(view, Rpc.resultEnvelope(req.id, result))
		} catch (e) {
			const code = e && e.code ? e.code : 'internal'
			const message = String(e && e.message ? e.message : e)
			post(view, Rpc.errorEnvelope(req.id, code, message))
		}
	}

	// ---------- 原始字节 / 解析帧 / 设备事件 ----------
	function ensureByteTap() {
		if (byteTapInstalled || !root.serialByteTap) return
		byteTapInstalled = true
		root.serialByteTap.add(function (direction, sid, data) {
			let payload = null
			views.forEach(function (view) {
				if (view.closed || !view.ready) return
				if ((view.plugin.capabilities || []).indexOf('serial.io') === -1) return
				// 同一块字节只转成数组一次，postMessage 各自结构化克隆
				if (!payload) payload = { lane: sid, at: Date.now(), bytes: Array.from(data) }
				post(view, Rpc.eventEnvelope(direction === 'rx' ? 'serial.rx' : 'serial.tx', payload))
			})
		})
		doc.addEventListener('serial-parse-frame', function (e) {
			const detail = e && e.detail ? e.detail : null
			views.forEach(function (view) {
				if (view.closed || !view.ready) return
				if ((view.plugin.capabilities || []).indexOf('protocol.read') === -1) return
				post(view, Rpc.eventEnvelope('protocol.frame', detail))
			})
		})
		doc.addEventListener('serial-session', function (e) {
			const d = e && e.detail ? e.detail : null
			if (!d) return
			views.forEach(function (view) {
				if (view.closed || !view.ready) return
				if ((view.plugin.capabilities || []).indexOf('device.read') === -1) return
				post(view, Rpc.eventEnvelope('device.lane', { sid: d.sid, state: d.state, generation: d.generation }))
			})
		})
		const adapter = root.SerialAdapter
		if (adapter && adapter.addEventListener) {
			['connect', 'disconnect', 'change'].forEach(function (type) {
				adapter.addEventListener(type, function () {
					views.forEach(function (view) {
						if (view.closed || !view.ready) return
						if ((view.plugin.capabilities || []).indexOf('device.read') === -1) return
						post(view, Rpc.eventEnvelope('device.ports', { type: type }))
					})
				})
			})
		}
	}

	// ---------- 左栏 ----------
	function ensureRail() {
		if (railBox) return railBox
		const top = doc.querySelector('#activity-rail .rail-top')
		if (!top) return null
		railBox = mk('div', 'rail-plugins')
		railBox.id = 'rail-plugins'
		railBox.setAttribute('role', 'group')
		railBox.setAttribute('aria-label', '插件')
		railBox.dataset.feature = 'plugins'
		const label = mk('div', 'rail-section-label', '插件')
		label.setAttribute('aria-hidden', 'true')
		railBox.appendChild(label)
		top.appendChild(railBox)
		return railBox
	}
	function railItem(plugin) {
		const item = mk('button', 'rail-item rail-plugin')
		item.type = 'button'
		item.dataset.plugin = plugin.id
		item.dataset.view = viewIdOf(plugin.id)
		item.title = plugin.name + '（插件 ' + plugin.version + '）'
		item.draggable = true
		const icon = String(plugin.icon || '')
		if (icon && (icon.indexOf('/') !== -1 || icon.indexOf('.') !== -1)) {
			const img = doc.createElement('img')
			img.className = 'rail-plugin-img'
			img.alt = ''
			img.src = pluginUrl(plugin, icon)
			item.appendChild(img)
		} else {
			item.appendChild(mk('i', 'icon icon-lg icon-' + (/^[a-z0-9-]+$/.test(icon) ? icon : 'layout-grid')))
		}
		item.appendChild(mk('span', 'rail-label', plugin.name))
		item.addEventListener('click', function () { openPlugin(plugin.id) })
		item.addEventListener('keydown', function (e) {
			if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
			e.preventDefault()
			const next = Rpc.movePlugin(order, plugin.id, e.key === 'ArrowUp' ? -1 : 1)
			order = next
			saveOrder()
			renderRail()
			const again = railBox.querySelector('[data-plugin="' + plugin.id + '"]')
			if (again) again.focus()
		})
		item.addEventListener('dragstart', function (e) {
			dragId = plugin.id
			item.classList.add('is-dragging')
			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move'
				try { e.dataTransfer.setData('text/plain', plugin.id) } catch (err) {}
			}
		})
		item.addEventListener('dragend', function () {
			dragId = ''
			clearDropMarks()
			item.classList.remove('is-dragging')
		})
		item.addEventListener('dragover', function (e) {
			if (!dragId || dragId === plugin.id) return
			e.preventDefault()
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
			const box = item.getBoundingClientRect()
			const after = (e.clientY - box.top) > box.height / 2
			clearDropMarks()
			dropTarget = { id: plugin.id, after: after }
			item.classList.add(after ? 'is-drop-after' : 'is-drop-before')
		})
		item.addEventListener('dragleave', function () { item.classList.remove('is-drop-before', 'is-drop-after') })
		item.addEventListener('drop', function (e) {
			if (!dragId || dragId === plugin.id) return
			e.preventDefault()
			const list = Rpc.orderPlugins(railIds(), order)
			const from = list.indexOf(dragId)
			let to = list.indexOf(plugin.id) + (dropTarget && dropTarget.after ? 1 : 0)
			if (from !== -1 && to > from) to -= 1
			order = Rpc.movePluginTo(list, from, to)
			saveOrder()
			dragId = ''
			clearDropMarks()
			renderRail()
		})
		return item
	}
	function clearDropMarks() {
		if (!railBox) return
		railBox.querySelectorAll('.is-drop-before, .is-drop-after').forEach(function (el) {
			el.classList.remove('is-drop-before', 'is-drop-after')
		})
	}
	function railIds() {
		return visible().map(function (p) { return p.id })
	}
	function renderRail() {
		const box = ensureRail()
		if (!box) return
		const list = visible()
		order = Rpc.orderPlugins(list.map(function (p) { return p.id }), order)
		saveOrder()
		box.querySelectorAll('.rail-plugin').forEach(function (el) { el.remove() })
		box.hidden = list.length === 0
		if (!list.length) return
		const byOrder = order.map(byId).filter(Boolean)
		byOrder.forEach(function (plugin) { box.appendChild(railItem(plugin)) })
	}

	// ---------- 视图切换 ----------
	function openPlugin(id) {
		const plugin = byId(id)
		if (!plugin || !plugin.enabled || !plugin.supported || plugin.error) return
		const view = ensureView(plugin)
		if (!view) return
		// 视图切换只有一份实现(index.html 的 AppViews)：它按 id 切 .app-view 并写回存下的视图
		if (root.AppViews && root.AppViews.activate) {
			root.AppViews.activate(viewIdOf(id))
		} else {
			doc.querySelectorAll('.app-view').forEach(function (el) { el.classList.toggle('active', el.id === viewIdOf(id)) })
			doc.querySelectorAll('#activity-rail .rail-item[data-view]').forEach(function (el) { el.classList.toggle('active', el.dataset.view === viewIdOf(id)) })
		}
	}

	// 串口 / 日志 / 协议就绪后再装旁路，避免早于 common.js 执行
	function ensureHooks() {
		ensureByteTap()
		if (!root.serialByteTap) return false
		return true
	}

	async function reload() {
		let list = []
		try { list = (await svc.list()) || [] } catch (e) { list = [] }
		// 记下此刻显示中的视图 id：被停用/卸载的插件若正是当前视图，收尾时要回通信调试
		const activeEl = doc.querySelector('#views .app-view.active')
		const activeViewId = activeEl ? activeEl.id : ''
		const keep = new Set()
		list.forEach(function (p) { keep.add(p.id) })
		// 停用 / 卸载 / 不再支持：立刻销毁 iframe 与订阅
		Array.from(views.keys()).forEach(function (id) {
			const next = list.filter(function (p) { return p.id === id })[0]
			if (!next || !next.enabled || !next.supported || next.error) destroyView(id)
		})
		plugins = list
		loadOrder()
		renderRail()
		// 已存在的视图跟着新 manifest 走（版本变了要重新加载页面）
		views.forEach(function (view, id) {
			const next = list.filter(function (p) { return p.id === id })[0]
			if (!next) return
			if (next.version !== view.plugin.version || next.entry !== view.plugin.entry) {
				destroyView(id)
				return
			}
			view.plugin = next
		})
		// 当前看的就是被停用/卸载的插件视图（节点已被销毁）：回通信调试
		if (activeViewId.indexOf(VIEW_PREFIX) === 0 && !doc.getElementById(activeViewId)) {
			if (root.AppViews && root.AppViews.switchTo) root.AppViews.switchTo('view-serial')
		}
		ensureHooks()
		// 存下的视图是插件页时（刷新后）恢复它：插件视图是动态建的，index.html 的启动脚本那时还看不到它
		let saved = (root.AppViews && root.AppViews.initialSaved) || ''
		if (!saved) {
			try { saved = localStorage.getItem('serial-debug-active-view') || '' } catch (e) {}
		}
		if (saved.indexOf(VIEW_PREFIX) === 0) {
			if (root.AppViews) root.AppViews.initialSaved = ''
			const plugin = visible().filter(function (p) { return viewIdOf(p.id) === saved })[0]
			if (plugin) openPlugin(plugin.id)
		}
	}

	function isBusyForUpdate() {
		let busy = false
		views.forEach(function (view) { if (view.busy.size) busy = true })
		return busy
	}

	function start() {
		if (started) return
		started = true
		root.addEventListener('message', onMessage)
		// 主题切换：data-theme 由 common.js 写在 html 上，这里只转发，不自己判断系统偏好
		if (root.MutationObserver) {
			new MutationObserver(pushTheme).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
		}
		doc.addEventListener('plugin-order-reset', function () { order = []; saveOrder(); renderRail() })
		if (svc.listen) {
			Promise.resolve(svc.listen('plugins-changed', function () { reload() })).catch(function () {})
		}
		reload()
	}

	root.PluginHost = {
		reload: reload,
		open: openPlugin,
		// 给管理面板用：停用 / 卸载后立刻收起对应视图
		close: destroyView,
		list: function () { return plugins.slice() },
		order: function () { return order.slice() },
	}
	P.provide('plugin-host', {
		isBusyForUpdate: isBusyForUpdate,
		release: async function () {
			Array.from(views.keys()).forEach(destroyView)
		},
		reload: reload,
		busyLabels: function () {
			const labels = []
			views.forEach(function (view) {
				view.busy.forEach(function (label) { labels.push(view.plugin.name + ' · ' + label) })
			})
			return labels
		},
	})

	if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start)
	else start()
})(typeof window !== 'undefined' ? window : globalThis)
