// Run: node tests/settings-view.cjs — synthetic DOM only, no browser.
// 覆盖 js/settings-view.js：分组导航(点击 / 键盘 / 门控隐藏)、open 保留或退回分组、分组内容经
// SettingsView.onMount 建进 .settings-host(只建一次)、客户端服务行按服务缺失隐藏、GitHub 令牌的保存/清除/错误文案
// (仍走 plugins 平台服务的钥匙串接口，界面不回显明文)。
require('./i18n-env.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const src = fs.readFileSync(path.join(__dirname, '../js/settings-view.js'), 'utf8')

class El {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase()
		this.children = []
		this.parentNode = null
		this.attrs = {}
		this.dataset = {}
		this.listeners = {}
		this.className = ''
		this.textContent = ''
		this.value = ''
		this.hidden = false
		this.disabled = false
		this.tabIndex = 0
		this.visible = true
		this.classList = {
			toggle: (name, on) => {
				const set = new Set(this.className.split(/\s+/).filter(Boolean))
				if (on) set.add(name)
				else set.delete(name)
				this.className = Array.from(set).join(' ')
			},
			contains: (name) => this.className.split(/\s+/).includes(name),
			add: (name) => this.classList.toggle(name, true),
			remove: (name) => this.classList.toggle(name, false),
		}
	}
	appendChild(c) { c.parentNode = this; this.children.push(c); return c }
	setAttribute(k, v) { this.attrs[k] = String(v) }
	getAttribute(k) { return this.attrs[k] }
	hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) }
	removeAttribute(k) { delete this.attrs[k] }
	addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f) }
	fire(t, ev) { (this.listeners[t] || []).forEach((f) => f(Object.assign({ target: this, preventDefault() { this.defaultPrevented = true } }, ev || {}))) }
	// 事件在真实 DOM 里会冒泡到分组导航：模拟时直接派到导航宿主上，target 仍是原来那一项
	fireOn(host, t, ev) { (host.listeners[t] || []).forEach((f) => f(Object.assign({ target: this, preventDefault() { this.defaultPrevented = true } }, ev || {}))) }
	click() { this.fire('click') }
	focus() { this.focused = true }
	getClientRects() { return this.visible ? [{}] : [] }
	closest(sel) { return sel === '[data-settings-group]' && this.dataset.settingsGroup ? this : null }
	querySelector(sel) {
		if (sel === '.settings-host') return this.host || null
		if (sel === '.settings-nav') return this.nav || null
		if (sel === '.settings-panes') return this.panes || null
		const m = /^\[data-settings-group="([^"]+)"\]$/.exec(sel)
		if (!m) return null
		let found = null
		const walk = (el) => {
			if (found) return
			el.children.forEach((c) => {
				if (found) return
				if (c.dataset.settingsGroup === m[1]) found = c
				else walk(c)
			})
		}
		walk(this)
		return found
	}
	querySelectorAll(sel) {
		const out = []
		const walk = (el) => {
			el.children.forEach((c) => {
				if (matches(c, sel)) out.push(c)
				walk(c)
			})
		}
		walk(this)
		return out
	}
}
function matches(el, sel) {
	if (sel === '[data-settings-group]') return !!el.dataset.settingsGroup
	return false
}

