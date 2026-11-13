// 配置页(与通信调试 / 固件打包同级的视图)：左侧分组导航 + 右侧内容。
// 这里只做「切分组 / 打开视图 / 各分组自己的小动作」，配置项一律复用原控件与原 API：
// 导入导出重置仍是 index.html 里带原 id 的按钮(common.js 绑定)，主题仍是 #theme-switch(common.js 的状态源)，
// 更新走 AppUpdate.check，MCP 面板走 McpServiceStatus.open，GitHub 令牌走 plugins 平台服务的钥匙串接口。
// 协议来源与插件的内容由各自面板模块经 SettingsView.onMount(group, fn) 挂进来，不在这里重复它们的业务。
;(function (root) {
	'use strict'

	const P = root.AppPlatform
	const doc = root.document
	const $ = function (id) { return doc.getElementById(id) }
	if (!doc || !P) return

	const view = $('view-settings')
	if (!view) return
	const nav = view.querySelector('.settings-nav')
	const panes = view.querySelector('.settings-panes')
	const hooks = Object.create(null)
	const mounted = Object.create(null)
	let current = ''

	function navItem(name) { return nav.querySelector('[data-settings-group="' + name + '"]') }
	function paneOf(name) { return panes.querySelector('[data-settings-group="' + name + '"]') }
	function visible(name) {
		const btn = navItem(name)
		return !!(btn && paneOf(name) && btn.getClientRects().length > 0)
	}
	// 画像没开的分组(协议来源 / 插件 / 账号)由 platform.js 写的 data-feature 样式隐藏，这里按实际可见性取列表
	function visibleGroups() {
		return Array.from(nav.querySelectorAll('[data-settings-group]')).filter(function (el) { return el.getClientRects().length > 0 })
	}
	function show(name) {
		const pane = paneOf(name), btn = navItem(name)
		if (!pane || !btn) return false
		current = name
		nav.querySelectorAll('[data-settings-group]').forEach(function (b) {
			const on = b === btn
			b.classList.toggle('active', on)
			b.setAttribute('aria-selected', String(on))
			b.tabIndex = on ? 0 : -1
		})
		panes.querySelectorAll('[data-settings-group]').forEach(function (p) { p.classList.toggle('active', p === pane) })
		runHooks(name, pane)
		refreshMcp()
		return true
	}
	// 分组内容建在分组的 .settings-host 里(标题与说明留在外面)，没有 host 时退回整块分组
	function runHooks(name, pane) {
		const list = hooks[name]
		if (!list || !list.length) return
		const done = mounted[name] || (mounted[name] = [])
		const host = (pane && pane.querySelector('.settings-host')) || pane
		list.forEach(function (fn) {
			if (done.indexOf(fn) !== -1) return
			done.push(fn)
			try { fn(host) } catch (e) { console.warn('配置分组内容构建失败', e) }
		})
	}
	function onMount(name, fn) {
		if (!name || typeof fn !== 'function') return
		;(hooks[name] || (hooks[name] = [])).push(fn)
		if (current === name) runHooks(name, paneOf(name))
	}
	// 打开配置页；不给分组时回到上次看的分组。点名一个被门控隐藏的分组(本画像没有)同样退回第一个可见分组
	function open(name) {
		// 先切视图再判可见性：视图没显示时分组项没有布局盒，会把点名分组误判成「本画像没有」
		if (root.AppViews && root.AppViews.activate) root.AppViews.activate('view-settings')
		else view.classList.add('active')
		if (name && !visible(name)) name = ''
		const list = visibleGroups().map(function (b) { return b.dataset.settingsGroup })
		const target = name || (list.indexOf(current) !== -1 ? current : list[0])
		if (target) show(target)
		return view
	}
	function refreshMcp() {
		const el = $('settings-mcp-state'), svc = root.McpServiceStatus
		if (!el || !svc || typeof svc.state !== 'function') return
		const text = { running: I18n.t('settings.runningPort', { port: svc.port() }), error: I18n.t('settings.serviceError'), waiting: I18n.t('settings.enabledWaitingToStart'), off: I18n.t('settings.off') }[svc.state()]
		el.textContent = text || I18n.t('settings.off')
	}

	root.SettingsView = {
		open: open,
		onMount: onMount,
		group: function () { return current },
		appearance: function () { return open('appearance') },
		backup: function () { return open('backup') },
		services: function () { return open('services') },
		protocols: function () { return open('protocols') },
		plugins: function () { return open('plugins') },
		account: function () { return open('account') },
	}

	function bindGroupNav() {
		nav.addEventListener('click', function (e) {
			const btn = e.target.closest('[data-settings-group]')
			if (btn) show(btn.dataset.settingsGroup)
		})
		nav.addEventListener('keydown', function (e) {
			const list = visibleGroups()
			const i = list.indexOf(e.target.closest('[data-settings-group]'))
			if (i === -1) return
			let next = -1
			if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (i + 1) % list.length
			else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (i - 1 + list.length) % list.length
			else if (e.key === 'Home') next = 0
			else if (e.key === 'End') next = list.length - 1
			if (next === -1) return
			e.preventDefault()
			const b = list[next]
			b.focus()
			show(b.dataset.settingsGroup)
		})
		// MCP 状态在面板里改过：切回前台 / 窗口聚焦时重读一次，避免长期显示旧文字
		doc.addEventListener('visibilitychange', function () { if (!doc.hidden) refreshMcp() })
		root.addEventListener('focus', function () { refreshMcp() })
	}

	function bindServices() {
		const updRow = $('settings-update-row'), updBtn = $('settings-update-check')
		if (updRow && updBtn) {
			updRow.hidden = !root.AppUpdate
			updBtn.addEventListener('click', function () { if (root.AppUpdate) root.AppUpdate.check(true) })
		}
		const mcpRow = $('settings-mcp-row'), mcpBtn = $('settings-mcp-open')
		// 平台没提供 mcp 服务就不显示这一行(门控只说明画像允许，服务本身由 native-shell 提供)
		if (mcpRow && !P.service('mcp')) mcpRow.hidden = true
		if (mcpBtn) mcpBtn.addEventListener('click', function () { if (root.McpServiceStatus && root.McpServiceStatus.open) root.McpServiceStatus.open() })
		// 链接与左栏是同一批入口：地址跟着左栏走，客户端里整行由 shell.browser 门控隐藏
		const fb = $('settings-link-feedback'), home = $('settings-link-homepage')
		const rail = doc.querySelector('#activity-rail .rail-bottom')
		const railFb = rail && rail.querySelector('a.rail-item[href*="/issues"]')
		const railHome = rail && rail.querySelector('a.rail-item[href*="github.com/Roomen/DeviceDock"]')
		if (fb && railFb) fb.href = railFb.href
		if (home && railHome) home.href = railHome.href
	}

	// ---------- GitHub 令牌：只写系统钥匙串，界面永不回显明文 ----------
	function bindToken() {
		const input = $('settings-token-input'), save = $('settings-token-save'), clear = $('settings-token-clear')
		const badge = $('settings-token-badge'), row = $('settings-token-msg-row'), msg = $('settings-token-msg')
		const svc = P.service('plugins')
		if (!svc || !svc.tokenStatus || !input) return
		let busy = false, set = false, note = '', isError = false
		function paint() {
			badge.textContent = set ? I18n.t('settings.set') : I18n.t('settings.notSet')
			badge.classList.toggle('is-set', set)
			input.disabled = busy
			save.disabled = busy
			clear.disabled = busy || !set
			row.hidden = !note
			msg.className = isError ? 'mdn-src-err' : 'settings-row-note'
			msg.textContent = note || ''
		}
		function refresh() {
			return Promise.resolve(svc.tokenStatus()).then(function (st) {
				set = !!(st && st.set)
				paint()
			}, function () { paint() })
		}
		function run(job, okText) {
			busy = true
			note = ''
			paint()
			return Promise.resolve(job).then(function (st) {
				input.value = ''
				set = !!(st && st.set)
				note = okText
				isError = false
			}, function (e) {
				note = String((e && e.message) || e)
				isError = true
			}).then(function () {
				busy = false
				paint()
			})
		}
		save.addEventListener('click', function () {
			if (busy) return
			const value = input.value.trim()
			if (!value) {
				note = I18n.t('settings.enterTheGithubTokenToSave')
				isError = true
				paint()
				return
			}
			run(svc.tokenSet(value), I18n.t('settings.tokenSavedToTheSystemKeychain'))
		})
		clear.addEventListener('click', function () {
			if (busy) return
			run(svc.tokenClear(), I18n.t('settings.tokenRemovedFromTheSystemKeychain'))
		})
		input.addEventListener('keydown', function (e) {
			if (e.key === 'Enter' && !e.isComposing) {
				e.preventDefault()
				save.click()
			}
		})
		refresh()
	}

	// 左栏入口：配置页本身(与视图切换同时生效)，主题直接落到外观分组
	function bindRail() {
		const configBtn = $('rail-config-btn'), themeBtn = $('rail-theme-btn')
		if (configBtn) configBtn.addEventListener('click', function () { open() })
		if (themeBtn) themeBtn.addEventListener('click', function () { open('appearance') })
	}

	function init() {
		bindRail()
		bindGroupNav()
		bindServices()
		bindToken()
		current = 'appearance'
		refreshMcp()
	}
	if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init)
	else init()
})(typeof window !== 'undefined' ? window : globalThis)
