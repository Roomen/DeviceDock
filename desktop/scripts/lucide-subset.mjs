// 生成客户端随包的精简 lucide 图标样式（desktop/vendor/lucide/lucide.css）。
// lucide-static 的完整 lucide.css 有 2000 多条图标规则，其中不少名字会被 no-internal-names-scan.py 误判；
// 客户端只需要仓库实际用到的图标名，所以按用量裁剪。网页版仍走 CDN 完整样式，不受影响。
// 用法：先下载同版本完整样式，再生成
//   curl -o /tmp/lucide.css https://cdn.jsdelivr.net/npm/lucide-static@1.62.0/font/lucide.css
//   node desktop/scripts/lucide-subset.mjs /tmp/lucide.css
// 升级 lucide 版本时同时更新 index.html 的 CDN 地址、desktop/vendor/manifest.json 与 lucide.woff2。
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const VENDOR_CSS = join(root, 'desktop/vendor/lucide/lucide.css')
const VERSION = '1.62.0'
const NAME = /\bicon-([a-z0-9]+(?:-[a-z0-9]+)*)\b/g
// 尺寸 / 形态修饰类不是图标名（css/icons.css 里的 .icon-sm / .icon-lg，Bootstrap 的 icon-btn）
const MODIFIERS = new Set(['sm', 'lg', 'btn'])

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) {
			walk(full, out)
			continue
		}
		if (/\.(?:html|js|css|mjs)$/.test(entry)) out.push(full)
	}
	return out
}

// 收集仓库里实际出现的 icon-<name>；index.html 与 js / css 是唯一来源，不扫 vendor 自身
export function usedIconNames(files) {
	const names = new Set()
	for (const file of files) {
		const text = readFileSync(file, 'utf8')
		for (const [, name] of text.matchAll(NAME)) {
			if (!MODIFIERS.has(name)) names.add(name)
		}
	}
	return [...names].sort()
}

export function buildSubset(fullCss, names) {
	const rules = new Map()
	for (const line of fullCss.split('\n')) {
		const m = line.match(/^\.icon-([a-z0-9-]+)::before \{ content: "([^"]+)"; \}$/)
		if (m) rules.set(m[1], line)
	}
	const missing = names.filter(n => !rules.has(n))
	if (missing.length) throw new Error('完整样式里没有这些图标：' + missing.join(', '))
	const header = [
		'/* lucide 图标字体样式（随客户端打包，ISC License，见同目录 LICENSE）。',
		'\t由 lucide-static@' + VERSION + ' 的 font/lucide.css 裁剪而成：只保留仓库实际用到的图标名，',
		'\t升级 lucide 或新增图标时重新生成：node desktop/scripts/lucide-subset.mjs <完整 lucide.css>。',
		'\t网页版使用 CDN 完整样式，不受此裁剪影响。 */',
		'@font-face {',
		'  font-family: "lucide";',
		"  src: url('lucide.woff2') format('woff2');",
		'}',
		'',
		'[class^="icon-"], [class*=" icon-"] {',
		"  font-family: 'lucide' !important;font-size: inherit;",
		'  font-style:normal;',
		'  -webkit-font-smoothing: antialiased;',
		'  -moz-osx-font-smoothing: grayscale;',
		'}',
		'',
	].join('\n')
	return header + names.map(n => rules.get(n)).join('\n') + '\n'
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const source = process.argv[2]
	if (!source) {
		console.error('用法：node desktop/scripts/lucide-subset.mjs <完整 lucide.css>')
		process.exit(1)
	}
	const files = [join(root, 'index.html'), ...walk(join(root, 'js')), ...walk(join(root, 'css'))]
	const names = usedIconNames(files)
	writeFileSync(VENDOR_CSS, buildSubset(readFileSync(source, 'utf8'), names))
	console.log('已写入 ' + VENDOR_CSS + '（' + names.length + ' 个图标）')
}
