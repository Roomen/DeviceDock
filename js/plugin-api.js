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
			if (params.start === false) {
				if (ble.stopScan) await ble.stopScan()
				return { scanning: false }
			}
			// 扫描由宿主持有：插件关页面 / 停用时统一停掉；发现的设备以事件推给该插件
			await ble.scan(function (d) {
				if (d) ctx.send('device.ble', { deviceId: d.deviceId || '', name: d.name || '', rssi: typeof d.rssi === 'number' ? d.rssi : null, services: Array.isArray(d.services) ? d.services.slice(0, 16) : [] })
			})
			ctx.onTeardown(function () { if (ble.stopScan) ble.stopScan().catch(function () {}) })
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
			return { claimId: id, mode: params.mode === 'shared' ? 'shared' : 'exclusive' }
		},
		async 'claim.release'(params, ctx) {
			const rec = ctx.claimRecord(params.claimId)
			if (!rec) return { released: false }
			await closeClaim(rec)
			root.serialPortClaims.release(rec.id)
			ctx.dropClaim(rec.id)
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
			return { claimId: rec.id, open: true }
		},
		async 'claim.close'(params, ctx) {
			const rec = ctx.claimRecord(params.claimId)
			if (!rec) return { closed: false }
			await closeClaim(rec)
			return { closed: true }
		},
		async 'claim.write'(params, ctx) {
			const rec = ctx.claimRecord(params.claimId)
			if (!rec) throw fail('not_found', '占用声明不存在')
			if (!rec.open || !rec.port.writable) throw fail('not_found', '串口未打开')
			const bytes = bytesOf(params.bytes)
			const writer = rec.port.writable.getWriter()
			try {
				await writer.write(bytes)
			} finally {
				try { writer.releaseLock() } catch (e) {}
			}
			return { bytes: bytes.length }
		},

		async 'protocol.info'(params) {
			const sid = requireLane(params.lane)
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
			const value = def[fn].apply(def, args)
			// 结果必须是可 JSON 序列化的视图模型；函数 / DOM 节点一律丢掉，不把宿主对象交给插件
			return JSON.parse(JSON.stringify(value === undefined ? null : value))
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

	// ---------- 插件独占的口：打开 / 读循环 / 关闭 ----------
	async function openClaim(rec, params) {
		if (rec.open) return
		if (rec.opening) throw fail('bad_request', '正在打开，请稍候')
		rec.opening = true
		try {
			await rec.port.open({
				baudRate: num(params.baudRate, 115200),
				dataBits: 8,
				stopBits: 1,
				parity: 'none',
				flowControl: 'none',
			})
		} catch (e) {
			throw fail('internal', '无法打开串口：' + (e && e.message ? e.message : e))
		} finally {
			rec.opening = false
		}
		rec.open = true
		rec.reading = true
		readClaim(rec)
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

	async function closeClaim(rec) {
		rec.reading = false
		if (rec.reader) {
			try { await rec.reader.cancel() } catch (e) {}
		}
		if (rec.open) {
			try { await rec.port.close() } catch (e) {}
		}
		rec.open = false
	}

	root.PluginApi = {
		call: async function (method, params, ctx) {
			const fn = api[method]
			if (typeof fn !== 'function') throw fail('unknown_method', '宿主不支持这个方法：' + method)
			return await fn(params || {}, ctx)
		},
		methods: Object.keys(api),
		keyOfPort: keyOfPort,
		portOfKey: portOfKey,
		visibleLanes: visibleLanes,
	}
})(typeof window !== 'undefined' ? window : globalThis)
