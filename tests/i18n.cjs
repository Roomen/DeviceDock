// Run: node tests/i18n.cjs — 界面语言（js/i18n.js + 两份字典）的静态与运行时回归：
// 两份字典键集合一致、占位参数一致、英文不残留中文；index.html 与 js/*.js 引用的键都存在、字典里没有无人引用的键；
// index.html 里带中文的文本 / 属性都标了 data-i18n*；宿主模块里不再有未经 I18n.t 的中文界面字符串（协议模块与列出的例外除外）；
// t() 的参数替换与回退、跟随系统的判定、选择的存取；插件语言契约（app.locale 状态事件、SDK getLocale / onLocale）。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const CJK = /[　-〿一-鿿＀-￯]/

function loadI18n(opts) {
	const o = opts || {}
	const store = new Map(Object.entries(o.storage || {}))
	const ctx = vm.createContext({
		navigator: o.navigator,
		localStorage: {
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem: (k, v) => store.set(k, String(v)),
			removeItem: (k) => store.delete(k),
		},
	})
	ctx.window = ctx
	for (const f of ['js/i18n.js', 'js/i18n-zh-CN.js', 'js/i18n-en.js']) vm.runInContext(read(f), ctx, { filename: f })
	return { I18n: ctx.I18n, store }
}

const { I18n } = loadI18n({ navigator: { language: 'zh-CN' } })
const zh = I18n._dicts['zh-CN']
const en = I18n._dicts.en
const zhKeys = Object.keys(zh).sort()
const enKeys = Object.keys(en).sort()

// ---- 字典 ----
assert.deepEqual(enKeys, zhKeys, '两份字典的键集合必须一致')
assert.ok(zhKeys.length > 1000, '字典不应为空')
const params = (s) => Array.from(new Set(Array.from(String(s).matchAll(/\{(\w+)\}/g), (m) => m[1]))).sort().join(',')
for (const k of zhKeys) {
	assert.ok(String(zh[k]).length > 0, 'zh-CN 文案为空：' + k)
	assert.ok(String(en[k]).length > 0, 'en 文案为空：' + k)
	assert.equal(params(en[k]), params(zh[k]), '占位参数不一致：' + k)
	assert.ok(!CJK.test(en[k]), '英文字典里残留中文：' + k + ' = ' + en[k])
}

// ---- 引用的键都存在，字典里没有无人引用的键 ----
const html = read('index.html')
const jsFiles = fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js') && !/^i18n-(zh-CN|en)\.js$/.test(f))
const used = new Set()
for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(m[1])
for (const f of jsFiles) {
	const src = read('js/' + f)
	for (const m of src.matchAll(/I18n\.t\('([^']+)'/g)) {
		assert.ok(m[1] in zh, 'js/' + f + ' 引用了不存在的键：' + m[1])
		used.add(m[1])
	}
}
for (const k of used) assert.ok(k in zh, 'index.html 引用了不存在的键：' + k)
const unused = zhKeys.filter((k) => !used.has(k))
assert.deepEqual(unused, [], '字典里有无人引用的键')

// ---- index.html：带中文的文本 / 属性都要标注 ----
function scanHtml(src) {
	const misses = []
	const ATTRS = ['title', 'placeholder', 'aria-label', 'label', 'alt', 'value']
	// 去掉注释与脚本 / 样式正文
	const body = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2>)/g, (m, a, n, mid, b) => a + mid.replace(/[^\n]/g, ' ') + b)
	const stack = []
	const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g
	const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'hr', 'source'])
	let m
	while ((m = tagRe.exec(body))) {
		if (m[4] != null) {
			const text = m[4]
			const parent = stack[stack.length - 1]
			if (CJK.test(text) && !(parent && /\sdata-i18n="/.test(parent.attrs)) && !(parent && /\slang="zh-CN"/.test(parent.attrs) && text.trim() === '中文')) {
				misses.push('文本：' + text.trim().slice(0, 40))
			}
			continue
		}
		const [, close, name, attrs] = m
		if (close) {
			const idx = stack.map((x) => x.name).lastIndexOf(name.toLowerCase())
			if (idx >= 0) stack.length = idx
			continue
		}
		for (const a of ATTRS) {
			const am = new RegExp('\\s' + a + '="([^"]*)"').exec(attrs)
			if (am && CJK.test(am[1]) && !new RegExp('\\sdata-i18n-' + a + '="').test(attrs)) misses.push(a + '：' + am[1].slice(0, 40))
		}
		if (!VOID.has(name.toLowerCase()) && !/\/$/.test(attrs)) stack.push({ name: name.toLowerCase(), attrs })
	}
	return misses
}
assert.deepEqual(scanHtml(html), [], 'index.html 有没标 data-i18n 的中文')

