;(function () {
	'use strict'

	if (!window.PCP || !window.FirmwareParser) {
		console.error('PCP 模块未加载')
		return
	}
	if (!window.serialApi) {
		console.error('串口接口未就绪')
		return
	}

	const PCP = window.PCP
	const PCPMessageCode = window.PCPMessageCode
	const FirmwareParser = window.FirmwareParser
	const serialApi = window.serialApi
	// 收发走哪条连接：有固件页的画像(桌面)用固件页自己的连接 serialApi.firmwareLink(与通信页各路互不影响，不钉扎主发路)；
	// 没有固件页的画像(移动端，固件面板停靠在通信页)仍走主发那一路，用事务钉扎锁住它
	const fwLink = serialApi.firmwareLink && serialApi.firmwareLink.enabled() ? serialApi.firmwareLink : null
	function linkOpen() {
		return fwLink ? fwLink.isOpen() : serialApi.isOpen()
	}
	// 占用连接：固件连接记占用者(升级期间不换口、不改参数、不准备应用更新)，主发路走事务钉扎；失败抛错
	function beginLink() {
		if (fwLink) return fwLink.begin(I18n.t('common.fwUpgradeOwner'))
		window.serialApi.suppressParse = true
		try {
			return serialApi.pinSession(serialApi.getActiveSendSid(), 'firmware')
		} catch (e) {
			window.serialApi.suppressParse = false
			throw e
		}
	}
	function endLink(token) {
		if (fwLink) {
			fwLink.end(token)
			return
		}
		serialApi.unpinSession(token)
		window.serialApi.suppressParse = false
	}
	// 自动升级(原始固件 → 按设备版本在内存里生成差分包或压缩包再升级，不输出中间产物)：js/firmware-core.js 与 js/firmware-library.js
	const Core = window.FirmwareCore
	const library = window.FirmwareLibrary || null
	const diffRunner = Core.createDiffRunner(new URL('firmware-diff-worker.js', document.currentScript.src).href, {
		onDone: function (r) { log(I18n.t('fwUp.diffTookMsPatch', { round: Math.round(r.ms), fmtSize: fmtSize(r.size) }), 'info') },
	})

	let fw = null                 // 解析后的固件信息
	let fwFileBuffer = null       // 固件 ArrayBuffer
	let running = false
	let fwTxToken = null
	let stopFlag = false
	let recvBuffer = []
	let recvOffset = 0

	const el = {
		file: document.getElementById('fw-file'),
		select: document.getElementById('fw-select'),
		fileName: document.getElementById('fw-file-name'),
		fileSize: document.getElementById('fw-file-size'),
		dropZone: document.getElementById('fw-drop-zone'),
		fileCard: document.getElementById('fw-file-card'),
		fileClear: document.getElementById('fw-file-clear'),
		chunkSize: document.getElementById('fw-chunk-size'),
		parseInfo: document.getElementById('fw-parse-info'),
		versionRow: document.getElementById('fw-version-row'),
		version: document.getElementById('fw-version'),
		parse: document.getElementById('fw-parse'),
		diagnose: document.getElementById('fw-diagnose'),
		info: document.getElementById('fw-info'),
		start: document.getElementById('fw-start'),
		stop: document.getElementById('fw-stop'),
		query: document.getElementById('fw-query'),
		clearLog: document.getElementById('fw-clear-log'),
		status: document.getElementById('fw-status'),
		progress: document.getElementById('fw-progress'),
		log: document.getElementById('fw-log'),
		librarySummary: document.getElementById('fw-library-summary'),
		libraryClear: document.getElementById('fw-library-clear'),
	}

	// 只读事件：固件页的升级流水线(js/modern-firmware.js)据此显示进度、分块与校验，不影响升级流程与时序
	function emit(detail) {
		try { document.dispatchEvent(new CustomEvent('fw-upgrade', { detail: detail })) } catch (e) { /* 事件只供界面使用 */ }
	}
	let lastError = ''
	let outcomeOk = false
	// 本轮设备上报的下载结果码(0x16)，自动升级据此判断差分包被拒后是否改用压缩包
	let lastDownloadStatus = null

	function fmtSize(bytes) {
		if (bytes < 1024) return bytes + ' B'
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
		return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
	}

	// 读取固件信息开关: 关闭后不解析包头, 整个文件当作固件数据, 版本号由用户手填
	function parseInfoEnabled() {
		return el.parseInfo.checked
	}

	// 文件名去扩展名作为默认版本号(版本号字段最长 16 字节)
	// 差分包名形如 "旧版本_时间戳_to_新版本_时间戳", 升级目标是 to 后面那个版本
	function defaultVersionFromName(name) {
		let s = String(name || '').replace(/\.[^.]*$/, '')
		const parts = s.split(/[\s_-]+to[\s_-]+/i)
		if (parts.length > 1) s = parts[parts.length - 1].replace(/_\d+$/, '')
		return s.slice(0, 16)
	}

	function autoInfoText(f) {
		return [
			I18n.t('fwUp.file', { v: (f.fileName || '') }),
			I18n.t('fwUp.typeRawFirmwareAutoUpgrade'),
			I18n.t('fwUp.embeddedVersion', { version: f.version }),
			I18n.t('fwUp.sizeBytesCrc320x', { length: f.rawData.length, crc: f.crc.toString(16).toUpperCase().padStart(8, '0') }),
			'',
			I18n.t('fwUp.onStartTheDeviceVersionIs'),
			I18n.t('fwUp.otherwiseOrWithSeveralDifferentBuilds'),
		].join('\n')
	}

	// 原始固件存进本机固件库，之后设备跑的是它时可以作差分基准
	// 进行中的存库任务：自动升级查库前先等它，免得刚导入的旧固件还没写进去就判成「找不到」
	let librarySaving = Promise.resolve()
	function saveToLibrary(name, data) {
		if (!library) return
		const job = library.add(name, data).then(function (r) {
			if (r && r.evicted) log(I18n.t('fwUp.firmwareLibraryFullEvictedLeastRecently', { evicted: r.evicted }), 'info')
			refreshLibrarySummary()
		}).catch(function (e) { log(I18n.t('fwUp.failedToSaveToTheFirmware', { v: (e && e.message || e) }), 'warn') })
		// 等全部在途的存库，不只最近一次(先导入的那份可能更慢)
		librarySaving = Promise.all([librarySaving, job])
	}

	function refreshLibrarySummary() {
		if (!el.librarySummary) return
		if (!library) { el.librarySummary.textContent = I18n.t('fwUp.firmwareLibraryUnavailable'); return }
		library.summary().then(function (s) {
			el.librarySummary.textContent = I18n.t('fwUp.localFirmwareLibrary', { count: s.count, v: (s.count ? I18n.t('fwUp.s', { fmtSize: fmtSize(s.bytes) }) : '') })
		}).catch(function () { el.librarySummary.textContent = I18n.t('fwUp.firmwareLibraryUnavailable') })
	}

	function manualInfoText(name, size, version) {
		return [
			I18n.t('fwUp.file', { v: (name || '') }),
			I18n.t('fwUp.version', { v: (version || I18n.t('fwUp.notSet')) }),
			I18n.t('fwUp.dataSizeBytesHeaderNotParsed', { size }),
		].join('\n')
	}

	// 升级实际使用的版本号: 手动模式取输入框当前值
	function effectiveVersion() {
		return parseInfoEnabled() ? fw.version : el.version.value.trim()
	}

	function applyParseMode() {
		const on = parseInfoEnabled()
		el.versionRow.classList.toggle('d-none', on)
		el.diagnose.disabled = !on
		el.parse.textContent = on ? I18n.t('fwUp.inspectFirmware') : I18n.t('fwUp.loadFirmware')
	}

	function showFileCard(name, size) {
		el.dropZone.classList.add('d-none')
		el.fileCard.classList.remove('d-none')
		el.fileName.textContent = name
		el.fileSize.textContent = fmtSize(size)
		emit({ type: 'file-set', name: name, size: size })
	}

	function hideFileCard() {
		el.dropZone.classList.remove('d-none')
		el.fileCard.classList.add('d-none')
		el.fileName.textContent = I18n.t('fwUp.noFirmwareFileSelected')
		el.fileSize.textContent = '--'
		emit({ type: 'file-clear' })
	}

	function loadFwFile(file) {
		if (!file) return
		el.fileName.dataset.name = file.name
		el.version.value = defaultVersionFromName(file.name)
		const reader = new FileReader()
		reader.onload = function () {
			fwFileBuffer = reader.result
			showFileCard(file.name, file.size)
			log(I18n.t('fwUp.firmwareLoaded', { name: file.name, fmtSize: fmtSize(file.size) }), 'info')
			el.parse.click()
		}
		reader.readAsArrayBuffer(file)
	}

	const LOG_MAX_LINES = 3000
	function log(msg, level) {
		const cls = { info: '', success: 'text-success', error: 'text-danger', warn: 'text-warning' }[level || 'info']
		const time = new Date().toLocaleTimeString()
		const line = document.createElement('div')
		line.className = cls
		line.textContent = `[${time}] ${msg}`
		el.log.appendChild(line)
		// 每个分片都记一行，连续升级、设备反复重请求时没有上限就一直涨
		while (el.log.childElementCount > LOG_MAX_LINES) el.log.removeChild(el.log.firstElementChild)
		el.log.scrollTop = el.log.scrollHeight
		if (level === 'error' && running) lastError = msg
		emit({ type: 'log', msg: msg, level: level || 'info' })
	}
	function setProgress(p) {
		p = Math.max(0, Math.min(100, p))
		el.progress.style.width = p + '%'
		el.progress.textContent = p + '%'
		el.progress.setAttribute('aria-valuenow', p)
		emit({ type: 'progress', percent: p })
	}
	function setStatus(s) {
		el.status.textContent = s || ''
	}

	el.select.addEventListener('click', function (e) { e.stopPropagation(); el.file.click() })
	el.dropZone.addEventListener('click', function () { el.file.click() })

	el.fileClear.addEventListener('click', function (e) {
		e.stopPropagation()
		fw = null
		fwFileBuffer = null
		hideFileCard()
		el.file.value = ''
		el.info.textContent = ''
		el.version.value = ''
		el.start.disabled = true
		log(I18n.t('fwUp.firmwareFileCleared'), 'info')
		emit({ type: 'parsed', ok: false, error: '' })
	})

	el.file.addEventListener('change', function (e) {
		const f = e.target.files[0]
		if (f) loadFwFile(f)
	})

	// Drag & Drop
	;['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function (evt) {
		el.dropZone.addEventListener(evt, function (e) { e.preventDefault(); e.stopPropagation() }, false)
	})
	;['dragenter', 'dragover'].forEach(function (evt) {
		el.dropZone.addEventListener(evt, function () { el.dropZone.classList.add('drag-over') }, false)
	})
	;['dragleave', 'drop'].forEach(function (evt) {
		el.dropZone.addEventListener(evt, function () { el.dropZone.classList.remove('drag-over') }, false)
	})
	el.dropZone.addEventListener('drop', function (e) {
		const files = e.dataTransfer.files
		if (files.length > 0) loadFwFile(files[0])
	}, false)

	el.parse.addEventListener('click', () => {
		if (!fwFileBuffer) {
			log(I18n.t('fwUp.selectAFirmwareFileFirst'), 'error')
			return
		}
		if (!parseInfoEnabled()) {
			const name = el.fileName.dataset.name
			if (!el.version.value.trim()) el.version.value = defaultVersionFromName(name)
			fw = {
				ok: true,
				raw: true,
				fileName: name,
				firmwareData: new Uint8Array(fwFileBuffer),
				version: el.version.value.trim(),
			}
			el.info.textContent = manualInfoText(name, fw.firmwareData.length, fw.version)
			log(I18n.t('fwUp.firmwareLoadedHeaderNotParsedBytes', { length: fw.firmwareData.length }), 'success')
			emit({ type: 'parsed', ok: true, raw: true, version: fw.version, size: fw.firmwareData.length })
			el.start.disabled = !linkOpen()
			return
		}
		const bytes = new Uint8Array(fwFileBuffer)
		const kind = Core.classify(bytes)
		if (kind.kind === 'raw') {
			fw = { ok: true, auto: true, fileName: el.fileName.dataset.name, rawData: bytes, version: kind.version, crc: kind.crc }
			el.info.textContent = autoInfoText(fw)
			log(I18n.t('fwUp.rawFirmwareEmbeddedVersionOnStart', { version: kind.version }), 'success')
			saveToLibrary(fw.fileName, bytes)
			emit({ type: 'parsed', ok: true, raw: false, auto: true, version: kind.version, pkgType: I18n.t('fwUp.rawFirmwareAutoDiffCompressed'), size: bytes.length })
			el.start.disabled = !linkOpen()
			return
		}
		const r = FirmwareParser.parse(fwFileBuffer)
		if (!r.ok) {
			log(I18n.t('fwUp.firmwareParseFailed', { error: r.error }), 'error')
			emit({ type: 'parsed', ok: false, error: r.error })
			fw = null
			el.start.disabled = true
			return
		}
		r.fileName = el.fileName.dataset.name
		fw = r
		el.info.textContent = FirmwareParser.diagnose(r)
		log(I18n.t('fwUp.firmwareParsedVersion', { version: r.version }), 'success')
		emit({ type: 'parsed', ok: true, raw: false, version: r.version, pkgType: r.pkgTypeName, size: r.firmwareData.length })
		el.start.disabled = !linkOpen()
	})

	el.diagnose.addEventListener('click', () => {
		if (!fw) {
			el.parse.click()
			if (!fw) return
		}
		if (fw.raw) {
			el.info.textContent = manualInfoText(fw.fileName, fw.firmwareData.length, effectiveVersion())
			return
		}
		if (fw.auto) {
			el.info.textContent = autoInfoText(fw)
			return
		}
		el.info.textContent = FirmwareParser.diagnose(fw)
	})

	el.query.addEventListener('click', async () => {
		if (!linkOpen()) {
			log(fwLink ? I18n.t('fwUp.connectFirmwareDeviceFirst') : I18n.t('fwUp.openThePortFirst'), 'error')
			return
		}
		try {
			fwTxToken = beginLink()
		} catch (e) {
			log(I18n.t('fwUp.canTStartTheQuery', { v: (e.message || e) }), 'error')
			emit({ type: 'device-version', ok: false, source: 'query', error: e.message || String(e) })
			return
		}
		emit({ type: 'query-start' })
		try {
			const resp = await sendAndWait(PCP.buildQueryVersionRequest(), PCPMessageCode.QUERY_VERSION, 5000)
			const res = PCP.parseQueryVersionResponse(resp)
			if (res.resultCode !== 0) {
				log(I18n.t('fwUp.versionQueryFailedResultCode0x', { resultCode: res.resultCode.toString(16) }), 'error')
				emit({ type: 'device-version', ok: false, source: 'query', error: I18n.t('fwUp.resultCode0x', { resultCode: res.resultCode.toString(16) }) })
			} else {
				log(I18n.t('fwUp.deviceVersion', { version: res.version }), 'success')
				emit({ type: 'device-version', ok: true, source: 'query', version: res.version })
			}
		} catch (e) {
			if (upgradeInterrupted(e)) return
			log(I18n.t('fwUp.versionQueryTimedOut', { message: e.message }), 'error')
			emit({ type: 'device-version', ok: false, source: 'query', error: I18n.t('fwUp.timedOut') })
		} finally {
			endLink(fwTxToken)
			fwTxToken = null
		}
	})

	el.clearLog.addEventListener('click', () => { el.log.innerHTML = '' })

	// 持久化分片大小
	;(function () {
		var saved = localStorage.getItem('fwChunkSize')
		if (saved) el.chunkSize.value = saved
		el.chunkSize.addEventListener('change', function () {
			localStorage.setItem('fwChunkSize', this.value)
		})
		el.parseInfo.checked = localStorage.getItem('fwParseInfo') !== '0'
		applyParseMode()
		el.parseInfo.addEventListener('change', function () {
			localStorage.setItem('fwParseInfo', this.checked ? '1' : '0')
			applyParseMode()
			// 模式变了, 已载入的文件要按新模式重新处理
			fw = null
			el.info.textContent = ''
			el.start.disabled = true
			if (fwFileBuffer) el.parse.click()
		})
		el.version.addEventListener('input', function () {
			if (fw && fw.raw) {
				fw.version = this.value.trim()
				el.info.textContent = manualInfoText(fw.fileName, fw.firmwareData.length, fw.version)
			}
		})
	})()

	el.start.addEventListener('click', async () => {
		if (!fw) {
			log(parseInfoEnabled() ? I18n.t('fwUp.inspectTheFirmwareFirst') : I18n.t('fwUp.loadFirmwareFirst'), 'error')
			return
		}
		if (!linkOpen()) {
			log(fwLink ? I18n.t('fwUp.connectFirmwareDeviceFirst') : I18n.t('fwUp.openThePortFirst'), 'error')
			return
		}
		const ver = effectiveVersion()
		if (!ver) {
			log(I18n.t('fwUp.enterTheTargetVersionFirst'), 'error')
			return
		}
		if (new TextEncoder().encode(ver).length > 16) {
			log(I18n.t('fwUp.versionExceeds16Bytes'), 'error')
			return
		}
		stopFlag = false
		// 先占住连接再发布启动状态，抢不到不走启动清理。固件连接：期间不换口、不改参数、不准备应用更新；
		// 主发路(移动端)：事务钉扎(owner=firmware)，期间切主发口被拦，测试流程等其它事务持有时这里被拒
		try {
			fwTxToken = beginLink()
		} catch (e) {
			log(I18n.t('fwUp.canTStartTheUpgrade', { v: (e.message || e) }), 'error')
			return
		}
		running = true
		lastError = ''
		outcomeOk = false
		emit({ type: 'start', version: ver, chunkSize: parseInt(el.chunkSize.value) || 128, size: fw.auto ? fw.rawData.length : fw.firmwareData.length })
		el.start.disabled = true
		el.stop.disabled = false
		el.query.disabled = true
		setProgress(0)
		try {
			if (fw.auto) await runAuto(fw)
			else await runUpgrade(fw)
		} finally {
			diffRunner.dispose()
			running = false
			cancelFirmwareWaiters(new StopError(I18n.t('fwUp.upgradeEnded')))
			endLink(fwTxToken)
			fwTxToken = null
			el.start.disabled = false
			el.stop.disabled = true
			el.query.disabled = false
			recvBuffer = []
			recvOffset = 0
			emit({ type: 'end', ok: outcomeOk, stopped: stopFlag && !outcomeOk, error: lastError })
		}
	})

	el.stop.addEventListener('click', () => {
		if (!running) return
		stopFlag = true
		clearTransferInbox()
		cancelFirmwareWaiters(new StopError(I18n.t('fwUp.stopped')))
		log(I18n.t('fwUp.stoppingUpgrade'), 'warn')
		// 自动升级的准备阶段(查库、取 BLANK、算差分)不经串口，要主动打断：结束在途差分、中止 BLANK 请求、让等待立即返回
		cancelPrepare()
	})

	// ---- 自动升级准备阶段的取消 ----
	// StopError：用户点停止(记为已停止)；断线时 disconnected 为 true(记为失败)
	class StopError extends Error {
		constructor(msg, disconnected) { super(msg); this.disconnected = !!disconnected }
	}
	function upgradeInterrupted(error) {
		if (!running || (!stopFlag && !(error instanceof StopError))) return false
		if (!stopFlag && error.disconnected) log(I18n.t('fwUp.portDisconnectedUpgradeAborted'), 'error')
		else log(I18n.t('fwUp.upgradeStopped'), 'info')
		return true
	}
	let prepAbort = null
	let prepStop = null
	let prepWatch = 0
	function beginPrepare() {
		prepAbort = typeof AbortController === 'function' ? new AbortController() : null
		let fire = null
		const p = new Promise(function (resolve, reject) { fire = reject })
		p.catch(function () {})
		prepStop = { promise: p, fire: fire, reason: null }
		// 准备阶段不收发串口，断线不会让任何等待自己结束：盯着连接状态，断了就走同一条取消路径
		prepWatch = setInterval(function () {
			if (!linkOpen()) cancelPrepare(new StopError(I18n.t('fwUp.portDisconnected'), true))
		}, 200)
	}
	// 在途差分由 buildAutoPackage 的 finally 结束 Worker(等待被这里打断后立即走到)
	function cancelPrepare(reason) {
		const r = reason || new StopError(I18n.t('fwUp.stopped'))
		// 先记原因再 abort：被中止的请求先报错时，调用方据此认出这是取消而不是普通失败
		if (prepStop && !prepStop.reason) prepStop.reason = r
		if (prepAbort) prepAbort.abort()
		if (prepStop) prepStop.fire(r)
	}
	function endPrepare() {
		clearInterval(prepWatch)
		prepWatch = 0
		prepAbort = null
		prepStop = null
	}
	function prepInterrupted(e) {
		if (e && e.disconnected) log(I18n.t('fwUp.portDisconnectedAutoUpgradeAborted'), 'error')
	}
	// 等一个准备阶段的异步结果；停止后立即抛 StopError，迟到的结果丢弃
	function untilStopped(promise) {
		if (prepStop && prepStop.reason) return Promise.reject(prepStop.reason)
		if (stopFlag) return Promise.reject(new StopError(I18n.t('fwUp.stopped')))
		return prepStop ? Promise.race([promise, prepStop.promise]) : promise
	}

	// 累积接收字节, 提取一个完整的 PCP 帧(起始 0xFFFE + 8字节头 + dataLength)
	function firmwareTurnaroundMs() {
		const sid = serialApi.getMode() === 'single' ? 'S' : serialApi.getActiveSendSid()
		try {
			const transport = fwLink ? fwLink.transport() : (window.serialLanes && window.serialLanes.transportOf(sid))
			if (transport === 'ble') return 0
		} catch (_) { /* 未能确认 BLE 时保留原有串口周转时间 */ }
		return 200
	}
	async function writeFirmware(bytes) {
		let timing
		if (fwLink) {
			timing = await fwLink.write(bytes)
		} else {
			// getActiveSendSid 是 UI 路号：单路返回 A；writeRawTo 要的是真正的物理 S/A/B。
			const sid = serialApi.getMode() === 'single' ? 'S' : serialApi.getActiveSendSid()
			timing = await serialApi.writeRawTo(sid, bytes, { token: fwTxToken })
		}
		// 只读诊断，不改原始 TX 行的「开始写」时间；完成表示后端写入兑现，并非设备处理完成。
		if (timing) emit(Object.assign({ type: 'write', code: bytes[3] }, timing))
		return timing
	}
	function tryReadFrame() {
		// 只移动读游标，整批处理完再回收前缀，避免多帧粘包时反复搬移整个数组。
		while (recvBuffer.length - recvOffset >= 8) {
			if (recvBuffer[recvOffset] !== 0xFF || recvBuffer[recvOffset + 1] !== 0xFE) {
				recvOffset++
				continue
			}
			const dataLength = (recvBuffer[recvOffset + 6] << 8) | recvBuffer[recvOffset + 7]
			const total = 8 + dataLength
			if (recvBuffer.length - recvOffset < total) break
			const frame = Uint8Array.from(recvBuffer.slice(recvOffset, recvOffset + total))
			recvOffset += total
			return frame
		}
		return null
	}

	// 常驻接收: 把所有串口原始字节累积进 recvBuffer, 并尝试派发给正在等待的 waiter
	let waiters = []
	// 只接纳当前通知被允许之后的下载消息；ACK 与请求可能在同一读回中。
	// 有界去重队列覆盖 await 的微任务间隙与写入期间，不把普通流量带到下一轮。
	let transferInbox = null
	const receiveDropReasons = new Set()
	function dropFirmwareFrame(reason) {
		if (!receiveDropReasons.has(reason) && receiveDropReasons.size < 10) {
			receiveDropReasons.add(reason)
			log(I18n.t('fwUp.ignoredUpgradeFrame', { reason }), 'warn')
		}
		return false
	}
	function beginTransferInbox(version, totalChunks) {
		// 与通知帧相同的 16 字节 UTF-8 截取 / NUL 终止语义，不按 UI 原始字符串猜版本。
		transferInbox = { version: PCP.bytesToVersion(PCP.versionToBytes(version)), totalChunks, accepted: false, frames: [] }
	}
	function cancelFirmwareWaiters(error) {
		for (const w of waiters.splice(0)) {
			clearTimeout(w.timer)
			w.reject(error)
		}
	}
	function clearTransferInbox() {
		transferInbox = null
		receiveDropReasons.clear()
		recvBuffer = []
		recvOffset = 0
	}
	function validTransferMessage(parsed, frame) {
		if (stopFlag) return false
		if (!transferInbox || !transferInbox.accepted) return dropFirmwareFrame(I18n.t('fwUp.upgradeNotYetAllowed'))
		if (parsed.messageCode === PCPMessageCode.DOWNLOAD_RESULT) {
			return parsed.dataLength >= 1 || dropFirmwareFrame(I18n.t('fwUp.downloadResultTooShort'))
		}
		if (parsed.dataLength < 18) return dropFirmwareFrame(I18n.t('fwUp.downloadRequestTooShort'))
		const req = PCP.parseDownloadRequest(frame)
		if (req.targetVersion !== transferInbox.version) return dropFirmwareFrame(I18n.t('fwUp.targetVersionMismatch'))
		if (req.chunkIndex >= transferInbox.totalChunks) return dropFirmwareFrame(I18n.t('fwUp.chunkIndexOutOfRange'))
		return true
	}
	const onFirmwareRx = (data) => {
		if (!data || !data.length) return
		// 未升级也未查询时，不让普通串口流量进入固件帧解析器。
		if (!running && !waiters.length) { recvBuffer = []; recvOffset = 0; return }
		// 不能用 push(...data)：单次读回可能上万字节，展开成实参会超出调用栈上限抛 RangeError，这块数据就被静默丢掉
		for (let i = 0; i < data.length; i++) recvBuffer.push(data[i])
		let frame
		while ((frame = tryReadFrame())) {
			const parsed = PCP.parseMessage(frame)
			if (!parsed) continue
			// parseMessage 也返回校验失败的视图，升级收发只能使用完整有效的协议帧。
			if (!parsed.checksumValid) { dropFirmwareFrame(I18n.t('fwUp.checksumError')); continue }
			if (parsed.version !== PCP.PROTOCOL_VERSION) { dropFirmwareFrame(I18n.t('fwUp.protocolVersionMismatch')); continue }
			if (parsed.messageCode === PCPMessageCode.NEW_VERSION_NOTIFY && parsed.dataLength < 1) { dropFirmwareFrame(I18n.t('fwUp.notifyAckTooShort')); continue }
			const transfer = parsed.messageCode === PCPMessageCode.DOWNLOAD_REQUEST || parsed.messageCode === PCPMessageCode.DOWNLOAD_RESULT
			if (transfer && !validTransferMessage(parsed, frame)) continue
			let delivered = false
			for (let i = waiters.length - 1; i >= 0; i--) {
				const w = waiters[i]
				if (w.codes.indexOf(parsed.messageCode) !== -1) {
					waiters.splice(i, 1)
					clearTimeout(w.timer)
					if (transferInbox && parsed.messageCode === PCPMessageCode.NEW_VERSION_NOTIFY && parsed.dataLength >= 1) {
						transferInbox.accepted = parsed.data[0] === 0
					}
					delivered = true
					w.resolve(frame)
				}
			}
			if (transfer && !delivered) {
				const queue = transferInbox.frames
				if (!queue.some(f => f.length === frame.length && f.every((b, i) => b === frame[i]))) {
					if (queue.length < 16) queue.push(frame)
					else dropFirmwareFrame(I18n.t('fwUp.pendingMessageQueueFull'))
				}
			}
		}
		if (recvOffset) { recvBuffer.splice(0, recvOffset); recvOffset = 0 }
		// PCP 最大帧为 8 + 65535 字节，保留尚未收全的最大帧。
		if (recvBuffer.length > 65543) recvBuffer.splice(0, recvBuffer.length - 65543)
	}
	if (fwLink) fwLink.onReceive(onFirmwareRx)
	else serialApi.onReceive(onFirmwareRx)

	// 发送数据并等待指定消息码的响应(可同时等待多个消息码), 带超时
	function sendAndWait(reqBytes, expectCodes, timeout) {
		const codes = Array.isArray(expectCodes) ? expectCodes : [expectCodes]
		return new Promise((resolve, reject) => {
			let writeTask
			const w = {
				codes,
				// RX 可能在最后一片写入兑现前到达；释放 writer 后才进入下一步。
				resolve(frame) { Promise.resolve().then(() => writeTask).then(() => resolve(frame), reject) },
				reject,
				timer: setTimeout(() => {
					const idx = waiters.indexOf(w)
					if (idx !== -1) waiters.splice(idx, 1)
					reject(new Error(I18n.t('fwUp.responseTimedOut')))
				}, timeout),
			}
			waiters.push(w)
			const failWrite = (error) => {
				// 只撤掉这笔等待；若应答/超时已经结束它，迟到的写失败也不影响别的事务。
				const idx = waiters.indexOf(w)
				if (idx === -1) return
				waiters.splice(idx, 1)
				clearTimeout(w.timer)
				reject(error)
			}
			try {
				writeTask = Promise.resolve(writeFirmware(reqBytes))
				writeTask.catch(failWrite)
			} catch (error) {
				failWrite(error)
				return
			}
			log(I18n.t('fwUp.sent', { bytesToHex: bytesToHex(reqBytes) }), 'info')
		})
	}

	function bytesToHex(arr) {
		return Array.from(arr).map(b => ('0' + b.toString(16).toUpperCase()).slice(-2)).join(' ')
	}

	// 自动升级：查设备版本 → 固件库找原固件 → 内存里生成差分包(找到唯一一份)或压缩包 → 照常升级；
	// 设备以「校验失败 / 不支持该包类型」拒收差分包时，应答该结果后改用压缩包重来一次
	async function runAuto(src) {
		let deviceVersion = ''
		try {
			const resp = await sendAndWait(PCP.buildQueryVersionRequest(), PCPMessageCode.QUERY_VERSION, 5000)
			const res = PCP.parseQueryVersionResponse(resp)
			if (res.resultCode !== 0) {
				log(I18n.t('fwUp.versionQueryFailed0x', { resultCode: res.resultCode.toString(16) }), 'error')
				return
			}
			deviceVersion = res.version
			log(I18n.t('fwUp.deviceVersion2', { deviceVersion }), 'success')
			emit({ type: 'device-version', ok: true, source: 'upgrade', version: deviceVersion })
		} catch (e) {
			if (upgradeInterrupted(e)) return
			log(I18n.t('fwUp.versionQueryTimedOut', { message: e.message }), 'error')
			return
		}
		if (stopFlag) return
		beginPrepare()
		let plan = null
		let pkg = null
		try {
			let candidates = []
			if (library) {
				try {
					await untilStopped(librarySaving)
					candidates = await untilStopped(library.findByVersion(deviceVersion))
				} catch (e) {
					if (e instanceof StopError) throw e
					log(I18n.t('fwUp.readingTheFirmwareLibraryFailedUsing', { v: (e && e.message || e) }), 'warn')
				}
			}
			plan = Core.planUpgrade({ deviceVersion, candidates })
			const why = { 'no-device-version': I18n.t('fwUp.theDeviceDidnTReportA'), 'not-found': I18n.t('fwUp.noRawFirmwareForInThe', { deviceVersion }), 'ambiguous': I18n.t('fwUp.theLibraryHasDifferentBuildsOf', { deviceVersion, count: plan.count }) }
			if (plan.mode === 'diff') log(I18n.t('fwUp.foundRawFirmwareInTheLibrary', { v: (plan.base.name || deviceVersion) }), 'info')
			else log(I18n.t('fwUp.buildingACompressedPackage', { v: (why[plan.reason] || '') }), 'info')
			pkg = await buildAutoPackage(plan, src)
		} catch (e) {
			if (!(e instanceof StopError)) throw e
			prepInterrupted(e)
			return
		} finally {
			endPrepare()
		}
		if (!pkg || stopFlag) return
		await runUpgrade(pkg)
		if (!outcomeOk && !stopFlag && Core.shouldFallbackToCompress(plan.mode, lastDownloadStatus)) {
			log(I18n.t('fwUp.theDeviceRejectedTheDiffPackage'), 'warn')
			// 先应答这次失败的下载结果，设备收尾后才接新一轮通知；应答都发不出去就不再重来
			try {
				await writeFirmware(PCP.buildDownloadResultAck(0))
			} catch (e) {
				log(I18n.t('fwUp.acknowledgingTheDownloadResultFailedNot', { v: (e && e.message || e) }), 'error')
				return
			}
			lastError = ''
			emit({ type: 'retry', reason: 'diff-rejected', status: lastDownloadStatus })
			// 之后成功的是压缩包：被拒的差分基准不能记成「最近用过」
			plan = { mode: 'compress', reason: 'device-rejected' }
			beginPrepare()
			try {
				pkg = await buildAutoPackage(plan, src)
			} catch (e) {
				if (!(e instanceof StopError)) throw e
				prepInterrupted(e)
				return
			} finally {
				endPrepare()
			}
			if (!pkg || stopFlag) return
			await runUpgrade(pkg)
		}
		if (outcomeOk && plan.mode === 'diff' && library) library.touch(plan.base.key).catch(function () {})
	}

	let blankData = null
	async function loadBlank() {
		if (blankData) return blankData
		try {
			// 取不到就用内置默认值；给个超时，网络挂住也不拖住升级
			const timer = setTimeout(function () { if (prepAbort) prepAbort.abort() }, 5000)
			try {
				const r = await untilStopped(fetch('imgs/BLANK.BIN', prepAbort ? { signal: prepAbort.signal } : undefined))
				if (!r.ok) throw new Error('HTTP ' + r.status)
				blankData = new Uint8Array(await untilStopped(r.arrayBuffer()))
			} finally {
				clearTimeout(timer)
			}
		} catch (e) {
			if (e instanceof StopError) throw e
			if (prepStop && prepStop.reason) throw prepStop.reason
			if (stopFlag) throw new StopError(I18n.t('fwUp.stopped'))
			blankData = Core.BLANK_BUILTIN
		}
		return blankData
	}

	// 生成并解析一个内存里的升级包；失败记日志返回 null，停止抛 StopError。生成完立即释放差分 Worker(WASM 内存)，不留到传输结束
	async function buildAutoPackage(plan, src) {
		const type = plan.mode === 'diff' ? 'diff' : 'compress'
		const label = type === 'diff' ? I18n.t('fwUp.diffPackage') : I18n.t('fwUp.compressedPackage')
		try {
			const base = type === 'diff' ? plan.base.data : await loadBlank()
			if (stopFlag) throw new StopError(I18n.t('fwUp.stopped'))
			const data = await untilStopped(Core.buildPackage(type, src.rawData, base, diffRunner.createPatch))
			if (stopFlag) throw new StopError(I18n.t('fwUp.stopped'))
			const r = FirmwareParser.parse(data.buffer)
			if (!r.ok) {
				log(I18n.t('fwUp.generatedPackageFailedVerification', { error: r.error }), 'error')
				return null
			}
			if (r.version !== src.version) {
				log(I18n.t('fwUp.generatedPackageVersionDiffersFromThe', { v: (r.version || I18n.t('fwUp.empty')), version: src.version }), 'error')
				return null
			}
			r.fileName = src.fileName
			log(I18n.t('fwUp.builtRawFirmware', { label, fmtSize: fmtSize(data.length), fmtSize2: fmtSize(src.rawData.length) }), 'success')
			return r
		} catch (e) {
			if (e instanceof StopError) throw e
			if (prepStop && prepStop.reason) throw prepStop.reason
			if (stopFlag) throw new StopError(I18n.t('fwUp.stopped'))
			log(I18n.t('fwUp.failed', { label, v: (e && e.message || e) }), 'error')
			return null
		} finally {
			diffRunner.dispose()
		}
	}

	async function runUpgrade(target) {
		clearTransferInbox()
		try { await performUpgrade(target) } finally { clearTransferInbox() }
	}

	async function performUpgrade(target) {
		const chunkSize = parseInt(el.chunkSize.value) || 128
		const firmwareData = target.firmwareData
		const totalChunks = Math.ceil(firmwareData.length / chunkSize)
		// 手动模式(不读包头)取输入框里的版本，其余取包头里的版本
		const version = target.raw ? el.version.value.trim() : target.version
		lastDownloadStatus = null
		log(I18n.t('fwUp.startingFirmwareUpgradeVersionChunks', { version, totalChunks }), 'info')
		emit({ type: 'plan', version: version, chunkSize: chunkSize, totalChunks: totalChunks, size: firmwareData.length })

		// 步骤1: 查询设备版本
		if (stopFlag) return
		emit({ type: 'phase', name: 'query' })
		try {
			const resp = await sendAndWait(PCP.buildQueryVersionRequest(), PCPMessageCode.QUERY_VERSION, 5000)
			const res = PCP.parseQueryVersionResponse(resp)
			if (res.resultCode !== 0) {
				log(I18n.t('fwUp.versionQueryFailed0x', { resultCode: res.resultCode.toString(16) }), 'error')
				return
			}
			log(I18n.t('fwUp.deviceVersion', { version: res.version }), 'success')
			emit({ type: 'device-version', ok: true, source: 'upgrade', version: res.version })
			setProgress(15)
		} catch (e) {
			if (upgradeInterrupted(e)) return
			log(I18n.t('fwUp.versionQueryTimedOut', { message: e.message }), 'error')
			return
		}

		// 步骤2: 通知新版本
		if (stopFlag) return
		beginTransferInbox(version, totalChunks)
		emit({ type: 'phase', name: 'notify' })
		try {
			const resp = await sendAndWait(
				PCP.buildNewVersionNotify(version, chunkSize, totalChunks),
				PCPMessageCode.NEW_VERSION_NOTIFY, 5000)
			const res = PCP.parseNewVersionNotifyResponse(resp)
			const errMap = {
				0x01: I18n.t('fwUp.deviceBusy'), 0x02: I18n.t('fwUp.poorSignal'), 0x03: I18n.t('fwUp.alreadyUpToDate'),
				0x04: I18n.t('fwUp.lowBattery'), 0x05: I18n.t('fwUp.notEnoughStorage'), 0x09: I18n.t('fwUp.outOfMemory'), 0x7F: I18n.t('fwUp.internalError'),
			}
			if (res.resultCode !== 0) {
				log(I18n.t('fwUp.theDeviceRefusedTheUpgrade', { v: (errMap[res.resultCode] || ('0x' + res.resultCode.toString(16))) }), 'error')
				return
			}
			log(I18n.t('fwUp.theDeviceAcceptedTheUpgrade'), 'success')
			setProgress(25)
		} catch (e) {
			if (upgradeInterrupted(e)) return
			log(I18n.t('fwUp.newVersionNoticeTimedOut'), 'error')
			return
		}

		// 步骤3: 分片下载传输
		if (stopFlag) return
		const sentChunks = new Set()
		let pendingMessage = null
		emit({ type: 'phase', name: 'transfer' })
		try {
			// 设备请求哪个分片就回哪个分片; 收到下载结果(0x16)即视为传输完成
			while (true) {
				if (stopFlag) return
				let requestData
				if (pendingMessage) {
					requestData = pendingMessage
					pendingMessage = null
				} else {
					// 同时等待分片请求(0x15)与下载结果上报(0x16)
					requestData = await waitForCode([PCPMessageCode.DOWNLOAD_REQUEST, PCPMessageCode.DOWNLOAD_RESULT], 10000)
				}
				if (!requestData) {
					log(I18n.t('fwUp.timedOutWaitingForTheDevice', { size: sentChunks.size, totalChunks }), 'error')
					return
				}
				const parsed = PCP.parseMessage(requestData)
				if (parsed.messageCode === PCPMessageCode.DOWNLOAD_RESULT) {
					log(I18n.t('fwUp.theDeviceReportedItsDownloadResult'), 'info')
					pendingMessage = requestData
					break
				}
				if (parsed.messageCode !== PCPMessageCode.DOWNLOAD_REQUEST) {
					log(I18n.t('fwUp.unexpectedMessage', { messageCodeName: PCP.messageCodeName(parsed.messageCode) }), 'warn')
					continue
				}
				const req = PCP.parseDownloadRequest(requestData)
				const idx = req.chunkIndex
				if (idx >= totalChunks) {
					log(I18n.t('fwUp.theDeviceRequestedAnInvalidChunk', { idx }), 'warn')
					continue
				}
				emit({ type: 'request', index: idx, resend: sentChunks.has(idx), total: totalChunks })
				const start = idx * chunkSize
				const end = Math.min(start + chunkSize, firmwareData.length)
				let chunk = firmwareData.subarray(start, end)
				// 末尾不足一个分包大小需用 0xFF 补齐
				if (chunk.length < chunkSize) {
					const padded = new Uint8Array(chunkSize)
					padded.set(chunk, 0)
					padded.fill(0xFF, chunk.length)
					chunk = padded
				}
				const resp = PCP.buildDownloadResponse(idx, chunk, version)
				// 只对确认的 BLE 链路省去周转等待，普通串口 / SPP / 未知传输保持原来的 200ms。
				const turnaround = firmwareTurnaroundMs()
				if (turnaround) await sleep(turnaround)
				if (stopFlag || !linkOpen()) return
				const timing = await writeFirmware(resp)
				const isResend = sentChunks.has(idx)
				log(I18n.t('fwUp.sentChunkBytes', { bytesToHex: bytesToHex(resp.slice(0, 50)), idx, length: chunk.length, v: (isResend ? I18n.t('fwUp.resent') : ''), v2: (timing ? I18n.t('fwUp.backendWriteDoneMs', { durationMs: timing.durationMs }) : '') }), 'info')
				sentChunks.add(idx)
				const done = sentChunks.size
				emit({ type: 'chunk', index: idx, resend: isResend, sent: done, total: totalChunks, bytes: chunk.length })
				setProgress(25 + Math.floor(done / totalChunks * 45))
				if (done % 10 === 0 || done === totalChunks) {
					log(I18n.t('fwUp.transferredChunks', { done, totalChunks }), 'info')
				}
			}
			log(I18n.t('fwUp.firmwareTransferCompleteChunks', { size: sentChunks.size }), 'success')
		} catch (e) {
			if (upgradeInterrupted(e)) return
			log(I18n.t('fwUp.downloadError', { message: e.message }), 'error')
			return
		}

		// 步骤4: 上报下载结果
		if (stopFlag) return
		emit({ type: 'phase', name: 'result' })
		try {
			let reportData = pendingMessage
			if (!reportData) reportData = await waitForCode(PCPMessageCode.DOWNLOAD_RESULT, 30000)
			if (!reportData) {
				log(I18n.t('fwUp.timedOutWaitingForTheDownload'), 'error')
				return
			}
			const res = PCP.parseDownloadResultReport(reportData)
			lastDownloadStatus = res.downloadStatus
			const errMap = {
				0x05: I18n.t('fwUp.notEnoughStorage'), 0x06: I18n.t('fwUp.downloadTimedOut'), 0x07: I18n.t('fwUp.packageVerificationFailed'),
				0x08: I18n.t('fwUp.packageTypeNotSupportedTheDevice'),
			}
			if (res.downloadStatus !== 0) {
				log(I18n.t('fwUp.deviceDownloadFailed', { v: (errMap[res.downloadStatus] || ('0x' + res.downloadStatus.toString(16))) }), 'error')
				return
			}
			await writeFirmware(PCP.buildDownloadResultAck(0))
			log(I18n.t('fwUp.deviceDownloadSucceeded'), 'success')
			setProgress(80)
		} catch (e) {
			if (upgradeInterrupted(e)) return
			log(I18n.t('fwUp.errorHandlingTheDownloadResult', { message: e.message }), 'error')
			return
		}

		// 步骤5: 执行升级
		if (stopFlag) return
		emit({ type: 'phase', name: 'execute' })
		try {
			await sleep(500)
			if (stopFlag || !linkOpen()) return
			await writeFirmware(PCP.buildExecuteUpgradeRequest())
			log(I18n.t('fwUp.upgradeCommandSentTheDeviceIs'), 'success')
			setProgress(100)
			log(I18n.t('fwUp.upgradeComplete'), 'success')
			outcomeOk = true
		} catch (e) {
			if (upgradeInterrupted(e)) return
			log(I18n.t('fwUp.upgradeExecutionError', { message: e.message }), 'error')
		}
	}

	// 仅等待某一消息码(不自动发送), 带超时, 用于分片请求/下载结果
	function waitForCode(expectCode, timeout) {
		const codes = Array.isArray(expectCode) ? expectCode : [expectCode]
		if (transferInbox && !stopFlag) {
			const idx = transferInbox.frames.findIndex(frame => codes.indexOf(frame[3]) !== -1)
			if (idx !== -1) return Promise.resolve(transferInbox.frames.splice(idx, 1)[0])
		}
		return new Promise((resolve, reject) => {
			const w = {
				codes,
				resolve,
				reject,
				timer: setTimeout(() => {
					const idx = waiters.indexOf(w)
					if (idx !== -1) waiters.splice(idx, 1)
					resolve(null)
				}, timeout),
			}
			waiters.push(w)
		})
	}

	function sleep(ms) {
		return new Promise(r => setTimeout(r, ms))
	}

	// 串口打开状态变化时同步按钮
	const syncStartBtn = () => {
		el.start.disabled = !(fw && linkOpen())
	}

	// 供固件打包工具调用的外部接口
	window.setFwUpgradeFile = function (arrayBuffer, fileName) {
		fw = null
		fwFileBuffer = arrayBuffer
		el.fileName.dataset.name = fileName || 'packed_fw.bin'
		el.version.value = defaultVersionFromName(fileName || 'packed_fw.bin')
		showFileCard(fileName || 'packed_fw.bin', arrayBuffer.byteLength)
		log(I18n.t('fwUp.firmwareLoadedFromPackaging', { v: (fileName || 'packed_fw.bin'), fmtSize: fmtSize(arrayBuffer.byteLength) }), 'info')
		var parseBtn = document.getElementById('fw-parse')
		if (parseBtn) parseBtn.click()
	}
	if (el.libraryClear) {
		el.libraryClear.addEventListener('click', async function () {
			if (!library) return
			if (!await window.AppDialog.confirm(I18n.t('fwUp.clearTheLocalFirmwareLibraryWithout'), { title: I18n.t('fwUp.clearFirmwareLibrary'), okText: I18n.t('fwUp.clear'), danger: true })) return
			library.clear().then(function () {
				log(I18n.t('fwUp.localFirmwareLibraryCleared'), 'info')
				refreshLibrarySummary()
			}).catch(function (e) { log(I18n.t('fwUp.clearingTheFirmwareLibraryFailed', { v: (e && e.message || e) }), 'error') })
		})
	}
	refreshLibrarySummary()
	// 固件连接的系统消息(打开失败、断线、自动重连等)记进升级日志
	if (fwLink) document.addEventListener('serial-fw-log', function (e) {
		const msg = e && e.detail && e.detail.msg
		if (msg) log(msg, 'warn')
	})

	// 监听 serialApi 状态: 简单轮询 open 状态变化
	let lastOpen = linkOpen()
	setInterval(() => {
		const open = linkOpen()
		if (open !== lastOpen) {
			lastOpen = open
			syncStartBtn()
			if (!open && running) {
				clearTransferInbox()
				cancelFirmwareWaiters(new StopError(I18n.t('fwUp.portDisconnected'), true))
			}
		}
	}, 500)
})()
