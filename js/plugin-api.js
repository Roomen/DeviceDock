// 宿主 API 的实现：每个方法对应 js/plugin-rpc.js 方法表里的一个名字，能力校验在 RPC 层做完，
// 这里只管「用页面既有的路径做这件事」，不另造串口 / 协议 / 日志实现。
// 页面里的对象：window.serialLanes(选口与各路状态)、window.serialApi(收发)、window.SerialHub(会话)、
// window.serialByteTap(原始字节旁路)、window.serialPortClaims(归属声明)、window.serialLogApi(日志)、
// window.DeviceDockProtocols(协议注册表)、window.AppDialog(页内对话框)、window.AppPlatform(平台画像)。
;(function (root) {
	'use strict'

	const Rpc = root.DeviceDockPluginRpc
	if (!Rpc) throw new Error('plugin-api: plugin-rpc.js 未加载')

	// 端口对象 ↔ 文档内稳定 key：端口对象只在本文档内有效(刷新后重新选口)，所以 key 也不跨文档
	const portKeys = new Map()
	const keyPorts = new Map()
	let portKeySeq = 0
	function keyOfPort(port) {
		if (!port) return null
		let key = portKeys.get(port)
		if (!key) {
			key = 'p' + (++portKeySeq)
			portKeys.set(port, key)
			keyPorts.set(key, port)
		}
		return key
	}
	function portOfKey(key) {
		return keyPorts.get(String(key || '')) || null
	}

	function fail(code, message) {
		const e = new Error(message)
		e.code = code
		return e
	}

	function lanes() {
		return root.serialLanes || null
	}
	function hub() {
		return root.SerialHub || null
	}
	function platform() {
		return root.AppPlatform || null
	}
	function service(name) {
		const p = platform()
		return p && p.service ? p.service(name) : null
	}
	function visibleLanes() {
		const h = hub()
		if (!h) return []
		return Rpc.lanesForMode(h.mode)
	}
	function requireLane(lane) {
		const h = hub()
		if (!h) throw fail('unsupported', I18n.t('pluginApi.theSerialModuleIsnTReady'))
		if (lane !== 'S' && lane !== 'A' && lane !== 'B') throw fail('bad_request', I18n.t('pluginApi.laneMustBeSAB'))
		if (!h.isVisible(lane)) throw fail('not_found', I18n.t('pluginApi.thisLaneIsnTVisibleRight'))
		return lane
	}
	function bytesOf(value, max) {
		const r = Rpc.toBytes(value, max)
		if (!r.ok) throw fail(r.error.code, r.error.message)
		return Uint8Array.from(r.bytes)
	}
	function num(value, fallback) {
		const n = Number(value)
		return Number.isFinite(n) && n > 0 ? n : fallback
	}

	// ---------- 端口信息 ----------
	function portInfo(port) {
		const l = lanes()
		const meta = l && l.portMeta ? l.portMeta(port) : {}
		const h = hub()
		const busy = h ? h.busyOwnerOfPort(port, null) : null
		let selected = null
		if (h) {
			for (const sid of h.allPhys()) {
				if (h.getPort(sid) === port) { selected = sid; break }
			}
		}
		return {
			key: keyOfPort(port),
			portName: meta.portName || '',
			productName: meta.productName || '',
			alias: meta.alias || '',
			vid: meta.vid || null,
			pid: meta.pid || null,
			serialNumber: meta.sn || null,
			persistent: !!meta.persistent,
			selected,
			busy: busy || null,
		}
	}

	// 串口占用 / 打开状态变化属于「状态事件」，宿主侧会合并成最新态并保证送达
	function notifyClaimState(ctx) {
		ctx.send('claim.state', {
			pluginId: ctx.id,
			at: Date.now(),
			claims: ctx.claims().map(function (rec) {
				return { claimId: rec.id, open: !!rec.open, closing: !!rec.closing, port: rec.port ? keyOfPort(rec.port) : null }
			}),
		})
	}
	function isAsyncProtocolFn(fn) {
		const C = root.DeviceDockContract
		if (C && typeof C.isAsyncFunction === 'function') return C.isAsyncFunction(fn)
		if (typeof fn !== 'function') return false
		return Object.prototype.toString.call(fn) === '[object AsyncFunction]'
	}

	// 协议函数要在该路协议 + 一次性隔离会话里跑：SEK 解析会读写 skSession 的基准水量，
	// 双路 A/B 不能串，单路 S 也不能让插件输入污染实时会话（inLane 换入的 st 用完即丢）。
	function inProtocolLane(sid, fn) {
		const l = lanes()
		if (!l || typeof l.callInIsolatedLane !== 'function') throw fail('unsupported', I18n.t('pluginApi.theHostProvidesNoPerLane'))
		return l.callInIsolatedLane(sid, fn)
	}

	const api = {
		async 'device.listPorts'() {
			const adapter = root.SerialAdapter
			if (!adapter) throw fail('unsupported', I18n.t('pluginApi.theSerialAdapterIsnTReady'))
			const ports = adapter.canEnumerate && adapter.canEnumerate() ? await adapter.listPorts() : await adapter.getPorts()
			const list = ports || []
			// 预先解析身份(网页版经 USB 设备表补产品名)，返回的名字与界面一致
			if (lanes() && lanes().resolvePorts) await lanes().resolvePorts(list)
			return list.map(portInfo)
		},
		async 'device.listBle'() {
			const ble = service('computer-ble')
			if (!ble || !ble.devices) return []
			return ble.devices().map(function (d) {
				return { deviceId: d.deviceId || '', name: d.name || '', rssi: typeof d.rssi === 'number' ? d.rssi : null, services: Array.isArray(d.services) ? d.services.slice(0, 16) : [] }
			})
		},
		async 'device.listClassic'() {
			const classic = service('classic')
			if (!classic || !classic.devices) return []
			return classic.devices().map(function (d) {
				return { deviceId: d.deviceId || '', name: d.name || '', paired: !!d.paired }
			})
		},
		async 'device.bleScan'(params, ctx) {
			const ble = service('computer-ble')
			if (!ble || !ble.scan) throw fail('unsupported', I18n.t('pluginApi.thisComputerCanTScanFor'))
			// 扫描所有权在启动前就登记：停用发生在扫描期间也要能等到真实收尾
			const owner = ctx.scanOwner || (ctx.scanOwner = { ble: ble, active: false, task: null, stopping: null })
			if (params.start === false) {
				await stopBleScan(owner)
				return { scanning: false }
			}
			ctx.onTeardown(function () { return stopBleScan(owner) })
			if (owner.active) return { scanning: true }
			owner.active = true
			const task = Promise.resolve().then(function () {
				return ble.scan(function (d) {
					if (d) ctx.send('device.ble', { deviceId: d.deviceId || '', name: d.name || '', rssi: typeof d.rssi === 'number' ? d.rssi : null, services: Array.isArray(d.services) ? d.services.slice(0, 16) : [] })
				})
			})
			owner.task = task
			// 持续扫描的 promise 直到停止才兑现，不能 await 它把 RPC 挂住；收尾交给 teardown
			task.catch(function (e) {
				ctx.send('device.ble-error', { message: String(e && e.message ? e.message : e) })
			}).then(function () {
				if (owner.task === task) { owner.active = false; owner.task = null }
			})
			return { scanning: true }
		},
		async 'device.lanes'() {
			const h = hub()
			const l = lanes()
			if (!h || !l) return []
			return h.allPhys().filter(function (sid) { return h.isVisible(sid) }).map(function (sid) {
				const snap = l.laneSnapshot ? l.laneSnapshot(sid) : {}
				const port = h.getPort(sid)
				return {
					sid: sid,
					label: sid === 'S' ? '' : (sid === 'A' ? h.getLabelA() : h.getLabelB()),
					open: h.isOpen(sid),
					opening: h.isOpening(sid),
					protocol: l.protocolOf ? l.protocolOf(sid) : '',
					protocolName: l.protocolOf && l.protocolName ? l.protocolName(l.protocolOf(sid)) : '',
					transport: l.transportOf ? l.transportOf(sid) : 'serial',
					params: snap && snap.options ? snap.options : null,
					port: port ? portInfo(port) : null,
				}
			})
		},

		async 'serial.write'(params) {
			const sid = requireLane(params.lane)
			const bytes = bytesOf(params.bytes)
			if (!bytes.length) throw fail('bad_request', I18n.t('pluginApi.nothingToWrite'))
			const sapi = root.serialApi
			if (!sapi || !sapi.writeRawTo) throw fail('unsupported', I18n.t('pluginApi.thePortIsnTReadyYet'))
			const timing = await sapi.writeRawTo(sid, bytes, {})
			return { lane: sid, bytes: bytes.length, durationMs: timing ? timing.durationMs : null }
		},

		async 'claim.acquire'(params, ctx) {
			const port = portOfKey(params.portKey)
			if (!port) throw fail('not_found', I18n.t('pluginApi.portNotFoundPortIdsAre'))
			const claims = root.serialPortClaims
			if (!claims) throw fail('unsupported', I18n.t('pluginApi.portClaimsArenTAvailableHere'))
			// 插件的串口连接只受「物理口独占」约束，不看通信页哪一路开着、主发路是否钉扎：
			// 口正被某个会话占着(通信页各路或固件页的连接：打开 / 打开中 / 尚未确认释放 / 正在换上)时拒绝，
			// 否则声明成功、claim.open 才失败，且会话那边也不会感知这个声明
			const h = hub()
			const owner = h && h.sessionOwnerOfPort ? h.sessionOwnerOfPort(port) : null
			if (owner) {
				const who = owner === 'F' ? I18n.t('pluginApi.whoFirmwarePage') : (owner === 'S' ? I18n.t('pluginApi.whoSingle') : I18n.t('pluginApi.whoLane', { sid: owner }))
				throw fail('bad_request', I18n.t('pluginApi.portInUseByWho', { who }))
			}
			const id = claims.claim(port, ctx.id, ctx.name, params.mode)
			const rec = ctx.claim(id)
			rec.port = port
			notifyClaimState(ctx)
			return { claimId: id, mode: params.mode === 'shared' ? 'shared' : 'exclusive' }
		},
		async 'claim.release'(params, ctx) {
			const rec = ctx.claimRecord(params.claimId)
			if (!rec) return { released: false }
			await closeClaim(rec, { cancelled: true })
			if (root.serialPortClaims) root.serialPortClaims.release(rec.id)
			ctx.dropClaim(rec.id)
			notifyClaimState(ctx)
			return { released: true }
		},
		async 'claim.list'(params, ctx) {
			return ctx.claims().map(function (rec) {
				return { claimId: rec.id, mode: rec.mode, open: !!rec.open, port: rec.port ? portInfo(rec.port) : null }
			})
		},
		async 'claim.open'(params, ctx) {
			const rec = ctx.claimRecord(params.claimId)
			if (!rec) throw fail('not_found', I18n.t('pluginApi.claimNotFound'))
			await openClaim(rec, params)
			notifyClaimState(ctx)
			return { claimId: rec.id, open: true }
		},
		async 'claim.close'(params, ctx) {
			const rec = ctx.claimRecord(params.claimId)
			if (!rec) return { closed: false }
			// 普通关闭不是停用：不置 cancelled，同一声明之后还能重新 open
			await closeClaim(rec, { cancelled: false })
			notifyClaimState(ctx)
			return { closed: true }
		},
		async 'claim.ack'(params, ctx) {
			// 只认本插件自己的 claim：ctx.claimRecord 是当前 view 的声明表
			const rec = ctx.claimRecord(params.claimId)
			// 未知 claim / 未知 gen / 超前 seq / 不前进的 seq 一律忽略，不报错
			if (!rec) return { ack: false }
			return { ack: ackClaimRx(rec, Number(params.gen), Number(params.seq)) }
		},
		async 'claim.write'(params, ctx) {
			const rec = ctx.claimRecord(params.claimId)
			if (!rec) throw fail('not_found', I18n.t('pluginApi.claimNotFound'))
			if (rec.cancelled) throw fail('not_found', I18n.t('pluginApi.thePluginIsDisabled'))
			if (rec.closing) throw fail('closing', I18n.t('pluginApi.thePortIsClosingCanT'))
			if (!rec.open || !rec.port.writable) throw fail('not_found', I18n.t('pluginApi.portIsNotOpen'))
			const bytes = bytesOf(params.bytes)
			// 写任务记在 rec 上并串行化：关闭时必须等持锁的 writer 写完、释放锁再 close
			const run = async function () {
				if (rec.cancelled || rec.closing || !rec.open || !rec.port.writable) throw fail(rec.closing ? 'closing' : 'not_found', rec.closing ? I18n.t('pluginApi.thePortIsClosing') : I18n.t('pluginApi.thePortIsClosed'))
				const writer = rec.port.writable.getWriter()
				try {
					await writer.write(bytes)
				} finally {
					try { writer.releaseLock() } catch (e) {}
				}
				return { bytes: bytes.length }
			}
			const task = (rec.writeTask || Promise.resolve()).catch(function () {}).then(run)
			rec.writeTask = task
			task.catch(function () {}) // 避免排队中间的 rejection 变成未处理错误
			return await task
		},

		async 'protocol.info'(params) {
			const sid = requireLane(params.lane)
			return inProtocolLane(sid, function () {
				const l = lanes()
				const id = l && l.protocolOf ? l.protocolOf(sid) : ''
				const registry = root.DeviceDockProtocols
				const def = id && registry && registry.get ? registry.get(id) : null
				return {
					lane: sid,
					id: id,
					name: def ? def.name : (l && l.protocolOf && l.protocolName ? l.protocolName(l.protocolOf(sid)) : ''),
					fields: def && def.fields ? def.fields : [],
					queries: def && def.queries ? def.queries : [],
				}
			})
		},
		async 'protocol.call'(params) {
			const sid = requireLane(params.lane)
			const fn = String(params.fn || '')
			const ALLOWED = ['parseFrame', 'formatFrame', 'findFrame', 'metrics', 'buildRead', 'buildWrite', 'matchResponse', 'logView', 'byteMap', 'buildDownFrame']
			if (ALLOWED.indexOf(fn) === -1) throw fail('bad_request', I18n.t('pluginApi.protocolFunctionCanTBeCalled', { fn }))
			const l = lanes()
			const id = l && l.protocolOf ? l.protocolOf(sid) : ''
			const registry = root.DeviceDockProtocols
			const def = id && registry && registry.get ? registry.get(id) : null
			if (!def) throw fail('not_found', I18n.t('pluginApi.thisLaneHasNoProtocol'))
			if (typeof def[fn] !== 'function') throw fail('unsupported', I18n.t('pluginApi.theProtocolHasNo', { fn }))
			const args = Array.isArray(params.args) ? params.args : []
			// 注册层已拒绝 async 实现；这里再挡一次，避免异步函数在隔离上下文退出后继续跑
			if (isAsyncProtocolFn(def[fn])) throw fail('unsupported_async', I18n.t('pluginApi.protocolFunctionsCanTBeAsync', { fn }))
			// inLane 里只跑同步代码，不 await；结果经 JSON 克隆剔除函数与 DOM 引用
			const value = inProtocolLane(sid, function () { return def[fn].apply(def, args) })
			try {
				return JSON.parse(JSON.stringify(value === undefined ? null : value))
			} catch (e) {
				return null
			}
		},

		async 'log.write'(params, ctx) {
			if (!root.serialLogApi) throw fail('unsupported', I18n.t('pluginApi.theLogModuleIsnTReady'))
			root.serialLogApi.append(params.text, ctx.name)
			return { ok: true }
		},
		async 'log.recent'(params) {
			if (!root.serialLogApi) return []
			return root.serialLogApi.recent(params.count)
		},
		async 'log.export'() {
			if (!root.serialLogApi) return { text: '' }
			return { text: root.serialLogApi.exportText() }
		},

		async 'app.theme'(params, ctx) {
			return ctx.theme()
		},
		async 'app.platform'(params, ctx) {
			const p = platform()
			return {
				os: p ? p.os : 'web',
				runtime: p ? p.runtime : 'browser',
				profile: p ? p.profile : 'desktop',
				lanes: p ? p.lanes : 1,
				version: root.APP_VERSION || '',
				plugin: { id: ctx.id, name: ctx.name, version: ctx.version },
			}
		},
		async 'app.busyAcquire'(params, ctx) {
			return { busyId: ctx.busyAcquire(String(params.label || I18n.t('pluginApi.pluginTask')).slice(0, 40)) }
		},
		async 'app.busyRelease'(params, ctx) {
			return { released: ctx.busyRelease(params.busyId) }
		},
		async 'app.storageGet'(params, ctx) {
			const svc = service('plugins')
			if (!svc || !svc.storageGet) throw fail('unsupported', I18n.t('pluginApi.thePluginServiceIsnTReady'))
			return { value: await svc.storageGet(ctx.id, String(params.key || '')) }
		},
		async 'app.storageSet'(params, ctx) {
			const svc = service('plugins')
			if (!svc || !svc.storageSet) throw fail('unsupported', I18n.t('pluginApi.thePluginServiceIsnTReady'))
			// Rust 侧单值上限 64 KiB；在页面里先拦一次，别把超大对象序列化后送进 IPC
			if (Rpc.estimateSize(params.value, 64 * 1024) > 64 * 1024) throw fail('too_large', I18n.t('pluginApi.storedValueExceeds64Kib'))
			await svc.storageSet(ctx.id, String(params.key || ''), params.value === undefined ? null : params.value)
			return { ok: true }
		},
		async 'app.storageRemove'(params, ctx) {
			const svc = service('plugins')
			if (!svc || !svc.storageRemove) throw fail('unsupported', I18n.t('pluginApi.thePluginServiceIsnTReady'))
			await svc.storageRemove(ctx.id, String(params.key || ''))
			return { ok: true }
		},
		async 'app.saveFile'(params) {
			// 走页面既有的 <a download> + blob：桌面客户端由原生壳存进系统「下载」目录并提示，网页版是浏览器下载
			if (Rpc.estimateSize(params, Rpc.LIMITS.maxExportChars) > Rpc.LIMITS.maxExportChars) {
				throw fail('too_large', I18n.t('pluginApi.exportExceedsBytes', { maxExportChars: Rpc.LIMITS.maxExportChars }))
			}
			const name = String(params.name || 'plugin-export.txt').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
			let blob
			if (typeof params.base64 === 'string') {
				const bin = atob(params.base64)
				const bytes = new Uint8Array(bin.length)
				for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
				blob = new Blob([bytes], { type: params.mime || 'application/octet-stream' })
			} else {
				blob = new Blob([String(params.text == null ? '' : params.text)], { type: params.mime || 'text/plain;charset=utf-8' })
			}
			const url = URL.createObjectURL(blob)
			const a = document.createElement('a')
			a.href = url
			a.download = name
			a.style.display = 'none'
			document.body.appendChild(a)
			a.click()
			setTimeout(function () {
				a.remove()
				URL.revokeObjectURL(url)
			}, 1000)
			return { name: name }
		},
		async 'app.dialog'(params) {
			const dlg = root.AppDialog
			if (!dlg) throw fail('unsupported', I18n.t('pluginApi.dialogsAreUnavailable'))
			const kind = params.kind === 'confirm' || params.kind === 'prompt' ? params.kind : 'alert'
			const text = String(params.text == null ? '' : params.text).slice(0, 4000)
			const title = String(params.title || I18n.t('pluginApi.plugin')).slice(0, 80)
			if (kind === 'confirm') return { value: !!(await dlg.confirm(text, { title: title })) }
			if (kind === 'prompt') return { value: await dlg.prompt(text, String(params.value || ''), { title: title }) }
			await dlg.alert(text, { title: title })
			return { value: null }
		},
		async 'app.notify'(params) {
			const l = lanes()
			if (!l || !l.toast) return { ok: false }
			l.toast(String(params.text == null ? '' : params.text).slice(0, 200), params.kind)
			return { ok: true }
		},
	}

	// ---------- BLE 扫描所有权 ----------
	// 停用时必须等 stopScan 与扫描任务都真实收尾，不能只发一个不等待的停止请求
	async function stopBleScan(owner) {
		if (owner.stopping) return owner.stopping
		const p = (async function () {
			// 重试时取当前服务（不钉死启动扫描那一刻的对象），瞬时失败修好后能真正收尾
			const ble = service('computer-ble') || owner.ble
			if (ble && ble.stopScan) await ble.stopScan()
			if (owner.task) {
				try { await owner.task } catch (e) { /* 扫描任务的失败由错误事件上报 */ }
			}
			owner.active = false
			owner.task = null
		})()
		owner.stopping = p
		try { await p } finally { owner.stopping = null }
	}

	// claim.open 的可选控制信号：{ dataTerminalReady?: boolean, requestToSend?: boolean }。
	// 只收这两个键、值必须是布尔；没给或给了空对象返回 null(不调 setSignals)
	const SIGNAL_KEYS = ['dataTerminalReady', 'requestToSend']
	function claimSignals(raw) {
		if (raw === undefined || raw === null) return null
		if (typeof raw !== 'object' || Array.isArray(raw)) throw fail('bad_request', 'signals 必须是对象，如 { dataTerminalReady: true }')
		const out = {}
		let n = 0
		for (const k in raw) {
			if (!Object.prototype.hasOwnProperty.call(raw, k)) continue
			if (SIGNAL_KEYS.indexOf(k) === -1) throw fail('bad_request', 'signals 只支持 dataTerminalReady / requestToSend')
			if (typeof raw[k] !== 'boolean') throw fail('bad_request', 'signals.' + k + ' 必须是 true / false')
			out[k] = raw[k]
			n++
		}
		return n ? out : null
	}

	// ---------- 插件独占的口：打开 / 读循环 / 关闭 ----------
	async function openClaim(rec, params) {
		if (rec.open) return
		// 控制信号先校验：端口不支持 setSignals 时明确报 unsupported，不打开、不静默忽略
		const signals = claimSignals(params.signals)
		if (signals && typeof rec.port.setSignals !== 'function') throw fail('unsupported', I18n.t('pluginApi.portNoSignals'))
		if (rec.openTask) throw fail('bad_request', I18n.t('pluginApi.openingPleaseWait'))
		if (rec.cancelled) throw fail('not_found', I18n.t('pluginApi.thePluginIsDisabled'))
		if (rec.portOpened && !rec.portClosed) throw fail('internal', I18n.t('pluginApi.thePreviousCloseWasnTConfirmed'))
		// 普通 claim.close 之后可以重新打开同一声明：重置这一轮的流状态
		rec.portOpened = false
		rec.portClosed = false
		rec.closing = false
		rec.open = false
		rec.reading = false
		rec.reader = null
		rec.readTask = null
		// 把在飞打开记在 rec 上：停用时要等它收尾，不能让打开在视图销毁后继续完成并起读循环
		const task = (async function () {
			await rec.port.open({
				baudRate: num(params.baudRate, 115200),
				dataBits: 8,
				stopBits: 1,
				parity: 'none',
				flowControl: 'none',
			})
			rec.portOpened = true
			if (rec.cancelled) return false
			if (signals) {
				try {
					await rec.port.setSignals(signals)
				} catch (e) {
					// 信号没设上就不算打开成功：把刚打开的口关掉(关不掉保持 portOpened，下次 open 先报未确认关闭)
					try { await rec.port.close(); rec.portClosed = true } catch (closeErr) { /* 见上 */ }
					throw fail('internal', '设置控制信号失败：' + String(e && e.message ? e.message : e))
				}
				if (rec.cancelled) return false
			}
			// 每次 claim.open 开一个新 gen：gen 记在 rec 上（跨 close 保留），
			// 该 gen 的 seq 与 offset 从 0 重新起算（第一个批次 seq=1、offset=0）。
			// 新 gen：只在 rec.gens 里新开一条记账（旧 gen 未确认的批次继续占用在途额度），
			// 新 gen 的 seq 从 0 起算、offset 归零。
			rec.gen = (rec.gen || 0) + 1
			rec.rxOffset = 0
			rec.rx = null
			genEntry(rec, rec.gen)
			reapIdleGens(rec, true)
			rec.open = true
			rec.reading = true
			rec.readTask = readClaim(rec)
			return true
		})()
		rec.openTask = task
		try {
			const opened = await task
			if (!opened) throw fail('not_found', I18n.t('pluginApi.thePluginIsDisabled'))
		} catch (e) {
			if (e && e.code) throw e
			throw fail('internal', I18n.t('pluginApi.canTOpenThePort', { String: String(e && e.message ? e.message : e) }))
		} finally {
			if (rec.openTask === task) rec.openTask = null
		}
	}

	// ---------- claim.rx 合批 ----------
	// 每个 claim 一个接收缓冲：读循环把块追加进去，按时间窗（16 ms）或字节阈值（256 KiB）刷一次。
	// 一条 claim.rx 可能包含多次 read 的数据，插件必须按字节流解析、不能假设「一事件一帧」。
	//
	// 事件形状（定稿）：
	//   claim.rx   { claimId, gen, seq, offset, at, bytes: Uint8Array }
	//     gen    = 该 claim 第几次 claim.open（从 1 起，每次 open +1）
	//     seq    = 同一 gen 内从 1 单调递增
	//     offset = 本批首字节在该 gen 字节流中的绝对偏移（含已丢弃的字节）
	//   插件判断缺口：offset !== 上一批 offset + 上一批 bytes.length
	//   claim.gap  { claimId, gen, offset, bytes, reason }  reason: 'overflow' | 'closing'
	//     offset = 被丢字节的起点，与 claim.rx 一起走「直发」路径（不受任何配额）。
	const CLAIM_RX_WINDOW_MS = 16
	const CLAIM_RX_FLUSH_BYTES = 256 * 1024
	const CLAIM_RX_MAX_BYTES = 8 * 1024 * 1024
	// 背压：每个 claim 允许 4 批「已发未确认」在途，**跨 gen 累计**——反复 close/open 不会重置额度，
	// 旧代没被确认的批次继续占用配额，直到插件 ack 它们（旧 gen 的 ack 照样生效）。
	const CLAIM_RX_INFLIGHT_MAX = 4

	// 每个 claim 的在途记账：rec.gens = { <gen>: { rxSeq, ackedSeq } }，还带上该 gen 的 offset。
	// gen / offset 也在 rec 上（rec.gen / rec.rxOffset），不随 rec.rx 清空而丢。
	// 只保证「有 gen 号、有记帐表、有 offset」——**不**顺手重建当前 gen 的条目：
	// 条目在该 gen 真正有数据 / 打开时才建，全部确认后就被删掉，读取路径不能把它复活。
	function ensureGen(rec) {
		if (!rec.gen) rec.gen = 1
		if (!rec.gens) rec.gens = {}
		if (typeof rec.rxOffset !== 'number') rec.rxOffset = 0
		return rec.gen
	}

	function genEntry(rec, gen) {
		ensureGen(rec)
		if (!rec.gens[gen]) rec.gens[gen] = { rxSeq: 0, ackedSeq: 0, offset: 0 }
		return rec.gens[gen]
	}

	// 在途总数 = 所有 gen 的 (rxSeq - ackedSeq) 之和
	function claimInflight(rec) {
		ensureGen(rec)
		let total = 0
		const gens = rec.gens
		for (const g in gens) total += Math.max(0, gens[g].rxSeq - gens[g].ackedSeq)
		return total
	}

	function claimRxState(rec) {
		ensureGen(rec)
		// 有数据进出就说明这个 gen 在用：确保它的记帐条目存在
		genEntry(rec, rec.gen)
		// pendingGap：每个 claim 至多一条待发缺口 { offset, bytes, reason }，连续丢弃累加进去
		// （offset 保留首次丢弃起点）。它只在「即将真正发送一批数据之前」或 16 ms 定时器到点时发出。
		if (!rec.rx) rec.rx = { chunks: [], bytes: 0, at: 0, timer: 0, pendingGap: null }
		return rec.rx
	}

	function sendClaimGap(rec, gap) {
		if (!gap || !gap.bytes) return
		rec.ctx.send('claim.gap', { claimId: rec.id, gen: ensureGen(rec), offset: gap.offset, bytes: gap.bytes, reason: gap.reason })
	}

	// 把一次丢弃并进待发缺口：每个 claim 只保留**一条**待发记录，连续丢弃累加 bytes、
	// offset 保留首次丢弃起点；reason 变化时把旧的并入新的（保留最早 offset）。
	// 这里**不发送、也不挂定时器**：缺口只在「即将真正发送一批数据之前」或关闭收尾时发出，
	// 所以插件不消费时缺口一直合并在宿主这一条记录里（有界）。
	function queueClaimGap(rec, offset, bytes, reason) {
		if (!bytes) return
		const st = claimRxState(rec)
		const cur = st.pendingGap
		if (!cur) {
			st.pendingGap = { offset: offset, bytes: bytes, reason: reason }
			return
		}
		// 合并：保留最早的 offset 与字节数；reason 以最先记录的那条为准（overflow 先于 closing 时仍是 overflow）
		cur.bytes += bytes
		if (cur.offset > offset) cur.offset = offset
	}

	function takeClaimGap(rec) {
		const st = rec.rx
		if (!st || !st.pendingGap) return null
		const gap = st.pendingGap
		st.pendingGap = null
		return gap
	}

	// 把一块字节追加进缓冲；返回是否到了需要立刻刷的字节阈值。
	// 溢出规则：始终丢**最早**的字节；单个超过上限的新块截掉前缀、**复制**保留尾部（slice 而非 subarray，
	// 否则视图仍引用整个原始 ArrayBuffer，实际持有内存会远超上限）。丢弃字节并入待发缺口。
	function appendClaimRx(rec, value) {
		const st = claimRxState(rec)
		if (!st.at) st.at = Date.now()
		let chunks = st.chunks
		let bytes = st.bytes
		let need = bytes + value.length - CLAIM_RX_MAX_BYTES
		if (need > 0) {
			const gapStart = rec.rxOffset
			let dropped = 0
			// 1) 先从缓冲区最老的块丢
			while (need > 0 && chunks.length) {
				const head = chunks[0]
				if (head.length <= need) {
					chunks.shift()
					bytes -= head.length
					need -= head.length
					dropped += head.length
				} else {
					// 同样用 slice 复制：切掉前缀后不保留对原底层缓冲的引用
					chunks[0] = head.slice(need)
					bytes -= need
					dropped += need
					need = 0
				}
			}
			// 2) 缓冲清空了还有剩余需求：截掉新块前缀，复制保留尾部（单个超上限的块也走这里）
			if (need > 0) {
				const cut = Math.min(need, value.length)
				value = value.slice(cut)
				need -= cut
				dropped += cut
			}
			if (dropped > 0) {
				rec.rxOffset = gapStart + dropped
				queueClaimGap(rec, gapStart, dropped, 'overflow')
			}
		}
		if (value.length) {
			// 只接受独立、且大小与内容一致的块：view 指向大底层缓冲时按 byteLength 复制一份，
			// 这样缓冲实际占用（栈上 bytes 计数 + 底层内存）都不超过上限。
			if (value.byteOffset !== 0 || value.buffer.byteLength !== value.byteLength) value = value.slice()
			chunks.push(value)
			bytes += value.length
		}
		st.chunks = chunks
		st.bytes = bytes
		return st.bytes >= CLAIM_RX_FLUSH_BYTES
	}

	function concatChunks(chunks, total) {
		const out = new Uint8Array(total)
		let off = 0
		for (let i = 0; i < chunks.length; i++) {
			out.set(chunks[i], off)
			off += chunks[i].length
		}
		return out
	}

	// 刷出缓冲。opts.discard：iframe 已销毁，直接丢弃且不报告（无人可收）。
	// 缺口只在「即将真正发送一批数据之前」发出（随这批一起受在途 ≤ 4 约束），或由关闭收尾发出。
	function flushClaimRx(rec, opts) {
		const st = rec.rx
		if (!st) return false
		if (opts && opts.discard) {
			if (st.timer) { clearTimeout(st.timer); st.timer = 0 }
			st.chunks = []
			st.bytes = 0
			st.at = 0
			st.pendingGap = null
			return false
		}
		// （discard 的 gen 回收由 disposeClaimRx 统一处理）
		// 背压：在途未确认的批次（跨 gen 累计）到上限时既不发数据也不发缺口。
		// **早退时不清定时器**：数据合批窗口的截止时间不能被持续读取推迟。
		if (claimInflight(rec) >= CLAIM_RX_INFLIGHT_MAX) return false
		if (!st.bytes) {
			// 没有数据可发（只有待发缺口）：保留到下一批数据之前或关闭时再发
			if (st.timer) { clearTimeout(st.timer); st.timer = 0 }
			return false
		}
		if (st.timer) { clearTimeout(st.timer); st.timer = 0 }
		// 即将真正发送一批数据：先发待发缺口（保证缺口先于后续数据到达）
		const gap = takeClaimGap(rec)
		if (gap) sendClaimGap(rec, gap)
		const bytes = concatChunks(st.chunks, st.bytes)
		const at = st.at || Date.now()
		const offset = rec.rxOffset
		st.chunks = []
		st.bytes = 0
		st.at = 0
		rec.rxOffset = offset + bytes.length
		const g = genEntry(rec, rec.gen)
		g.rxSeq += 1
		g.offset = rec.rxOffset
		rec.ctx.send('claim.rx', { claimId: rec.id, gen: rec.gen, seq: g.rxSeq, offset: offset, at: at, bytes: bytes })
		return true
	}

	// 数据合批窗口（16 ms）：只负责把缓冲里的数据成批发出去，不承担缺口的发送。
	function scheduleClaimFlush(rec) {
		const st = claimRxState(rec)
		if (st.timer) return
		st.timer = setTimeout(function () {
			st.timer = 0
			flushClaimRx(rec)
		}, CLAIM_RX_WINDOW_MS)
	}

	// 累计确认（只前进）：ack(seq) 表示已处理到 seq。未知 claim / 旧 gen / 超前 seq / 不前进的 seq
	// 一律忽略。inflight 永远由 rxSeq - ackedSeq 推出，重复或旧 ACK 不会改变它。
	function ackClaimRx(rec, gen, seq) {
		if (!rec || !rec.gens) return false
		const g = rec.gens[gen]
		// 未知 gen / 超前 seq / 不前进的 seq 一律忽略（旧 gen 的 ack 只要还在记账里就生效）
		if (!g) return false
		if (!Number.isInteger(seq) || seq <= 0 || seq > g.rxSeq) return false
		if (seq <= g.ackedSeq) return false
		g.ackedSeq = seq
		// 当前 gen 的条目**永不删除**：seq / ackedSeq 在同一 gen 内必须单调，
		// 删掉再重建会让新批次从 seq=1 开始，迟到的旧 ACK 就能"确认"新批次。
		// 只回收「非当前 gen 且在途为 0」的旧 gen。
		if (gen !== rec.gen && g.ackedSeq >= g.rxSeq) delete rec.gens[gen]
		const st = rec.rx
		if (st && st.bytes) flushClaimRx(rec)
		return true
	}

	// 定时器随 claim 释放；关闭 / 停用时：能发多少发多少（受在途上限），发不下的按 closing 并进缺口。
	function disposeClaimRx(rec, opts) {
		const st = rec.rx
		if (!st) {
			// 没有缓冲（例如空 open 后立刻 close）：仍然要回收零在途的 gen 记账
			reapIdleGens(rec, false)
			return
		}
		if (st.timer) { clearTimeout(st.timer); st.timer = 0 }
		if (opts && opts.discard) {
			flushClaimRx(rec, { discard: true })
			rec.rx = null
			reapIdleGens(rec, false)
			return
		}
		// 最多发到在途上限为止：循环 flush 直到没有空间或缓冲清空
		let guard = CLAIM_RX_INFLIGHT_MAX + 1
		while (st.bytes && claimInflight(rec) < CLAIM_RX_INFLIGHT_MAX && guard-- > 0) {
			if (!flushClaimRx(rec)) break
		}
		// 仍发不出去的残余：并入 closing 缺口（不静默丢，也不越过在途上限）。
		// 关闭是终态：这里直接发出这条 closing 缺口 + 之前合并的 overflow 缺口，不再等定时器。
		if (st.bytes) {
			const gapStart = rec.rxOffset
			const dropped = st.bytes
			st.chunks = []
			st.bytes = 0
			st.at = 0
			rec.rxOffset = gapStart + dropped
			queueClaimGap(rec, gapStart, dropped, 'closing')
		}
		if (st.timer) { clearTimeout(st.timer); st.timer = 0 }
		// 关闭是终态：把合并后的缺口（含 closing）发**一条**
		const leftover = takeClaimGap(rec)
		if (leftover) sendClaimGap(rec, leftover)
		rec.rx = null
		// 回收零在途的 gen 记账。关闭是终态：连当前 gen 也在「在途 0」时一起回收
		// （下次 open 会开新 gen），所以反复空 open/close 不会让 rec.gens 无界增长。
		reapIdleGens(rec, false)
	}

	// 只保留「还有在途批次的 gen」；keepCurrent 为真时额外保留当前 gen
	// （同一 gen 内 seq 必须单调，不能在 ack 之后把条目删掉重建）。
	// 因此条目数 ≤ 有在途批次的 gen 数 + (keepCurrent ? 1 : 0)。
	function reapIdleGens(rec, keepCurrent) {
		if (!rec.gens) return
		const gens = rec.gens
		for (const g in gens) {
			const id = Number(g)
			if (keepCurrent && id === rec.gen) continue
			if (gens[g].ackedSeq < gens[g].rxSeq) continue
			delete gens[g]
		}
	}

	// 读循环：读错误后后端会换一条新流(Chromium 行为)，换流就续读；流为 null 表示设备丢失
	async function readClaim(rec) {
		let lastStream = null
		while (rec.reading) {
			const stream = rec.port.readable
			if (!stream) break
			if (stream === lastStream) {
				await new Promise(function (r) { setTimeout(r, 50) })
				continue
			}
			lastStream = stream
			let reader
			try {
				reader = stream.getReader()
			} catch (e) {
				break
			}
			rec.reader = reader
			try {
				while (rec.reading) {
					const { value, done } = await reader.read()
					if (done) break
					// 关闭可能已经把 rec.reading 置 false，但这一块字节**已经读到了**：
					// 先入缓冲（含溢出报告），再判断是否退出，绝不静默丢。
					if (value && value.length) {
						if (appendClaimRx(rec, value)) flushClaimRx(rec)
						else scheduleClaimFlush(rec)
					}
					if (!rec.reading) break
				}
			} catch (e) {
				// 设备丢失 / 读错误：交给下面的换流判断或结束
			} finally {
				rec.reader = null
				try { reader.releaseLock() } catch (e) {}
			}
			if (!rec.port.readable) break
		}
		rec.reading = false
		// 读循环结束时把残余刷出（受在途上限约束；吃不下的留给 close 的 force 刷）
		flushClaimRx(rec)
	}

	// opts.cancelled=true 是停用 / 卸载（该声明此后不可再用）；false 是普通 claim.close（可重新 open）。
	// 串行化关闭：失败的释放重试时不能并发再跑一次 close。
	async function closeClaim(rec, opts) {
		// 一进入关闭就置位：等待在飞写入期间不能再排队新的 claim.write
		if (opts && opts.cancelled) rec.cancelled = true
		rec.closing = true
		rec.reading = false
		if (rec.closingTask) return rec.closingTask
		const task = (async function () {
			// 1) 等打开收尾：打开途中停用不能留下没人管的句柄
			if (rec.openTask) {
				try { await rec.openTask } catch (e) { /* 打开失败也要继续把已开的口关掉 */ }
			}
			// 2) 等在飞写入结束：写流还被锁着时 close 会失败
			if (rec.writeTask) {
				try { await rec.writeTask } catch (e) { /* 写失败也继续收尾 */ }
			}
			// 3) 取消并等待持锁的 reader，读循环结束后才关端口
			if (rec.reader) {
				try { await rec.reader.cancel() } catch (e) {}
			}
			if (rec.readTask) {
				try { await rec.readTask } catch (e) {}
				rec.readTask = null
			}
			// 3b) 读循环停了：把缓冲里的残余刷给插件（iframe 已销毁则丢弃），再释放定时器
			disposeClaimRx(rec, opts && opts.discard ? { discard: true } : undefined)
			// 4) 关闭失败要如实抛出：占用声明与 busy 源都保留，应用更新也不能放行
			if (rec.portOpened && !rec.portClosed) {
				await rec.port.close()
				rec.portClosed = true
			}
			rec.open = false
			rec.closing = false
		})()
		rec.closingTask = task
		try {
			return await task
		} finally {
			rec.closingTask = null
		}
	}

	// 停用 / 卸载 / 更新准备统一走这里：逐个等串口收尾，成功才注销声明，失败保留占用供重试
	async function closeClaims(ctx, opts) {
		const failures = []
		const recs = ctx.claims()
		for (let i = 0; i < recs.length; i++) {
			const rec = recs[i]
			try {
				await closeClaim(rec, opts || { cancelled: true })
				if (root.serialPortClaims) root.serialPortClaims.release(rec.id)
				ctx.dropClaim(rec.id)
			} catch (e) {
				failures.push({ claimId: rec.id, message: String(e && e.message ? e.message : e) })
			}
		}
		return failures
	}

	root.PluginApi = {
		CLAIM_RX_WINDOW_MS: CLAIM_RX_WINDOW_MS,
		CLAIM_RX_FLUSH_BYTES: CLAIM_RX_FLUSH_BYTES,
		CLAIM_RX_MAX_BYTES: CLAIM_RX_MAX_BYTES,
		// 测试注入：直接驱动合批（不经过真串口）
		CLAIM_RX_INFLIGHT_MAX: CLAIM_RX_INFLIGHT_MAX,
		_claimInflight: claimInflight,
		_reapIdleGens: reapIdleGens,
		_appendClaimRx: appendClaimRx,
		_scheduleClaimFlush: scheduleClaimFlush,
		_flushClaimRx: flushClaimRx,
		_disposeClaimRx: disposeClaimRx,
		_ackClaimRx: ackClaimRx,
		_queueClaimGap: queueClaimGap,
		_takeClaimGap: takeClaimGap,
		_pendingClaimGap: function (rec) { return rec && rec.rx ? rec.rx.pendingGap : null },
		call: async function (method, params, ctx) {
			const fn = api[method]
			if (typeof fn !== 'function') throw fail('unknown_method', I18n.t('pluginApi.theHostDoesnTSupportThis', { method }))
			return await fn(params || {}, ctx)
		},
		methods: Object.keys(api),
		closeClaims: closeClaims,
		keyOfPort: keyOfPort,
		portOfKey: portOfKey,
		visibleLanes: visibleLanes,
	}
})(typeof window !== 'undefined' ? window : globalThis)