// ---- 宿主模块：中文字符串必须经 I18n.t ----
// 协议模块的字段名与解析结果属于协议数据，本轮不翻译；其余列出的是开发者自用的报错、MCP 给 agent 的工具结果、
// 默认快捷发送（存进用户数据）与 Worker 里拿不到 I18n 的报错。
const PROTOCOL_MODULES = new Set(['protocol.js', 'protocol-schema.js', 'protocol-presets.js', 'cjt188-protocol.js', 'sek-test-profile.js', 'sek-transaction.js', 'pcp.js', 'protocol-crypto.js'])
const ALLOWED = {
	'common.js': 21,
	'mcp-bridge.js': Infinity,
	'firmware-diff-worker.js': 2,
	'platform.js': 1,
	'plugin-api.js': 1,
	'protocol-registry.js': 2,
	'serial-adapter.js': 1,
	'modern-shell.js': 1,
}
// 粗粒度的字符串扫描：跳过注释与正则，收集带中文的 '…' / "…" / `…` 字面量（模板里 ${} 之外的部分）
function cjkStrings(src) {
	const out = []
	let i = 0
	let prev = ''
	const n = src.length
	while (i < n) {
		const c = src[i]
		const d = src[i + 1]
		if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue }
		if (c === '/' && d === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; continue }
		if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]|^$|return$/.test(prev)) {
			// 正则字面量
			i++
			let cls = false
			while (i < n) {
				const ch = src[i]
				if (ch === '\\') { i += 2; continue }
				if (ch === '[') cls = true
				else if (ch === ']') cls = false
				else if (ch === '/' && !cls) break
				else if (ch === '\n') break
				i++
			}
			i++
			prev = 'x'
			continue
		}
		if (c === '\'' || c === '"' || c === '`') {
			let j = i + 1
			let s = ''
			let depth = 0
			while (j < n) {
				const ch = src[j]
				if (ch === '\\') { s += src.slice(j, j + 2); j += 2; continue }
				if (c === '`' && ch === '$' && src[j + 1] === '{') { depth++; j += 2; while (j < n && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++ } continue }
				if (ch === c) break
				s += ch
				j++
			}
			// 对象字面量的键（前面是 { 或 ,、后面是 :）是数据不是文案，例如命令面板的中文关键词 → 拼音别名表
			const before = src.slice(0, i).replace(/\s+$/, '').slice(-1)
			const after = src.slice(j + 1).replace(/^\s+/, '')[0]
			const isKey = (before === '{' || before === ',') && after === ':'
			if (CJK.test(s) && !isKey) {
				const line = src.slice(0, i).split('\n').length
				const lineText = src.split('\n')[line - 1]
				if (!/console\.(log|warn|error|info|debug)\(/.test(lineText)) out.push(line + ': ' + s.slice(0, 50))
			}
			i = j + 1
			prev = 'x'
			continue
		}
		if (!/\s/.test(c)) prev = /[\w$]/.test(c) ? (/[\w$]/.test(prev.slice(-1)) ? prev + c : c) : c
		i++
	}
	return out
}
for (const f of jsFiles) {
	if (PROTOCOL_MODULES.has(f) || /^(i18n|hdiffi|ansi_up)/.test(f)) continue
	const found = cjkStrings(read('js/' + f))
	const limit = ALLOWED[f] || 0
	assert.ok(found.length <= limit, 'js/' + f + ' 有未经 I18n.t 的中文字符串：\n' + found.join('\n'))
}

