// Run: node tests/curves-core.cjs — synthetic data only.
// 曲线纯逻辑回归（js/curves-core.js）：环形序列与按路隔离、实时帧抽取、单位分轴、时间对齐、CSV、
// 数值格式化、时间换算（毫秒存储 / uPlot 秒轴 / 24 小时制本地显示）。
const assert = require('node:assert/strict')
const C = require('../js/curves-core.js')

// ---- 环形序列：容量裁剪、非数值点丢弃、元数据回填 ----
{
	// 容量夹取：下限 100、上限 50000（界面输入范围同）
	const s = C.createStore({ capacity: 3 })
	assert.equal(s.capacity(), 100, '低于下限夹到 100')
	assert.equal(C.createStore({ capacity: 999999 }).capacity(), C.CAP_MAX, '高于上限夹到 50000')
	const s2 = C.createStore({ capacity: 102 })
	const meta = function () { return { name: 'A', unit: 'V', chart: true } }
	for (let i = 1; i <= 104; i++) s2.ingest('S', i, [{ key: 'a', value: i }], meta)
	const a = s2.get('S', 'a')
	assert.equal(a.t.length, 102, '环形按容量裁剪')
	assert.deepEqual(a.t.slice(0, 2), [3, 4], '丢最早的点')
	assert.deepEqual(a.v.slice(-1), [104])
	assert.equal(a.name, 'A')
	assert.equal(a.unit, 'V')
	assert.equal(a.chart, true)
	s2.ingest('S', 105, [{ key: 'a', value: 105 }])
	assert.equal(a.t.length, 102)
	assert.equal(a.t[0], 4)
	s2.setCapacity(101)
	assert.equal(a.t.length, 101, '缩容量立即裁剪')
	assert.equal(s2.keys('S').length, 1)
	// metrics 点带 unit 时覆盖字段目录的单位（0.01V 原始编码 → V 显示）
	{
		const s3 = C.createStore({})
		const meta = function () { return { name: '阈值', unit: '0.01V', chart: true } }
		s3.ingest('S', 1, [{ key: 't', value: 360 }], meta)
		s3.ingest('S', 2, [{ key: 't', value: 3.6, unit: 'V' }], meta)
		assert.equal(s3.get('S', 't').unit, 'V', '点级 unit 覆盖目录单位')
		assert.deepEqual(s3.get('S', 't').v, [360, 3.6])
		const s4 = C.createStore({})
		s4.ingest('S', 1, [{ key: 't', value: 1, unit: 'V' }], function () { return null })
		assert.equal(s4.get('S', 't').unit, 'V', '目录缺字段时点的 unit 仍生效')
	}
	// 按路隔离：S / A / B 同 key 互不可见
	s2.ingest('A', 5, [{ key: 'a', value: 7 }])
	s2.ingest('B', 6, [{ key: 'a', value: 8 }])
	assert.equal(a.v[a.v.length - 1], 105)
	assert.equal(s2.get('A', 'a').v[0], 7)
	assert.equal(s2.get('B', 'a').v[0], 8)
	assert.equal(s2.keys('A').length, 1)
	s2.clear('A')
	assert.equal(s2.get('A', 'a'), null, 'clear 单路')
	assert.ok(s2.get('S', 'a'), 'clear 单路不影响别的路')
	s2.clear()
	assert.equal(s2.size(), 0, 'clear 全部')
}

// ---- 实时帧抽取：完整帧切出、跨块残帧留缓冲、无 findFrame 时不出帧 ----
{
	const frames = [[1, 2, 3, 4], [5, 6, 7]]
	const pump = C.createFramePump({
		findFrame: function (u8) {
			if (u8.length >= 4 && u8[0] === 0xAA) {
				const need = u8[1]
				if (u8.length < need) return { found: false }
				return { found: true, offset: 0, length: need, frame: u8.subarray(0, need) }
			}
			return { found: false }
		},
		parseFrame: function (raw) { return { bytes: Array.from(raw) } },
	})
	let out = pump.push([0xAA, 6, 1, 2])
	assert.equal(out.length, 0, '半帧不出')
	out = pump.push([3, 4, 0xAA, 4, 5, 6, 7, 0xAA])
	assert.equal(out.length, 2)
	assert.deepEqual(out[0].frame.bytes, [0xAA, 6, 1, 2, 3, 4], 'parseFrame 收到完整帧字节')
	assert.deepEqual(out[1].frame.bytes, [0xAA, 4, 5, 6], '长度声明在帧头，按声明切')
	assert.equal(pump.size(), 2, '尾巴留在缓冲里')
	pump.reset()
	assert.equal(pump.size(), 0)
	// 缓冲上限：一直收不到完整帧时丢最早字节
	const capped = C.createFramePump({ findFrame: function () { return { found: false } }, maxBuffer: 10 })
	for (let i = 0; i < 100; i++) capped.push([i & 0xff])
	assert.ok(capped.size() <= 10, '缓冲不无限涨')
}

