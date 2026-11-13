// Hello 示例插件：演示设备列表查询、RX 原始字节订阅、亮/暗主题跟随、界面语言跟随与 busy 源申请。
;(function () {
	'use strict'

	const sdk = window.DeviceDockPlugin
	const $ = function (id) { return document.getElementById(id) }

	// 插件自带的两份文案；语言跟随宿主（app.locale），旧宿主没有 onLocale 或尚未收到时按浏览器语言回退
	const STRINGS = {
		'zh-CN': {
			title: 'Hello 插件示例',
			connecting: '正在连接 DeviceDock 宿主…',
			host: '宿主 DeviceDock v{version} · {os}',
			devicesTitle: '设备与连接 (device.read)',
			refresh: '刷新',
			lanesLoading: '各路状态加载中…',
			portsNotRead: '尚未读取串口列表',
			rxTitle: '串口 RX 计数 (serial.io)',
			reset: '清零',
			rxLastNone: '最近接收：无',
			rxLast: '最近接收 ({lane})：{hex}',
			busyTitle: '后台任务与日志 (app / log)',
			busyNone: '当前未持有 busy 源（应用可正常更新）',
			busyHeld: '已持有 busy 源 ({id})：宿主此时会阻止应用更新',
			busyAcquire: '申请 busy 源',
			busyRelease: '释放 busy 源',
			busyLabel: 'Hello 示例任务',
			writeLog: '写入宿主日志',
			laneOpen: '{sid} 已连接',
			laneClosed: '{sid} 未连接',
			noLanes: '无可见通道',
			noPorts: '当前没有在位或已授权串口',
			busyBy: ' [占用: {owner}]',
			readFailed: '读取设备失败：{message}',
			opFailed: '操作失败：{message}',
			logText: '来自 Hello 插件的测试日志，当前累计 RX {bytes} 字节',
			logWritten: '已写入一条插件日志',
			logFailed: '写日志失败：{message}',
		},
		en: {
			title: 'Hello plugin example',
			connecting: 'Connecting to the DeviceDock host…',
			host: 'Host DeviceDock v{version} · {os}',
			devicesTitle: 'Devices & connections (device.read)',
			refresh: 'Refresh',
			lanesLoading: 'Loading lane status…',
			portsNotRead: 'Port list not read yet',
			rxTitle: 'Serial RX count (serial.io)',
			reset: 'Reset',
			rxLastNone: 'Last received: none',
			rxLast: 'Last received ({lane}): {hex}',
			busyTitle: 'Background task & log (app / log)',
			busyNone: 'No busy source held (app updates are allowed)',
			busyHeld: 'Holding busy source ({id}): the host blocks app updates meanwhile',
			busyAcquire: 'Acquire busy source',
			busyRelease: 'Release busy source',
			busyLabel: 'Hello example task',
			writeLog: 'Write host log',
			laneOpen: '{sid} connected',
			laneClosed: '{sid} disconnected',
			noLanes: 'No visible lanes',
			noPorts: 'No present or authorized ports',
			busyBy: ' [in use: {owner}]',
			readFailed: 'Reading devices failed: {message}',
			opFailed: 'Operation failed: {message}',
			logText: 'Test log from the Hello plugin, {bytes} RX bytes so far',
			logWritten: 'Wrote a plugin log line',
			logFailed: 'Writing the log failed: {message}',
		},
	}
	function fallbackLocale() {
		return /^zh/i.test(navigator.language || '') ? 'zh-CN' : 'en'
	}
	let locale = (sdk.getLocale && sdk.getLocale()) || fallbackLocale()
	function t(key, params) {
		const s = (STRINGS[locale] || STRINGS.en)[key] || key
		return s.replace(/\{(\w+)\}/g, function (m, k) { return params && params[k] != null ? String(params[k]) : m })
	}

	const rxByLane = { S: 0, A: 0, B: 0 }
	let rxTotal = 0
	let lastRx = null
	let activeBusyId = null
	let hostInfo = null
	let lastDevices = null

	function errText(e) { return e && e.message ? e.message : String(e) }

	function updateThemeBadge(th) {
		const mode = (th && th.theme) || document.documentElement.getAttribute('data-theme') || 'light'
		$('theme-badge').textContent = 'theme: ' + mode
	}

	function renderRx() {
		$('rx-total').textContent = rxTotal + ' B'
		$('rx-lanes').textContent = 'S: ' + rxByLane.S + ' B · A: ' + rxByLane.A + ' B · B: ' + rxByLane.B + ' B'
		$('rx-last').textContent = lastRx ? t('rxLast', lastRx) : t('rxLastNone')
	}

	function renderBusy() {
		$('busy-status').textContent = activeBusyId ? t('busyHeld', { id: activeBusyId }) : t('busyNone')
		$('btn-toggle-busy').textContent = activeBusyId ? t('busyRelease') : t('busyAcquire')
	}

	function renderHost() {
		const p = hostInfo && hostInfo.platform ? hostInfo.platform : null
		$('host-summary').textContent = p ? t('host', { version: p.version || '?', os: p.os || 'desktop' }) : t('connecting')
	}

	function renderDevices() {
		if (!lastDevices) return
		const { ports, lanes, error } = lastDevices
		if (error) {
			$('lanes-summary').textContent = t('readFailed', { message: error })
			return
		}
		const laneText = (lanes || []).map(function (l) {
			return t(l.open ? 'laneOpen' : 'laneClosed', { sid: l.sid }) + (l.protocol ? ' (' + l.protocol + ')' : '')
		}).join(' · ')
		$('lanes-summary').textContent = laneText || t('noLanes')
		const listEl = $('ports-list')
		listEl.textContent = ''
		if (!ports || !ports.length) {
			const li = document.createElement('li')
			li.className = 'plg-item'
			li.textContent = t('noPorts')
			listEl.appendChild(li)
			return
		}
		ports.forEach(function (p) {
			const li = document.createElement('li')
			li.className = 'plg-item'
			const name = p.alias || p.productName || p.portName || p.key
			const busy = p.busy ? t('busyBy', { owner: p.busy }) : ''
			li.textContent = name + (p.portName ? ' (' + p.portName + ')' : '') + busy
			listEl.appendChild(li)
		})
	}

	// 静态文案：带 data-t 的节点按当前语言重写（纯文本）
	function applyStatic() {
		document.documentElement.setAttribute('lang', locale)
		document.title = t('title')
		document.querySelectorAll('[data-t]').forEach(function (el) { el.textContent = t(el.getAttribute('data-t')) })
		renderHost()
		renderRx()
		renderBusy()
		renderDevices()
	}

	async function refreshDevices() {
		try {
			const [ports, lanes] = await Promise.all([
				sdk.device.listPorts(),
				sdk.device.lanes(),
			])
			lastDevices = { ports, lanes }
		} catch (e) {
			lastDevices = { error: errText(e) }
		}
		renderDevices()
	}

	async function toggleBusy() {
		const btn = $('btn-toggle-busy')
		btn.disabled = true
		try {
			if (!activeBusyId) {
				const res = await sdk.app.busyAcquire(t('busyLabel'))
				activeBusyId = res && res.busyId ? res.busyId : null
			} else {
				await sdk.app.busyRelease(activeBusyId)
				activeBusyId = null
			}
			renderBusy()
		} catch (e) {
			$('busy-status').textContent = t('opFailed', { message: errText(e) })
		} finally {
			btn.disabled = false
		}
	}

	async function writeHostLog() {
		try {
			await sdk.log.write(t('logText', { bytes: rxTotal }))
			await sdk.app.notify(t('logWritten'))
		} catch (e) {
			$('busy-status').textContent = t('logFailed', { message: errText(e) })
		}
	}

	sdk.on('ready', function (info) {
		hostInfo = info || {}
		updateThemeBadge(info)
		renderHost()
		refreshDevices()
	})
	sdk.on('theme-change', function (th) {
		updateThemeBadge(th)
	})
	if (typeof sdk.onLocale === 'function') {
		sdk.onLocale(function (next) {
			if (next === locale) return
			locale = next
			applyStatic()
		})
	}
	sdk.on('device.ports', refreshDevices)
	sdk.on('device.lane', refreshDevices)
	// serial.rx 的 bytes 是数组；claim.rx（合批事件）的 bytes 是 Uint8Array，两种都按字节序列处理
	function rxBytes(pkt) {
		if (!pkt) return null
		if (pkt.bytes instanceof Uint8Array) return pkt.bytes
		if (Array.isArray(pkt.bytes)) return Uint8Array.from(pkt.bytes)
		return null
	}
	sdk.serial.onRx(function (pkt) {
		const bytes = rxBytes(pkt)
		if (!bytes) return
		const lane = pkt.lane || 'S'
		rxByLane[lane] = (rxByLane[lane] || 0) + bytes.length
		rxTotal += bytes.length
		const hex = Array.from(bytes.slice(0, 16), function (b) { return Number(b).toString(16).padStart(2, '0').toUpperCase() }).join(' ')
		lastRx = { lane, hex }
		renderRx()
	})

	$('btn-refresh-devices').addEventListener('click', refreshDevices)
	$('btn-reset-rx').addEventListener('click', function () {
		rxByLane.S = 0
		rxByLane.A = 0
		rxByLane.B = 0
		rxTotal = 0
		lastRx = null
		renderRx()
	})
	$('btn-toggle-busy').addEventListener('click', toggleBusy)
	$('btn-write-log').addEventListener('click', writeHostLog)
	applyStatic()
})()
