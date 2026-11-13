// Run: node tests/firmware-link.cjs — synthetic data only.
// 覆盖: 固件页自己的连接(物理 sid 'F')与通信页 S / A / B、插件串口归属声明之间的物理口独占(三方互认)、
// F 不受通信页增减路与主发路事务钉扎影响、选走另一边关着记着的口时另一边放手、热插拔只接回 F 自己拔出过的口、
// 升级占用期间拒绝换口与准备应用更新、重连意图存 sessionStorage。
// 按锚点截取 js/common.js(与 tests/port-select-guard.cjs 相同的锚点，外加 `// 固件连接的占用者` 到 `var ansi_up`、
// `const SERIAL_WANT_OPEN_KEY = ` 到 `// reload 自动重连已整体移到`)，这些注释是锚点，别删。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../js/common.js'), 'utf8')

function slice(startMark, endMark) {
	const start = source.indexOf(startMark)
	const end = source.indexOf(endMark, start)
	assert.ok(start > 0 && end > start, 'common.js 锚点不见了: ' + startMark.trim())
	return source.slice(start, end)
}
const hubStart = source.indexOf('\tfunction makeSerialSession(')
const hubEnd = source.indexOf('\n\t}\n', source.indexOf('\tconst SerialHub = {'))
assert.ok(hubStart > 0 && hubEnd > hubStart, 'common.js 的 SerialHub 段不见了')
const hubSrc = source.slice(hubStart, hubEnd + 3)
const conflictSrc = slice('\tfunction findPortConflict(', '\tfunction portHeldByOther(')
const bindSrc = slice('\t// opts.openAfterSelect: 无口时点', '\t//屏幕唤醒锁')
const laneSrc = slice('\t// ===== 现代布局连接栏的串口列表', '\t// 列表行要显示的东西')
const apiSrc = slice('\t// 固件连接的占用者', '\tvar ansi_up')
const wantSrc = slice('\tconst SERIAL_WANT_OPEN_KEY = ', '\t// reload 自动重连已整体移到')
const releaseSrc = slice('\tfunction portHeldByOther(', '\tfunction randAliasId(') + slice('\tasync function releasePort(sid) {', '\t//页面销毁时释放串口句柄')

let nextId = 0
function makePort(vid, pid) {
	return { id: ++nextId, getInfo() { return { usbVendorId: vid || 0x10c4, usbProductId: pid || 0xea60 } } }
}
function store() {
	const m = new Map()
	return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}

function harness(mode, opts) {
	opts = opts || {}
	const msgs = []
	const opens = []
	const claims = new Map()
	const ctx = {
		window: {},
		document: { getElementById() { return null }, querySelectorAll() { return [] }, dispatchEvent() {} },
		CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail } },
		refreshParamsBusyUI() {},
		pinSid: null,
		laneMoving: false,
		readGenBySid: { S: 0, A: 0, B: 0, F: 0 },
		rxWatch() { return { lastRxAt: 0, backoff: 0 } },
		resetRxWatch() {},
		flushSerialPack() {},
		addLogErrSafe(m) { msgs.push(m) },
		WeakSet, Map, Promise, console, setTimeout, clearTimeout, JSON,
		platformHasSid: (sid) => (sid === 'F' ? !opts.mobile : true),
		notifyFirmwareConn() {},
		showToast(m) { msgs.push(m) },
		showMsg(m) { msgs.push(m) },
		addLogErr(m) { msgs.push(m) },
		sidName: (sid) => (sid === 'F' ? '固件连接' : sid === 'S' ? '单路' : sid + '路'),
		isBluetoothSerialPort: () => false,
		_portIdentityCache: new WeakMap(),
		getPortIdentityKey: () => Promise.resolve({ keys: ['k'], fingerprint: {} }),
		syncPortIdentity: (p) => ({ keys: ['usb:' + p.getInfo().usbVendorId + ':' + p.getInfo().usbProductId], fingerprint: {} }),
		strongIdentity: () => ({ conflict: false, snMatch: false }),
		anyShared: () => false,
		keyPaths: () => [],
		refreshPortDisplayNames() {},
		updateOpenButton() {},
		updatePortButtonDisplay() {},
		handleToggleClick() { return Promise.resolve() },
		sessionStorage: store(),
		localStorage: store(),
		SerialAdapter: { grantPort() {}, requestPort() { return Promise.reject(Object.assign(new Error('none'), { name: 'NotFoundError' })) } },
	}
	ctx.window.serialPortClaims = { ownerOf: (p) => (claims.has(p) ? 'plugin:' + claims.get(p) : null) }
	vm.createContext(ctx)
	vm.runInContext([hubSrc, conflictSrc, bindSrc, laneSrc, wantSrc, apiSrc, releaseSrc].join('\n') +
		'\nthis.SerialHub = SerialHub; this.api = { releasePort, selectLanePort, lanePortOwner, laneSelectBlock, laneBlockReason: typeof laneBlockReason === "function" ? laneBlockReason : null, getSerialWantOpen, setSerialWantOpen, setSerialWantPortKey, getSerialWantPortKey }', ctx)
	const hub = ctx.SerialHub
	hub.mode = mode
	ctx.window.serialApi.isPinned = function () { return !!this.pinned }
	ctx.closeSerial = function (sid) { hub.setOpen(sid, false); return Promise.resolve(true) }
	ctx.openSerial = function (sid) {
		hub.setOpen(sid, true)
		opens.push([sid, hub.getPort(sid).id])
		return Promise.resolve(true)
	}
	return { hub, msgs, opens, ctx, claims, api: ctx.api, serialApi: ctx.window.serialApi }
}

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test('通信页开着的口：固件连接选不到，提示被谁占用', async () => {
	const h = harness('single')
	const p = makePort()
	h.hub.setPort('S', p)
	h.hub.setOpen('S', true)
	assert.equal(h.api.lanePortOwner(p, 'F'), 'S')
	assert.equal(await h.api.selectLanePort('F', p, { open: true }), false)
	assert.equal(h.hub.getPort('F'), null)
	assert.ok(h.msgs.some((m) => m.indexOf('单路') !== -1))
})

