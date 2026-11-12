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
		if (!h) throw fail('unsupported', '串口模块尚未就绪')
		if (lane !== 'S' && lane !== 'A' && lane !== 'B') throw fail('bad_request', 'lane 只能是 S / A / B')
		if (!h.isVisible(lane)) throw fail('not_found', '这一路当前不可见')
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
		if (!l || typeof l.callInIsolatedLane !== 'function') throw fail('unsupported', '宿主没有提供按路隔离的协议调用入口')
		return l.callInIsolatedLane(sid, fn)
	}

	const api = {
		async 'device.listPorts'() {
			const adapter = root.SerialAdapter
			if (!adapter) throw fail('unsupported', '串口接入层尚未就绪')
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
			if (!ble || !ble.scan) throw fail('unsupported', '这台电脑没有 BLE 扫描能力')
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
			if (!bytes.length) throw fail('bad_request', '要写的数据为空')
			const sapi = root.serialApi
			if (!sapi || !sapi.writeRawTo) throw fail('unsupported', '串口尚未就绪')
			const timing = await sapi.writeRawTo(sid, bytes, {})
			return { lane: sid, bytes: bytes.length, durationMs: timing ? timing.durationMs : null }
		},

		async 'claim.acquire'(params, ctx) {
			const port = portOfKey(params.portKey)
			if (!port) throw fail('not_found', '端口不存在（端口只在本次运行内有效，请重新列出口）')
			const claims = root.serialPortClaims
			if (!claims) throw fail('unsupported', '当前环境没有插件占用声明')
			// 口正被某路会话占着（打开 / 打开中）时先拒绝：声明要落在空闲的口上，
			// 否则声明成功、claim.open 才失败，且会话那边也不会感知这个声明
			const h = hub()
			if (h) {
				for (const sid of h.allPhys()) {
					if (h.getPort(sid) === port && (h.isOpen(sid) || h.isOpening(sid))) {
						throw fail('bad_request', '该串口正在被 ' + sid + ' 路使用，请先在对应路断开后再声明')
					}
				}
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
			if (!rec) throw fail('not_found', '占用声明不存在')
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
		async 'claim.write'(params, ctx) {
			const rec = ctx.claimRecord(params.claimId)
			if (!rec) throw fail('not_found', '占用声明不存在')
			if (rec.cancelled) throw fail('not_found', '插件已停用')
			if (rec.closing) throw fail('closing', '串口正在关闭，暂不能写入')
			if (!rec.open || !rec.port.writable) throw fail('not_found', '串口未打开')
			const bytes = bytesOf(params.bytes)
			// 写任务记在 rec 上并串行化：关闭时必须等持锁的 writer 写完、释放锁再 close
			const run = async function () {
				if (rec.cancelled || rec.closing || !rec.open || !rec.port.writable) throw fail(rec.closing ? 'closing' : 'not_found', rec.closing ? '串口正在关闭' : '串口已关闭')
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
			if (ALLOWED.indexOf(fn) === -1) throw fail('bad_request', '不支持调用的协议函数：' + fn)
			const l = lanes()
			const id = l && l.protocolOf ? l.protocolOf(sid) : ''
			const registry = root.DeviceDockProtocols
			const def = id && registry && registry.get ? registry.get(id) : null
			if (!def) throw fail('not_found', '这一路没有协议')
			if (typeof def[fn] !== 'function') throw fail('unsupported', '该协议没有 ' + fn)
			const args = Array.isArray(params.args) ? params.args : []
			// 注册层已拒绝 async 实现；这里再挡一次，避免异步函数在隔离上下文退出后继续跑
			if (isAsyncProtocolFn(def[fn])) throw fail('unsupported_async', '协议函数不支持异步实现：' + fn)
			// inLane 里只跑同步代码，不 await；结果经 JSON 克隆剔除函数与 DOM 引用
			const value = inProtocolLane(sid, function () { return def[fn].apply(def, args) })
			try {
				return JSON.parse(JSON.stringify(value === undefined ? null : value))
			} catch (e) {
				return null
			}
		},

		async 'log.write'(params, ctx) {
			if (!root.serialLogApi) throw fail('unsupported', '日志模块尚未就绪')
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
			return { busyId: ctx.busyAcquire(String(params.label || '插件任务').slice(0, 40)) }
		},
		async 'app.busyRelease'(params, ctx) {
			return { released: ctx.busyRelease(params.busyId) }
		},
		async 'app.storageGet'(params, ctx) {
			const svc = service('plugins')
			if (!svc || !svc.storageGet) throw fail('unsupported', '插件服务尚未就绪')
			return { value: await svc.storageGet(ctx.id, String(params.key || '')) }
		},
		async 'app.storageSet'(params, ctx) {
			const svc = service('plugins')
			if (!svc || !svc.storageSet) throw fail('unsupported', '插件服务尚未就绪')
			// Rust 侧单值上限 64 KiB；在页面里先拦一次，别把超大对象序列化后送进 IPC
			if (Rpc.estimateSize(params.value, 64 * 1024) > 64 * 1024) throw fail('too_large', '存储值超过 64 KiB')
			await svc.storageSet(ctx.id, String(params.key || ''), params.value === undefined ? null : params.value)
			return { ok: true }
		},
		async 'app.storageRemove'(params, ctx) {
			const svc = service('plugins')
			if (!svc || !svc.storageRemove) throw fail('unsupported', '插件服务尚未就绪')
			await svc.storageRemove(ctx.id, String(params.key || ''))
			return { ok: true }
		},
		async 'app.saveFile'(params) {
			// 走页面既有的 <a download> + blob：桌面客户端由原生壳存进系统「下载」目录并提示，网页版是浏览器下载
			if (Rpc.estimateSize(params, Rpc.LIMITS.maxExportChars) > Rpc.LIMITS.maxExportChars) {
				throw fail('too_large', '导出内容超过 ' + Rpc.LIMITS.maxExportChars + ' 字节')
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
			if (!dlg) throw fail('unsupported', '对话框不可用')
			const kind = params.kind === 'confirm' || params.kind === 'prompt' ? params.kind : 'alert'
			const text = String(params.text == null ? '' : params.text).slice(0, 4000)
			const title = String(params.title || '插件').slice(0, 80)
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

	// ---------- 插件独占的口：打开 / 读循环 / 关闭 ----------
	async function openClaim(rec, params) {
		if (rec.open) return
		if (rec.openTask) throw fail('bad_request', '正在打开，请稍候')
		if (rec.cancelled) throw fail('not_found', '插件已停用')
		if (rec.portOpened && !rec.portClosed) throw fail('internal', '上一次关闭未确认完成，请重试')
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
			rec.open = true
			rec.reading = true
			rec.readTask = readClaim(rec)
			return true
		})()
		rec.openTask = task
		try {
			const opened = await task
			if (!opened) throw fail('not_found', '插件已停用')
		} catch (e) {
			if (e && e.code) throw e
			throw fail('internal', '无法打开串口：' + String(e && e.message ? e.message : e))
		} finally {
			if (rec.openTask === task) rec.openTask = null
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
					if (done || !rec.reading) break
					if (!value || !value.length) continue
					rec.ctx.send('claim.rx', { claimId: rec.id, at: Date.now(), bytes: Array.from(value) })
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
		call: async function (method, params, ctx) {
			const fn = api[method]
			if (typeof fn !== 'function') throw fail('unknown_method', '宿主不支持这个方法：' + method)
			return await fn(params || {}, ctx)
		},
		methods: Object.keys(api),
		closeClaims: closeClaims,
		keyOfPort: keyOfPort,
		portOfKey: portOfKey,
		visibleLanes: visibleLanes,
	}
})(typeof window !== 'undefined' ? window : globalThis)
