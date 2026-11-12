// 测试流程引擎（纯逻辑）：步骤模型、校验、批量配置与随机读写的生成、执行、统计与导出。
// 只依赖协议契约：fields / queries / buildRead / buildWrite / buildQuery / matchResponse / readField / session。
// 这里不得出现任何协议的帧格式或特判：串口收发与应答匹配由调用方(js/test-flow-panel.js)注入的 io 完成。
// 可在 node 里跑：tests/test-flow.cjs。
;(function (root) {
	'use strict'

	const KINDS = ['read', 'write', 'verify', 'wait', 'send-raw']
	const DEFAULTS = { delayAfterMs: 200, timeoutMs: 5000, retries: 0, onFailure: 'continue', restoreOriginals: true }
	const MAX_STEPS = 500
	const STATUS = {
		success: 'success',
		fail: 'fail',
		timeout: 'timeout',
		mismatch: 'mismatch',
		unsupported: 'unsupported',
		skipped: 'skipped',
	}
	const STATUS_LABEL = {
		success: '成功', fail: '失败', timeout: '超时', mismatch: '不匹配', unsupported: '不支持', skipped: '跳过',
	}

	function toInt(v, fallback, min, max) {
		const n = Math.floor(Number(v))
		if (!Number.isFinite(n)) return fallback
		return Math.min(max, Math.max(min, n))
	}

	function normalizeDefaults(raw) {
		const d = Object.assign({}, DEFAULTS, raw || {})
		return {
			delayAfterMs: toInt(d.delayAfterMs, DEFAULTS.delayAfterMs, 0, 60000),
			timeoutMs: toInt(d.timeoutMs, DEFAULTS.timeoutMs, 200, 120000),
			retries: toInt(d.retries, DEFAULTS.retries, 0, 5),
			onFailure: d.onFailure === 'stop' ? 'stop' : 'continue',
			restoreOriginals: d.restoreOriginals !== false,
		}
	}

	// 步骤：{ kind, field?, value?, raw?, query?, expect?, delayAfterMs, timeoutMs, retries, verify }
	function normalizeStep(raw, index, defaults) {
		const d = normalizeDefaults(defaults)
		const src = raw || {}
		if (KINDS.indexOf(src.kind) === -1) throw new Error('第 ' + (index + 1) + ' 步的类型不支持：' + (src.kind || '(空)'))
		const step = {
			kind: src.kind,
			field: src.field != null ? String(src.field) : '',
			value: src.value == null ? '' : String(src.value),
			raw: src.raw == null ? '' : String(src.raw),
			query: src.query == null ? '' : String(src.query),
			expect: src.expect == null ? '' : String(src.expect),
			delayAfterMs: toInt(src.delayAfterMs, d.delayAfterMs, 0, 60000),
			timeoutMs: toInt(src.timeoutMs, d.timeoutMs, 200, 120000),
			retries: toInt(src.retries, d.retries, 0, 5),
			verify: !!src.verify,
			// 随机生成的写步骤不固定值：执行时按量程取一个与当前值不同的随机值
			randomValue: !!src.randomValue,
		}
		if (step.kind !== 'wait' && step.kind !== 'send-raw' && !step.field) {
			throw new Error('第 ' + (index + 1) + ' 步缺少字段')
		}
		if (step.kind === 'send-raw' && !step.raw && !step.query) {
			throw new Error('第 ' + (index + 1) + ' 步的原始发送既没有 HEX 也没有查询用例')
		}
		return step
	}

	function normalizeFlow(flow) {
		const src = flow || {}
		const defaults = normalizeDefaults(src.defaults)
		const steps = (Array.isArray(src.steps) ? src.steps : []).map(function (s, i) {
			return normalizeStep(s, i, defaults)
		})
		if (steps.length > MAX_STEPS) throw new Error('流程步骤超过上限 ' + MAX_STEPS)
		return {
			name: src.name ? String(src.name).slice(0, 60) : '未命名流程',
			kind: src.kind === 'random' ? 'random' : 'batch',
			seed: src.seed == null ? null : toInt(src.seed, 0, 0, 0x7fffffff),
			steps: steps,
			// send-raw 的查询步骤按 key 引用查询用例；校验与执行都从这份目录找（运行时面板传当前协议的 queries）
			queries: Array.isArray(src.queries) ? src.queries.slice() : [],
			defaults: defaults,
			counter: {
				value: toInt(src.counter && src.counter.value, 0, 0, 1e9),
				step: toInt(src.counter && src.counter.step, 1, 0, 1e6),
			},
		}
	}

	// ---------- 值：{n} 替换、随机取值、解码比对 ----------
	// 产线逐台的计数变量：步骤值里写 {n} 会被替换成 counter.value + counter.step * 台号(从 0 起)
	function substituteVars(value, vars) {
		const s = value == null ? '' : String(value)
		if (!vars) return s
		return s.replace(/\{([a-zA-Z0-9_]+)\}/g, function (m, name) {
			const v = vars[name]
			return v == null ? m : String(v)
		})
	}

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

	function enumValues(field) {
		return (field.enum || []).map(function (e) {
			return typeof e === 'object' && e ? e.value : e
		}).filter(function (v) { return v != null })
	}

	// 在字段的量程 / 步进 / 枚举里取一个值；30% 概率落在边界附近，便于撞到范围边界
	function pickRandomValue(rng, field) {
		if (field.type === 'enum' || field.type === 'bool') {
			const vs = field.type === 'bool' ? [0, 1] : enumValues(field)
			if (!vs.length) return null
			return vs[Math.floor(rng() * vs.length)]
		}
		if (field.type === 'ascii') {
			const len = field.fillLen || 8
			let s = ''
			for (let i = 0; i < Math.min(len, 8); i++) s += String.fromCharCode(48 + Math.floor(rng() * 10))
			return s
		}
		if (field.type === 'bcd') {
			const digits = Math.min(field.fillLen ? field.fillLen * 2 : 8, 10)
			let s = String(1 + Math.floor(rng() * 9))
			for (let i = 1; i < digits; i++) s += String(Math.floor(rng() * 10))
			return s
		}
		const min = field.min != null ? field.min : 0
		const max = field.max != null ? field.max : 255
		const step = field.step || 1
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

	// 取一个与当前值不同的随机值（最多试 12 次，避免只写同一个值看不出效果）
	function newValueFor(rng, field, current) {
		const cur = current == null ? null : String(current)
		for (let i = 0; i < 12; i++) {
			const v = pickRandomValue(rng, field)
			if (v == null) return null
			if (cur == null || String(v) !== cur) return v
		}
		return null
	}

	// 回读比对：bcd 比数字串(去前导零)，ascii 比到第一个 0x00 为止，数值按类型解码后比数值。
	// 每种类型先验字节长度：不够就是无效编码（返回 null），不能拿残缺字节凑出一个错值
	function decodeFieldBytes(bytes, field) {
		if (!bytes || !bytes.length || !field) return null
		const arr = Array.prototype.slice.call(bytes)
		if (field.type === 'bcd') {
			let digits = ''
			for (let i = arr.length - 1; i >= 0; i--) {
				digits += String((arr[i] >> 4) & 0xf) + String(arr[i] & 0xf)
			}
			digits = digits.replace(/^0+(?=\d)/, '')
			return digits === '' ? '0' : digits
		}
		if (field.type === 'ascii') {
			let s = ''
			for (let i = 0; i < arr.length; i++) {
				if (arr[i] === 0) break
				s += String.fromCharCode(arr[i])
			}
			return s
		}
		const NEED = { uint32le: 4, int32le: 4, float32le: 4, float64le: 8, uint16le: 2, int16le: 2, uint8: 1, int8: 1, enum: 1, bool: 1 }
		const need = NEED[field.type]
		if (need != null && arr.length < need) return null
		if (field.type === 'float32le' || field.type === 'float64le') {
			const dv = new DataView(new ArrayBuffer(arr.length))
			for (let i = 0; i < arr.length; i++) dv.setUint8(i, arr[i] & 0xff)
			return field.type === 'float32le' ? dv.getFloat32(0, true) : dv.getFloat64(0, true)
		}
		switch (field.type) {
			case 'uint32le': return (arr[0] | (arr[1] << 8) | (arr[2] << 16) | (arr[3] << 24)) >>> 0
			case 'int32le': return arr[0] | (arr[1] << 8) | (arr[2] << 16) | (arr[3] << 24)
			case 'uint16le': return (arr[0] | (arr[1] << 8)) & 0xffff
			case 'int16le': return ((arr[0] | (arr[1] << 8)) << 16) >> 16
			case 'int8': return (arr[0] << 24) >> 24
			case 'bool': return arr[0] ? 1 : 0
			default: return arr[0] & 0xff
		}
	}

	function sameValue(a, b, field) {
		if (a == null || b == null) return false
		if (field && (field.type === 'bcd' || field.type === 'ascii')) {
			return String(a).replace(/^0+(?=\d)/, '') === String(b).replace(/^0+(?=\d)/, '')
		}
		return Number(a) === Number(b)
	}

	function parseHex(text) {
		const hex = String(text || '').replace(/[^0-9a-fA-F]/g, '')
		if (!hex.length || hex.length % 2 !== 0) return null
		const out = []
		for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16))
		return out
	}

	function hexOf(bytes) {
		return (bytes || []).map(function (b) {
			return ('0' + (b & 0xff).toString(16).toUpperCase()).slice(-2)
		}).join(' ')
	}

	function fieldIndex(fields) {
		const map = new Map()
		;(fields || []).forEach(function (f) { if (f && f.key != null) map.set(String(f.key), f) })
		return map
	}

	// ---------- 校验 ----------
	// 只做静态可判的检查：字段在不在、能不能读/写、枚举取值、HEX 是否合法。真的能不能跑要等设备应答。
	function validateFlow(flow, fields) {
		const idx = fieldIndex(fields)
		const errors = []
		const steps = (flow && flow.steps) || []
		if (!steps.length) errors.push({ index: -1, message: '流程没有步骤' })
		steps.forEach(function (step, i) {
			const at = { index: i, message: '' }
			if (step.kind === 'send-raw') {
				if (step.query) {
					if (!(flow.queries || []).some(function (q) { return q.key === step.query })) {
						at.message = '查询用例不存在：' + step.query
						errors.push(at)
					}
					return
				}
				// 期望 HEX（send-raw 的应答子串过滤）也要是合法字节，运行时才能转成凭证
				if (step.expect && !parseHex(step.expect)) {
					at.message = '期望 HEX 不合法'
					errors.push(at)
					return
				}
				if (!parseHex(step.raw)) {
					at.message = '原始发送的 HEX 不合法'
					errors.push(at)
				}
				return
			}
			if (step.kind === 'wait') return
			const f = idx.get(step.field)
			if (!f) {
				at.message = '字段不存在：' + step.field
				errors.push(at)
				return
			}
			if ((step.kind === 'read' || step.kind === 'verify') && f.read === false) {
				at.message = f.name + ' 不可读'
				errors.push(at)
				return
			}
			if (step.kind === 'write') {
				if (f.write === false) {
					at.message = f.name + ' 不可写'
					errors.push(at)
					return
				}
				// 随机步骤的值在运行时生成，静态校验只查字段可写
				if (step.randomValue) return
				const problem = checkValue(f, step.value)
				if (problem) {
					at.message = f.name + ' ' + problem
					errors.push(at)
				}
			}
		})
		return errors
	}

	function checkValue(field, value) {
		const v = String(value == null ? '' : value)
		if (field.type === 'bcd') {
			if (!/^[0-9]+$/.test(v)) return '须为纯数字'
			if (field.fillLen && v.length > field.fillLen * 2) return '超出字段长度(' + (field.fillLen * 2) + ' 位十进制)'
			return ''
		}
		if (field.type === 'ascii') {
			if (field.fillLen && v.length > field.fillLen) return '超出字段长度(' + field.fillLen + ' 字节)'
			return ''
		}
		const n = Number(v)
		if (!Number.isFinite(n)) return '须为数值'
		if (field.type === 'enum' || field.type === 'bool') {
			const vs = field.type === 'bool' ? [0, 1] : enumValues(field)
			if (vs.length && vs.indexOf(n) === -1) return '不在可选值内'
			return ''
		}
		if (field.min != null && n < field.min) return '小于下限 ' + field.min
		if (field.max != null && n > field.max) return '大于上限 ' + field.max
		return ''
	}

	// ---------- 生成 ----------
	// 批量配置：从可写字段挑若干项，按顺序写；每项可单独设值 / 延时 / 超时 / 重试 / 写后回读
	// 批量导入的规范化（纯函数）：编辑器只能表达「全局间隔 / 全局超时 / 全局重试 / 全局写后回读 / 逐行值与步进」，
	// 逐步定制（延时 / 超时 / 重试 / 随机取值）与非写步骤一律拒绝，避免导入成功却改变行为。
	// 返回 { steps, gapMs, verify, defaults, counter }：gapMs 是流程默认延时，导入方要把它同步到全局间隔
	function normalizeBatchImport(flow) {
		const defaults = normalizeDefaults(flow && flow.defaults)
		const stepsSrc = Array.isArray(flow && flow.steps) ? flow.steps : []
		if (!stepsSrc.length) throw new Error('流程没有步骤')
		const steps = stepsSrc.map(function (s, i) {
			const norm = normalizeStep(s, i, defaults)
			if (norm.kind !== 'write') {
				throw new Error('批量流程仅支持写步骤（第 ' + (i + 1) + ' 步是「' + norm.kind + '」）')
			}
			if (norm.delayAfterMs !== defaults.delayAfterMs) {
				throw new Error('第 ' + (i + 1) + ' 步的延时为自定义值（' + norm.delayAfterMs + 'ms），批量清单只有全局间隔，无法表达')
			}
			if (norm.timeoutMs !== defaults.timeoutMs) {
				throw new Error('第 ' + (i + 1) + ' 步的超时为自定义值（' + norm.timeoutMs + 'ms），批量清单只有全局超时，无法表达')
			}
			if (norm.retries !== defaults.retries) {
				throw new Error('第 ' + (i + 1) + ' 步的重试为自定义值（' + norm.retries + '），批量清单只有全局重试，无法表达')
			}
			if (norm.randomValue) {
				throw new Error('第 ' + (i + 1) + ' 步是随机取值步骤，批量清单无法表达')
			}
			return { field: norm.field, value: norm.value, step: s.step != null ? String(s.step) : '0' }
		})
		const verif = stepsSrc.map(function (s, i) { return normalizeStep(s, i, defaults).verify })
		if (verif.some(function (v) { return v !== verif[0] })) {
			throw new Error('各步骤的「写后回读」不一致，批量清单只有一个全局开关，无法表达')
		}
		return {
			steps: steps,
			gapMs: defaults.delayAfterMs,
			verify: verif[0],
			defaults: defaults,
			counter: flow.counter && typeof flow.counter === 'object' ? flow.counter : null,
		}
	}

	function batchSteps(items, defaults) {
		const d = normalizeDefaults(defaults)
		return (items || []).map(function (it, i) {
			const step = {
				kind: 'write',
				field: String(it.field),
				value: it.value == null ? '' : String(it.value),
				verify: !!it.verify,
				delayAfterMs: it.delayAfterMs == null ? d.delayAfterMs : it.delayAfterMs,
				timeoutMs: it.timeoutMs == null ? d.timeoutMs : it.timeoutMs,
				retries: it.retries == null ? d.retries : it.retries,
			}
			return normalizeStep(step, i, d)
		})
	}

	// 随机读写：读 / 写 / 查询交错，值在量程 / 枚举内随机；写过的字段末尾按比例抽检
	function randomPlan(opts) {
		const o = opts || {}
		const rng = mulberry32(o.seed >>> 0)
		const count = toInt(o.count, 40, 1, MAX_STEPS)
		// 只有显式 random:true 的字段才进随机（缺省与任何非布尔值都不进）：危险字段靠协议目录自己排除，
		// 引擎这里再做一层白名单兜底；「包括无法回读的字段」开关只影响可写性过滤，管不到这一层
		const fields = (o.fields || []).filter(function (f) { return f && f.key && f.random === true })
		const readable = fields.filter(function (f) { return f.read !== false })
		const writable = fields.filter(function (f) { return f.write !== false })
		const queries = o.queries || []
		const steps = []
		const written = []
		if (!readable.length && !writable.length) return { seed: o.seed >>> 0, steps: steps }

		function queryStep(q) {
			return normalizeStep({ kind: 'send-raw', query: q.key, delayAfterMs: o.delayAfterMs, timeoutMs: o.timeoutMs }, steps.length, o)
		}
		function readStep(f) {
			return normalizeStep({ kind: 'read', field: f.key, delayAfterMs: o.delayAfterMs, timeoutMs: o.timeoutMs }, steps.length, o)
		}
		function verifyStep(f) {
			return normalizeStep({ kind: 'verify', field: f.key, delayAfterMs: o.delayAfterMs, timeoutMs: o.timeoutMs }, steps.length, o)
		}

		// 没有查询用例时把读的上限压低：否则随机序列会几乎全是读，写根本没被覆盖
		const hasQueries = queries.length > 0
		const readLimit = hasQueries ? 0.55 : 0.35
		let guard = 0
		while (steps.length < count && guard++ < count * 4) {
			const r = rng()
			// 有待校验的写入时提高抽检概率；紧跟在写后面的抽检必须指向刚写的那个字段
			//（回读比对的是 lastWritten[key]，指到别的字段会让「写→回读」读起来像错指）
			if (written.length && r < 0.22) {
				const last = steps[steps.length - 1]
				const key = last && last.kind === 'write' ? last.field : pick(rng, written)
				const f = fields.filter(function (x) { return x.key === key })[0]
				if (f) { steps.push(verifyStep(f)); continue }
			}
			if (hasQueries && r < 0.35) {
				steps.push(queryStep(pick(rng, queries)))
				continue
			}
			if (readable.length && r < readLimit) {
				steps.push(readStep(pick(rng, readable)))
				continue
			}
			if (!writable.length) {
				if (readable.length) steps.push(readStep(pick(rng, readable)))
				else steps.push(queryStep(pick(rng, queries)))
				continue
			}
			// 写：每次一步，同一字段不连续出现（连写同一参数没有验证价值，还容易把设备调乱）
			const last = steps[steps.length - 1]
			let cands = writable
			if (last && last.kind === 'write') {
				const notLast = writable.filter(function (w) { return w.key !== last.field })
				if (notLast.length) cands = notLast
			}
			const f = pick(rng, cands)
			if (!f) continue
			steps.push(normalizeStep({
				kind: 'write', field: f.key, value: '', verify: !!o.verify, randomValue: true,
				delayAfterMs: o.delayAfterMs, timeoutMs: o.timeoutMs,
			}, steps.length, o))
			if (written.indexOf(f.key) < 0) written.push(f.key)
		}
		// 末尾按 30%~100% 的比例对写过的字段抽检；若最后一步是写，首个抽检先对它——
		// 与循环内的规则一致：紧跟写步骤的回读必须指向同一字段
		if (o.verifyTail !== false) {
			const shuffled = written.slice()
			for (let i = shuffled.length - 1; i > 0; i--) {
				const j = Math.floor(rng() * (i + 1))
				const t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t
			}
			const last = steps[steps.length - 1]
			if (last && last.kind === 'write') {
				const at = shuffled.indexOf(last.field)
				if (at > 0) { shuffled.splice(at, 1); shuffled.unshift(last.field) }
				else if (at === -1) shuffled.unshift(last.field)
			}
			const n = Math.max(1, Math.ceil(shuffled.length * (0.3 + rng() * 0.7)))
			for (let i = 0; i < n && i < shuffled.length; i++) {
				const f = fields.filter(function (x) { return x.key === shuffled[i] })[0]
				if (f) steps.push(verifyStep(f))
			}
		}
		return { seed: o.seed >>> 0, steps: steps.slice(0, MAX_STEPS) }
	}

	// ---------- 执行 ----------
	function statsOf(results, durationMs) {
		const st = { success: 0, fail: 0, timeout: 0, mismatch: 0, unsupported: 0, skipped: 0, total: results.length, durationMs: durationMs || 0 }
		results.forEach(function (r) { if (st[r.status] != null) st[r.status]++ })
		st.failed = st.fail + st.timeout + st.mismatch
		return st
	}

	function describe(step, fields) {
		if (step.kind === 'wait') return '等待 ' + step.delayAfterMs + ' ms'
		if (step.kind === 'send-raw') return step.query ? '查询 ' + step.query : '原始发送 ' + step.raw
		const f = fields && fields.get ? fields.get(step.field) : null
		const name = f ? f.name : step.field
		if (step.kind === 'read') return '读 ' + name
		if (step.kind === 'verify') return '回读比对 ' + name
		return '写 ' + name + ' = ' + step.value + (step.verify ? '（写后回读）' : '')
	}

	// io：由界面注入的串口与协议适配层，见 js/test-flow-panel.js
	async function run(flow, io) {
		const startedAt = io.now()
		const fields = fieldIndex(io.fields)
		const results = []
		const originals = new Map() // field key -> 原值(解码后)
		const lastWritten = new Map() // field key -> 写入值(解码后)
		let stopped = false
		let writeUnclosed = false
		let lastCommAt = io.now()
		let fatal = ''
		let stepStartedAt = null
		const vars = Object.assign({}, io.vars || {})
		// 随机流程按 seed 复现：同一个 seed 生成同样的取值序列
		const rng = mulberry32((flow.seed || 0) >>> 0)
		const steps = flow.steps

		// 只造记录不落库：重试时后一次会覆盖前一次，结果里一步只留一行
		function record(step, index, patch) {
			const r = Object.assign({
				index: index,
				kind: step.kind,
				field: step.field,
				value: step.value,
				status: STATUS.success,
				reason: '',
				requestHex: '',
				responseHex: '',
				durationMs: stepStartedAt == null ? 0 : io.now() - stepStartedAt,
				attempts: 1,
				label: describe(step, fields),
			}, patch || {})
			return r
		}

		function commit(result, index) {
			results.push(result)
			if (io.onStep) io.onStep(result, index, steps.length)
			return result
		}

		// 可被停止打断的延时：停止后不再空等（延时最长 60s，不能让「停止」卡在延时上）
		async function pause(ms) {
			let left = ms
			while (left > 0 && !io.shouldStop()) {
				const slice = Math.min(100, left)
				await io.sleep(slice)
				left -= slice
			}
		}
		async function keepAlive() {
			if (io.shouldStop()) return
			const sess = io.session
			if (!sess || typeof sess.keepalive !== 'function') return
			const idleMs = sess.idleMs || 20000
			if (io.now() - lastCommAt < idleMs) return
			const req = sess.keepalive()
			if (!req) return
			io.log('info', '距上次通信已 ' + Math.round((io.now() - lastCommAt) / 1000) + 's，发送保活查询')
			await io.send(req.bytes, req.request, sess.keepaliveTimeoutMs || 4000)
			lastCommAt = io.now()
			io.log('info', '保活成功')
		}

		async function readOnce(field, timeoutMs) {
			const req = io.buildRead(field)
			if (!req) throw Object.assign(new Error(field.name + ' 没有可用的读请求'), { unsupported: true })
			const res = await io.send(req.bytes, req.request, timeoutMs)
			lastCommAt = io.now()
			const bytes = io.readField(res.frame, field)
			if (!bytes) throw Object.assign(new Error(field.name + ' 应答里没有该字段'), { unsupported: true })
			return { bytes: bytes, value: decodeFieldBytes(bytes, field), res: res }
		}

		// 首次写前必须读到原值：读不到（超时 / 设备未返回 / 已停止）就由调用方放弃这一步——
		// 否则恢复阶段要么跳过（无从恢复）、要么按错误的原值把设备改得更乱
		async function readOriginal(field, timeoutMs) {
			const cur = await readOnce(field, timeoutMs)
			const v = cur.value
			// 原值登记只接受完整有效的解码值：null（字段缺失 / 字节不足）/ NaN / ±Infinity
			// 不能作为恢复基准，否则恢复阶段会静默跳过或写坏设备
			if (v == null || (typeof v === 'number' && !Number.isFinite(v))) {
				throw Object.assign(new Error('原值无效'), { invalid: true })
			}
			originals.set(field.key, { field: field, value: v })
			return v
		}
		async function writeOnce(field, value, timeoutMs, verify) {
			const req = io.buildWrite(field, value)
			const res = await io.send(req.bytes, req.request, timeoutMs)
			lastCommAt = io.now()
			lastWritten.set(field.key, value)
			if (!verify) return { res: res }
			const back = await readOnce(field, timeoutMs)
			return { res: res, read: back }
		}

		async function runStep(step, index) {
			const t0 = io.now()
			const patch = { requestHex: '', responseHex: '' }
			try {
				if (step.kind === 'wait') {
					await pause(step.delayAfterMs)
					return record(step, index, patch)
				}
				if (step.kind === 'send-raw') {
					let req = null
					if (step.query) {
						const q = (io.queries || []).filter(function (x) { return x.key === step.query })[0]
						if (!q) throw Object.assign(new Error('查询用例不存在：' + step.query), { unsupported: true })
						req = io.buildQuery(q)
						if (!req) throw Object.assign(new Error('查询用例无法构帧：' + step.query), { unsupported: true })
						const res = await io.send(req.bytes, req.request, step.timeoutMs)
						lastCommAt = io.now()
						patch.requestHex = hexOf(req.bytes)
						patch.responseHex = res.raw ? hexOf(res.raw) : ''
						return record(step, index, patch)
					}
					const bytes = parseHex(step.raw)
					if (!bytes) throw new Error('原始发送的 HEX 不合法')
					const expectBytes = step.expect ? parseHex(step.expect) : null
					if (step.expect && !expectBytes) throw Object.assign(new Error('期望 HEX 不合法'), { unsupported: true })
					const request = { op: 'raw', expect: step.expect || '', expectBytes: expectBytes }
					const res = await io.send(bytes, request, step.timeoutMs)
					lastCommAt = io.now()
					patch.requestHex = hexOf(bytes)
					patch.responseHex = res && res.raw ? hexOf(res.raw) : ''
					return record(step, index, patch)
				}
				const field = fields.get(step.field)
				if (!field) throw Object.assign(new Error('字段不存在：' + step.field), { unsupported: true })
				if (step.kind === 'read') {
					const got = await readOnce(field, step.timeoutMs)
					patch.requestHex = ''
					patch.responseHex = hexOf(got.bytes)
					patch.readValue = got.value
					return record(step, index, patch)
				}
				if (step.kind === 'write') {
				// 原值必须先读到：读不到（超时 / 设备未返回 / 已停止）这一步就不写，
				// 并把原因记进结果——不写没法校验，也没法在恢复阶段还原
				if (!originals.has(field.key)) {
					try {
						await readOriginal(field, step.timeoutMs)
					} catch (e) {
						if (e && e.unclosed) {
							return record(step, index, { status: STATUS.fail, reason: (e && e.message) || '写入未确认收尾', unclosed: true })
						}
						const why = e && e.timeout ? '读原值超时' : e && e.unsupported ? '设备未返回原值' : (e && e.message) || '读原值失败'
						const status = e && e.timeout ? STATUS.timeout : e && e.unsupported ? STATUS.unsupported : STATUS.fail
						return record(step, index, { status: status, reason: why + '，未写入' })
					}
				}
				let value = substituteVars(step.value, vars)
				if (step.randomValue) {
					// 先拿到当前值，再取一个不同的随机值：只写同一个值看不出设备真的接受了
					const cur = lastWritten.has(field.key) ? lastWritten.get(field.key) : originals.get(field.key).value
					const v = newValueFor(rng, field, cur)
					if (v == null) {
						return record(step, index, { status: STATUS.skipped, reason: '无法生成与当前值不同的随机值' })
					}
					value = String(v)
				}
				const out = await writeOnce(field, value, step.timeoutMs, step.verify)
					patch.responseHex = out.res && out.res.raw ? hexOf(out.res.raw) : ''
					patch.written = value
					if (step.verify && out.read) {
						patch.readValue = out.read.value
						patch.responseHex = hexOf(out.read.bytes)
						if (!sameValue(out.read.value, value, field)) {
							patch.status = STATUS.mismatch
							patch.reason = '写后回读不一致：期望 ' + value + '，实际 ' + out.read.value
						}
					}
					return record(step, index, patch)
				}
				// verify
				const expected = step.expect !== '' ? step.expect : lastWritten.get(field.key)
				const got = await readOnce(field, step.timeoutMs)
				patch.readValue = got.value
				patch.responseHex = hexOf(got.bytes)
				if (expected == null || expected === '') {
					// 没有写入记录就当普通读
					return record(step, index, patch)
				}
				if (!sameValue(got.value, expected, field)) {
					patch.status = STATUS.mismatch
					patch.reason = '期望 ' + expected + '，实际 ' + got.value
				}
				return record(step, index, patch)
			} catch (e) {
				const msg = e && e.message ? e.message : String(e)
				if (e && e.unclosed) {
					return record(step, index, Object.assign(patch, { status: STATUS.fail, reason: msg, unclosed: true, durationMs: io.now() - stepStartedAt }))
				}
				const status = e && e.timeout ? STATUS.timeout : e && e.unsupported ? STATUS.unsupported : STATUS.fail
				return record(step, index, Object.assign(patch, { status: status, reason: msg, durationMs: io.now() - stepStartedAt }))
			}
		}

		// 会话前置：协议自己的连通检查（SEK 的保活查询）。失败就是致命错误，后面不再跑
		if (io.session && typeof io.session.prepare === 'function') {
			try {
				const req = io.session.prepare()
				if (req) {
					await io.send(req.bytes, req.request, flow.defaults.timeoutMs)
					lastCommAt = io.now()
					io.log('pass', '连通检查 OK')
				}
			} catch (e) {
				fatal = '连通检查失败：' + (e && e.message ? e.message : e)
				io.log('fail', fatal)
			}
		}

		for (let i = 0; i < steps.length && !fatal; i++) {
			if (io.shouldStop()) { stopped = true; io.log('warn', '用户停止'); break }
			if (!io.isOpen()) { fatal = '串口已关闭'; io.log('warn', fatal); break }
			const step = steps[i]
			// 重试算在同一步里：耗时包含前面失败的尝试
			stepStartedAt = io.now()
			let attempt = 0
			let result = null
			for (;;) {
				// 停止后不再起新尝试：直接记「用户停止」并跳到恢复阶段
				if (io.shouldStop()) { stopped = true; io.log('warn', '用户停止'); break }
				try {
					await keepAlive()
				} catch (e) {
					fatal = '保活失败：' + (e && e.message ? e.message : e)
					io.log('fail', fatal)
					break
				}
				result = await runStep(step, i)
				if (result.unclosed) break
				if (result.status === STATUS.success || result.status === STATUS.skipped || result.status === STATUS.unsupported) break
				if (attempt >= step.retries) break
				// 停止后不再重试：attempts 只统计真实发生过的尝试
				if (io.shouldStop()) { stopped = true; io.log('warn', '用户停止'); break }
				attempt++
				io.log('warn', '第 ' + (i + 1) + ' 步失败，重试 ' + attempt + '/' + step.retries)
			}
			if (fatal) break
			if (result) result.attempts = attempt + 1
			if (result) commit(result, i)
			if (result && result.unclosed) {
				writeUnclosed = true
				fatal = '写入未确认收尾'
				io.log('fail', fatal)
				break
			}
			if (result && result.status !== STATUS.success && result.status !== STATUS.skipped && result.status !== STATUS.unsupported) {
				if (flow.defaults.onFailure === 'stop') {
					stopped = true
					io.log('warn', '遇失败已停止')
					break
				}
			}
			if (step.kind !== 'wait' && step.delayAfterMs > 0) await pause(step.delayAfterMs)
		}

		// 在飞物理写收尾（有上限）：未确认收尾就不再恢复（写都不可靠），如实报错并交给故障占用
		if (io.settleWrites) {
			const settled = await io.settleWrites()
			if (!settled) {
				writeUnclosed = true
				fatal = '写入未确认收尾'
				io.log('fail', fatal)
			}
		}
		// 恢复原值：只写回真的写过、且读到了原值的字段；停止后仍尝试恢复（串口还开着就恢复）
		const restore = { restored: [], failed: [] }
		if (flow.defaults.restoreOriginals && originals.size && !writeUnclosed) {
			if (!io.isOpen()) {
				restore.failed.push({ field: '(全部)', message: '串口已关闭，未能恢复' })
			} else {
				for (const entry of originals.values()) {
					const f = entry.field
					if (entry.value == null) continue // 原值没读到过，没有可恢复的东西

					try {
						const req = io.buildWrite(f, entry.value)
						await io.send(req.bytes, req.request, flow.defaults.timeoutMs)
						await io.sleep(80)
						const back = await readOnce(f, flow.defaults.timeoutMs)
						if (sameValue(back.value, entry.value, f)) restore.restored.push(f.name)
						else restore.failed.push({ field: f.name, message: '写回后=' + back.value + '，期望 ' + entry.value })
					} catch (e) {
						restore.failed.push({ field: f.name, message: e && e.message ? e.message : String(e) })
					}
				}
			}
			if (restore.restored.length) io.log('pass', '已恢复：' + restore.restored.join('、'))
			restore.failed.forEach(function (x) { io.log('fail', '恢复失败：' + x.field + ' ' + x.message) })
		}

		const durationMs = io.now() - startedAt
		return {
			flow: { name: flow.name, kind: flow.kind, seed: flow.seed, defaults: flow.defaults, counter: flow.counter },
			results: results,
			stats: statsOf(results, durationMs),
			restore: restore,
			stopped: stopped,
			writeUnclosed: writeUnclosed,
			fatal: fatal,
			durationMs: durationMs,
			vars: vars,
		}
	}

	// ---------- 导出 ----------
	function toJSON(report) {
		return JSON.stringify({
			flow: report.flow,
			stats: report.stats,
			stopped: report.stopped,
			fatal: report.fatal,
			restore: report.restore,
			results: report.results.map(function (r) {
				return {
					index: r.index,
					kind: r.kind,
					field: r.field,
					value: r.value,
					label: r.label,
					status: r.status,
					reason: r.reason,
					durationMs: r.durationMs,
					attempts: r.attempts,
					requestHex: r.requestHex,
					responseHex: r.responseHex,
				}
			}),
		}, null, 2)
	}

	function csvCell(v) {
		const s = v == null ? '' : String(v)
		return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
	}

	function toCSV(report) {
		const rows = [['index', 'kind', 'field', 'label', 'status', 'durationMs', 'attempts', 'request', 'response', 'reason'].join(',')]
		report.results.forEach(function (r) {
			rows.push([
				r.index + 1, r.kind, r.field, r.label, STATUS_LABEL[r.status] || r.status,
				r.durationMs, r.attempts, r.requestHex, r.responseHex, r.reason,
			].map(csvCell).join(','))
		})
		return rows.join('\n')
	}

	const lib = {
		KINDS: KINDS,
		DEFAULTS: DEFAULTS,
		STATUS: STATUS,
		STATUS_LABEL: STATUS_LABEL,
		MAX_STEPS: MAX_STEPS,
		normalizeDefaults: normalizeDefaults,
		normalizeStep: normalizeStep,
		normalizeFlow: normalizeFlow,
		validateFlow: validateFlow,
		checkValue: checkValue,
		batchSteps: batchSteps,
		normalizeBatchImport: normalizeBatchImport,
		randomPlan: randomPlan,
		mulberry32: mulberry32,
		pickRandomValue: pickRandomValue,
		newValueFor: newValueFor,
		decodeFieldBytes: decodeFieldBytes,
		sameValue: sameValue,
		substituteVars: substituteVars,
		parseHex: parseHex,
		hexOf: hexOf,
		fieldIndex: fieldIndex,
		statsOf: statsOf,
		describe: describe,
		run: run,
		toJSON: toJSON,
		toCSV: toCSV,
	}

	if (typeof module !== 'undefined' && module.exports) module.exports = lib
	if (root) root.TestFlow = lib
})(typeof window !== 'undefined' ? window : globalThis)