// ---- 运行时 ----
assert.equal(I18n.locale, 'zh-CN')
assert.equal(I18n.t('common.laneDefault', { sid: 'A' }), 'A路')
assert.equal(I18n.t('no.such.key'), 'no.such.key', '缺失的键原样返回')
assert.equal(I18n.t('testFlow.waitMs', { delayAfterMs: 5 }), '等待 5 ms')
I18n._setLocaleForTest('en')
assert.equal(I18n.t('common.laneDefault', { sid: 'B' }), 'Lane B')
assert.equal(I18n.t('testFlow.waitMs', {}), 'Wait {delayAfterMs} ms', '没给的参数保持占位')
I18n._setLocaleForTest('zh-CN')

// 跟随系统：zh 开头为 zh-CN，其它（含 zh 以外的中文以外语言）为 en；存下的选择优先
assert.equal(loadI18n({ navigator: { languages: ['zh-TW', 'en'] } }).I18n.locale, 'zh-CN')
assert.equal(loadI18n({ navigator: { language: 'en-US' } }).I18n.locale, 'en')
assert.equal(loadI18n({ navigator: { language: 'ja-JP' } }).I18n.locale, 'en')
assert.equal(loadI18n({ navigator: { language: 'en-US' }, storage: { uiLocaleV1: 'zh-CN' } }).I18n.locale, 'zh-CN')
assert.equal(loadI18n({ navigator: { language: 'zh-CN' }, storage: { uiLocaleV1: 'bogus' } }).I18n.choice, 'system')
{
	const env = loadI18n({ navigator: { language: 'zh-CN' } })
	assert.equal(env.I18n.setChoice('en'), 'en')
	assert.equal(env.store.get('uiLocaleV1'), 'en')
	assert.equal(env.I18n.choice, 'en')
	assert.equal(env.I18n.setChoice('system'), 'zh-CN')
	assert.equal(env.store.has('uiLocaleV1'), false, '跟随系统不留存储键')
}

// ---- 插件语言契约 ----
{
	const ctx = vm.createContext({ I18n })
	ctx.window = ctx
	vm.runInContext(read('js/plugin-rpc.js'), ctx)
	const Rpc = ctx.DeviceDockPluginRpc
	assert.ok(Rpc.isStateEvent('app.locale'), 'app.locale 是状态事件')
	assert.deepEqual(JSON.parse(JSON.stringify(Rpc.localePayload('zh-CN'))), { locale: 'zh-CN' })
	assert.deepEqual(JSON.parse(JSON.stringify(Rpc.localePayload('fr'))), { locale: 'en' })
	assert.ok(read('js/plugin-host.js').includes("Rpc.eventEnvelope('app.locale', localeState())"), '插件 load 后推送 app.locale')
}
{
	const sdkCtx = vm.createContext({})
	sdkCtx.window = sdkCtx
	vm.runInContext(read('sdk/devicedock-plugin.js'), sdkCtx)
	const sdk = sdkCtx.DeviceDockPlugin.createSdk({})
	assert.equal(sdk.getLocale(), null, '尚未收到时为 null')
	const seen = []
	const off = sdk.onLocale((l) => seen.push(l))
	sdk._handleMessage({ data: { __devicedock: 1, event: 'app.locale', payload: { locale: 'en' } } })
	assert.equal(sdk.getLocale(), 'en')
	const late = []
	sdk.onLocale((l) => late.push(l))
	assert.deepEqual(late, ['en'], '订阅时已有值立即回调一次')
	off()
	sdk._handleMessage({ data: { __devicedock: 1, event: 'app.locale', payload: { locale: 'zh-CN' } } })
	assert.deepEqual(seen, ['en'], '取消订阅后不再回调')
	assert.deepEqual(late, ['en', 'zh-CN'])
	sdk._handleMessage({ data: { __devicedock: 1, event: 'app.locale', payload: { locale: 'xx' } } })
	assert.equal(sdk.getLocale(), 'zh-CN', '非法值不改变当前语言')
	assert.equal(read('examples/plugin-hello/sdk/devicedock-plugin.js'), read('sdk/devicedock-plugin.js'), '示例插件的 SDK 副本与 sdk/ 一致')
}

console.log('i18n: ' + zhKeys.length + ' keys, all checks passed')
