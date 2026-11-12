// 曲线面板（工作台面板 curves）：把 js/curves.js 采集的序列画成图。
// 宿主统一画图：协议只给 fields(名称/单位/chart) 与 metrics(frame) 数值点，这里不认任何协议。
// 颜色只编码通道（单路 accent、A 青、B 琥珀，都读 CSS 变量），同一路多个字段靠线型区分；主题切换时重建图表。
;(function () {
	'use strict'

	const C = window.SerialCurvesCore
	const S = window.SerialCurves
	if (!C || !S) {
		console.warn('curves-panel: 缺少 curves-core.js / curves.js')
		return
	}

	const $ = function (id) { return document.getElementById(id) }

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

	const el = {}
	let chart = null
	let chartSig = ''
	let fieldCache = {}
	let popOpen = false
	let readoutTimer = null
	const seriesMeta = [] // 当前图上的序列，供读数与 CSV 使用

	// ---------- 主题令牌：颜色只从 CSS 变量取，不写裸色值 ----------
	function tokens() {
		const cs = getComputedStyle(document.documentElement)
		const v = function (name) { return (cs.getPropertyValue(name) || '').trim() }
		return {
			a: v('--ch-a'),
			b: v('--ch-b'),
			s: v('--ch-s'),
			accent: v('--accent'),
			text: v('--text-secondary'),
			muted: v('--text-muted'),
			grid: v('--border-light'),
			axis: v('--border-color'),
			mono: v('--font-mono') || 'monospace',
			micro: v('--fs-micro') || '11px',
			small: v('--fs-small') || '12px',
		}
	}

	function laneColor(sid, t) {
		if (sid === 'A') return t.a
		if (sid === 'B') return t.b
		return t.s
	}

	// ---------- 选择 ----------
	function refreshFieldCache() {
		fieldCache = {}
		S.lanes().forEach(function (sid) { fieldCache[sid] = S.fieldsFor(sid) })
	}

	function defaultSelection() {
		const out = []
		S.lanes().forEach(function (sid) {
			;(fieldCache[sid] || []).forEach(function (f) {
				if (f.chart && f.hasMetrics) out.push(sid + '|' + f.key)
			})
		})
		return out
	}

	function currentSelection() {
		const saved = S.selected()
		if (saved) return saved
		return defaultSelection()
	}

	function selectionItems() {
		const lanes = S.lanes()
		const out = []
		currentSelection().forEach(function (spec) {
			const i = spec.indexOf('|')
			if (i < 0) return
			const sid = spec.slice(0, i)
			const key = spec.slice(i + 1)
			if (lanes.indexOf(sid) === -1) return
			const f = (fieldCache[sid] || []).filter(function (x) { return x.key === key })[0]
			out.push({ sid: sid, key: key, name: f ? f.name : key, unit: f ? f.unit : '', hasMetrics: f ? f.hasMetrics : true })
		})
		return out
	}

	// ---------- 图表 ----------
	function destroyChart() {
		if (chart) {
			try { chart.destroy() } catch (e) { /* */ }
			chart = null
		}
		chartSig = ''
		el.plot.textContent = ''
		if (el.legend) {
			el.legend.textContent = ''
			el.legend.hidden = true
		}
	}

	function chartData(items) {
		const list = items.map(function (it) { return S.store.get(it.sid, it.key) }).filter(Boolean)
		const aligned = C.alignSeries(list)
		// uPlot 的 time 轴按「秒」解释 x：序列内部存毫秒，画图时换算；读数 / 导出仍用毫秒
		return { list: list, data: [aligned.t.map(function (ms) { return ms / 1000 })].concat(aligned.cols), aligned: aligned }
	}

	function buildChart(items) {
		const t = tokens()
		const w = el.plot.clientWidth
		const h = el.plot.clientHeight
		if (!window.uPlot || !w || !h) return null
		destroyChart()
		const grouped = C.groupAxes(items, function (it) { return it.unit })
		const axisOf = new Map()
		grouped.axes.forEach(function (ax, idx) {
			ax.items.forEach(function (it) { axisOf.set(it.sid + '|' + it.key, idx) })
		})
		const laneIndex = {}
		const series = [{}]
		seriesMeta.length = 0
		items.forEach(function (it) {
			if (!axisOf.has(it.sid + '|' + it.key)) return
			// 同一路选了几个字段：第一个实线、后面依次换虚线，色相仍只代表通道；图例同步这套线型
			laneIndex[it.sid] = (laneIndex[it.sid] || 0)
			const nth = laneIndex[it.sid]++
			const dash = nth === 0 ? [] : nth === 1 ? [6, 4] : [2, 3]
			const axis = axisOf.get(it.sid + '|' + it.key)
			const meta = {
				sid: it.sid, key: it.key, name: it.name, unit: it.unit,
				axis: axis, nth: nth, color: laneColor(it.sid, t),
				label: (S.lanes().length > 1 ? S.laneName(it.sid) + ' ' : '') + it.name + (it.unit ? ' (' + it.unit + ')' : ''),
			}
			seriesMeta.push(meta)
			series.push({
				label: meta.label,
				stroke: meta.color,
				width: 1.5,
				dash: dash,
				scale: axis === 0 ? 'y' : 'y2',
				points: { show: false },
				value: function (u, v) { return v == null ? '—' : C.formatNumber(v) },
			})
		})
		// 横轴 24 小时制本地时间；uPlot 的 x 是秒，格式化前换回毫秒。纵轴单位不再用旋转标签（会与刻度数字
		// 重叠），改在图例条上给「左轴 / 右轴」单位徽标
		const xSpan = function (u) {
			const x = u.data[0] || []
			return x.length ? (x[x.length - 1] - x[0]) * 1000 : 0
		}
		const axes = [{
			stroke: t.muted,
			grid: { stroke: t.grid, width: 1 },
			ticks: { stroke: t.axis, width: 1 },
			font: t.micro + ' ' + t.mono,
			size: 30,
		}, {
			scale: 'y',
			stroke: t.muted,
			grid: { stroke: t.grid, width: 1 },
			ticks: { stroke: t.axis, width: 1 },
			font: t.micro + ' ' + t.mono,
			size: 46,
		}]
		if (grouped.axes[1]) {
			axes.push({
				scale: 'y2',
				side: 1,
				stroke: t.muted,
				grid: { stroke: t.grid, width: 0 },
				ticks: { stroke: t.axis, width: 1 },
				font: t.micro + ' ' + t.mono,
				size: 46,
			})
		}
		axes[0].values = function (u, splits) {
			const span = xSpan(u)
			return splits.map(function (v) { return C.formatAxisTime(v * 1000, span) })
		}
		const opts = {
			width: w,
			height: h,
			padding: [8, 8, 0, 0],
			series: series,
			axes: axes,
			scales: { x: { time: true } },
			legend: { show: false },
			cursor: {
				drag: { x: true, y: false, setScale: true },
				points: { show: false },
			},
			hooks: {
				setCursor: [function (u) {
					const idx = u.cursor.idx
					renderReadout(u, idx)
				}],
				setScale: [function () { syncZoomButton() }],
			},
		}
		const built = chartData(items)
		chart = new window.uPlot(opts, built.data, el.plot)
		chartSig = sigOf(items)
		renderReadout(chart, null)
		renderLegend(grouped)
		syncZoomButton()
		return chart
	}

	function sigOf(items) {
		const t = tokens()
		return items.map(function (it) { return it.sid + '|' + it.key }).join(',') + '#' +
			t.a + t.b + t.s + t.grid + t.mono
	}

	function syncZoomButton() {
		if (!el.reset) return
		const zoomed = !!(chart && chart.scales && chart.scales.x && chart.scales.x.min != null)
		el.reset.disabled = !zoomed
	}

	// 悬停读数：时间 + 每个序列的当前值，等宽数字
	function renderReadout(u, idx) {
		if (!el.readout) return
		if (readoutTimer != null) {
			clearTimeout(readoutTimer)
			readoutTimer = null
		}
		el.readout.textContent = ''
		if (!u || idx == null || !u.data || !u.data[0] || u.data[0][idx] == null) {
			const hint = mk('span', 'mdn-curve-readout-hint', '悬停读取数值 · 拖拽框选缩放')
			el.readout.appendChild(hint)
			return
		}
		const ts = u.data[0][idx] * 1000 // x 轴是秒
		const span = (u.data[0][u.data[0].length - 1] - u.data[0][0]) * 1000
		el.readout.appendChild(mk('span', 'mdn-curve-readout-time', C.formatHoverTime(ts, span)))
		seriesMeta.forEach(function (m, i) {
			const cell = mk('span', 'mdn-curve-readout-cell')
			const swatch = mk('span', 'mdn-curve-swatch')
			swatch.style.background = m.color
			const value = u.data[i + 1] ? u.data[i + 1][idx] : null
			cell.append(swatch, mk('span', 'mdn-curve-readout-label', m.label), mk('span', 'mdn-curve-readout-value', C.formatNumber(value)))
			el.readout.appendChild(cell)
		})
	}

	// 图例：字段名 + 单位 + 路标，同一路多字段用线型区分（实线 / 虚线 / 点线），颜色只编码通道；
	// 纵轴单位在轴上不再画旋转标签，这里给「左轴 / 右轴」单位徽标
	function renderLegend(grouped) {
		if (!el.legend) return
		el.legend.textContent = ''
		const units = ['左轴', '右轴']
		seriesMeta.forEach(function (m) {
			const chip = mk('span', 'mdn-curve-legend-chip')
			const swatch = mk('span', 'mdn-curve-swatch')
			swatch.style.color = m.color
			if (m.nth === 1) swatch.classList.add('mdn-curve-swatch--dash')
			if (m.nth >= 2) swatch.classList.add('mdn-curve-swatch--dot')
			const laneTag = S.lanes().length > 1 ? S.laneName(m.sid) : ''
			chip.append(swatch, mk('span', 'mdn-curve-legend-lane', laneTag),
				mk('span', 'mdn-curve-legend-label', m.name + (m.unit ? ' (' + m.unit + ')' : '')))
			el.legend.appendChild(chip)
		})
		if (grouped && grouped.axes.length) {
			grouped.axes.forEach(function (ax, i) {
				if (!ax.unit) return
				const chip = mk('span', 'mdn-curve-legend-unit', units[i] + ' ' + ax.unit)
				el.legend.appendChild(chip)
			})
		}
		el.legend.hidden = !seriesMeta.length
	}

	function render() {
		if (!el.pane.classList.contains('active')) return
		refreshFieldCache()
		const items = selectionItems()
		updateFieldButton(items)
		const drawable = items.filter(function (it) { return it.hasMetrics })
		const anyData = drawable.some(function (it) { return S.store.get(it.sid, it.key) })
		updateEmpty(drawable, anyData)
		if (!drawable.length) {
			destroyChart()
			seriesMeta.length = 0
			renderReadout(null, null)
			return
		}
		const sig = sigOf(drawable)
		if (!chart || chartSig !== sig || chart.width !== el.plot.clientWidth || chart.height !== el.plot.clientHeight) {
			if (!buildChart(drawable)) return
		}
		const built = chartData(drawable)
		chart.setData(built.data)
	}

	function updateEmpty(items, anyData) {
		if (!el.empty) return
		if (!items.length) {
			el.empty.textContent = '当前协议没有可画的字段：协议需要用 fields 给出字段目录，并用 metrics(frame) 返回数值点'
			el.empty.hidden = false
			return
		}
		const noMetrics = items.filter(function (it) { return !it.hasMetrics })
		if (noMetrics.length === items.length) {
			el.empty.textContent = '当前协议没有 metrics(frame)：曲线只能由协议提供的数值点驱动'
			el.empty.hidden = false
			return
		}
		el.empty.textContent = anyData ? '' : '等待数据：收到可解析的帧后自动出点'
		el.empty.hidden = !!anyData
	}

	function updateFieldButton(items) {
		if (!el.fields) return
		const n = items.length
		el.fieldsLabel.textContent = n ? '字段 ' + n : '字段'
		el.fields.setAttribute('aria-expanded', popOpen ? 'true' : 'false')
	}

	// ---------- 字段选择浮层 ----------
	function renderPop() {
		if (!el.pop) return
		el.pop.textContent = ''
		const lanes = S.lanes()
		const sel = currentSelection()
		if (lanes.length > 1) {
			el.pop.appendChild(mk('div', 'mdn-curve-pop-head', 'A / B 同一字段会自动对比'))
		}
		lanes.forEach(function (sid) {
			const fields = fieldCache[sid] || []
			const group = mk('div', 'mdn-curve-pop-group')
			const head = mk('div', 'mdn-curve-pop-title')
			head.append(mk('span', 'mdn-curve-pop-lane', lanes.length > 1 ? S.laneName(sid) : '字段'))
			head.append(mk('span', 'mdn-curve-pop-proto', S.protoName(sid)))
			group.appendChild(head)
			if (!fields.length) {
				group.appendChild(mk('div', 'mdn-curve-pop-empty', '当前协议未提供字段目录'))
			}
			fields.forEach(function (f) {
				const spec = sid + '|' + f.key
				const label = mk('label', 'ctl-chip ctl-chip--micro')
				const cb = document.createElement('input')
				cb.type = 'checkbox'
				cb.checked = sel.indexOf(spec) !== -1
				cb.disabled = !f.hasMetrics
				cb.addEventListener('change', function () {
					const next = currentSelection().filter(function (x) { return x !== spec })
					if (cb.checked) next.push(spec)
					S.setSelected(next)
					render()
				})
				label.append(cb, mk('span', '', f.name + (f.unit ? ' · ' + f.unit : '')))
				if (f.chart) label.title = '协议标记为默认显示'
				group.appendChild(label)
			})
			el.pop.appendChild(group)
		})
		const foot = mk('div', 'mdn-curve-pop-foot')
		const reset = btn('btn btn-sm btn-outline-secondary', '恢复默认')
		reset.addEventListener('click', function () {
			S.setSelected(defaultSelection())
			render()
			renderPop()
		})
		foot.appendChild(reset)
		el.pop.appendChild(foot)
	}

	function togglePop(open) {
		popOpen = open != null ? !!open : !popOpen
		if (!el.pop) return
		el.pop.hidden = !popOpen
		if (popOpen) renderPop()
		updateFieldButton(selectionItems())
	}

	// ---------- 导出 ----------
	function download(name, text) {
		const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = name
		document.body.appendChild(a)
		a.click()
		document.body.removeChild(a)
		URL.revokeObjectURL(url)
	}

	function exportCsv() {
		const items = selectionItems().filter(function (it) { return it.hasMetrics })
		const list = items.map(function (it) { return S.store.get(it.sid, it.key) }).filter(Boolean)
		if (!list.length) {
			if (window.AppDialog) window.AppDialog.alert('还没有数据可以导出')
			return
		}
		const csv = C.toCSV(list, {
			laneName: function (sid) { return S.lanes().length > 1 ? S.laneName(sid) : '' },
			formatTime: function (ts) { return new Date(ts).toISOString() },
		})
		const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
		download('curves-' + stamp + '.csv', csv)
	}

	// ---------- 构建 ----------
	function build() {
		const pane = mk('div', 'tab-pane d-flex flex-column wb-pane wb-curves')
		pane.id = 'wb-pane-curves'
		pane.setAttribute('role', 'tabpanel')

		const bar = mk('div', 'mdn-curve-bar')
		const fields = btn('mdn-curve-fields')
		fields.setAttribute('aria-haspopup', 'true')
		fields.setAttribute('aria-expanded', 'false')
		const fieldsLabel = mk('span', 'mdn-curve-fields-label', '字段')
		fields.append(icon('icon-chart-line'), fieldsLabel)
		const pause = btn('ctl-toggle', '')
		pause.id = 'mdn-curve-pause'
		pause.setAttribute('aria-pressed', 'false')
		pause.append(icon('icon-pause'), mk('span', '', '暂停'))
		const clear = btn('btn btn-sm btn-outline-secondary', '清空')
		const reset = btn('btn btn-sm btn-outline-secondary', '复位缩放')
		reset.disabled = true
		const capWrap = mk('label', 'mdn-curve-cap')
		const cap = document.createElement('input')
		cap.type = 'number'
		cap.min = String(C.CAP_MIN)
		cap.max = String(C.CAP_MAX)
		cap.step = '100'
		cap.value = String(S.capacity())
		capWrap.append(mk('span', '', '每序列'), cap, mk('span', '', '点'))
		const csv = btn('btn btn-sm btn-outline-secondary', '导出 CSV')
		bar.append(fields, pause, clear, reset, capWrap, csv)

		const pop = mk('div', 'mdn-curve-pop')
		pop.hidden = true
		pop.id = 'mdn-curve-pop'

		const readout = mk('div', 'mdn-curve-readout')
		readout.setAttribute('aria-live', 'off')
		const legend = mk('div', 'mdn-curve-legend')
		legend.hidden = true
		const plot = mk('div', 'mdn-curve-plot')
		const empty = mk('div', 'mdn-curve-empty', '等待数据')
		pane.append(bar, pop, readout, legend, plot, empty)

		el.pane = pane
		el.fields = fields
		el.fieldsLabel = fieldsLabel
		el.pop = pop
		el.pause = pause
		el.clear = clear
		el.reset = reset
		el.cap = cap
		el.csv = csv
		el.readout = readout
		el.legend = legend
		el.plot = plot
		el.empty = empty

		fields.addEventListener('click', function (e) {
			e.stopPropagation()
			togglePop()
		})
		pop.addEventListener('click', function (e) { e.stopPropagation() })
		document.addEventListener('click', function () {
			if (popOpen) togglePop(false)
		})
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && popOpen) togglePop(false)
		})
		pause.addEventListener('click', function () {
			const paused = S.setPaused(!S.isPaused())
			pause.setAttribute('aria-pressed', paused ? 'true' : 'false')
			pause.lastChild.textContent = paused ? '继续' : '暂停'
			pause.title = paused ? '继续采集新的数据点' : '暂停采集新的数据点（已有的点保留）'
			render()
		})
		clear.addEventListener('click', function () { S.clear() })
		reset.addEventListener('click', function () {
			if (!chart) return
			chart.setScale('x', { min: null, max: null })
			syncZoomButton()
		})
		csv.addEventListener('click', exportCsv)
		cap.addEventListener('change', function () {
			cap.value = String(S.setCapacity(cap.value))
		})
		return pane
	}

	// ---------- 挂载 ----------
	function mount() {
		if (!window.Workbench) return
		const pane = build()
		window.Workbench.registerPanel({
			id: 'curves',
			title: '曲线',
			label: '曲线',
			icon: 'icon-chart-line',
			el: pane,
			order: 30,
			available: function () {
				const items = selectionItems()
				if (!items.length) return false
				return items.some(function (it) { return it.hasMetrics })
			},
			unavailableHint: '当前协议没有 metrics，无法出曲线',
		})
		refreshFieldCache()
		S.onChange(render)
		document.addEventListener('serial-curves', render)
		document.addEventListener('serial-lane-config', function () {
			refreshFieldCache()
			if (popOpen) renderPop()
			render()
			if (window.Workbench) window.Workbench.refreshAvailability()
		})
		document.addEventListener('protocol-registry-change', function () {
			refreshFieldCache()
			render()
			if (window.Workbench) window.Workbench.refreshAvailability()
		})
		// 停靠区开合 / 拖动改宽度后补画：图表按容器像素尺寸建，宽度 0 时先不建
		const watch = new MutationObserver(function () { render() })
		watch.observe(pane, { attributes: true, attributeFilter: ['class'] })
		if (typeof ResizeObserver === 'function') {
			new ResizeObserver(function () { render() }).observe(pane)
		}
		// 主题切换要重取颜色（颜色只来自 CSS 变量，画布不会自己跟着变）
		const themeWatch = new MutationObserver(function () { render() })
		themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
		render()
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
	else mount()

	window.SerialCurvesPanel = { render: render, exportCsv: exportCsv }
})()