test('固件连接开着的口：单路与双路 A / B 都选不到，提示被固件页占用', async () => {
	for (const mode of ['single', 'dual']) {
		const h = harness(mode)
		const p = makePort()
		h.hub.setPort('F', p)
		h.hub.setOpen('F', true)
		for (const sid of mode === 'single' ? ['S'] : ['A', 'B']) {
			assert.equal(h.api.lanePortOwner(p, sid), 'F')
			assert.equal(await h.api.selectLanePort(sid, p, { open: true }), false)
			assert.equal(h.hub.getPort(sid), null)
		}
		assert.ok(h.msgs.some((m) => m.indexOf('固件页') !== -1))
	}
})

test('插件声明的口：固件连接选不到；固件连接开着的口算插件声明前的会话占用', async () => {
	const h = harness('single')
	const p = makePort()
	h.claims.set(p, '功耗')
	assert.equal(h.api.lanePortOwner(p, 'F'), 'plugin:功耗')
	assert.equal(await h.api.selectLanePort('F', p, { open: true }), false)
	const q = makePort()
	h.hub.setPort('F', q)
	h.hub.setOpen('F', true)
	assert.equal(h.hub.sessionOwnerOfPort(q), 'F')
	h.hub.setOpen('F', false)
	assert.equal(h.hub.sessionOwnerOfPort(q), null, '关着记着的口不算占用')
	h.hub._sess('F').releaseFailed = true
	assert.equal(h.hub.sessionOwnerOfPort(q), 'F', '未确认释放仍算占用')
})

test('固件连接关着记着的口被插件声明并打开后，换口不关插件的口(读流锁着也不让换口失败)', async () => {
	const h = harness('single')
	// 走真实的 releasePort：关闭 = 置未打开 + 释放
	h.ctx.closeSerial = async function (sid) { h.hub.setOpen(sid, false); return h.api.releasePort(sid) }
	const p = makePort()
	let pClosed = 0
	p.readable = { locked: true }
	p.writable = {}
	p.close = async function () { pClosed++; throw Object.assign(new Error('locked'), { name: 'TypeError' }) }
	// 1. 固件连接选口但保持关闭
	assert.equal(await h.api.selectLanePort('F', p, { open: false }), true)
	assert.equal(h.hub.isOpen('F'), false)
	// 2. 插件声明并打开该口(插件自己 open，口上挂着流)
	h.claims.set(p, '功耗')
	// 3. 固件连接改选另一个口
	const q = makePort()
	assert.equal(await h.api.selectLanePort('F', q, { open: false }), true)
	assert.equal(pClosed, 0, '插件声明着的口不能被固件连接关掉')
	assert.equal(h.hub.getPort('F'), q)
	assert.equal(h.hub.isReleaseFailed('F'), false)
	// 通信页单路同理：关着记着的口被插件拿去后，单路换口也不关它
	h.hub.setPort('S', makePort())
	const s = h.hub.getPort('S')
	s.readable = {}; s.writable = {}
	let sClosed = 0
	s.close = async () => { sClosed++ }
	h.claims.set(s, '功耗')
	assert.equal(await h.api.selectLanePort('S', makePort(), { open: false }), true)
	assert.equal(sClosed, 0)
	// 没被别处持有的口照旧关(本会话自己的脏状态口)
	h.claims.clear()
	const own = h.hub.getPort('S')
	own.readable = {}; own.writable = {}
	let ownClosed = 0
	own.close = async () => { ownClosed++ }
	assert.equal(await h.api.releasePort('S'), true)
	assert.equal(ownClosed, 1)
})

test('固件连接不受通信页增减路、主发路事务钉扎影响', async () => {
	const h = harness('dual')
	const p = makePort()
	h.ctx.laneMoving = true
	h.serialApi.pinned = true
	h.hub.activeSendId = 'A'
	assert.equal(h.api.laneSelectBlock('F', p), '')
	assert.equal(await h.api.selectLanePort('F', p, { open: true }), true)
	assert.equal(h.hub.getPort('F'), p)
	assert.deepEqual(h.opens, [['F', p.id]])
	assert.ok(h.api.laneSelectBlock('A', makePort()), '通信页这一路仍被拦')
})

