// 字段文档生成器（无依赖）：读协议的 fields 目录，生成 Markdown 字段表（key/名称/类型/单位/范围/读写/分组/曲线）。
// 内置 SEK：VM 加载 js/sek-test-profile.js（stub 掉 DeviceDockProtocols 与 sekTx，只取 fields）。
// 外部协议：import bundle 并调用 activate(host stub)，取注册对象的 fields —— 与页面同一条入口，不用另抄一份目录。
// 用法：
//   node tools/protocol-fields-doc.mjs --sek > docs/protocols/sek-fields.md          生成到 stdout
//   node tools/protocol-fields-doc.mjs --sek --check docs/protocols/sek-fields.md   与文件比对，不一致退出 1（CI 用）
//   node tools/protocol-fields-doc.mjs examples/protocol-repo/packages/demo/index.js demo.a5frame > ...md
// 外部协议仓库应在自己的 CI 里对同样的入口跑同样的生成与比对（约定见 docs/protocol-contract.md）。
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------- 内置 SEK：stub 环境，跑 js/sek-test-profile.js 拿 fields ----------
function loadSekFields() {
	// sek-test-profile 只用到这些 sekTx 函数；构帧在这里没有意义，stub 成最小返回
	const sekTx = {
		buildDown: () => ({ frame: [], seq: 0, opts: {} }),
		funcValue: () => null,
		tag11Result: () => null,
		hasTag: () => false,
		findTlvItem: () => null,
		bytesEqual: () => false,
		clearBuffer: () => {},
		cancelAll: () => {},
	}
	let patch = null
	// sek-test-profile 以 window 为根：sekTx 与 DeviceDockProtocols 都要挂在 window 上
	const window = { sekTx: sekTx }
	window.DeviceDockProtocols = {
		has: () => true,
		extend: (id, p) => { patch = p },
	}
	const sandbox = { window: window, console }
	sandbox.globalThis = sandbox
	const ctx = vm.createContext(sandbox)
	vm.runInContext(readFileSync(join(ROOT, 'js/protocol-presets.js'), 'utf8'), ctx, { filename: 'protocol-presets.js' })
	vm.runInContext(readFileSync(join(ROOT, 'js/sek-test-profile.js'), 'utf8'), ctx, { filename: 'sek-test-profile.js' })
	if (!patch || !Array.isArray(patch.fields)) throw new Error('sek-test-profile 未产出 fields')
	return { id: 'sek', name: 'SEK', fields: patch.fields }
}

// ---------- 外部协议：import bundle，activate(host stub) ----------
async function loadBundleFields(entryPath, protocolId) {
	const url = pathToFileURL(entryPath.startsWith('/') ? entryPath : join(process.cwd(), entryPath))
	const mod = await import(url.href)
	if (typeof mod.activate !== 'function') throw new Error(entryPath + ' 没有导出 activate')
	const registered = []
	mod.activate({ registerProtocol(def) { registered.push(def) } })
	const def = protocolId
		? registered.find(d => (d.id || '') === protocolId)
		: registered[0]
	if (!def) throw new Error('bundle 里没有协议 ' + (protocolId || '(未指定 id)'))
	if (!Array.isArray(def.fields)) throw new Error(def.id + ' 没有提供 fields')
	return { id: def.id || protocolId, name: def.name || def.id, fields: def.fields }
}

// ---------- Markdown ----------
function esc(s) {
	return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}
function rangeOf(f) {
	if (Array.isArray(f.enum) && f.enum.length) {
		return f.enum.map(function (e) {
			if (typeof e === 'object' && e) return e.label != null ? (e.value + '=' + e.label) : String(e.value)
			return String(e)
		}).join(' / ')
	}
	const parts = []
	if (f.min != null || f.max != null) parts.push((f.min != null ? f.min : '-∞') + ' ~ ' + (f.max != null ? f.max : '∞'))
	if (f.step != null) parts.push('步进 ' + f.step)
	return parts.join('，')
}
function rwOf(f) {
	const r = f.read !== false ? 'R' : ''
	const w = f.write !== false ? 'W' : ''
	return (r + w) || '-'
}
function renderDoc(proto) {
	const fields = proto.fields
	const chartCount = fields.filter(f => f.chart).length
	const out = []
	out.push('<!-- 由 tools/protocol-fields-doc.mjs 自动生成，请勿手改；协议 fields 变更后重新生成并提交。 -->')
	out.push('# ' + proto.name + ' 字段目录')
	out.push('')
	out.push('协议 id：`' + proto.id + '` · 字段 ' + fields.length + ' 项 · 曲线默认显示 ' + chartCount + ' 项（`chart: true`）')
	out.push('')
	out.push('| key | 名称 | 类型 | 单位 | 范围 / 枚举 | 读写 | 分组 | 曲线 |')
	out.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
	fields.forEach(function (f) {
		out.push('| `' + esc(f.key) + '` | ' + esc(f.name) + ' | `' + esc(f.type) + '` | ' +
			esc(f.unit || '') + ' | ' + esc(rangeOf(f)) + ' | ' + rwOf(f) + ' | ' +
			esc(f.group || '') + ' | ' + (f.chart ? '✓' : '') + ' |')
	})
	out.push('')
	out.push('只读字段（读写列无 W）没有写入地址；`source: frame` 类字段来自帧头，不在 TLV 里，单独回读取不到。')
	out.push('')
	return out.join('\n')
}

// ---------- 入口 ----------
async function main() {
	const args = process.argv.slice(2)
	const checkIdx = args.indexOf('--check')
	const checkPath = checkIdx !== -1 ? args[checkIdx + 1] : null
	const rest = checkIdx === -1 ? args : args.filter((a, i) => i !== checkIdx && i !== checkIdx + 1)
	let proto = null
	if (rest[0] === '--sek') {
		proto = loadSekFields()
	} else if (rest[0]) {
		proto = await loadBundleFields(rest[0], rest[1])
	} else {
		console.error('用法：node tools/protocol-fields-doc.mjs --sek | <bundle 入口> [协议 id] [--check <文件>]')
		process.exit(2)
	}
	const md = renderDoc(proto)
	if (checkPath) {
		let current = ''
		try { current = readFileSync(checkPath, 'utf8') } catch (e) { current = '' }
		if (current !== md) {
			console.error('字段文档与协议 fields 不一致：' + checkPath)
			console.error('重新生成：node tools/protocol-fields-doc.mjs ' + rest.join(' ') + ' > ' + checkPath)
			process.exit(1)
		}
		console.log('fields doc check ok: ' + checkPath)
		return
	}
	process.stdout.write(md)
}

main().catch(function (e) {
	console.error(e && e.message ? e.message : e)
	process.exit(1)
})