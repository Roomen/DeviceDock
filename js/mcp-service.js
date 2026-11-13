// 本地 MCP 服务的界面：只在桌面客户端(提供了 AppPlatform.service('mcp') 且画像开启 service.mcp)里挂一个独立导航入口。
// 网页版 / 移动端没有这个服务，本文件什么都不做，也不注册任何监听。
// 令牌只在用户显式点「显示 / 复制」时经命令取回，放在内存里，关面板即清空；不写 localStorage、不打印日志。
;(function (root) {
	'use strict'
	const P = root.AppPlatform
	if (!P || !P.service || (P.has && !P.has('service.mcp'))) return
	const svc = P.service('mcp')
	if (!svc) return

	const doc = root.document
	let entry = null
	let latestStatus = null
	let opening = false
	let session = null // 当前打开的面板；关闭后置 null，迟到的异步结果一律丢弃

	function mk(tag, cls, text) {
		const el = doc.createElement(tag)
		if (cls) el.className = cls
		if (text != null) el.textContent = text
		return el
	}
	function toast(msg) {
		if (root.serialLanes && root.serialLanes.toast) root.serialLanes.toast(msg)
	}
	async function copyText(text) {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			try {
				await navigator.clipboard.writeText(text)
				toast(I18n.t('mcpService.copiedToClipboard'))
			} catch (e) { toast(I18n.t('mcpService.copyFailedRetryOrCopyThe')) }
		} else {
			toast(I18n.t('mcpService.clipboardIsnTAvailableHereSelect'))
		}
	}
	function baseUrl(status) {
		return status.url || 'http://127.0.0.1:' + (status.port || 38992) + '/mcp'
	}
	// 复制出去的是干净的 MCP 客户端 JSON，不带注释
	function configJson(status, token) {
		return JSON.stringify({
			mcpServers: {
				'devicedock': {
					type: 'http',
					url: baseUrl(status),
					headers: { Authorization: 'Bearer ' + (token || '<TOKEN>') },
				},
			},
		}, null, 2)
	}
	function cliCommand(status, token) {
		return 'claude mcp add --transport http devicedock ' + baseUrl(status) + ' --header "Authorization: Bearer ' + (token || '<TOKEN>') + '"'
	}
	function agentInstructions(status, token) {
		return [
			I18n.t('mcpService.connectToTheRunningMcpServer'),
			I18n.t('mcpService.transportStreamableHttpUrl', { baseUrl: baseUrl(status) }),
			I18n.t('mcpService.hereIsTheCompleteMcpClient'),
			'```json', configJson(status, token), '```',
			I18n.t('mcpService.claudeCodeCanAlsoRunThis'),
			'```sh', cliCommand(status, token), '```',
			I18n.t('mcpService.afterConnectingCallWindowsListFirst'),
			I18n.t('mcpService.serialToolsSerialOpenSerialClose'),
			I18n.t('mcpService.selectTheDeviceInTheApp'),
			I18n.t('mcpService.thisConfigContainsALocalAccess'),
		].join('\n\n')
	}

	// 复制动作本身即为取凭据的明确意图；不必先显示令牌，也不把令牌写进可见面板。
	async function copyConnection(s, format) {
		if (s.closed || s.copying) return
		s.copying = true
		render(s)
		try {
			const status = await svc.status()
			if (s.closed) return
			s.status = status
			if (!status || !status.running) {
				toast(I18n.t('mcpService.enableAndStartTheLocalMcp'))
				return
			}
			const token = String(await svc.revealToken())
			if (s.closed) return
			if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(I18n.t('mcpService.theAccessTokenIsUnavailableRe'))
			const text = format === 'agent' ? agentInstructions(status, token)
				: (format === 'cli' ? cliCommand(status, token) : configJson(status, token))
			await copyText(text)
		} catch (e) {
			if (!s.closed) toast(String((e && e.message) || e))
		} finally {
			s.copying = false
			render(s)
		}
	}

	function updateEntry(status) {
		latestStatus = status
		if (!entry) return
		const st = status || {}
		const state = st.running ? 'running' : st.lastError ? 'error' : st.enabled ? 'waiting' : 'off'
		const label = { running: I18n.t('mcpService.running'), error: I18n.t('mcpService.error'), waiting: I18n.t('mcpService.waitingToStart'), off: I18n.t('mcpService.off') }[state]
		entry.dataset.state = state
		entry.title = I18n.t('mcpService.localMcpServer2', { label })
		entry.setAttribute('aria-label', entry.title)
	}

	function mountEntry() {
		const rail = doc.querySelector('#activity-rail .rail-bottom')
		if (!rail || doc.getElementById('serial-mcp-service')) return
		entry = mk('button', 'rail-item rail-mcp')
		entry.type = 'button'
		entry.id = 'serial-mcp-service'
		entry.dataset.feature = 'service.mcp'
		entry.appendChild(mk('i', 'icon icon-server'))
		entry.appendChild(mk('span', 'rail-label', 'MCP'))
		const dot = mk('span', 'rail-status-dot')
		dot.setAttribute('aria-hidden', 'true')
		entry.appendChild(dot)
		entry.addEventListener('click', function () { openPanel() })
		rail.insertBefore(entry, rail.firstChild)
		updateEntry(latestStatus)
		// 订阅先于读取；若读取期间收到了新状态，不用旧快照覆盖它。
		const snapshot = latestStatus
		Promise.resolve(svc.status()).then(function (status) {
			if (latestStatus === snapshot) updateEntry(status)
		}, function () { if (latestStatus === snapshot) updateEntry({ lastError: true }) })
	}

	function buildPanel(body, s) {
		body.classList.toggle('mdn-mcp-panel', true)
		s.statusLine = mk('div', 'mdn-mcp-status')
		s.urlLine = mk('div', 'mdn-mcp-url')
		s.urlLine.hidden = true

		const portRow = mk('div', 'mdn-mcp-row')
		const portLabel = mk('label', 'mdn-mcp-label', I18n.t('mcpService.port'))
		s.port = mk('input', 'form-control form-control-sm mdn-mcp-port')
		s.port.type = 'number'
		s.port.value = String((s.status && s.status.port) || 38992)
		s.port.min = '1024'
		s.port.max = '65535'
		s.port.setAttribute('inputmode', 'numeric')
		portLabel.appendChild(s.port)
		portRow.appendChild(portLabel)
		s.toggleBtn = mk('button', 'btn btn-sm btn-primary', I18n.t('mcpService.enableServer'))
		s.toggleBtn.type = 'button'
		s.startBtn = mk('button', 'btn btn-sm btn-outline-primary', I18n.t('mcpService.start'))
		s.startBtn.type = 'button'
		s.startBtn.hidden = true
		portRow.appendChild(s.toggleBtn)
		portRow.appendChild(s.startBtn)
		body.appendChild(s.statusLine)
		body.appendChild(s.urlLine)
		body.appendChild(portRow)
		s.copyAgentBtn = mk('button', 'btn btn-sm btn-primary', I18n.t('mcpService.copyForAgent'))
		s.copyAgentBtn.type = 'button'
		s.copyAgentBtn.title = I18n.t('mcpService.copyTheFullSetupInstructionsServer')
		body.appendChild(s.copyAgentBtn)

		const tokenRow = mk('div', 'mdn-mcp-row')
		s.tokenBox = mk('code', 'mdn-mcp-token', I18n.t('mcpService.hidden'))
		s.revealBtn = mk('button', 'btn btn-sm btn-outline-secondary', I18n.t('mcpService.showToken'))
		s.revealBtn.type = 'button'
		s.copyTokenBtn = mk('button', 'btn btn-sm btn-outline-secondary', I18n.t('mcpService.copyToken'))
		s.copyTokenBtn.type = 'button'
		s.regenBtn = mk('button', 'btn btn-sm btn-outline-danger', I18n.t('mcpService.regenerate'))
		s.regenBtn.type = 'button'
		tokenRow.appendChild(s.tokenBox)
		tokenRow.appendChild(s.revealBtn)
		tokenRow.appendChild(s.copyTokenBtn)
		tokenRow.appendChild(s.regenBtn)
		body.appendChild(tokenRow)

		const configHead = mk('div', 'mdn-mcp-section-head')
		configHead.appendChild(mk('div', 'mdn-mcp-sub', I18n.t('mcpService.clientConfig')))
		s.copyCfgBtn = mk('button', 'btn btn-sm btn-outline-secondary', I18n.t('mcpService.copyConfig'))
		s.copyCfgBtn.type = 'button'
		s.cfg = mk('pre', 'mdn-mcp-cfg')
		configHead.appendChild(s.copyCfgBtn)
		body.appendChild(configHead)
		body.appendChild(s.cfg)
		const cliHead = mk('div', 'mdn-mcp-section-head')
		cliHead.appendChild(mk('div', 'mdn-mcp-sub', 'Claude Code'))
		s.copyCliBtn = mk('button', 'btn btn-sm btn-outline-secondary', I18n.t('mcpService.copyCommand'))
		s.copyCliBtn.type = 'button'
		s.cli = mk('pre', 'mdn-mcp-cfg')
		cliHead.appendChild(s.copyCliBtn)
		body.appendChild(cliHead)
		body.appendChild(s.cli)
		body.appendChild(mk('div', 'mdn-mcp-hint', I18n.t('mcpService.listensOn127001')))

		s.toggleBtn.addEventListener('click', function () { toggleService(s) })
		s.startBtn.addEventListener('click', function () { toggleService(s, true) })
		s.revealBtn.addEventListener('click', function () {
			if (s.token) {
				s.token = ''
				render(s)
				return
			}
			revealInto(s)
		})
		s.copyTokenBtn.addEventListener('click', function () {
			if (s.token) {
				copyText(s.token)
				return
			}
			revealInto(s, function (token) { copyText(token) })
		})
		s.regenBtn.addEventListener('click', function () { regenerate(s) })
		s.copyAgentBtn.addEventListener('click', function () { copyConnection(s, 'agent') })
		s.copyCfgBtn.addEventListener('click', function () { copyConnection(s, 'json') })
		s.copyCliBtn.addEventListener('click', function () { copyConnection(s, 'cli') })
	}

	async function revealInto(s, after) {
		try {
			const token = String(await svc.revealToken())
			if (!s || s.closed) return // 面板已关：迟到的令牌不再写回页面
			s.token = token
			render(s)
			if (after) after(token)
		} catch (e) {
			if (s && !s.closed) toast(String((e && e.message) || e))
		}
	}

	async function toggleService(s, forceStart) {
		const st = s.status || {}
		s.busy = true
		render(s)
		try {
			if (st.running || st.enabled) {
				if (forceStart) await svc.enable(Number(s.port.value) || undefined)
				else await svc.disable()
			} else {
				await svc.enable(Number(s.port.value) || undefined)
			}
		} catch (e) {
			if (!s.closed) toast(String((e && e.message) || e))
		} finally {
			s.busy = false
			if (!s.closed) await refresh(s, true)
		}
	}

	// 面板内两步确认，不再嵌套 AppDialog(它是单模态，会把确认框排在面板后面死等)
	function regenerate(s) {
		if (!s.regenArmed) {
			s.regenArmed = true
			render(s)
			clearTimeout(s.regenTimer)
			s.regenTimer = setTimeout(function () {
				if (s.closed) return
				s.regenArmed = false
				render(s)
			}, 5000)
			return
		}
		clearTimeout(s.regenTimer)
		s.regenArmed = false
		svc.regenerateToken().then(function (status) {
			if (s.closed) return
			s.token = ''
			s.status = status || s.status
			render(s)
			toast(I18n.t('mcpService.tokenRegeneratedUpdateExistingClientConfigs'))
		}, function (e) {
			if (!s.closed) toast(String((e && e.message) || e))
		})
	}

	function render(s) {
		if (!s || s.closed) return
		const st = s.status || {}
		const running = !!st.running
		let text
		if (running) text = I18n.t('mcpService.running')
		else if (st.starting) text = I18n.t('mcpService.starting')
		else if (st.enabled && st.lastError) text = I18n.t('mcpService.failedToStart', { lastError: st.lastError })
		else if (st.enabled && st.waitingForWindow) text = I18n.t('mcpService.enabledStartsOnceTheWindowIs')
		else if (st.enabled) text = I18n.t('mcpService.enabledNotRunning')
		else text = I18n.t('mcpService.offDefault')
		s.statusLine.textContent = text
		s.statusLine.classList.toggle('is-on', running)
		s.statusLine.classList.toggle('is-error', !!(st.enabled && st.lastError))
		s.urlLine.hidden = !running
		s.urlLine.textContent = running ? baseUrl(st) : ''
		if (doc.activeElement !== s.port) s.port.value = String(st.port || 38992)
		s.port.disabled = running || !!s.busy
		s.toggleBtn.disabled = !!s.busy
		s.toggleBtn.textContent = st.enabled ? I18n.t('mcpService.disableServer') : I18n.t('mcpService.enableServer')
		s.startBtn.hidden = !(st.enabled && !running)
		s.startBtn.disabled = !!s.busy
		const copyButtons = [s.copyAgentBtn, s.copyCfgBtn, s.copyCliBtn]
		copyButtons.forEach(function (button) {
			button.disabled = !!s.copying || !!s.busy || !running
		})
		s.tokenBox.textContent = s.token || I18n.t('mcpService.hidden')
		s.revealBtn.textContent = s.token ? I18n.t('mcpService.hideToken') : I18n.t('mcpService.showToken')
		s.regenBtn.textContent = s.regenArmed ? I18n.t('mcpService.confirmRegenerate') : I18n.t('mcpService.regenerate')
		s.cfg.textContent = configJson(st, s.token)
		s.cli.textContent = cliCommand(st, s.token)
	}

	async function refresh(s, force) {
		if (!s || s.closed) return
		try {
			const status = await svc.status()
			updateEntry(status)
			if (!s.closed) s.status = status
		} catch (e) {
			if (force && !s.closed) s.status = Object.assign({}, s.status, { lastError: String((e && e.message) || e) })
		}
		render(s)
	}

	async function openPanel() {
		if (opening || session) return
		opening = true
		let status = null
		try { status = await svc.status() } catch (e) { status = { lastError: String((e && e.message) || e) } }
		const s = { status: status, token: '', busy: false, regenArmed: false, regenTimer: 0, closed: false }
		opening = false
		session = s
		root.AppDialog.panel({
			title: I18n.t('mcpService.localMcpServer'),
			wide: true,
			closeText: I18n.t('mcpService.close'),
			build: function (body) { buildPanel(body, s) },
		}).then(function () {
			s.closed = true
			s.token = ''
			clearTimeout(s.regenTimer)
			if (session === s) session = null
		})
		render(s)
	}

	Promise.resolve(svc.listen('mcp-service', function (status) {
		updateEntry(status)
		if (!session) return
		session.status = status || session.status
		render(session)
	})).catch(function () {})

	// 状态栏芯片(js/workbench.js TASKS)的只读接口：状态由 updateEntry / listen 保持新鲜，open 打开本面板
	function statusState() {
		const st = latestStatus || {}
		return st.running ? 'running' : st.lastError ? 'error' : st.enabled ? 'waiting' : 'off'
	}
	root.McpServiceStatus = {
		state: statusState,
		label: function () {
			return { running: I18n.t('mcpService.running'), error: I18n.t('mcpService.error'), waiting: I18n.t('mcpService.waitingToStart'), off: I18n.t('mcpService.off') }[statusState()]
		},
		port: function () {
			const st = latestStatus || {}
			return st.port || 38992
		},
		open: function () { openPanel() },
	}

	if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mountEntry)
	else mountEntry()
})(typeof window !== 'undefined' ? window : globalThis)
