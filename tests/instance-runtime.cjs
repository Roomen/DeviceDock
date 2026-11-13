require('./i18n-env.cjs')
'use strict'
// 编辑中的流程（localStorage 共享）与产线计数（sessionStorage 按实例隔离）的真实存取函数。
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const source = fs.readFileSync(require('node:path').join(__dirname, '../js/test-flow-panel.js'), 'utf8')
const begin = source.indexOf('\tfunction saveState()')
const end = source.indexOf('\t// ---------- 命名流程', begin)
if (begin < 0 || end < 0) throw new Error('anchors not found')
const shared = new Map([['sk-batch-state', JSON.stringify({ mode: 'batch', batch: { steps: [{ field: 'a', value: '1', step: '0' }] }, index: 99, gapMs: 200 })]])
const storage = map => ({ getItem: k => map.get(k) || null, setItem: (k, v) => map.set(k, v) })
function instance(session) {
	const ctx = vm.createContext({
		localStorage: storage(shared), sessionStorage: storage(session), STATE_KEY: 'sk-batch-state', COUNTER_KEY: 'sk-batch-state.index',
		defaultDraft: () => ({ mode: 'batch', batch: { steps: [{ field: 'a', value: '1', step: '0' }] }, random: {}, defaults: {} }),
	})
	vm.runInContext('let current = 0, draft = null\n' + source.slice(begin, end) + '\nglobalThis.api = { saveState, loadState, set(v) { current = v }, get() { return current }, draft() { return draft } }', ctx)
	ctx.api.loadState()
	return ctx.api
}
const aSession = new Map(), bSession = new Map()
const a = instance(aSession), b = instance(bSession)
assert.equal(a.get(), 0, 'legacy shared progress does not seed a new instance')
a.set(17)
a.saveState()
b.loadState()
assert.equal(b.get(), 0)
b.set(4)
b.saveState()
assert.equal(instance(aSession).get(), 17, 'refresh retains own progress')
assert.equal(instance(bSession).get(), 4)
assert.equal(Object.hasOwn(JSON.parse(shared.get('sk-batch-state')), 'index'), false)
assert.equal(a.draft().batch.steps.length, 1, 'draft comes from the shared localStorage copy')
console.log('instance-runtime: ok')
