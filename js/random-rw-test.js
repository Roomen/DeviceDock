// 协议随机读写测试
// 跟随上方协议选择(当前仅 SEK 实现); 不含开猫/复位/阀控;
// 真随机指令序列(读/写/查询可交错、可重复); seed 可复现
;(function () {
	'use strict'

	const IR_IDLE_MS = 20000
	const IR_KEEPALIVE_TIMEOUT = 4000
	const DEFAULT_STEP_TIMEOUT = 5000
	const DEFAULT_GAP_MS = 200
	// ---------- PRNG ----------
	function mulberry32(seed) {
		let t = seed >>> 0
		return function () {
			t += 0x6D2B79F5
			let r = Math.imul(t ^ (t >>> 15), 1 | t)
			r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
			return ((r ^ (r >>> 14)) >>> 0) / 4294967296
		}
	}

	function pick(rng, arr) {
		if (!arr || !arr.length) return null
		return arr[Math.floor(rng() * arr.length)]
	}

	function pickRandomVal(rng, c) {
		if (c.type === 'enum') {
			const vs = (c.enum || []).map(function (e) { return e.value })
			if (!vs.length) return null
			return vs[Math.floor(rng() * vs.length)]
		}
		let min = c.min != null ? c.min : 0
		let max = c.max != null ? c.max : 255
		const step = c.step || 1
		if (step > 1) {
			const n0 = Math.ceil(min / step)
			const n1 = Math.floor(max / step)
			if (n1 < n0) return min
			return (n0 + Math.floor(rng() * (n1 - n0 + 1))) * step
		}
		if (rng() < 0.3) {
			const edges = [min, max]
			if (max > min + 1) edges.push(min + 1, max - 1)
			return edges[Math.floor(rng() * edges.length)]
		}
		return min + Math.floor(rng() * (max - min + 1))
	}

	function numToBytes(val, type) {
		switch (type) {
			case 'uint32le':
				return [val & 0xff, (val >> 8) & 0xff, (val >> 16) & 0xff, (val >> 24) & 0xff]
			case 'uint16le':
				return [val & 0xff, (val >> 8) & 0xff]
			case 'uint8':
			case 'enum':
				return [val & 0xff]
			default:
				return []
		}
	}

	function bytesToNum(bytes, type) {
		if (!bytes || !bytes.length) return null
		switch (type) {
			case 'uint32le':
				return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0
			case 'uint16le':
				return (bytes[0] | (bytes[1] << 8)) & 0xffff
			case 'uint8':
			case 'enum':
				return bytes[0] & 0xff
			default:
				return null
		}
	}

	function hexOf(arr) {
		return (arr || []).map(function (b) {
			return ('0' + (b & 0xff).toString(16).toUpperCase()).slice(-2)
		}).join(' ')
	}

	function sleep(ms) {
		return new Promise(function (r) { setTimeout(r, ms) })
	}

	function fieldKey(c) {
		return c.key || (c.tag + '-' + c.fid)
	}

	// ---------- DOM ----------
	const el = {}
	let running = false
	let stopFlag = false
	let lastCommAt = 0
	let keepingAlive = false
	let tagCache = {}

	function $(id) { return document.getElementById(id) }

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

	function logLine(msg, level) {
		if (!el.log) return
		const div = document.createElement('div')
		div.className = 'sk-rw-log-line sk-rw-' + (level || 'info')
		const t = new Date()
		const ts = [t.getHours(), t.getMinutes(), t.getSeconds()].map(function (n) {
			return ('0' + n).slice(-2)
		}).join(':')
		div.textContent = '[' + ts + '] ' + msg
		el.log.appendChild(div)
		el.log.scrollTop = el.log.scrollHeight
	}

	function clearLog() {
		if (el.log) el.log.innerHTML = ''
		if (el.summary) {
			el.summary.textContent = ''
			el.summary.className = 'sk-rw-summary'
		}
	}

	// ---------- 协议 ----------
	// 字段目录、查询目录与执行器都来自当前协议(v1 契约的 fields / queries / tx)，本文件不写死任何协议数据
	function getActiveProtoId() {
		return window._activeProtocol ||
			(document.getElementById('serial-protocol-select') || {}).value ||
			'sek'
	}

	function getActiveProto() {
		return typeof window.getActiveProtocol === 'function' ? window.getActiveProtocol() : null
	}

	function getActiveProtoName() {
		const p = getActiveProto()
		if (p && p.name) return p.name
		const id = getActiveProtoId()
		return id ? id.toUpperCase() : '?'
	}

	function getCatalog() {
		const p = getActiveProto()
		return {
			fields: p && Array.isArray(p.fields) ? p.fields : [],
			queries: p && Array.isArray(p.queries) ? p.queries : [],
		}
	}

	// 不能跑的具体原因：没注册 / 没字段目录 / 没执行器 / 没查询用例
	function unsupportedReason() {
		const p = getActiveProto()
		if (!p) return '未注册'
		if (!Array.isArray(p.fields) || !p.fields.length) return '未提供字段目录'
		if (!p.tx) return '未提供随机读写执行接口'
		if (!Array.isArray(p.queries) || !p.queries.length) return '未提供查询用例'
		return ''
	}

	function isProtoSupported() {
		return !unsupportedReason()
	}

	function refreshProtoUi() {
		const name = getActiveProtoName()
		const reason = unsupportedReason()
		if (el.titleProto) el.titleProto.textContent = name
		if (el.hint) {
			if (reason) {
				el.hint.textContent = '当前协议「' + name + '」' + reason + '，无法运行随机读写测试'
			} else {
				el.hint.textContent = '协议 ' + name +
					' · 真随机读/写/查询交错 · seed=随机序列种子(相同seed可复现) · 不含开猫/复位/表号/IP/时间'
			}
		}
		if (el.start && !running) el.start.disabled = !!reason
		if (el.card) el.card.classList.toggle('is-disabled', !!reason)
	}

	// ---------- 事务 ----------
	function assertRunning() {
		if (stopFlag) throw new Error('测试已停止')
		if (!window.serialApi || !window.serialApi.isOpen()) throw new Error('串口未打开')
		const p = getActiveProto()
		if (!p || !p.tx) throw new Error('当前协议未提供随机读写执行接口')
	}

	function requireTx() {
		assertRunning()
		return getActiveProto().tx
	}

	function invalidateTag(tag) { delete tagCache[tag] }
	function clearTagCache() { tagCache = {} }

	async function sendQueryRaw(queryId, timeoutMs) {
		const tx = requireTx()
		const res = await tx.queryById(queryId, { timeoutMs: timeoutMs || DEFAULT_STEP_TIMEOUT })
		lastCommAt = Date.now()
		return res
	}

	async function keepAliveIfNeeded() {
		if (stopFlag) throw new Error('测试已停止')
		if (!window.serialApi || !window.serialApi.isOpen()) throw new Error('串口未打开')
		if (keepingAlive) return
		if (Date.now() - lastCommAt < IR_IDLE_MS) return

		keepingAlive = true
		logLine('距上次通信已 ' + Math.round((Date.now() - lastCommAt) / 1000) +
			's, 发送保活查询(阈值' + (IR_IDLE_MS / 1000) + 's)', 'info')
		try {
			await sendQueryRaw(1, IR_KEEPALIVE_TIMEOUT)
			logLine('保活成功', 'info')
		} catch (e) {
			const err = new Error('保活失败, 测试中止: ' + (e.message || e))
			err.fatal = true
			throw err
		} finally {
			keepingAlive = false
		}
	}

	async function doQuery(queryId, timeoutMs) {
		await keepAliveIfNeeded()
		return sendQueryRaw(queryId, timeoutMs)
	}

	async function doWrite(field, valueBytes, timeoutMs) {
		const tx = requireTx()
		await keepAliveIfNeeded()
		const tag = field.tag
		const res = await tx.writeRaw({ tag: tag, id: field.fid, bytes: valueBytes }, { timeoutMs: timeoutMs || DEFAULT_STEP_TIMEOUT })
		lastCommAt = Date.now()
		invalidateTag(tag)
		if (res.tag11 != null && res.tag11 !== 1) {
			const names = (window.SK_RESULT_CODES && window.SK_RESULT_CODES.Tag11) || {}
			const err = new Error('写应答失败 Tag11=' + res.tag11 + '(' + (names[res.tag11] || '?') + ')')
			err.tag11 = res.tag11
			err.skipLike = (res.tag11 === 2 || res.tag11 === 3)
			err.unsupported = (res.tag11 === 2 || res.tag11 === 3)
			throw err
		}
		return res
	}

	// 按 tag 整包查询一次，取该字段的原始字节；同一 tag 的结果在 tagCache 里复用，写入后失效
	async function readField(field, timeoutMs, forceRefresh) {
		const tx = requireTx()
		const tag = field.tag
		if (!forceRefresh && tagCache[tag] && tagCache[tag].values && tagCache[tag].values[field.key]) {
			return tagCache[tag].values[field.key].slice()
		}
		await keepAliveIfNeeded()
		const res = await tx.readTag(tag, { timeoutMs: timeoutMs || DEFAULT_STEP_TIMEOUT })
		lastCommAt = Date.now()
		if (!res) throw new Error('无 Tag' + tag + ' 的整包查询码')
		tagCache[tag] = { values: res.values, at: Date.now() }
		const bytes = res.values[field.key]
		return bytes ? bytes.slice() : null
	}

	// ---------- 随机步骤生成 ----------
	// op: query | write | verify | read
	function buildRandomPlan(rng, catalog, stepCount) {
		const plan = []
		const queries = catalog.queries
		const fields = catalog.fields
		// 记录「最近写入」供 verify 抽检
		const writtenKeys = []

		for (let i = 0; i < stepCount; i++) {
			const r = rng()
			// 有待校验写入时提高 verify 概率
			if (writtenKeys.length && r < 0.22) {
				const key = pick(rng, writtenKeys)
				const f = fields.filter(function (x) { return fieldKey(x) === key })[0]
				if (f) {
					plan.push({ op: 'verify', field: f })
					continue
				}
			}
			if (r < 0.35) {
				// 查询
				plan.push({ op: 'query', q: pick(rng, queries) })
			} else if (r < 0.55) {
				// 只读某字段
				plan.push({ op: 'read', field: pick(rng, fields) })
			} else {
				// 写(可重复写同一字段)
				const f = pick(rng, fields)
				const n = 1 + Math.floor(rng() * 3) // 连续写 1~3 次
				for (let k = 0; k < n && plan.length < stepCount; k++) {
					plan.push({ op: 'write', field: f })
					const key = fieldKey(f)
					if (writtenKeys.indexOf(key) < 0) writtenKeys.push(key)
				}
			}
		}
		// 末尾对写过的字段抽 30%~100% 做 verify
		const shuffled = writtenKeys.slice()
		for (let i = shuffled.length - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1))
			const t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t
		}
		const nVerify = Math.max(1, Math.ceil(shuffled.length * (0.3 + rng() * 0.7)))
		for (let i = 0; i < nVerify && i < shuffled.length; i++) {
			const f = fields.filter(function (x) { return fieldKey(x) === shuffled[i] })[0]
			if (f) plan.push({ op: 'verify', field: f })
		}
		return plan
	}

	// ---------- 单步执行 ----------
	// originals: { key: { field, bytes } } 首次读到的原值, 用于结束恢复
	// lastWrite: { key: bytes } 最近一次写入期望
	async function runStep(step, ctx) {
		const timeoutMs = ctx.timeoutMs
		const gapMs = ctx.gapMs
		const rng = ctx.rng

		if (step.op === 'query') {
			const q = step.q
			const res = await doQuery(q.queryId, timeoutMs)
			if (q.expectTag != null && !requireTx().hasTag(res.frame, q.expectTag)) {
				return { status: 'unsupported', detail: '响应无 Tag' + q.expectTag }
			}
			return { status: 'pass', detail: '查询OK' }
		}

		const f = step.field
		const key = fieldKey(f)
		const label = f.name + '(T' + f.tag + '-ID' + f.fid + ')'

		if (step.op === 'read') {
			const raw = await readField(f, timeoutMs, true)
			if (!raw || !raw.length) {
				return { status: 'unsupported', detail: label + ' 设备未返回该字段' }
			}
			if (!ctx.originals[key]) {
				ctx.originals[key] = { field: f, bytes: raw.slice() }
			}
			return { status: 'pass', detail: label + ' 读=' + bytesToNum(raw, f.type) + ' [' + hexOf(raw) + ']' }
		}

		if (step.op === 'write') {
			// 首次写前记下原值
			if (!ctx.originals[key]) {
				const orig = await readField(f, timeoutMs, false)
				if (!orig || !orig.length) {
					return { status: 'unsupported', detail: label + ' 无法读原值, 可能不支持' }
				}
				ctx.originals[key] = { field: f, bytes: orig.slice() }
			}
			const cur = ctx.lastWrite[key]
				? bytesToNum(ctx.lastWrite[key], f.type)
				: bytesToNum(ctx.originals[key].bytes, f.type)
			let newVal = null
			for (let t = 0; t < 12; t++) {
				const v = pickRandomVal(rng, f)
				if (v != null && v !== cur) { newVal = v; break }
			}
			if (newVal == null) {
				return { status: 'skip', detail: label + ' 无法生成新随机值' }
			}
			const newBytes = numToBytes(newVal, f.type === 'enum' ? 'enum' : f.type)
			try {
				await doWrite(f, newBytes, timeoutMs)
			} catch (e) {
				if (e.unsupported || e.skipLike) {
					return { status: 'unsupported', detail: label + ' ' + e.message }
				}
				throw e
			}
			ctx.lastWrite[key] = newBytes.slice()
			if (gapMs > 0) await sleep(gapMs)
			return { status: 'pass', detail: label + ' 写=' + newVal + ' [' + hexOf(newBytes) + ']' }
		}

		if (step.op === 'verify') {
			const expected = ctx.lastWrite[key]
			if (!expected) {
				// 无写入记录则当 read
				const raw = await readField(f, timeoutMs, true)
				if (!raw || !raw.length) {
					return { status: 'unsupported', detail: label + ' 设备未返回该字段' }
				}
				return { status: 'pass', detail: label + ' 读检=' + bytesToNum(raw, f.type) }
			}
			const raw = await readField(f, timeoutMs, true)
			if (!raw || !raw.length) {
				return { status: 'fail', detail: label + ' 校验读回为空' }
			}
			const ok = requireTx().bytesEqual(raw, expected)
			const detail = label + ' 期望=' + bytesToNum(expected, f.type) +
				' 实际=' + bytesToNum(raw, f.type) +
				' [' + hexOf(expected) + ' vs ' + hexOf(raw) + ']'
			return ok
				? { status: 'pass', detail: '校验OK ' + detail }
				: { status: 'fail', detail: '校验失败 ' + detail }
		}

		return { status: 'skip', detail: '未知步骤' }
	}

	async function restoreAll(originals, timeoutMs) {
		const keys = Object.keys(originals)
		const fails = []
		const oks = []
		for (let i = 0; i < keys.length; i++) {
			if (stopFlag) break
			if (!window.serialApi || !window.serialApi.isOpen()) break
			const o = originals[keys[i]]
			const f = o.field
			try {
				await doWrite(f, o.bytes, timeoutMs)
				await sleep(80)
				const rb = await readField(f, timeoutMs, true)
				if (rb && requireTx().bytesEqual(rb, o.bytes)) {
					oks.push(f.name)
				} else {
					fails.push(f.name + ' 写回后=' + hexOf(rb) + ' 期望=' + hexOf(o.bytes))
				}
			} catch (e) {
				fails.push(f.name + ' ' + (e.message || e))
			}
		}
		return { oks: oks, fails: fails }
	}

	function printReport(lists, seed, stopped) {
		logLine('════════ 测试报告' + (stopped ? '(已停止)' : '') + ' seed=' + seed + ' ════════', 'info')

		function dump(title, arr, level) {
			if (!arr.length) {
				logLine(title + ': (无)', 'info')
				return
			}
			logLine(title + ' (' + arr.length + '):', level)
			arr.forEach(function (s) { logLine('  · ' + s, level) })
		}

		dump('失败', lists.fail, 'fail')
		dump('不支持', lists.unsupported, 'skip')
		dump('跳过', lists.skip, 'skip')
		if (lists.restoreFail.length) {
			dump('⚠ 恢复原值失败(请人工确认)', lists.restoreFail, 'fail')
		}
		logLine('通过 ' + lists.passCount +
			' / 失败 ' + lists.fail.length +
			' / 不支持 ' + lists.unsupported.length +
			' / 跳过 ' + lists.skip.length +
			' / 恢复失败 ' + lists.restoreFail.length, lists.fail.length || lists.restoreFail.length ? 'fail' : 'pass')
	}

	// ---------- 主流程 ----------
	async function runAll() {
		if (running) return
		const reason = unsupportedReason()
		if (reason) {
			setStatus('当前协议不支持', 'err')
			logLine('协议「' + getActiveProtoName() + '」' + reason, 'fail')
			return
		}
		if (!window.serialApi || !window.serialApi.isOpen()) {
			setStatus('请先打开串口', 'err')
			return
		}

		running = true
		stopFlag = false
		clearLog()
		// 整轮测试钉扎主发口: 期间切主发口被拦, 恢复字段不会写到另一台设备
		window.serialApi.pinSession(window.serialApi.getActiveSendSid())
		try {
			el.start.disabled = true
			el.stop.disabled = false
			setStatus('测试中…', 'run')
	
			const requestedSteps = parseInt(el.steps.value, 10)
			const stepsN = Number.isFinite(requestedSteps) ? Math.min(500, Math.max(5, requestedSteps)) : 40
			el.steps.value = String(stepsN)
			const gapMs = Math.max(0, parseInt(el.gap.value, 10) || DEFAULT_GAP_MS)
			const timeoutMs = Math.max(1000, parseInt(el.timeout.value, 10) || DEFAULT_STEP_TIMEOUT)
			let seed = parseInt(el.seed.value, 10)
			if (isNaN(seed)) {
				seed = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0
				el.seed.value = String(seed)
			}
			const continueOnFail = !!(el.continueOnFail && el.continueOnFail.checked)
			const doRestore = !(el.restore && !el.restore.checked)
			const rng = mulberry32(seed)
			const protoName = getActiveProtoName()
			const catalog = getCatalog()
	
			const plan = buildRandomPlan(rng, catalog, stepsN)
			const total = plan.length
			let done = 0
	
			const lists = {
				fail: [],
				skip: [],
				unsupported: [],
				restoreFail: [],
				passCount: 0
			}
			const ctx = {
				rng: rng,
				timeoutMs: timeoutMs,
				gapMs: gapMs,
				originals: {},
				lastWrite: {}
			}
	
			logLine('开始随机测试 协议=' + protoName + ' seed=' + seed + ' 步数=' + total +
				' 恢复原值=' + (doRestore ? '是' : '否'), 'info')
			logLine('seed=伪随机种子, 相同 seed 会生成相同指令序列, 便于复现问题', 'info')
			logLine('指令模式: 查询/读字段/写字段(可连写1~3次)/校验 随机交错', 'info')
			logLine('红外保活阈值 ' + (IR_IDLE_MS / 1000) + 's · 不含开猫/复位/表号/IP/时间/密钥', 'info')
	
			requireTx().reset()
			clearTagCache()
			lastCommAt = Date.now()
	
			// 先做一次连通查询
			try {
				await doQuery(1, timeoutMs)
				logLine('连通检查 OK', 'pass')
			} catch (e) {
				logLine('连通检查失败: ' + e.message, 'fail')
				lists.fail.push('连通检查: ' + e.message)
				printReport(lists, seed, true)
				finishRun(true, lists, seed, 0, total)
				return
			}
	
			for (let i = 0; i < plan.length; i++) {
				if (stopFlag) {
					logLine('用户停止', 'warn')
					break
				}
				if (!window.serialApi || !window.serialApi.isOpen()) {
					logLine('串口已关闭, 测试中止', 'warn')
					stopFlag = true
					break
				}
	
				const step = plan[i]
				const opName = step.op + (step.q ? ':' + step.q.name : '') +
					(step.field ? ':' + step.field.name : '')
				const label = '[' + (i + 1) + '/' + total + '] ' + opName
				setStatus(label, 'run')
				let result
				const t0 = Date.now()
				try {
					result = await runStep(step, ctx)
				} catch (e) {
					result = { status: 'fail', detail: e.message || String(e), fatal: !!(e && e.fatal) }
					if (stopFlag || result.fatal ||
						/串口未打开|测试已停止|保活失败/.test(result.detail || '')) {
						lists.fail.push(label + ' — ' + result.detail)
						logLine('✗ ' + label + ' ' + result.detail, 'fail')
						logLine('致命错误, 测试中止', 'warn')
						stopFlag = true
						break
					}
				}
				const ms = Date.now() - t0
				done++
				setProgress(done, total)
	
				const line = label + ' (' + ms + 'ms) ' + (result.detail || '')
				if (result.status === 'pass') {
					lists.passCount++
					logLine('✓ ' + line, 'pass')
				} else if (result.status === 'unsupported') {
					lists.unsupported.push(line)
					logLine('⊘ ' + line, 'skip')
				} else if (result.status === 'skip') {
					lists.skip.push(line)
					logLine('○ ' + line, 'skip')
				} else {
					lists.fail.push(line)
					logLine('✗ ' + line, 'fail')
					if (!continueOnFail) {
						logLine('遇失败已停止', 'warn')
						break
					}
				}
	
				if (gapMs > 0) await sleep(gapMs)
			}
	
			// 恢复所有改动过的字段
			if (doRestore && Object.keys(ctx.originals).length &&
				window.serialApi && window.serialApi.isOpen() && !stopFlag) {
				logLine('恢复已改写字段 (' + Object.keys(ctx.originals).length + ' 项)…', 'info')
				const rr = await restoreAll(ctx.originals, timeoutMs)
				if (rr.oks.length) logLine('已恢复: ' + rr.oks.join(', '), 'pass')
				rr.fails.forEach(function (s) {
					lists.restoreFail.push(s)
					logLine('⚠ 恢复失败: ' + s, 'fail')
				})
			} else if (doRestore && stopFlag && Object.keys(ctx.originals).length) {
				logLine('已停止, 仍尝试恢复已改写字段…', 'warn')
				if (window.serialApi && window.serialApi.isOpen()) {
					const rr = await restoreAll(ctx.originals, timeoutMs)
					rr.fails.forEach(function (s) {
						lists.restoreFail.push(s)
						logLine('⚠ 恢复失败: ' + s, 'fail')
					})
					if (rr.oks.length) logLine('已恢复: ' + rr.oks.join(', '), 'pass')
				}
			}
	
			printReport(lists, seed, stopFlag)
			finishRun(stopFlag, lists, seed, done, total)
		} finally {
			window.serialApi.unpinSession()
		}
	}

	function finishRun(stopped, lists, seed, done, total) {
		const sum = (stopped ? '已停止' : '完成') +
			': 通过' + lists.passCount +
			' 失败' + lists.fail.length +
			' 不支持' + lists.unsupported.length +
			' 跳过' + lists.skip.length +
			' 恢复失败' + lists.restoreFail.length +
			' (seed=' + seed + ')'
		if (el.summary) {
			el.summary.textContent = sum
			el.summary.className = 'sk-rw-summary' +
				(lists.fail.length || lists.restoreFail.length ? ' is-fail' : ' is-pass')
		}
		setStatus(stopped ? '已停止' : '完成',
			stopped ? 'warn' : (lists.fail.length ? 'err' : 'ok'))
		setProgress(done, total)
		running = false
		el.start.disabled = !isProtoSupported()
		el.stop.disabled = true
	}

	function stopAll() {
		stopFlag = true
		setStatus('正在停止…', 'warn')
		const p = getActiveProto()
		if (p && p.tx && typeof p.tx.cancel === 'function') {
			try { p.tx.cancel('测试已停止') } catch (e) { /* */ }
		}
	}

	// ---------- init ----------
	function init() {
		el.card = $('sk-rw-card')
		el.start = $('sk-rw-start')
		el.stop = $('sk-rw-stop')
		el.steps = $('sk-rw-steps')
		el.gap = $('sk-rw-gap')
		el.timeout = $('sk-rw-timeout')
		el.seed = $('sk-rw-seed')
		el.continueOnFail = $('sk-rw-continue')
		el.restore = $('sk-rw-restore')
		el.progress = $('sk-rw-progress-bar')
		el.status = $('sk-rw-status')
		el.log = $('sk-rw-log')
		el.summary = $('sk-rw-summary')
		el.hint = $('sk-rw-case-hint')
		el.titleProto = $('sk-rw-proto-name')
		if (!el.start) return

		el.start.addEventListener('click', function () {
			runAll().catch(function (e) {
				logLine('异常: ' + e.message, 'fail')
				setStatus('异常', 'err')
				running = false
				el.start.disabled = !isProtoSupported()
				el.stop.disabled = true
			})
		})
		el.stop.addEventListener('click', stopAll)
		el.stop.disabled = true

		const sel = $('serial-protocol-select')
		if (sel) {
			sel.addEventListener('change', function () {
				clearTagCache()
				refreshProtoUi()
			})
		}
		refreshProtoUi()
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init)
	} else {
		init()
	}

	window.skRandomRw = {
		runAll: runAll,
		stop: stopAll,
		isProtoSupported: isProtoSupported,
	}
})()
