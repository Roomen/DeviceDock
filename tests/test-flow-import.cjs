// Run: node tests/test-flow-import.cjs — synthetic data only.
// 回修 7 · 3：importFlow 面板入口——批量 JSON 导入成功、全局间隔与计数器生效、失败保持草稿。
// 按锚点截取 test-flow-panel.js 的 importFlow，配假 DOM / 假 FileReader（真实入口，不是纯函数）。
require('./i18n-env.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const T = require('../js/test-flow.js')

const file = fs.readFileSync(path.join(__dirname, '../js/test-flow-panel.js'), 'utf8')
const src = file.slice(file.indexOf('\tfunction importFlow(file) {'), file.indexOf('\tfunction renderReport(report) {'))

function makeWorld(draftInit) {
	const draft = draftInit
	const el = { batchGap: { value: '200' }, status: { textContent: '', className: '' } }
	const calls = { saveState: 0, syncModeUi: 0, renderBatchList: 0, renderRandomList: 0 }
	const ctx = {
		T: T,
		draft: draft,
		mode: draft.mode,
		current: 1,
		randomPlan: null,
		el: el,
		setStatus: function (text, cls) { el.status.textContent = text; el.status.className = cls || '' },
		saveState: function () { calls.saveState++ },
		syncModeUi: function () { calls.syncModeUi++ },
		renderBatchList: function () { calls.renderBatchList++ },
		renderRandomList: function () { calls.renderRandomList++ },
		FileReader: class {
			readAsText(f) { this.result = f.__content; this.onload() }
		},
	}
	ctx.window = ctx
	vm.createContext(ctx)
	vm.runInContext(src + '\nglobalThis.api = { importFlow, get mode() { return mode }, get current() { return current }, get draft() { return draft } }', ctx)
	return { ctx: ctx, api: ctx.api, draft: draft, el: el, calls: calls }
}

const batchJson = JSON.stringify({
	name: '导入测试', kind: 'batch',
	defaults: { delayAfterMs: 1000, timeoutMs: 5000, retries: 0, onFailure: 'continue', restoreOriginals: true },
	counter: { value: 3, step: 1 },
	steps: [
		{ kind: 'write', field: 'rw-t3-9', value: '720', verify: true },
		{ kind: 'write', field: 'rw-t3-10', value: '2', verify: true },
	],
})

// 成功导入：间隔 1000、计数器 3、两步清单、草稿落盘
{
	const w = makeWorld({ mode: 'batch', batch: { steps: [], gapMs: 200 }, random: { count: 40, gapMs: 200, timeoutMs: 5000, seed: '', includeNoReadback: false }, defaults: { timeoutMs: 5000, retries: 0, onFailure: 'continue', restoreOriginals: true }, batchVerify: true })
	w.api.importFlow({ __content: batchJson })
	assert.ok(w.el.status.textContent.indexOf('已导入') !== -1, '导入成功：' + w.el.status.textContent)
	assert.equal(w.draft.batch.steps.length, 2, '两步清单')
	assert.equal(w.draft.batch.gapMs, 1000, '全局间隔同步为流程默认 1000')
	assert.equal(w.el.batchGap.value, '1000', '间隔控件显示 1000')
	assert.equal(w.draft.mode, 'batch')
	assert.equal(w.api.current, 3, '计数器恢复为 3')
	assert.equal(w.calls.saveState, 1, '草稿已落盘')
	// 失败保持草稿
	w.api.importFlow({ __content: '{oops' })
	assert.ok(w.el.status.textContent.indexOf('导入失败') !== -1, '坏 JSON 报错')
	assert.equal(w.draft.batch.steps.length, 2, '草稿未被破坏')
	assert.equal(w.draft.batch.gapMs, 1000, '草稿间隔未被破坏')
}

// 计数器缺省：没有 counter 字段时不清计数
{
	const w = makeWorld({ mode: 'batch', batch: { steps: [], gapMs: 200 }, random: { count: 40, gapMs: 200, timeoutMs: 5000, seed: '', includeNoReadback: false }, defaults: { timeoutMs: 5000, retries: 0, onFailure: 'continue', restoreOriginals: true }, batchVerify: true })
	const flow = JSON.parse(batchJson)
	delete flow.counter
	w.api.importFlow({ __content: JSON.stringify(flow) })
	assert.equal(w.api.current, 1, '无 counter 字段时计数保持')
}

console.log('test-flow-import: ok')
