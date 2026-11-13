// Run: node tests/plugin-rpc.cjs — synthetic data only.
// 覆盖: 插件 RPC 能力白名单校验、拖拽/键盘排序持久化、主题推送与 SDK applyTheme、
// 宿主 API 串口归属声明与 busy 源阻断应用更新、示例插件(examples/plugin-hello)清单摘要自洽。
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const Rpc = require('../js/plugin-rpc.js')
const SdkMod = require('../sdk/devicedock-plugin.js')
const { blockers } = require('../js/app-update.js')

// ---- 1. 请求校验与能力白名单（唯一的真实权限边界） ----
{
	assert.equal(Rpc.validateRequest(null).ok, false)
	assert.equal(Rpc.validateRequest({ __devicedock: 2, id: '1', method: 'app.theme' }).ok, false)
	assert.equal(Rpc.validateRequest({ __devicedock: 1, id: '', method: 'app.theme' }).ok, false)
	assert.equal(Rpc.validateRequest({ __devicedock: 1, id: '1', method: '' }).ok, false)
	assert.equal(Rpc.validateRequest({ __devicedock: 1, id: '1', method: 'app.theme', params: [] }).ok, false)

	const ok = Rpc.validateRequest({ __devicedock: 1, id: 'req-1', method: 'device.listPorts' })
	assert.equal(ok.ok, true)
	assert.equal(ok.id, 'req-1')
	assert.equal(ok.method, 'device.listPorts')
	assert.deepEqual(ok.params, {})

	// 未登记的方法一律 unknown_method
	const unknown = Rpc.authorize(Rpc.CAPABILITIES, 'fs.readFile')
	assert.equal(unknown.code, 'unknown_method')

	// 方法属于 serial.io，但插件只声明了 device.read → capability_denied
	const denied = Rpc.authorize(['device.read'], 'serial.write')
	assert.equal(denied.code, 'capability_denied')
	assert.match(denied.message, /serial\.io/)

	// 已声明对应能力 → 放行(返回 null)
	assert.equal(Rpc.authorize(['device.read', 'serial.io'], 'serial.write'), null)
	assert.equal(Rpc.authorize(['serial.claim'], 'claim.acquire'), null)
	assert.equal(Rpc.authorize(['protocol.read'], 'protocol.call'), null)
	assert.equal(Rpc.authorize(['log'], 'log.write'), null)
	assert.equal(Rpc.authorize(['app'], 'app.busyAcquire'), null)

	// 能力差异比较
	const diff = Rpc.changedCapabilities(['device.read', 'app'], ['device.read', 'serial.io'])
	assert.deepEqual(diff, { added: ['serial.io'], removed: ['app'] })
	const summary = Rpc.capabilitySummary(['device.read', 'serial.claim'])
	assert.equal(summary.length, 2)
	assert.ok(summary[0].text.includes('串口'))
}

