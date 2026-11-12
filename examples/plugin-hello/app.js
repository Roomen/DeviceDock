// Hello 示例插件：演示设备列表查询、RX 原始字节订阅、亮/暗主题跟随与 busy 源申请。
;(function () {
	'use strict'

	const sdk = window.DeviceDockPlugin
	const $ = function (id) { return document.getElementById(id) }

	const rxByLane = { S: 0, A: 0, B: 0 }
	let rxTotal = 0
	let activeBusyId = null

	function updateThemeBadge(t) {
		const mode = (t && t.theme) || document.documentElement.getAttribute('data-theme') || 'light'
		$('theme-badge').textContent = 'theme: ' + mode
	}

	function renderRx(lastHex, lane) {
		$('rx-total').textContent = rxTotal + ' B'
		$('rx-lanes').textContent = 'S: ' + rxByLane.S + ' B · A: ' + rxByLane.A + ' B · B: ' + rxByLane.B + ' B'
		if (lastHex) {
			$('rx-last').textContent = '最近接收 (' + lane + ')：' + lastHex
		}
	}

	async function refreshDevices() {
		try {
			const [ports, lanes] = await Promise.all([
				sdk.device.listPorts(),
				sdk.device.lanes(),
			])
			const laneText = (lanes || []).map(function (l) {
				return l.sid + (l.open ? ' 已连接' : ' 未连接') + (l.protocol ? ' (' + l.protocol + ')' : '')
			}).join(' · ')
			$('lanes-summary').textContent = laneText || '无可见通道'

			const listEl = $('ports-list')
			listEl.textContent = ''
			if (!ports || !ports.length) {
				const li = document.createElement('li')
				li.className = 'plg-item'
				li.textContent = '当前没有在位或已授权串口'
				listEl.appendChild(li)
				return
			}
			ports.forEach(function (p) {
				const li = document.createElement('li')
				li.className = 'plg-item'
				const name = p.alias || p.productName || p.portName || p.key
				const busy = p.busy ? ' [占用: ' + p.busy + ']' : ''
				li.textContent = name + (p.portName ? ' (' + p.portName + ')' : '') + busy
				listEl.appendChild(li)
			})
		} catch (e) {
			$('lanes-summary').textContent = '读取设备失败：' + (e && e.message ? e.message : e)
		}
	}

	async function toggleBusy() {
		const btn = $('btn-toggle-busy')
		btn.disabled = true
		try {
			if (!activeBusyId) {
				const res = await sdk.app.busyAcquire('Hello 示例任务')
				activeBusyId = res && res.busyId ? res.busyId : null
				$('busy-status').textContent = '已持有 busy 源 (' + activeBusyId + ')：宿主此时会阻止应用更新'
				btn.textContent = '释放 busy 源'
			} else {
				await sdk.app.busyRelease(activeBusyId)
				activeBusyId = null
				$('busy-status').textContent = '当前未持有 busy 源（应用可正常更新）'
				btn.textContent = '申请 busy 源'
			}
		} catch (e) {
			$('busy-status').textContent = '操作失败：' + (e && e.message ? e.message : e)
		} finally {
			btn.disabled = false
		}
	}

	async function writeHostLog() {
		try {
			await sdk.log.write('来自 Hello 插件的测试日志，当前累计 RX ' + rxTotal + ' 字节')
			await sdk.app.notify('已写入一条插件日志')
		} catch (e) {
			$('busy-status').textContent = '写日志失败：' + (e && e.message ? e.message : e)
		}
	}

	sdk.on('ready', function (info) {
		updateThemeBadge(info)
		const p = info && info.platform ? info.platform : {}
		$('host-summary').textContent = '宿主 DeviceDock v' + (p.version || '?') + ' · ' + (p.os || 'desktop')
		refreshDevices()
	})
	sdk.on('theme-change', function (t) {
		updateThemeBadge(t)
	})
	sdk.on('device.ports', refreshDevices)
	sdk.on('device.lane', refreshDevices)
	sdk.serial.onRx(function (pkt) {
		if (!pkt || !Array.isArray(pkt.bytes)) return
		const lane = pkt.lane || 'S'
		rxByLane[lane] = (rxByLane[lane] || 0) + pkt.bytes.length
		rxTotal += pkt.bytes.length
		const hex = pkt.bytes.slice(0, 16).map(function (b) { return Number(b).toString(16).padStart(2, '0').toUpperCase() }).join(' ')
		renderRx(hex, lane)
	})

	$('btn-refresh-devices').addEventListener('click', refreshDevices)
	$('btn-reset-rx').addEventListener('click', function () {
		rxByLane.S = 0
		rxByLane.A = 0
		rxByLane.B = 0
		rxTotal = 0
		$('rx-last').textContent = '最近接收：无'
		renderRx('', '')
	})
	$('btn-toggle-busy').addEventListener('click', toggleBusy)
	$('btn-write-log').addEventListener('click', writeHostLog)
})()
