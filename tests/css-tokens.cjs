// Run: node tests/css-tokens.cjs
// 静态契约：css/style.css 只允许一层令牌、字号只取 7 档、颜色不写裸 hex、不用 transition: all、不叠无限脉冲。
// 这是 P1.5 界面重做（.claude/skills/unslop）留下的护栏，防止 9 个 pass 之后又漂回去。
require('./i18n-env.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const css = fs.readFileSync(path.join(__dirname, '../css/style.css'), 'utf8')
const TOKEN_START = css.indexOf('/* ========== Design Tokens')
const BODY_START = css.indexOf('/* ========== Base Styles ========== */')
assert.ok(TOKEN_START >= 0 && BODY_START > TOKEN_START, 'style.css 必须保留「Design Tokens」与「Base Styles」两段标记')
const tokens = css.slice(TOKEN_START, BODY_START)
const body = css.slice(BODY_START)

// ---- 1. 令牌只有一层：浅色在 :root，深色在 [data-theme='dark']，不再有 prefers-color-scheme 或现代布局令牌块 ----
assert.ok(!/@media[^{]*prefers-color-scheme/.test(css), 'style.css 不得再用 prefers-color-scheme 定义主题：data-theme 由 js 首屏前写好')
// 只禁止「按主题重定义整组令牌」；个别组件在深色下换一个局部值(--mdn-on)是允许的，但不能是整块令牌
const themeBlocks = css.slice(BODY_START).split('\n').filter(l => /html\[data-layout='modern'\]\[data-theme='(light|dark)'\]\s*\{/.test(l))
assert.deepEqual(themeBlocks, [], '现代布局段不得再声明主题令牌，令牌只在最上面一层')
assert.ok(/:root\s*\{/.test(tokens) && /\[data-theme='dark'\]\s*\{/.test(tokens), '令牌块必须同时定义 :root 与 [data-theme="dark"]')

// ---- 2. 颜色：令牌块之外不得出现裸 hex（图表色等确实要写死的地方，先加进白名单并说明用途）----
// 白名单目前为空：曲线色走 --sk-series-color 之类的令牌，不需要写死。
const HEX_ALLOW = []
const bareHex = []
body.split('\n').forEach((line, i) => {
	const hit = line.match(/#[0-9a-fA-F]{3,8}\b/g)
	if (!hit) return
	if (HEX_ALLOW.some(a => line.includes(a))) return
	bareHex.push((BODY_START + i) + ': ' + line.trim())
})
assert.deepEqual(bareHex, [], '令牌块之外不得写裸 hex，改用 var(--…)：\n' + bareHex.join('\n'))

// ---- 3. 字号只取 7 档（11/12/13/14/16/20/28），图标用 --icon*，0 用于视觉隐藏 ----
const FS = ['--fs-micro', '--fs-small', '--fs-body', '--fs-body-lg', '--fs-title', '--fs-figure', '--fs-page']
const ICON = ['--icon', '--icon-sm', '--icon-lg']
const badFontSize = []
css.replace(/font-size:\s*([^;}!]+)/g, (m, value, off) => {
	const v = value.trim()
	const ok = v === '0' || v === 'inherit' ||
		FS.some(t => v === 'var(' + t + ')') || ICON.some(t => v === 'var(' + t + ')')
	if (!ok) {
		const line = css.slice(0, off).split('\n').length
		badFontSize.push(line + ': font-size: ' + v)
	}
	return m
})
assert.deepEqual(badFontSize, [], 'font-size 只能用 7 档字号令牌或图标令牌：\n' + badFontSize.join('\n'))

// 令牌里那 7 档必须真的存在且递增
const sizes = FS.map(t => {
	const m = tokens.match(new RegExp('\\' + t + ':\\s*(\\d+)px'))
	assert.ok(m, '缺少字号令牌 ' + t)
	return parseInt(m[1], 10)
})
assert.deepEqual(sizes, [...sizes].sort((a, b) => a - b), '字号令牌必须递增')
assert.equal(sizes.length, 7, '字号只能有 7 档')

// ---- 4. 动效：不写 transition: all（会连 width/height 一起补间），缓动只走一条曲线 ----
const transitionAll = css.split('\n').filter(l => /transition:\s*all/.test(l))
assert.deepEqual(transitionAll, [], '不得使用 transition: all，改为具体属性')

// 无限脉冲只允许解释「正在进行」的状态：serial-dot-pulse（连接中）与 sb-spin（后台任务在跑）
const ALLOW_INFINITE = ['serial-dot-pulse', 'sb-pulse']
const infinite = []
css.split('\n').forEach((line, i) => {
	if (!/animation:[^;]*infinite/.test(line)) return
	if (ALLOW_INFINITE.some(a => line.includes(a))) return
	infinite.push((i + 1) + ': ' + line.trim())
})
assert.deepEqual(infinite, [], '无限循环动画只允许解释进行中的状态，装饰性循环要去掉：\n' + infinite.join('\n'))

// ---- 5. 图标尺寸只有一份来源：css/icons.css 的三档，数值取自 --icon* 令牌 ----
// style.css 里不得再给图标写 font-size: var(--icon*)（会和 .icon 的 width/height 打架）
const iconSizeInStyle = css.split('\n').filter(l => /font-size:\s*var\(--icon(-sm|-lg)?\)/.test(l))
assert.deepEqual(iconSizeInStyle, [], 'style.css 不得再定义图标尺寸，尺寸只来自 css/icons.css 的 .icon / .icon-sm / .icon-lg')

const iconsCss = fs.readFileSync(path.join(__dirname, '../css/icons.css'), 'utf8')
const iconClasses = ['icon', 'icon-sm', 'icon-lg']
iconClasses.forEach(cls => {
	const block = iconsCss.match(new RegExp('\\.' + cls + '\\s*\\{([^}]*)\\}'))
	assert.ok(block, 'css/icons.css 缺少 .' + cls)
	const body = block[1]
	;['width', 'height', 'font-size'].forEach(prop => {
		const m = body.match(new RegExp(prop + ':\\s*([^;]+);'))
		assert.ok(m, '.' + cls + ' 必须定义 ' + prop)
		const v = m[1].trim()
		assert.ok(/^var\(--icon(-sm|-lg)?(,\s*\d+px)?\)$/.test(v), '.' + cls + ' 的 ' + prop + ' 必须引用 --icon 令牌（可带 px 兜底），实际：' + v)
	})
})

// ---- 6. 结构：样式表里不得残留合并冲突标记，花括号必须配对 ----
// 一条多余的 `=======` 会顶掉上一段规则缺失的 `}`，浏览器按 CSS 嵌套继续解析，把后面几十条规则
// 变成死规则（插件视图的 iframe 高度、左栏「插件」分组样式就是这么静默失效的），页面只是少了一部分
// 样式，肉眼不看那一屏根本发现不了。这里静态拦住。
const CSS_FILES = ['../css/style.css', '../css/icons.css', '../css/fonts.css']
CSS_FILES.forEach(function (rel) {
	const src = fs.readFileSync(path.join(__dirname, rel), 'utf8')
	const markers = src.split('\n').map(function (line, i) { return { line: i + 1, text: line } })
		.filter(function (l) { return /^(<{7}|={7}|>{7})/.test(l.text) })
	assert.deepEqual(markers.map(function (m) { return rel + ':' + m.line + ': ' + m.text.trim() }), [],
		rel + ' 里不得残留合并冲突标记：上一条规则会缺 `}`，后面的规则会被当成嵌套规则整段失效')
	const open = (src.match(/\{/g) || []).length
	const close = (src.match(/\}/g) || []).length
	assert.equal(open, close, rel + ' 的花括号必须配对（多/少一个都会让后续规则静默失效）：{ ' + open + ' 个，} ' + close + ' 个')
})

console.log('css token checks passed')
