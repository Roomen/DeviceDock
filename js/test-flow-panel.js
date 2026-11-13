// 测试流程面板（工作台面板 flow）：协议驱动的批量配置 / 随机读写。
// 只依赖契约：fields / queries / buildRead / buildWrite / buildQuery / matchResponse / readField / session；
// 串口收发走 serialApi.writeRaw + 本文件的按协议匹配泵（pumpFrames），不碰 sekTx，不写任何协议帧格式。
// 流程执行逻辑在 js/test-flow.js（纯逻辑），本文件只负责生成、界面与串口 io。
;(function () {
	'use strict'

	const T = window.TestFlow
	if (!T) {
		console.warn('test-flow-panel: test-flow.js 未加载')
		return
	}

	const STATE_KEY = 'sk-batch-state' // 编辑中的流程（localStorage，跨实例共享）
	const COUNTER_KEY = 'sk-batch-state.index' // 产线计数（sessionStorage，按实例隔离；platform.js 刷新继承时会清掉它）
	const FLOWS_KEY = 'testFlowFlowsV1' // 已保存的命名流程
	const IDLE_TAIL = 4096
	const MAX_BUF = 65536

	function $(id) { return document.getElementById(id) }
	function mk(tag, cls, text) {
		const n = document.createElement(tag)
		if (cls) n.className = cls
		if (text != null) n.textContent = text
		return n
	}
	function icon(name) {
		const i = mk('i', 'icon ' + name)
		i.setAttribute('aria-hidden', 'true')
		return i
	}
	function btn(cls, text, title) {
		const b = mk('button', cls, text)
		b.type = 'button'
		if (title) b.title = title
		return b
	}
	function sleep(ms) {
		return new Promise(function (r) { setTimeout(r, ms) })
	}

	// ---------- 协议 ----------
	function getActiveProto() {
		return typeof window.getActiveProtocol === 'function' ? window.getActiveProtocol() : null
	}
	function protoName() {
		const p = getActiveProto()
		return p && p.name ? p.name : '—'
	}
	// 不能跑的具体原因：没注册 / 没字段目录 / 没构帧钩子。曲线只吃 metrics，流程只吃构帧钩子，互不替代
	function unsupportedReason() {
		const p = getActiveProto()
		if (!p) return '未注册'
		if (!Array.isArray(p.fields) || !p.fields.length) return '未提供字段目录'
		if (typeof p.buildWrite !== 'function') return '未提供字段写入（buildWrite）'
		if (typeof p.matchResponse !== 'function') return '未提供应答匹配（matchResponse）'
		return ''
	}
	function isProtoSupported() { return !unsupportedReason() }

	function fieldsIndex() {
		const p = getActiveProto()
		const map = new Map()
		;((p && Array.isArray(p.fields)) ? p.fields : []).forEach(function (f) {
			if (f && f.key != null) map.set(String(f.key), f)
		})
		return map
	}
	function fieldsList() {
		return Array.from(fieldsIndex().values())
	}

	// ---------- 状态 ----------
	function defaultDraft() {
		return {
			mode: 'batch',
			batch: { steps: [], gapMs: 200 },
			random: { count: 40, gapMs: 200, timeoutMs: 5000, seed: '', includeNoReadback: false },
			defaults: { timeoutMs: 5000, retries: 0, onFailure: 'continue', restoreOriginals: true },
		}
	}
	let draft = defaultDraft()
	let current = 0 // 产线计数：下一台起始索引（{n} 与 bcd 步进都用它）
	let randomPlan = null // 随机模式生成的计划（{ seed, steps }）
	let running = false
	let flowTxToken = null
	let stopFlag = false

	// ---------- 状态持久化 ----------
	// 编辑中的流程存 localStorage（跨实例共享，与其它设置同类）；产线计数存 sessionStorage（每个实例一台一台配各自的，
	// 复制出来的标签页不继承别人的进度——platform.js 在认领实例时会清掉 COUNTER_KEY）。
	function saveState() {
		try { localStorage.setItem(STATE_KEY, JSON.stringify(draft)) } catch (e) { /* 忽略存储失败 */ }
		try { sessionStorage.setItem(COUNTER_KEY, String(current)) } catch (e) { /* 忽略存储失败 */ }
	}

	function loadState() {
		let st = null
		try {
			const raw = localStorage.getItem(STATE_KEY)
			if (raw) st = JSON.parse(raw)
		} catch (e) { st = null }
		if (st && typeof st === 'object') {
			const base = defaultDraft()
			draft = {
				mode: st.mode === 'random' ? 'random' : 'batch',
				batch: {
					steps: Array.isArray(st.batch && st.batch.steps) ? st.batch.steps : [],
					gapMs: Math.max(0, parseInt(st.batch && st.batch.gapMs, 10) || 200),
				},
				random: Object.assign(base.random, (st.random && typeof st.random === 'object') ? st.random : {}),
				defaults: Object.assign(base.defaults, (st.defaults && typeof st.defaults === 'object') ? st.defaults : {}),
			}
		}
		try { current = Math.max(0, parseInt(sessionStorage.getItem(COUNTER_KEY), 10) || 0) } catch (e) { current = 0 }
	}

	// ---------- 命名流程 ----------
	let flows = { v: 1, list: [] }
	try {
		const raw = localStorage.getItem(FLOWS_KEY)
		if (raw) {
			const parsed = JSON.parse(raw)
			if (parsed && Array.isArray(parsed.list)) flows = { v: 1, list: parsed.list }
		}
	} catch (e) { /* */ }
	function saveFlows() {
		try { localStorage.setItem(FLOWS_KEY, JSON.stringify(flows)) } catch (e) { /* */ }
	}
	function flowToJSON(name, kind, steps, defaults, counter) {
		return JSON.stringify({
			name: name,
			kind: kind,
			defaults: defaults,
			counter: { value: counter, step: 1 },
			steps: steps,
		}, null, 2)
	}

	// ---------- 串口 io：写原始字节 + 按当前协议等应答 ----------
	// 只在主发路（事务钉扎）上跑：send 前由 runAll 钉扎，RX 也只订阅主发语义（onReceive 跟随钉扎口）
	const pump = { buf: [], waiters: [], writeTask: null, writeUnclosed: false, unclosedTask: null, faultSid: null, releasing: null, late: 0 }
	let unsubscribeRx = null

	function parseOpts() {
		const api = window.serialApi
		if (api && typeof api.getParseOpts === 'function') {
			try { return api.getParseOpts() } catch (e) { /* */ }
		}
		return {}
	}
	function feed(bytes) {
		if (!bytes || !bytes.length) return
		for (let i = 0; i < bytes.length; i++) pump.buf.push(bytes[i] & 0xff)
		if (pump.buf.length > MAX_BUF) pump.buf.splice(0, pump.buf.length - MAX_BUF)
		pumpFrames()
	}
	function pumpFrames() {
		const proto = getActiveProto()
		while (pump.waiters.length) {
			// 最少字节量由协议的 findFrame 自己判断（契约没规定最短帧长），这里不再假设 4 字节
			if (!pump.buf.length) break
			const u8 = Uint8Array.from(pump.buf)
			let found = null
			if (proto && typeof proto.findFrame === 'function') {
				try { found = proto.findFrame(u8, parseOpts()) } catch (e) { found = null }
			}
			if (found && found.found && found.length > 0) {
				const start = found.offset || 0
				const consume = Math.min(pump.buf.length, start + found.length)
				const raw = found.frame || u8.subarray(start, consume)
				let parsed = found.parse || null
				if (!parsed && typeof window.skParseFrame === 'function') {
					try { parsed = window.skParseFrame(raw, parseOpts()) } catch (e) { parsed = null }
				}
				pump.buf.splice(0, consume)
				if (parsed) dispatchFrame(parsed, raw)
				continue
			}
			break
		}
		if (!pump.waiters.length && pump.buf.length > IDLE_TAIL) {
			pump.buf.splice(0, pump.buf.length - IDLE_TAIL)
		}
	}
	function dispatchFrame(parsed, raw) {
		// 应答资格完全由协议的 matchResponse 决定（dir / 有效性字段是契约没规定的东西，
		// 不能在这里预设——否则外部协议的合法应答会被丢掉）
		for (let i = pump.waiters.length - 1; i >= 0; i--) {
			const w = pump.waiters[i]
			let verdict = false
			try { verdict = matchProto(parsed, w.request, raw) } catch (e) { verdict = false }
			if (verdict === false) continue
			pump.waiters.splice(i, 1)
			clearTimeout(w.timer)
			if (verdict && typeof verdict === 'object' && verdict.ok === false) {
				const e = new Error(verdict.message || '应答不匹配')
				if (verdict.unsupported) e.unsupported = true
				w.reject(e)
			} else {
				w.resolve({ frame: parsed, raw: raw })
			}
			return
		}
		// 没有等待者认领的完整帧：大概率是超时请求的迟到应答——丢弃并计数（跑完汇总到日志）
		if (parsed && parsed.dir === 'up' && (parsed.ok === true || (parsed.crcOk && parsed.endOk))) {
			pump.late++
		}
	}
	// matchResponse 返回 false（继续等）/ true / { ok:false }；send-raw 的 expect 按原始响应字节过滤
	function matchProto(frame, request, raw) {
		const proto = getActiveProto()
		if (!proto || typeof proto.matchResponse !== 'function') return false
		const v = proto.matchResponse(frame, request)
		if (v === false || v == null) return false
		if (typeof v === 'object') return v
		// true 之后再看 send-raw 的期望字节（引擎已把 expect 转成字节放进凭证）
		if (request && request.op === 'raw' && request.expectBytes && request.expectBytes.length) {
			const hay = raw || (frame && frame.dataBytes) || null
			if (!hay || !containsBytes(hay, request.expectBytes)) return false
		}
		return true
	}
	function containsBytes(hay, needle) {
		if (!hay || !needle || needle.length > hay.length) return false
		outer: for (let i = 0; i + needle.length <= hay.length; i++) {
			for (let j = 0; j < needle.length; j++) {
				if ((hay[i + j] & 0xff) !== (needle[j] & 0xff)) continue outer
			}
			return true
		}
		return false
	}
	// 物理写收尾上限：超过就按「写入未确认收尾」处理（钉扎保持为故障占用，可手动释放），不能永久卡住
	const WRITE_SETTLE_CAP_MS = 3000
	// 等 in-flight 物理写收尾（有上限）：true=已收尾，false=超时未确认（pump.writeUnclosed 置位）
	function settleWriteTask() {
		if (!pump.writeTask) return Promise.resolve(true)
		const task = pump.writeTask
		if (pump.writeUnclosed) return Promise.resolve(false) // 已判定未收尾：保持故障占用，不再重复等
		return new Promise(function (resolve) {
			let settled = false
			const cap = setTimeout(function () {
				if (settled) return
				settled = true
				pump.writeUnclosed = true
				// 故障路固定：此时钉扎的物理路（faultSid）——之后主发路切换不影响释放哪一路
				pump.faultSid = window.serialApi.getActiveSendSid()
				// 未收尾任务保留引用：故障占用期间 send() 一律拒绝，手动释放后清掉
				pump.unclosedTask = task
				resolve(false)
			}, WRITE_SETTLE_CAP_MS)
			const onDone = function () {
				if (settled) return
				settled = true
				clearTimeout(cap)
				resolve(true)
			}
			task.then(onDone, onDone)
		})
	}
	function send(bytes, request, timeoutMs) {
		// 故障占用（写入未确认收尾）期间一律拒绝新业务写：钉扎保持，等手动释放
		if (pump.writeUnclosed) {
			const e = new Error('写入未确认收尾')
			e.unclosed = true
			return Promise.reject(e)
		}
		// 物理写与应答等待分开管理：每笔发送前先等上一笔物理写收尾（有上限），
		// 超时 / 取消只取消应答等待，物理写单独记录（未收尾任务保留引用）、由重试 / 恢复 / 收尾统一等待
		return settleWriteTask().then(function (settled) {
			if (!settled) {
				const e = new Error('写入未确认收尾')
				e.unclosed = true
				throw e
			}
			return sendLocked(bytes, request, timeoutMs)
		})
	}
	function sendLocked(bytes, request, timeoutMs) {
		const waiter = new Promise(function (resolve, reject) {
			const w = {
				request: request,
				resolve: resolve,
				reject: reject,
				timer: setTimeout(function () {
					const idx = pump.waiters.indexOf(w)
					if (idx !== -1) pump.waiters.splice(idx, 1)
					const e = new Error('等待响应超时(' + timeoutMs + 'ms)')
					e.timeout = true
					reject(e)
				}, timeoutMs),
			}
			// 新请求不能由上一事务留下的应答完成：没有别的等待者时清掉旧缓冲
			if (!pump.waiters.length) pump.buf = []
			pump.waiters.push(w)
			try {
				pump.writeTask = Promise.resolve(window.serialApi.writeRaw(bytes, { token: flowTxToken }))
			} catch (e) {
				clearTimeout(w.timer)
				const idx = pump.waiters.indexOf(w)
				if (idx !== -1) pump.waiters.splice(idx, 1)
				reject(e)
				return
			}
			pump.writeTask.catch(function (err) {
				// 写失败 = 不会有应答：撤掉这笔等待（物理写任务已单独记录，收尾在 settleWriteTask）
				clearTimeout(w.timer)
				const idx = pump.waiters.indexOf(w)
				if (idx !== -1) pump.waiters.splice(idx, 1)
				reject(err instanceof Error ? err : new Error(String(err)))
			})
			pumpFrames()
		})
		return waiter
	}
	function cancelWaiters(reason) {
		const msg = reason || '已停止'
		while (pump.waiters.length) {
			const w = pump.waiters.pop()
			clearTimeout(w.timer)
			try { w.reject(new Error(msg)) } catch (e) { /* */ }
		}
	}
	function watchRx() {
		if (unsubscribeRx || !window.serialApi) return
		unsubscribeRx = window.serialApi.onReceive(function (data) { feed(data) })
	}

	// ---------- 批量值计算：{n} 与 bcd 步进（老批量配置的逐台累加） ----------
	function addBig(startDigits, k, step) {
		if (!step) return startDigits
		return (BigInt(startDigits) + BigInt(k) * BigInt(step)).toString()
	}
	function effectiveValue(item, field, k) {
		const raw = item.value == null ? '' : String(item.value)
		let v = T.substituteVars(raw, { n: String(k) })
		const step = parseInt(item.step, 10) || 0
		if (step > 0 && field.type === 'bcd' && /^[0-9]+$/.test(v.trim())) {
			v = addBig(v.trim(), k, step)
		}
		return v
	}

	// ---------- DOM ----------
	const el = {}
	let mode = 'batch'
	let lastReport = null

	function setStatus(text, cls) {
		if (!el.status) return
		el.status.textContent = text
		el.status.className = 'sk-rw-status' + (cls ? ' ' + cls : '')
	}
	function setProgress(done, total) {
		if (!el.progress) return
		const pct = total ? Math.round(done * 100 / total) : 0
		el.progress.style.width = pct + '%'
		el.progress.textContent = done + '/' + total
	}

	// ---------- 字段下拉 ----------
	function fillFieldSelect() {
		const sel = el.fieldSelect
		if (!sel) return
		sel.textContent = ''
		const fields = fieldsList().filter(function (f) { return f.write !== false })
		const groups = {}
		fields.forEach(function (f) {
			const g = f.group || '字段'
			if (!groups[g]) groups[g] = []
			groups[g].push(f)
		})
		Object.keys(groups).forEach(function (g) {
			const og = document.createElement('optgroup')
			og.label = g
			groups[g].forEach(function (f) {
				const opt = document.createElement('option')
				opt.value = f.key
				opt.textContent = f.name
				og.appendChild(opt)
			})
			sel.appendChild(og)
		})
	}
	function selectedField() {
		const idx = fieldsIndex()
		return idx.get(el.fieldSelect ? el.fieldSelect.value : '') || null
	}

	// ---------- 步骤列表渲染 ----------
	function valueInputFor(field, value, onChange) {
		if (field.type === 'enum' || field.type === 'bool') {
			const sel = document.createElement('select')
			sel.className = 'form-select form-select-sm sk-flow-item-value'
			const values = field.type === 'bool' ? [{ value: 0, label: '0' }, { value: 1, label: '1' }] : (field.enum || [])
			values.forEach(function (e) {
				const opt = document.createElement('option')
				opt.value = String(typeof e === 'object' ? e.value : e)
				opt.textContent = typeof e === 'object' ? (e.label != null ? e.label : String(e.value)) : String(e)
				sel.appendChild(opt)
			})
			sel.value = value != null && value !== '' ? String(value) : (values.length ? String(typeof values[0] === 'object' ? values[0].value : values[0]) : '')
			sel.addEventListener('change', onChange)
			return sel
		}
		const input = document.createElement('input')
		input.className = 'form-control form-control-sm sk-flow-item-value'
		if (field.type === 'bcd' || field.type === 'ascii') input.type = 'text'
		else {
			input.type = 'number'
			if (field.min != null) input.min = String(field.min)
			if (field.max != null) input.max = String(field.max)
		}
		input.value = value == null ? '' : String(value)
		input.addEventListener('change', onChange)
		return input
	}

	function renderBatchList() {
		const box = el.batchList
		if (!box) return
		box.textContent = ''
		const idx = fieldsIndex()
		draft.batch.steps.forEach(function (item, i) {
			const field = idx.get(item.field)
			const row = mk('div', 'sk-flow-item-row')
			row.appendChild(mk('span', 'sk-flow-item-no', String(i + 1)))
			const nameText = field ? field.name : '(未知字段: ' + item.field + ')'
			const nameSpan = mk('span', 'sk-flow-item-name', nameText)
			nameSpan.title = nameText + (field && field.desc ? '\n' + field.desc : '')
			row.appendChild(nameSpan)
			if (field) {
				const val = valueInputFor(field, item.value, function () {
					item.value = val.value
					saveState()
				})
				row.appendChild(val)
			} else {
				row.appendChild(mk('span', 'sk-flow-item-value', item.value || ''))
			}
			if (field && field.type === 'bcd') {
				const step = document.createElement('input')
				step.type = 'number'
				step.className = 'form-control form-control-sm sk-flow-item-step'
				step.min = '0'
				step.title = '步进(逐台累加)，0=固定不累加；{n} 为台号'
				step.value = item.step != null ? item.step : '0'
				step.addEventListener('change', function () {
					item.step = step.value
					saveState()
				})
				row.appendChild(step)
			} else {
				row.appendChild(mk('span', 'sk-flow-item-step-ph'))
			}
			const up = btn('sk-flow-item-btn', '↑', '上移')
			up.addEventListener('click', function () {
				if (i === 0) return
				const t = draft.batch.steps[i - 1]
				draft.batch.steps[i - 1] = draft.batch.steps[i]
				draft.batch.steps[i] = t
				saveState()
				renderBatchList()
			})
			const down = btn('sk-flow-item-btn', '↓', '下移')
			down.addEventListener('click', function () {
				if (i >= draft.batch.steps.length - 1) return
				const t = draft.batch.steps[i + 1]
				draft.batch.steps[i + 1] = draft.batch.steps[i]
				draft.batch.steps[i] = t
				saveState()
				renderBatchList()
			})
			const del = btn('sk-flow-item-btn', '✕', '删除')
			del.addEventListener('click', function () {
				draft.batch.steps.splice(i, 1)
				saveState()
				renderBatchList()
			})
			row.append(up, down, del)
			box.appendChild(row)
		})
		if (!draft.batch.steps.length) {
			box.appendChild(mk('div', 'sk-flow-list-empty', '清单为空：从上方选择可写字段后点「添加」'))
		}
	}

	function renderRandomList() {
		const box = el.randomList
		if (!box) return
		box.textContent = ''
		if (!randomPlan) {
			box.appendChild(mk('div', 'sk-flow-list-empty', '还没生成：填好参数后点「生成步骤」，相同 seed 生成相同序列'))
			return
		}
		const idx = fieldsIndex()
		randomPlan.steps.forEach(function (step, i) {
			const row = mk('div', 'sk-flow-item-row')
			row.appendChild(mk('span', 'sk-flow-item-no', String(i + 1)))
			const field = idx.get(step.field)
			let label = ''
			if (step.kind === 'send-raw') label = '查询 ' + (step.query || '')
			else if (step.kind === 'read') label = '读 ' + (field ? field.name : step.field)
			else if (step.kind === 'verify') label = '回读比对 ' + (field ? field.name : step.field)
			else if (step.kind === 'write') label = '写 ' + (field ? field.name : step.field)
			const name = mk('span', 'sk-flow-item-name', label)
			name.title = label + (step.kind === 'write' ? '（值在量程 / 枚举内随机生成）' : '')
			row.appendChild(name)
			const val = mk('span', 'sk-flow-item-value sk-flow-item-static', step.kind === 'write' ? '随机' : '')
			if (step.kind === 'write') val.title = '值在运行时按量程 / 枚举随机生成，与当前值不同'
			row.appendChild(val)
			box.appendChild(row)
		})
	}

	// ---------- 预设 ----------
	function renderFlows() {
		const sel = el.flowSelect
		if (!sel) return
		sel.textContent = ''
		const opt0 = document.createElement('option')
		opt0.value = ''
		opt0.textContent = '已保存流程…'
		sel.appendChild(opt0)
		flows.list.forEach(function (f, i) {
			const opt = document.createElement('option')
			opt.value = String(i)
			opt.textContent = f.name + '（' + (f.kind === 'random' ? '随机' : '批量') + ' · ' + ((f.flow && f.flow.steps) || []).length + ' 步）'
			sel.appendChild(opt)
		})
	}
	function currentFlowObject() {
		if (mode === 'random') {
			if (!randomPlan) return null
			return {
				name: '随机读写 ' + new Date().toISOString().slice(0, 10),
				kind: 'random',
				defaults: draft.defaults,
				counter: { value: 0, step: 1 },
				steps: randomPlan.steps,
				random: { count: draft.random.count, seed: randomPlan.seed, verify: draft.random.verify, gapMs: draft.random.gapMs, timeoutMs: draft.random.timeoutMs },
			}
		}
		return {
			name: '批量配置 ' + new Date().toISOString().slice(0, 10),
			kind: 'batch',
			defaults: draft.defaults,
			counter: { value: current, step: 1 },
			steps: draft.batch.steps.map(function (it) {
				return { kind: 'write', field: it.field, value: it.value, step: it.step || '0', verify: draft.batchVerify !== false }
			}),
		}
	}
	function saveNamedFlow() {
		const flow = currentFlowObject()
		if (!flow) {
			setStatus(mode === 'random' ? '先「生成步骤」再保存' : '清单为空，先添加步骤', 'err')
			return
		}
		window.AppDialog.prompt('流程名称：', flow.name, { title: '保存流程' }).then(function (name) {
			if (name == null || !String(name).trim()) return
			flow.name = String(name).trim().slice(0, 60)
			flows.list.push({ id: 'f' + Date.now().toString(36), name: flow.name, kind: flow.kind, flow: flow })
			if (flows.list.length > 50) flows.list = flows.list.slice(-50)
			saveFlows()
			renderFlows()
			setStatus('已保存「' + flow.name + '」', 'ok')
		})
	}
	function loadNamedFlow() {
		const i = parseInt(el.flowSelect.value, 10)
		if (isNaN(i) || !flows.list[i]) return
		const f = flows.list[i]
		const flow = f.flow || {}
		const defaults = T.normalizeDefaults(flow.defaults)
		draft.defaults = { timeoutMs: defaults.timeoutMs, retries: defaults.retries, onFailure: defaults.onFailure, restoreOriginals: defaults.restoreOriginals }
		if (f.kind === 'random' || flow.kind === 'random') {
			mode = 'random'
			const r = flow.random || {}
			draft.random = {
				count: r.count || (flow.steps || []).length || 40,
				gapMs: r.gapMs != null ? r.gapMs : defaults.delayAfterMs,
				timeoutMs: r.timeoutMs || defaults.timeoutMs,
				seed: r.seed != null ? String(r.seed) : '',
				verify: !!r.verify,
			}
			randomPlan = { seed: (flow.seed != null ? flow.seed : (r.seed != null ? r.seed : 0)) >>> 0, steps: (flow.steps || []).map(function (s) { return T.normalizeStep(s, 0, defaults) }) }
		} else {
			mode = 'batch'
			draft.batch.steps = (flow.steps || []).map(function (s) {
				return { field: s.field, value: s.value == null ? '' : String(s.value), step: s.step != null ? String(s.step) : '0' }
			})
			draft.batchVerify = flow.steps && flow.steps.length && flow.steps[0].verify !== false
		}
		if (flow.counter && flow.counter.value != null) current = T.normalizeStep === null ? current : Math.max(0, Number(flow.counter.value) || 0)
		saveState()
		syncModeUi()
		renderBatchList()
		renderRandomList()
		setStatus('已载入「' + f.name + '」', 'ok')
	}
	function deleteNamedFlow() {
		const i = parseInt(el.flowSelect.value, 10)
		if (isNaN(i) || !flows.list[i]) return
		const f = flows.list[i]
		window.AppDialog.confirm('删除流程「' + f.name + '」？').then(function (ok) {
			if (!ok) return
			flows.list.splice(i, 1)
			saveFlows()
			renderFlows()
		})
	}
	function exportFlow() {
		const flow = currentFlowObject()
		if (!flow) {
			setStatus(mode === 'random' ? '先「生成步骤」再导出' : '清单为空', 'err')
			return
		}
		const blob = new Blob([JSON.stringify(flow, null, 2)], { type: 'application/json' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = 'test-flow.json'
		document.body.appendChild(a)
		a.click()
		document.body.removeChild(a)
		URL.revokeObjectURL(url)
	}
	function importFlow(file) {
		const reader = new FileReader()
		reader.onload = function () {
			// 先全部解析成局部变量，全部成功才落到 draft——导入失败不能改掉编辑中的草稿
			let flow = null
			try { flow = JSON.parse(String(reader.result)) } catch (e) { flow = null }
			if (!flow || !Array.isArray(flow.steps) || !flow.steps.length) {
				setStatus('导入失败：不是有效的流程 JSON', 'err')
				return
			}
			try {
				let defaults = null
				try { defaults = T.normalizeDefaults(flow.defaults) } catch (e) { defaults = T.normalizeDefaults({}) }
				let nextDefaults = { timeoutMs: defaults.timeoutMs, retries: defaults.retries, onFailure: defaults.onFailure, restoreOriginals: defaults.restoreOriginals }
				let nextMode = 'batch'
				let nextBatchSteps = null
				let nextBatchVerify = true
				let nextRandom = null
				let nextPlan = null
				let nextGapMs = defaults.delayAfterMs
				let nextCounter = null
				if (flow.kind === 'random') {
					nextMode = 'random'
					nextCounter = null
					const r = flow.random || {}
					nextRandom = {
						count: (flow.steps || []).length,
						gapMs: r.gapMs != null ? r.gapMs : defaults.delayAfterMs,
						timeoutMs: r.timeoutMs || defaults.timeoutMs,
						seed: r.seed != null ? String(r.seed) : '',
					}
					nextPlan = { seed: (flow.seed != null ? flow.seed : 0) >>> 0, steps: flow.steps.map(function (s, i) { return T.normalizeStep(s, i, defaults) }) }
				} else {
					// 批量导入规范化（纯函数，见 test-flow.js）：非写步骤 / 逐步定制 / 回读不一致一律拒绝，
					// 全局间隔随流程默认值同步（否则导入成功却按旧间隔执行）
					const imp = T.normalizeBatchImport(flow)
					nextBatchSteps = imp.steps
					nextBatchVerify = imp.verify
					nextGapMs = imp.gapMs
					nextDefaults = imp.defaults
					nextCounter = imp.counter
				}
				draft.defaults = nextDefaults
				draft.batch.gapMs = nextGapMs
				if (el.batchGap) el.batchGap.value = String(nextGapMs)
				if (nextCounter && nextCounter.value != null) current = Math.max(0, Number(nextCounter.value) || 0)
				mode = nextMode
				draft.mode = nextMode
				if (nextMode === 'random') {
					draft.random = nextRandom
					randomPlan = nextPlan
				} else {
					draft.batch.steps = nextBatchSteps
					draft.batchVerify = nextBatchVerify
				}
				saveState()
				syncModeUi()
				renderBatchList()
				renderRandomList()
				setStatus('已导入「' + (flow.name || '未命名') + '」', 'ok')
			} catch (e) {
				setStatus('导入失败：' + (e && e.message ? e.message : e), 'err')
			}
		}
		reader.readAsText(file)
	}

	// ---------- 结果 ----------
	function renderReport(report) {
		const box = el.results
		if (!box) return
		box.textContent = ''
		if (!report) return
		report.results.forEach(function (r) {
			const row = mk('div', 'sk-flow-result-row is-' + r.status)
			row.appendChild(mk('span', 'sk-flow-result-no', String(r.index + 1)))
			row.appendChild(mk('span', 'sk-flow-result-label', r.label))
			const st = mk('span', 'sk-flow-result-status', T.STATUS_LABEL[r.status] || r.status)
			if (r.reason) st.title = r.reason
			row.appendChild(st)
			row.appendChild(mk('span', 'sk-flow-result-ms', r.durationMs + 'ms'))
			const hex = mk('span', 'sk-flow-result-hex', r.responseHex ? r.responseHex : (r.readValue != null ? String(r.readValue) : ''))
			if (r.requestHex) hex.title = 'TX ' + r.requestHex + (r.reason ? '\n' + r.reason : '')
			row.appendChild(hex)
			box.appendChild(row)
		})
		if (!report.results.length) {
			box.appendChild(mk('div', 'sk-flow-list-empty', report.fatal || '没有执行任何步骤'))
		}
	}
	function exportReport(kind) {
		if (!lastReport) {
			setStatus('还没有运行结果', 'err')
			return
		}
		const text = kind === 'csv' ? T.toCSV(lastReport) : T.toJSON(lastReport)
		const blob = new Blob([text], { type: kind === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = kind === 'csv' ? 'test-flow-result.csv' : 'test-flow-result.json'
		document.body.appendChild(a)
		a.click()
		document.body.removeChild(a)
		URL.revokeObjectURL(url)
	}

	// ---------- 运行 ----------
	function buildIo() {
		const proto = getActiveProto()
		const sess = proto && proto.session ? proto.session : null
		return {
			now: function () { return Date.now() },
			sleep: sleep,
			isOpen: function () { return !!(window.serialApi && window.serialApi.isOpen()) },
			shouldStop: function () { return stopFlag },
			fields: fieldsList(),
			queries: (proto && Array.isArray(proto.queries)) ? proto.queries : [],
			session: sess,
			vars: { n: String(current) },
			buildRead: function (field) { return proto.buildRead(field) },
			buildWrite: function (field, value) { return proto.buildWrite(field, value) },
			buildQuery: function (query) { return typeof proto.buildQuery === 'function' ? proto.buildQuery(query) : null },
			readField: function (frame, field) { return typeof proto.readField === 'function' ? proto.readField(frame, field) : null },
			send: send,
			settleWrites: function () { return settleWriteTask() },
			log: function (level, msg) { logLine(level, msg) },
			onStep: function () { /* 结果在报告里统一渲染 */ },
		}
	}
	function logLine(level, msg) {
		if (!el.log) return
		const div = mk('div', 'sk-rw-log-line sk-rw-' + (level || 'info'), '[' + new Date().toLocaleTimeString() + '] ' + msg)
		el.log.appendChild(div)
		el.log.scrollTop = el.log.scrollHeight
	}

	// 运行前把「待写值」整体算一遍：编码 / 范围错误直接中止，一个字节都不发（老批量配置的保证）
	function preflight(steps) {
		const idx = fieldsIndex()
		for (let i = 0; i < steps.length; i++) {
			const s = steps[i]
			if (s.kind !== 'write') continue
			const field = idx.get(s.field)
			if (!field) return '第 ' + (i + 1) + ' 步字段不存在：' + s.field
			const value = effectiveValue(s, field, current)
			const problem = T.checkValue(field, value)
			if (problem) return '第 ' + (i + 1) + ' 步 ' + field.name + ' ' + problem
			try {
				getActiveProto().buildWrite(field, value)
			} catch (e) {
				return '第 ' + (i + 1) + ' 步 ' + field.name + ' ' + (e && e.message ? e.message : e)
			}
		}
		return ''
	}
	function collectBatchSteps() {
		return draft.batch.steps.map(function (it) {
			const field = fieldsIndex().get(it.field)
			return {
				kind: 'write',
				field: it.field,
				value: field ? effectiveValue(it, field, current) : (it.value || ''),
				verify: draft.batchVerify !== false,
				delayAfterMs: draft.batch.gapMs,
				timeoutMs: draft.defaults.timeoutMs,
				retries: draft.defaults.retries,
			}
		})
	}

	async function runAll() {
		if (running) return
		const reason = unsupportedReason()
		if (reason) {
			setStatus('当前协议' + reason + '，无法运行测试流程', 'err')
			return
		}
		if (!window.serialApi || !window.serialApi.isOpen()) {
			setStatus('请先打开串口', 'err')
			return
		}
		let steps = null
		let flow = null
		if (mode === 'batch') {
			steps = collectBatchSteps()
			const problem = preflight(steps)
			if (problem) {
				setStatus(problem, 'err')
				return
			}
			if (!steps.length) {
				setStatus('清单为空，先添加步骤', 'err')
				return
			}
		} else {
			if (!randomPlan) {
				setStatus('先「生成步骤」', 'err')
				return
			}
			steps = randomPlan.steps
		}
		let defaults = null
		try {
			defaults = T.normalizeDefaults(Object.assign({}, draft.defaults, { delayAfterMs: mode === 'batch' ? draft.batch.gapMs : draft.random.gapMs }))
		} catch (e) { defaults = T.normalizeDefaults({}) }
		try {
			const proto = getActiveProto()
			flow = T.normalizeFlow({
				name: mode === 'batch' ? '批量配置' : '随机读写',
				kind: mode === 'random' ? 'random' : 'batch',
				seed: mode === 'random' ? (randomPlan.seed >>> 0) : null,
				defaults: defaults,
				counter: { value: current, step: 1 },
				steps: steps,
				queries: (proto && Array.isArray(proto.queries)) ? proto.queries : [],
			})
		} catch (e) {
			setStatus('流程无效：' + (e && e.message ? e.message : e), 'err')
			return
		}
		const errors = T.validateFlow(flow, fieldsList())
		if (errors.length) {
			setStatus('流程校验未通过：' + errors[0].message + (errors.length > 1 ? '（共 ' + errors.length + ' 处）' : ''), 'err')
			return
		}

		running = true
		stopFlag = false
		if (el.log) el.log.textContent = ''
		el.results.textContent = ''
		lastReport = null
		el.start.disabled = true
		el.stop.disabled = false
		setStatus('运行中…', 'run')
		watchRx()
		pump.late = 0
		// 整轮独占主发口（owner=flow）：与固件升级等其它事务互斥——运行期间对方入口被拒，反之亦然
		try {
			flowTxToken = window.serialApi.pinSession(window.serialApi.getActiveSendSid(), 'flow')
			if (!flowTxToken) throw new Error('另一事务正在进行，暂不能开始流程')
		} catch (e) {
			setStatus('无法开始：' + (e && e.message ? e.message : e), 'err')
			running = false
			el.start.disabled = !isProtoSupported()
			el.stop.disabled = true
			return
		}
		try {
			const io = buildIo()
			const report = await T.run(flow, io)
			lastReport = report
			renderReport(report)
			const st = report.stats
			const sum = (report.stopped ? '已停止' : '完成') + '：成功 ' + st.success + ' / 失败 ' + st.fail +
				' / 超时 ' + st.timeout + ' / 不匹配 ' + st.mismatch + ' / 不支持 ' + st.unsupported +
				'，总耗时 ' + (report.durationMs / 1000).toFixed(1) + 's'
			if (el.summary) {
				el.summary.textContent = sum + (report.restore && report.restore.failed.length ? ' · 恢复失败 ' + report.restore.failed.length : '')
				el.summary.className = 'sk-rw-summary' + (st.failed || (report.restore && report.restore.failed.length) ? ' is-fail' : ' is-pass')
			}
			if (mode === 'batch' && !st.failed && !report.stopped && !report.fatal) {
				// 产线计数：这一台 PASS 才前进
				current = current + 1
				saveState()
				setStatus('第 ' + current + ' 台 PASS，下一台起始索引 ' + current, 'ok')
				if (el.counterLabel) el.counterLabel.textContent = '已配 ' + current + ' 台'
			} else if (mode === 'batch') {
				setStatus('第 ' + (current + 1) + ' 台未通过，请重试', 'err')
			} else {
				setStatus(report.stopped ? '已停止' : (st.failed ? '完成（有失败）' : '完成'), report.stopped ? 'warn' : (st.failed ? 'err' : 'ok'))
			}
			setProgress(st.total, st.total)
		} catch (e) {
			logLine('fail', '异常：' + (e && e.message ? e.message : e))
			setStatus('异常：' + (e && e.message ? e.message : e), 'err')
		} finally {
			// 等在飞物理写收尾（有上限）：未确认就保持故障占用（钉扎不解，状态栏 / 面板可见，停止键=手动释放）
			const unclosed = pump.writeUnclosed
			try { await settleWriteTask() } catch (e) { /* */ }
			if (unclosed || pump.writeUnclosed) {
				setStatus('写入未确认收尾：串口保持占用，点「停止」手动释放', 'err')
				running = true
				el.start.disabled = true
				el.stop.disabled = false
			} else {
				window.serialApi.unpinSession(flowTxToken)
				flowTxToken = null
				running = false
				el.start.disabled = !isProtoSupported()
				el.stop.disabled = true
			}
			if (pump.late > 0) {
				logLine('warn', '已丢弃迟到应答 ' + pump.late + ' 帧（超时请求的迟到响应不会计入任何步骤）')
			}
		}
	}

	async function stopAll() {
		if (pump.writeUnclosed) {
			// 故障释放串行化：重复点击直接复用同一份进行中的 Promise，不会重复进入
			if (pump.releasing) return pump.releasing
			// 释放期间停止键禁用（finally 恢复），避免连点推进第二次关闭
			el.stop.disabled = true
			pump.releasing = releaseFaultyHold()
			try {
				return await pump.releasing
			} finally {
				pump.releasing = null
				if (pump.writeUnclosed) el.stop.disabled = false
			}
		}
		stopFlag = true
		setStatus('正在停止…', 'warn')
		cancelWaiters('已停止')
	}

	// 故障终态的手动释放：先作废旧执行代次（停止标记 + 撤掉等待者）→ 关端口确认释放；
	// 本事务的钉扎会让关闭被拒，按归属与令牌释放后再试一次；失败则取回占用并如实提示
	async function releaseFaultyHold() {
		stopFlag = true
		cancelWaiters('已停止')
		// 故障路固定：用进入故障终态时记下的物理路，不读当前主发路（用户可能已经切走）
		const sid = pump.faultSid || window.serialApi.getActiveSendSid()
		let closed = false
		let res = null
		try { res = await window.serialLanes.close(sid) } catch (e) { res = null }
		closed = !!(res && res.ok)
		// transaction_pinned / lane_blocked / lane_busy：按归属与令牌释放后重试一次；
		// owner / token 校验由 forceReleaseTransaction 自己把关
		if (!closed && res && (res.code === 'transaction_pinned' || res.code === 'lane_blocked' || res.code === 'lane_busy')) {
			try { window.serialApi.forceReleaseTransaction('flow', flowTxToken) } catch (e) { /* */ }
			flowTxToken = null
			try { res = await window.serialLanes.close(sid) } catch (e) { res = null }
			closed = !!(res && res.ok)
		}
		if (!closed) {
			// 端口没确认释放：重新取回该路占用；取不到就保留原令牌（不清空，下次还能按它释放）
			try {
				const next = window.serialApi.pinSession(sid, 'flow')
				if (next) flowTxToken = next
			} catch (e) { /* 保持原令牌 */ }
			setStatus('端口未确认释放，保持占用；请重试关闭或手动断开该路', 'err')
			return
		}
		// 端口已确认释放：这些任务都属于已作废的执行代次，直接清掉，再解锁（若还没解）
		pump.writeTask = null
		pump.unclosedTask = null
		pump.writeUnclosed = false
		pump.faultSid = null
		if (flowTxToken) {
			try { window.serialApi.forceReleaseTransaction('flow', flowTxToken) } catch (e) { /* */ }
			flowTxToken = null
		}
		setStatus('事务占用已手动释放', 'ok')
		running = false
		el.start.disabled = !isProtoSupported()
		el.stop.disabled = true
	}

	// 可回读 = 协议能给这个字段构造读请求（有查询码、能读到原值、写后能校验与恢复）
	function canReadBack(proto, field) {
		if (field.read === false) return false
		if (typeof proto.buildRead !== 'function') return false
		try { return !!proto.buildRead(field) } catch (e) { return false }
	}
	function generateRandom() {
		const fields = fieldsList()
		const proto = getActiveProto()
		const readable = fields.filter(function (f) { return f.read !== false })
		const writableAll = fields.filter(function (f) { return f.write !== false })
		// 安全默认：只随机会写后能回读校验与恢复原值的字段；显式开关才包括不可回读的只写字段
		const writable = draft.random.includeNoReadback
			? writableAll
			: writableAll.filter(function (f) { return canReadBack(proto, f) })
		if (!readable.length && !writable.length) {
			setStatus('当前协议没有可读 / 可写字段', 'err')
			return
		}
		// 传给随机生成器的目录：读 / 写都只挑能回读的（buildRead 能构出读请求）；
		// 「包括无法回读的字段」只放宽写（写后不校验、不恢复）；危险字段 random:false 两边都不进
		const planFields = fields
			.filter(function (f) { return f.random !== false })
			.filter(function (f) { return canReadBack(proto, f) || (draft.random.includeNoReadback && f.write !== false) })
		const queries = (proto && Array.isArray(proto.queries)) ? proto.queries : []
		let seed = parseInt(draft.random.seed, 10)
		if (isNaN(seed)) seed = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0
		draft.random.seed = String(seed)
		const plan = T.randomPlan({
			seed: seed,
			count: draft.random.count,
			fields: planFields,
			queries: queries,
			verify: draft.batchVerify !== false,
			delayAfterMs: draft.random.gapMs,
			timeoutMs: draft.random.timeoutMs,
		})
		randomPlan = plan
		saveState()
		renderRandomList()
		setStatus('已生成 ' + plan.steps.length + ' 步（seed=' + seed + '，相同 seed 可复现）', 'ok')
	}

	// ---------- 界面同步 ----------
	function syncModeUi() {
		if (el.modeSeg) {
			el.modeSeg.querySelectorAll('button').forEach(function (b) {
				const on = b.dataset.mode === mode
				b.classList.toggle('active', on)
				b.setAttribute('aria-pressed', on ? 'true' : 'false')
			})
		}
		if (el.batchBox) el.batchBox.hidden = mode !== 'batch'
		if (el.randomBox) el.randomBox.hidden = mode !== 'random'
		if (el.counterBtn) el.counterBtn.hidden = mode !== 'batch'
		if (el.counterLabel) el.counterLabel.textContent = '已配 ' + current + ' 台'
	}
	function refreshProtoUi() {
		if (el.protoBadge) el.protoBadge.textContent = protoName()
		fillFieldSelect()
		const reason = unsupportedReason()
		if (el.hint) {
			el.hint.textContent = reason
				? '当前协议「' + protoName() + '」' + reason + '，无法运行测试流程'
				: '协议 ' + protoName() + ' · 批量配置逐台下发并回读，随机读写按字段量程随机取值（seed 可复现）'
		}
		if (el.start && !running) el.start.disabled = !!reason
		if (el.card) el.card.classList.toggle('is-disabled', !!reason)
	}

	// ---------- init ----------
	function init() {
		el.card = $('sk-flow-card')
		if (!el.card) return
		el.modeSeg = $('sk-flow-mode')
		el.hint = $('sk-flow-hint')
		el.protoBadge = $('sk-flow-proto-name')
		el.batchBox = $('sk-flow-batch-box')
		el.randomBox = $('sk-flow-random-box')
		el.fieldSelect = $('sk-flow-field-select')
		el.valueInput = $('sk-flow-value')
		el.batchGap = $('sk-flow-batch-gap')
		el.add = $('sk-flow-add')
		el.batchList = $('sk-flow-list')
		el.randomCount = $('sk-flow-count')
		el.randomGap = $('sk-flow-gap')
		el.randomTimeout = $('sk-flow-timeout')
		el.randomSeed = $('sk-flow-seed')
		el.randomNoReadback = $('sk-flow-noreadback')
		el.randomNoReadWarn = $('sk-flow-noread-warn')
		el.generate = $('sk-flow-generate')
		el.randomList = $('sk-flow-random-list')
		el.timeout = $('sk-flow-default-timeout')
		el.retries = $('sk-flow-retries')
		el.continueOnFail = $('sk-flow-continue')
		el.restore = $('sk-flow-restore')
		el.batchVerify = $('sk-flow-batch-verify')
		el.flowSelect = $('sk-flow-preset-select')
		el.flowSave = $('sk-flow-save')
		el.flowLoad = $('sk-flow-load')
		el.flowDelete = $('sk-flow-delete')
		el.importFile = $('sk-flow-import')
		el.export = $('sk-flow-export')
		el.start = $('sk-flow-start')
		el.stop = $('sk-flow-stop')
		el.counterBtn = $('sk-flow-reset')
		el.counterLabel = $('sk-flow-counter')
		el.progress = $('sk-flow-progress-bar')
		el.status = $('sk-flow-status')
		el.summary = $('sk-flow-summary')
		el.results = $('sk-flow-results')
		el.log = $('sk-flow-log')
		el.resultCsv = $('sk-flow-result-csv')
		el.resultJson = $('sk-flow-result-json')

		loadState()
		mode = draft.mode === 'random' ? 'random' : 'batch'
		// 控件初值
		if (el.batchGap) el.batchGap.value = String(draft.batch.gapMs)
		if (el.randomCount) el.randomCount.value = String(draft.random.count)
		if (el.randomGap) el.randomGap.value = String(draft.random.gapMs)
		if (el.randomTimeout) el.randomTimeout.value = String(draft.random.timeoutMs)
		if (el.randomSeed) el.randomSeed.value = draft.random.seed || ''
		if (el.randomNoReadback) el.randomNoReadback.checked = !!draft.random.includeNoReadback
		if (el.randomNoReadWarn) el.randomNoReadWarn.hidden = !draft.random.includeNoReadback
		if (el.batchVerify) el.batchVerify.checked = draft.batchVerify !== false
		if (el.timeout) el.timeout.value = String(draft.defaults.timeoutMs)
		if (el.retries) el.retries.value = String(draft.defaults.retries)
		if (el.continueOnFail) el.continueOnFail.checked = draft.defaults.onFailure !== 'stop'
		if (el.restore) el.restore.checked = draft.defaults.restoreOriginals !== false

		syncModeUi()
		renderBatchList()
		renderRandomList()
		renderFlows()
		refreshProtoUi()

		el.modeSeg.querySelectorAll('button').forEach(function (b) {
			b.addEventListener('click', function () {
				mode = b.dataset.mode === 'random' ? 'random' : 'batch'
				draft.mode = mode
				saveState()
				syncModeUi()
			})
		})
		el.add.addEventListener('click', function () {
			const field = selectedField()
			if (!field) return
			draft.batch.steps.push({ field: field.key, value: el.valueInput.value.trim(), step: '0' })
			el.valueInput.value = ''
			saveState()
			renderBatchList()
		})
		if (el.batchGap) el.batchGap.addEventListener('change', function () {
			draft.batch.gapMs = Math.max(0, parseInt(el.batchGap.value, 10) || 0)
			el.batchGap.value = String(draft.batch.gapMs)
			saveState()
		})
		el.generate.addEventListener('click', generateRandom)
		;[el.randomCount, el.randomGap, el.randomTimeout].forEach(function (input) {
			input.addEventListener('change', function () {
				draft.random.count = Math.min(500, Math.max(1, parseInt(el.randomCount.value, 10) || 40))
				draft.random.gapMs = Math.max(0, parseInt(el.randomGap.value, 10) || 0)
				draft.random.timeoutMs = Math.max(200, parseInt(el.randomTimeout.value, 10) || 5000)
				el.randomCount.value = String(draft.random.count)
				el.randomGap.value = String(draft.random.gapMs)
				el.randomTimeout.value = String(draft.random.timeoutMs)
				saveState()
			})
		})
		el.randomSeed.addEventListener('change', function () {
			draft.random.seed = el.randomSeed.value.trim()
			saveState()
		})
		if (el.randomNoReadback) el.randomNoReadback.addEventListener('change', function () {
			draft.random.includeNoReadback = el.randomNoReadback.checked
			if (el.randomNoReadWarn) el.randomNoReadWarn.hidden = !el.randomNoReadback.checked
			saveState()
		})
		el.batchVerify.addEventListener('change', function () {
			draft.batchVerify = el.batchVerify.checked
			saveState()
		})
		;[el.timeout, el.retries, el.continueOnFail, el.restore].forEach(function (input) {
			input.addEventListener('change', function () {
				draft.defaults.timeoutMs = Math.max(200, parseInt(el.timeout.value, 10) || 5000)
				draft.defaults.retries = Math.min(5, Math.max(0, parseInt(el.retries.value, 10) || 0))
				draft.defaults.onFailure = el.continueOnFail.checked ? 'continue' : 'stop'
				draft.defaults.restoreOriginals = el.restore.checked
				el.timeout.value = String(draft.defaults.timeoutMs)
				el.retries.value = String(draft.defaults.retries)
				saveState()
			})
		})
		el.flowSave.addEventListener('click', saveNamedFlow)
		el.flowLoad.addEventListener('click', loadNamedFlow)
		el.flowDelete.addEventListener('click', deleteNamedFlow)
		el.export.addEventListener('click', exportFlow)
		el.importFile.addEventListener('change', function () {
			if (el.importFile.files && el.importFile.files[0]) importFlow(el.importFile.files[0])
			el.importFile.value = ''
		})
		el.start.addEventListener('click', function () {
			runAll().catch(function (e) {
				logLine('fail', '异常：' + (e && e.message ? e.message : e))
				setStatus('异常', 'err')
				running = false
				el.start.disabled = !isProtoSupported()
				el.stop.disabled = true
			})
		})
		el.stop.addEventListener('click', stopAll)
		el.stop.disabled = true
		el.counterBtn.addEventListener('click', function () {
			if (running) return
			current = 0
			saveState()
			syncModeUi()
			setStatus('已重置计数为 0', 'ok')
		})
		el.resultCsv.addEventListener('click', function () { exportReport('csv') })
		el.resultJson.addEventListener('click', function () { exportReport('json') })

		const sel = $('serial-protocol-select')
		if (sel) sel.addEventListener('change', refreshProtoUi)
		document.addEventListener('protocol-registry-change', refreshProtoUi)
	}

	function start() {
		Promise.resolve(window.AppPlatform && window.AppPlatform.instanceReady).then(init)
	}
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start)
	} else {
		start()
	}

	window.skTestFlow = {
		runAll: runAll,
		stop: stopAll,
		isProtoSupported: isProtoSupported,
		generateRandom: generateRandom,
	}
})()