// ---- 2. 左栏插件拖拽排序与 Alt+↑/↓ 顺序计算 ----
{
	// 已保存顺序优先，新安装的追加在末尾，已卸载的剔除
	assert.deepEqual(
		Rpc.orderPlugins(['a', 'b', 'c'], ['c', 'ghost', 'a']),
		['c', 'a', 'b']
	)
	// 键盘 Alt+↑ / Alt+↓
	assert.deepEqual(Rpc.movePlugin(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c'])
	assert.deepEqual(Rpc.movePlugin(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b'])
	assert.deepEqual(Rpc.movePlugin(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c'])
	// 指针拖拽落点
	assert.deepEqual(Rpc.movePluginTo(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd'])
	assert.deepEqual(Rpc.movePluginTo(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c'])
}

// ---- 3. 字节转换与上限检查 ----
{
	assert.deepEqual(Rpc.toBytes('A5 03 ff'), { ok: true, bytes: [0xa5, 0x03, 0xff] })
	assert.deepEqual(Rpc.toBytes([0, 128, 255]), { ok: true, bytes: [0, 128, 255] })
	assert.equal(Rpc.toBytes('GG').ok, false)
	assert.equal(Rpc.toBytes([256]).ok, false)
	assert.equal(Rpc.toBytes([1, 2, 3], 2).error.code, 'too_large')
	// Uint8Array / 其它 ArrayBuffer 视图 / ArrayBuffer 都收(宿主推的 claim.rx 就是 Uint8Array)，按视图覆盖的字节取，上限一致
	assert.deepEqual(Rpc.toBytes(new Uint8Array([1, 2, 255])), { ok: true, bytes: [1, 2, 255] })
	const backing = new Uint8Array([9, 9, 7, 8, 9, 9])
	assert.deepEqual(Rpc.toBytes(backing.subarray(2, 4)), { ok: true, bytes: [7, 8] })
	assert.deepEqual(Rpc.toBytes(new DataView(backing.buffer, 1, 2)), { ok: true, bytes: [9, 7] })
	assert.deepEqual(Rpc.toBytes(new Uint8Array([4, 5]).buffer), { ok: true, bytes: [4, 5] })
	assert.equal(Rpc.toBytes(new Uint8Array(3), 2).error.code, 'too_large')
	assert.equal(Rpc.toBytes(new ArrayBuffer(3), 2).error.code, 'too_large')
	assert.equal(Rpc.toBytes({ 0: 1, length: 1 }).ok, false, '类数组对象不算字节缓冲')
	// 大小估算按字节数计，64 KiB 的 Uint8Array 不会被逐下标计步拒掉
	assert.ok(Rpc.estimateSize({ bytes: new Uint8Array(65536) }, 128 * 1024) < 128 * 1024)
}

// ---- 4. 主题推送、SDK applyTheme 与双向 postMessage RPC ----
;(async function () {
	const styleProps = {}
	const attrs = {}
	const sentToHost = []
	const fakeWin = {
		document: {
			documentElement: {
				setAttribute(k, v) { attrs[k] = v },
				getAttribute(k) { return attrs[k] || null },
				style: {
					setProperty(k, v) { styleProps[k] = v },
				},
			},
		},
		__DEVICEDOCK_HOST_TARGET__: {
			postMessage(msg) {
				sentToHost.push(msg)
				// 模拟宿主处理
				setImmediate(() => {
					if (msg.method === 'device.listPorts') {
						sdk._handleMessage({ data: Rpc.resultEnvelope(msg.id, [{ key: 'p1', portName: 'CU0' }]) })
					} else if (msg.method === 'serial.write') {
						sdk._handleMessage({ data: Rpc.errorEnvelope(msg.id, 'capability_denied', '插件没有声明能力 serial.io') })
					}
				})
			},
		},
		addEventListener() {},
	}
	const sdk = SdkMod.createSdk(fakeWin)

	let themeEventCount = 0
	sdk.on('theme-change', (t) => {
		themeEventCount++
		assert.equal(t.theme, styleProps['--bg-body'] === '#0b0e14' ? 'dark' : 'light')
	})

	// 宿主推送 ready（带初始 light 主题与令牌）
	sdk._handleMessage({
		data: Rpc.eventEnvelope('ready', {
			plugin: { id: 'hello', name: 'Hello', version: '1.0.0' },
			platform: { os: 'macos', version: '1.2.3' },
			theme: 'light',
			tokens: { '--bg-body': '#f6f7f9', '--accent': '#1f5fbf', 'not-a-var': 'ignored' },
		}),
	})
	const readyInfo = await sdk.ready()
	assert.equal(readyInfo.plugin.id, 'hello')
	assert.equal(attrs['data-theme'], 'light')
	assert.equal(styleProps['--bg-body'], '#f6f7f9')
	assert.equal(styleProps['--accent'], '#1f5fbf')
	assert.equal(styleProps['not-a-var'], undefined)
	assert.equal(themeEventCount, 1)

	// 宿主切换暗色主题 → 实时推送 theme-change
	sdk._handleMessage({
		data: Rpc.eventEnvelope('theme-change', Rpc.themePayload('dark', { '--bg-body': '#0b0e14', '--accent': '#6ea8ff' })),
	})
	assert.equal(attrs['data-theme'], 'dark')
	assert.equal(styleProps['--bg-body'], '#0b0e14')
	assert.equal(styleProps['--accent'], '#6ea8ff')
	assert.equal(themeEventCount, 2)

	// RPC 成功与拒绝
	const ports = await sdk.device.listPorts()
	assert.deepEqual(ports, [{ key: 'p1', portName: 'CU0' }])
	await assert.rejects(
		() => sdk.serial.write('S', [1, 2, 3]),
		(err) => err.code === 'capability_denied'
	)

	// ---- 5. busy 源接入 app-update 阻断条件 ----
	const env = {
		Workbench: { updateBlockers: () => [] },
		serialApi: { isPinned: () => false, prepareForAppUpdate: async () => {} },
		AppPlatform: {
			service(name) {
				if (name === 'plugin-host') {
					return {
						isBusyForUpdate: () => true,
						busyLabels: () => ['Hello 示例 · 采集任务'],
					}
				}
				return null
			},
		},
	}
	assert.deepEqual(blockers(env), ['Hello 示例 · 采集任务'])

	// ---- 6. 示例插件(examples/plugin-hello)清单与文件 sha256 自洽 ----
	const helloRoot = path.join(__dirname, '../examples/plugin-hello')
	const manifest = JSON.parse(fs.readFileSync(path.join(helloRoot, 'manifest.json'), 'utf8'))
	assert.equal(manifest.schemaVersion, 1)
	assert.equal(manifest.apiVersion, 1)
	assert.equal(manifest.id, 'hello')
	assert.equal(manifest.kind, 'web')
	assert.ok(manifest.integrity[manifest.entry], 'entry 必须在 integrity 中')
	for (const [rel, expected] of Object.entries(manifest.integrity)) {
		const bytes = fs.readFileSync(path.join(helloRoot, rel))
		const actual = 'sha256-' + crypto.createHash('sha256').update(bytes).digest('hex')
		assert.equal(actual, expected, rel + ' 的 sha256 必须与 manifest.json 一致')
	}

	// ---- 7. PluginApi 方法表与 plugin-rpc.js METHODS 严格一一对应 ----
	const ctx = { window: { DeviceDockPluginRpc: Rpc } }
	ctx.globalThis = ctx.window
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/plugin-api.js'), 'utf8'), ctx)
	const implMethods = Array.from(ctx.window.PluginApi.methods).sort()
	const declMethods = Object.keys(Rpc.METHODS).slice().sort()
	assert.deepEqual(implMethods, declMethods, 'PluginApi 实现的方法必须与 Rpc.METHODS 完全一致')

	// ---- 8. 插件串口归属声明(serialPortClaims)与 SerialHub 选口冲突 / 热插拔隔离 ----
	const commonSrc = fs.readFileSync(path.join(__dirname, '../js/common.js'), 'utf8')
	const hookStart = commonSrc.indexOf('	// ===== 插件宿主挂钩(仅桌面客户端，见 js/plugin-host.js) =====')
	const hookEnd = commonSrc.indexOf('	// ===== 端口别名 UI =====', hookStart)
	assert.ok(hookStart > 0 && hookEnd > hookStart, 'common.js 插件宿主挂钩锚点存在')
	const hookCtx = { window: {}, _portIdentityCache: new WeakMap(), syncPortIdentity: () => ({ keys: [] }), addLogErr() {}, SerialHub: { getLogContainer: () => null } }
	vm.runInNewContext(commonSrc.slice(hookStart, hookEnd), hookCtx)
	const claims = hookCtx.window.serialPortClaims
	const pA = { id: 1 }, pB = { id: 2 }, pC = { id: 3 }
	// 身份键对得上的另一端口对象也认这个声明（热插拔 / 重列给的是新对象）
	hookCtx.syncPortIdentity = (port) => ({ keys: port === pA || port === pC ? ['usb:1:2'] : ['usb:9:9'] })
	hookCtx._portIdentityCache = new WeakMap()
	const c1 = claims.claim(pA, 'power', '功耗分析', 'exclusive')
	assert.equal(claims.ownerOf(pA), 'plugin:功耗分析')
	assert.equal(claims.ownerOf(pB), null)
	assert.throws(() => claims.claim(pA, 'other', '其它插件', 'exclusive'), /已被插件「功耗分析」占用/)
	assert.equal(claims.ownerOf(pC), 'plugin:功耗分析', '同身份键的新端口对象也应算被占用')
	claims.releasePlugin('power')
	assert.equal(claims.ownerOf(pA), null)
	assert.equal(claims.ownerOf(pC), null)
	assert.equal(claims.release(c1), false)

	console.log('plugin-rpc: ok')
})().catch((err) => {
	console.error(err)
	process.exitCode = 1
})