// ---- 单位分轴：一个单位一根轴，最多两根，第三种单位整组丢 ----
{
	const items = [
		{ sid: 'S', key: 'u', unit: 'V' },
		{ sid: 'S', key: 'i', unit: 'V' },
		{ sid: 'S', key: 't', unit: '℃' },
		{ sid: 'S', key: 'p', unit: 'kPa' },
	]
	const g = C.groupAxes(items, function (it) { return it.unit })
	assert.equal(g.axes.length, 2)
	assert.deepEqual(g.axes[0].items.map(function (i) { return i.key }), ['u', 'i'])
	assert.deepEqual(g.axes[1].items.map(function (i) { return i.key }), ['t'])
	assert.deepEqual(g.droppedUnits, ['kPa'])
	const none = C.groupAxes([], function () { return '' })
	assert.equal(none.axes.length, 0)
}

// ---- 时间对齐：并集时间轴，缺值补 null；null 序列保留空列；同毫秒点按「后到覆盖」聚合 ----
{
	const a = { t: [10, 30, 50], v: [1, 3, 5] }
	const b = { t: [20, 30], v: [2, 3] }
	const r = C.alignSeries([a, b])
	assert.deepEqual(r.t, [10, 20, 30, 50])
	assert.deepEqual(r.cols[0], [1, null, 3, 5])
	assert.deepEqual(r.cols[1], [null, 2, 3, null])
	// 还没有数据的字段（store.get 为 null）：保留全 null 列，与图例 / 轴对齐
	const withNull = C.alignSeries([a, null, b])
	assert.equal(withNull.cols.length, 3)
	assert.deepEqual(withNull.cols[1], [null, null, null, null])
	assert.deepEqual(withNull.cols[0], r.cols[0])
	// 同一序列同一毫秒的多个点：显示 / 导出按「后到的覆盖先到的」聚合（store 里的原始点不动）
	const dup = C.alignSeries([{ t: [100, 100, 100, 200], v: [1, 2, 3, 4] }])
	assert.deepEqual(dup.t, [100, 200])
	assert.deepEqual(dup.cols[0], [3, 4], '同毫秒取最后写入的值')
	// 不同序列的同毫秒点各自成列，不互相顶掉
	const cross = C.alignSeries([
		{ t: [100, 100], v: [1, 2] },
		{ t: [100], v: [9] },
	])
	assert.deepEqual(cross.t, [100])
	assert.deepEqual(cross.cols[0], [2], '同序列取最后一个')
	assert.deepEqual(cross.cols[1], [9], '另一序列的同毫秒点保留')
}

// ---- CSV：表头（路标 + 单位）、缺值空串、逗号转义（时间用本地构造的日期，不依赖时区）----
{
	const t0 = new Date(2026, 10, 12, 1, 0, 1).getTime()
	const list = [
		{ sid: 'A', key: 'u', name: '电压', unit: 'V', t: [t0, t0 + 1000], v: [1.5, null] },
		{ sid: 'B', key: 'u', name: '电压', unit: 'V', t: [t0 + 1000], v: [2] },
	]
	const csv = C.toCSV(list, { laneName: function (sid) { return sid }, formatTime: function (ms) { return C.formatClock(ms) } })
	const lines = csv.split('\n')
	assert.equal(lines[0], 'time,A 电压 (V),B 电压 (V)')
	assert.equal(lines[1], '01:00:01,1.5,')
	assert.equal(lines[2], '01:00:02,,2')
	const quoted = C.toCSV([{ sid: 'S', key: 'x', name: 'a,b', unit: '', t: [0], v: [1] }], {})
	assert.match(quoted, /"a,b"/)
}

// ---- 数值格式化 ----
{
	assert.equal(C.formatNumber(12), '12')
	assert.equal(C.formatNumber(1.23456), '1.23')
	assert.equal(C.formatNumber(0.5), '0.5')
	assert.equal(C.formatNumber(123.456), '123.5')
	assert.equal(C.formatNumber(null), '—')
	assert.equal(C.formatNumber(NaN), '—')
}

// ---- 时间换算：毫秒存储，uPlot 轴按秒，显示 24 小时制本地时间 ----
{
	const d = new Date(2026, 10, 12, 20, 15, 30, 500)
	const ms = d.getTime()
	assert.equal(C.formatClock(ms), '20:15:30', '本地时区 24 小时制')
	assert.equal(C.formatClock(ms + 61000), '20:16:31')
	// 跨度不满一天：只显示时刻
	assert.equal(C.formatHoverTime(ms, 3600000), '20:15:30')
	assert.equal(C.formatAxisTime(ms, 3600000), '20:15:30')
	// 跨天：悬停补日期（保留秒），轴刻度到分
	assert.equal(C.formatHoverTime(ms, C.DAY_MS), '11-12 20:15:30')
	assert.equal(C.formatAxisTime(ms, C.DAY_MS), '11-12 20:15')
	assert.equal(C.formatHoverTime(ms, 3 * C.DAY_MS), '11-12 20:15:30')
	// 非法输入
	assert.equal(C.formatClock(NaN), '—')
	assert.equal(C.formatAxisTime(undefined, 0), '')
	// uPlot 用秒轴：换算关系 (ms / 1000) 往返
	const sec = Math.floor(ms / 1000)
	assert.equal(C.formatAxisTime(sec * 1000, 0), C.formatClock(ms), '秒轴换算回毫秒后同一时刻')
	// 跨天判据刚好在一天边界
	assert.equal(C.formatAxisTime(ms, C.DAY_MS - 1), '20:15:30')
	assert.equal(C.formatAxisTime(ms, C.DAY_MS), '11-12 20:15')
}

console.log('curves-core: ok')