test('选走另一边关着记着的口：另一边放手，同一个口只留一处记着', async () => {
	const h = harness('single')
	const p = makePort()
	h.hub.setPort('S', p)
	h.api.setSerialWantOpen(true, 'S')
	assert.equal(await h.api.selectLanePort('F', p, { open: true }), true)
	assert.equal(h.hub.getPort('F'), p)
	assert.equal(h.hub.getPort('S'), null)
	assert.equal(h.api.getSerialWantOpen('S'), false)
	// 反过来：通信页选走固件连接关着记着的口
	h.hub.setOpen('F', false)
	assert.equal(await h.api.selectLanePort('S', p, { open: false }), true)
	assert.equal(h.hub.getPort('S'), p)
	assert.equal(h.hub.getPort('F'), null)
})

test('升级占用固件连接期间：不能换口、不能关、不能准备应用更新；结束后放行', async () => {
	const h = harness('single')
	const p = makePort()
	h.hub.setPort('F', p)
	h.hub.setOpen('F', true)
	const link = h.serialApi.firmwareLink
	const token = link.begin('固件升级')
	assert.equal(link.isBusy(), true)
	assert.ok(h.api.laneSelectBlock('F', makePort()).indexOf('固件升级进行中') !== -1)
	assert.equal(await h.api.selectLanePort('F', makePort(), { open: true }), false)
	assert.equal(h.hub.getPort('F'), p)
	await assert.rejects(() => h.serialApi.prepareForAppUpdate(), /固件升级正在进行/)
	assert.throws(() => link.begin('查询'), /固件连接正被「固件升级」使用/)
	link.end('wrong-token')
	assert.equal(link.isBusy(), true, '令牌不符不能解除占用')
	link.end(token)
	assert.equal(link.isBusy(), false)
	assert.equal(h.api.laneSelectBlock('F', makePort()), '')
	// 准备应用更新时拒绝开始新的占用
	h.serialApi.updatePreparing = true
	assert.throws(() => link.begin('固件升级'), /应用更新/)
})

test('固件连接只走自己的订阅，不进通信页的通用订阅', () => {
	const h = harness('single')
	const got = []
	h.serialApi.firmwareLink.onReceive((d) => got.push(['F', d]))
	h.serialApi.onReceive((d) => got.push(['S', d]))
	assert.equal(JSON.stringify(h.serialApi._receivers.map((r) => r.sid)), '["F",null]')
	assert.equal(h.serialApi.isSessionOpen('F'), false, 'writeRawTo / isSessionOpen 不认 F(MCP、插件 lane 接口)')
	assert.equal(h.serialApi.sessionGeneration('F'), 0)
})

test('热插拔：固件连接接回自己拔出过的口，空着的固件连接不认领新插入的口', () => {
	const h = harness('single')
	const lost = new WeakSet()
	const old = makePort(0x1a86, 0x7523)
	h.hub.setPort('F', old)
	lost.add(old)
	h.hub.setPort('S', makePort())
	const back = makePort(0x1a86, 0x7523)
	assert.equal(h.hub.findRebindSession(back, (p) => lost.has(p)), 'F')
	const h2 = harness('single')
	h2.hub.setPort('S', makePort())
	assert.equal(h2.hub.findRebindSession(makePort(0x1234, 0x5678), () => false), null, '新口不进空着的固件连接')
	const h3 = harness('single', { mobile: true })
	const old3 = makePort(0x1a86, 0x7523)
	h3.hub.setPort('F', old3)
	assert.equal(h3.hub.findRebindSession(makePort(0x1a86, 0x7523), (p) => p === old3), 'S', '移动端没有固件连接')
})

test('重连意图：固件连接存 sessionStorage 的独立键，不写 localStorage', () => {
	const h = harness('single')
	h.api.setSerialWantOpen(true, 'F')
	h.api.setSerialWantPortKey('F', ['usb:6790:29987'])
	assert.equal(h.ctx.sessionStorage.getItem('serialWantOpenF'), '1')
	assert.equal(h.ctx.sessionStorage.getItem('serialWantPortKeyF'), '["usb:6790:29987"]')
	assert.equal(h.api.getSerialWantOpen('S'), false, '不影响通信页单路')
	assert.equal(h.ctx.localStorage.m.size, 0)
	h.api.setSerialWantOpen(false, 'F')
	assert.equal(h.api.getSerialWantOpen('F'), false)
})

;(async () => {
	let failed = 0
	for (const t of tests) {
		try {
			await t.fn()
			console.log('ok  ', t.name)
		} catch (e) {
			failed++
			console.log('FAIL', t.name)
			console.log('    ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e)
		}
	}
	if (failed) {
		console.log(failed + ' failed')
		process.exit(1)
	}
	console.log('all ' + tests.length + ' passed')
})()