function makeHarness(opts) {
	opts = opts || {}
	const groups = ['appearance', 'backup', 'services', 'protocols', 'plugins', 'account']
	const view = new El('div')
	const nav = new El('nav')
	const panes = new El('div')
	view.appendChild(nav)
	view.appendChild(panes)
	view.nav = nav
	view.panes = panes
	const navItems = {}
	const paneEls = {}
	groups.forEach((g) => {
		const b = new El('button')
		b.dataset.settingsGroup = g
		b.visible = !(opts.hidden || []).includes(g)
		// 与真实布局一致：视图没显示时分组项没有布局盒
		b.getClientRects = () => (b.visible && view.classList.contains('active') ? [{}] : [])
		nav.appendChild(b)
		navItems[g] = b
		const p = new El('section')
		p.dataset.settingsGroup = g
		const host = new El('div')
		host.className = 'settings-host'
		p.host = host
		p.appendChild(host)
		panes.appendChild(p)
		paneEls[g] = p
	})
	const byId = {}
	function addEl(id, extra) {
		const el = new El('div')
		el.id = id
		Object.assign(el, extra || {})
		byId[id] = el
		return el
	}
	const railConfig = addEl('rail-config-btn')
	railConfig.classList.active = () => false
	const railTheme = addEl('rail-theme-btn')
	addEl('settings-mcp-state')
	const mcpRow = addEl('settings-mcp-row')
	const updRow = addEl('settings-update-row', { hidden: true })
	addEl('settings-update-check')
	addEl('settings-mcp-open')
	const tokenInput = addEl('settings-token-input')
	addEl('settings-token-save')
	addEl('settings-token-clear')
	addEl('settings-token-badge')
	addEl('settings-token-msg-row', { hidden: true })
	addEl('settings-token-msg')

	const activated = []
	const tokenCalls = []
	const tokenState = { set: true }
	const plugins = opts.plugins === null ? null : Object.assign({
		tokenStatus: () => Promise.resolve({ set: tokenState.set }),
		tokenSet: (v) => { tokenCalls.push(['set', v]); tokenState.set = true; return Promise.resolve({ set: true }) },
		tokenClear: () => { tokenCalls.push(['clear']); tokenState.set = false; return Promise.resolve({ set: false }) },
	}, opts.plugins || {})
	const mcpState = { state: () => opts.mcpState || 'running', port: () => 38992, open: () => { activated.push('mcp-panel') } }
	const doc = {
		readyState: 'complete',
		hidden: false,
		querySelector: () => null,
		getElementById: (id) => byId[id] || (id === 'view-settings' ? view : null),
		addEventListener(t, f) { (doc.listeners = doc.listeners || {}); (doc.listeners[t] = doc.listeners[t] || []).push(f) },
	}
	const win = {
		document: doc,
		AppPlatform: {
			service: (n) => (n === 'plugins' ? plugins : n === 'mcp' ? (opts.mcp === false ? null : {}) : null),
		},
		AppViews: { activate: (id) => { activated.push(id); if (id === 'view-settings') view.classList.add('active') } },
		McpServiceStatus: opts.mcpStatus === false ? null : mcpState,
		AppUpdate: opts.update === false ? null : { check: (manual) => activated.push('update-check:' + manual) },
		addEventListener(t, f) { win.listeners = win.listeners || {}; (win.listeners[t] = win.listeners[t] || []).push(f) },
		console,
	}
	if (opts.gatedVisible === false) view.visible = false
	vm.runInNewContext(src, { window: win, document: doc, console, globalThis: win })
	return { view, nav, panes, navItems, paneEls, byId, win, activated, tokenCalls, tokenState, mcpRow, updRow, tokenInput, doc }
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)) }

