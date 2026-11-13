// 界面语言（zh-CN / en）。在 js/platform.js 之后、其它模块之前加载：首屏前写好 html[lang]，字典由 js/i18n-zh-CN.js / js/i18n-en.js 随后注册。
// 选择存 localStorage `uiLocaleV1`（缺省 = 跟随系统：navigator.language 以 zh 开头为 zh-CN，否则 en）；切换语言后整页重载，模块不监听语言变化。
// 文案一律经 t() 取纯文本，调用方用 textContent / 属性写入，不要把字典内容当 HTML 插入。
;(function (root) {
	'use strict'
	const STORE_KEY = 'uiLocaleV1'
	const LOCALES = ['zh-CN', 'en']
	const CHOICES = ['system', 'zh-CN', 'en']
	const FALLBACK = 'zh-CN'
	const dicts = { 'zh-CN': Object.create(null), en: Object.create(null) }

	function storage() {
		try { return root.localStorage || null } catch (e) { return null }
	}
	function readChoice() {
		const s = storage()
		let v = null
		try { v = s && s.getItem(STORE_KEY) } catch (e) { v = null }
		return v === 'zh-CN' || v === 'en' ? v : 'system'
	}
	function systemLocale() {
		const nav = root.navigator
		if (!nav) return FALLBACK
		const list = Array.isArray(nav.languages) && nav.languages.length ? nav.languages : [nav.language]
		const first = String(list[0] || '')
		if (!first) return FALLBACK
		return /^zh/i.test(first) ? 'zh-CN' : 'en'
	}
	function resolve(choice) {
		return choice === 'zh-CN' || choice === 'en' ? choice : systemLocale()
	}

	let choice = readChoice()
	let locale = resolve(choice)

	function format(str, params) {
		if (!params) return str
		return str.replace(/\{(\w+)\}/g, (m, name) => Object.prototype.hasOwnProperty.call(params, name) && params[name] != null ? String(params[name]) : m)
	}
	function lookup(key, loc) {
		const d = dicts[loc]
		if (d && key in d) return d[key]
		if (key in dicts[FALLBACK]) return dicts[FALLBACK][key]
		return null
	}
	function t(key, params) {
		const s = lookup(key, locale)
		return format(s == null ? String(key) : s, params)
	}
	function has(key) {
		return key in dicts[FALLBACK] || key in dicts.en
	}
	function add(loc, entries) {
		if (!dicts[loc] || !entries) return
		for (const k of Object.keys(entries)) dicts[loc][k] = String(entries[k])
	}
	function setChoice(next) {
		const c = CHOICES.includes(next) ? next : 'system'
		const s = storage()
		try {
			if (s) {
				if (c === 'system') s.removeItem(STORE_KEY)
				else s.setItem(STORE_KEY, c)
			}
		} catch (e) { /* 存储不可用：只在本次生效 */ }
		choice = c
		return resolve(c)
	}

	// 一次性替换静态文案：data-i18n 换元素里唯一的一段直接文本（保留图标等子元素与首尾空白），
	// data-i18n-<attr> 换对应属性（title / placeholder / aria-label / label …）。
	const ATTR_PREFIX = 'data-i18n-'
	function replaceText(el, text) {
		const nodes = []
		for (const n of Array.from(el.childNodes || [])) if (n.nodeType === 3 && n.nodeValue.trim()) nodes.push(n)
		if (!nodes.length) {
			if (!el.children || !el.children.length) el.textContent = text
			else el.appendChild(el.ownerDocument.createTextNode(text))
			return
		}
		const n = nodes[0]
		const m = /^(\s*)[\s\S]*?(\s*)$/.exec(n.nodeValue)
		n.nodeValue = m[1] + text + m[2]
		for (let i = 1; i < nodes.length; i++) nodes[i].nodeValue = ''
	}
	function applyEl(el) {
		const k = el.getAttribute('data-i18n')
		if (k) replaceText(el, t(k))
		for (const a of Array.from(el.attributes)) {
			if (a.name.indexOf(ATTR_PREFIX) !== 0) continue
			const target = a.name.slice(ATTR_PREFIX.length)
			if (!target) continue
			el.setAttribute(target, t(a.value))
		}
	}
	function apply(rootEl) {
		const r = rootEl || root.document
		if (r && r === root.document && r.documentElement) r.documentElement.removeAttribute('data-i18n-pending')
		if (!r || !r.querySelectorAll) return
		if (r.nodeType === 1) applyEl(r)
		const all = r.querySelectorAll('*')
		for (const el of all) {
			if (el.hasAttribute('data-i18n')) { applyEl(el); continue }
			const attrs = el.attributes
			for (let i = 0; i < attrs.length; i++) {
				if (attrs[i].name.indexOf(ATTR_PREFIX) === 0) { applyEl(el); break }
			}
		}
	}

	const api = {
		STORE_KEY,
		LOCALES,
		CHOICES,
		get locale() { return locale },
		get choice() { return choice },
		t,
		has,
		add,
		apply,
		resolve,
		setChoice,
		systemLocale,
		// 仅测试用：不读存储，直接切换当前语言
		_setLocaleForTest(loc) { if (LOCALES.includes(loc)) locale = loc },
		_dicts: dicts,
	}
	root.I18n = api
	const doc = root.document
	if (doc && doc.documentElement) {
		doc.documentElement.setAttribute('lang', locale)
		// 页面源文是中文：非中文界面在 I18n.apply 换完静态文案前先不显示正文，免得首屏闪一下中文；3 s 兜底放开
		if (locale !== FALLBACK && doc.head) {
			doc.documentElement.setAttribute('data-i18n-pending', '')
			const st = doc.createElement('style')
			st.textContent = 'html[data-i18n-pending] body{visibility:hidden}'
			doc.head.appendChild(st)
			setTimeout(() => doc.documentElement.removeAttribute('data-i18n-pending'), 3000)
		}
	}
})(typeof window !== 'undefined' ? window : globalThis)