;(async () => {
	const tests = []
	const test = (name, fn) => tests.push([name, fn])

	test('默认回到外观分组，主题入口也落到外观', async () => {
		const h = makeHarness()
		assert.ok(h.view.classList.contains('active') === false, '初始不自己切视图')
		h.win.SettingsView.open()
		assert.deepEqual(h.activated, ['view-settings'])
		assert.equal(h.win.SettingsView.group(), 'appearance')
		assert.ok(h.paneEls.appearance.classList.contains('active'))
		h.navItems.backup.fireOn(h.nav, 'click')
		assert.equal(h.win.SettingsView.group(), 'backup')
		h.activated.length = 0
		h.win.SettingsView.appearance()
		assert.deepEqual(h.activated, ['view-settings'])
		assert.equal(h.win.SettingsView.group(), 'appearance')
		assert.equal(h.navItems.appearance.getAttribute('aria-selected'), 'true')
		assert.equal(h.navItems.backup.getAttribute('aria-selected'), 'false')
	})

	test('从别的视图打开时仍能直接落到点名分组(视图未显示时不误判可见性)', async () => {
		const h = makeHarness()
		h.win.SettingsView.open('backup')
		assert.equal(h.win.SettingsView.group(), 'backup')
		h.view.classList.remove('active')
		h.activated.length = 0
		h.win.SettingsView.open('services')
		assert.deepEqual(h.activated, ['view-settings'])
		assert.equal(h.win.SettingsView.group(), 'services')
	})

	test('分组内容经 onMount 建进 .settings-host，且只建一次', async () => {
		const h = makeHarness()
		let calls = 0
		const hosts = []
		h.win.SettingsView.onMount('protocols', (host) => { calls++; hosts.push(host) })
		h.win.SettingsView.protocols()
		assert.equal(calls, 1)
		assert.equal(hosts[0], h.paneEls.protocols.host)
		h.navItems.appearance.fireOn(h.nav, 'click')
		h.navItems.protocols.fireOn(h.nav, 'click')
		assert.equal(calls, 1, '再次显示不重建')
	})

	test('门控隐藏的分组不参与切换；当前分组不可见时退回第一个可见分组', async () => {
		const h = makeHarness({ hidden: ['plugins', 'account'] })
		h.win.SettingsView.open('account')
		assert.equal(h.win.SettingsView.group(), 'appearance', '不可见分组直接回到第一个可见项')
		h.navItems.services.fireOn(h.nav, 'click')
		assert.equal(h.win.SettingsView.group(), 'services')
		// 键盘：↓ 跳到下一个可见分组(跳过隐藏项)
		h.navItems.services.fireOn(h.nav, 'keydown', { key: 'ArrowDown' })
		assert.equal(h.win.SettingsView.group(), 'protocols')
		h.navItems.protocols.fireOn(h.nav, 'keydown', { key: 'ArrowUp' })
		assert.equal(h.win.SettingsView.group(), 'services')
	})

	test('客户端服务：MCP 行按服务缺失隐藏、更新行按 AppUpdate 缺失隐藏，按钮只转给原入口', async () => {
		const h = makeHarness()
		assert.equal(h.mcpRow.hidden, false)
		assert.equal(h.updRow.hidden, false)
		h.byId['settings-mcp-open'].click()
		h.byId['settings-update-check'].click()
		assert.deepEqual(h.activated, ['mcp-panel', 'update-check:true'])
		const off = makeHarness({ mcp: false, update: false })
		assert.equal(off.mcpRow.hidden, true)
		assert.equal(off.updRow.hidden, true)
		assert.equal(off.byId['settings-update-row'].hidden, true)
	})

	test('MCP 状态文字跟随状态接口，未提供接口时保留占位', async () => {
		const h = makeHarness({ mcpState: 'running' })
		assert.match(h.byId['settings-mcp-state'].textContent, /运行中 · 端口 38992/)
		const waiting = makeHarness({ mcpState: 'waiting' })
		assert.equal(waiting.byId['settings-mcp-state'].textContent, '已启用，等待启动')
		const none = makeHarness({ mcpStatus: false })
		assert.equal(none.byId['settings-mcp-state'].textContent, '')
	})

	test('GitHub 令牌：保存 / 清除走钥匙串接口，空输入与失败都只给文字提示', async () => {
		const h = makeHarness()
		await flush()
		assert.equal(h.byId['settings-token-badge'].textContent, '已设置')
		h.byId['settings-token-input'].value = '  '
		h.byId['settings-token-save'].click()
		await flush()
		assert.match(h.byId['settings-token-msg'].textContent, /请输入要保存的 GitHub 令牌/)
		assert.equal(h.tokenCalls.length, 0)
		h.byId['settings-token-input'].value = 'ghp_x'
		h.byId['settings-token-save'].click()
		await flush()
		assert.deepEqual(h.tokenCalls[0], ['set', 'ghp_x'])
		assert.match(h.byId['settings-token-msg'].textContent, /令牌已写入系统钥匙串/)
		assert.equal(h.byId['settings-token-input'].value, '', '保存后清空输入框，界面不回显明文')
		h.byId['settings-token-clear'].click()
		await flush()
		assert.deepEqual(h.tokenCalls[1], ['clear'])
		assert.equal(h.byId['settings-token-badge'].textContent, '未设置')
		const bad = makeHarness({ plugins: { tokenSet: () => Promise.reject(new Error('钥匙串不可用')) } })
		await flush()
		bad.byId['settings-token-input'].value = 'ghp_y'
		bad.byId['settings-token-save'].click()
		await flush()
		assert.match(bad.byId['settings-token-msg'].textContent, /钥匙串不可用/)
	})

	test('没有 plugins 服务时不挂令牌控件', async () => {
		const h = makeHarness({ plugins: null })
		await flush()
		h.byId['settings-token-input'].value = 'ghp_z'
		h.byId['settings-token-save'].click()
		await flush()
		assert.equal(h.tokenCalls.length, 0)
		assert.equal(h.byId['settings-token-msg'].textContent, '')
	})

	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log('ok   ' + name)
		} catch (e) {
			failed++
			console.error('FAIL ' + name)
			console.error(e)
		}
	}
	if (failed) {
		console.error(failed + ' failed')
		process.exit(1)
	}
	console.log('all ' + tests.length + ' passed')
})()
