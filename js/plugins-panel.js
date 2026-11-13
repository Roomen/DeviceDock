// 插件管理（仅桌面客户端）：配置页「插件」分组的内容。
// 与协议来源面板共用 .mdn-src-* 卡片视觉，内容原样构建进配置页的分组容器，面板内不嵌套 AppDialog：
// 安装 / 更新确认与卸载确认都在分组内完成，列出能力（人话描述）、来源仓库、版本差异与 sha256 前 12 位。
// GitHub 令牌在配置页「账号与令牌」分组里设置（与协议来源共用同一个钥匙串条目），这里不再重复。
;(function (root) {
	'use strict'

	const P = root.AppPlatform
	const Rpc = root.DeviceDockPluginRpc
	if (!P || !Rpc || !root.document) return
	if (typeof P.has === 'function' && !P.has('plugins')) return
	const svc = P.service && P.service('plugins')
	if (!svc) return

	const doc = root.document
	let session = null

	function mk(tag, cls, text) {
		const el = doc.createElement(tag)
		if (cls) el.className = cls
		if (text != null) el.textContent = text
		return el
	}
	function iconBtn(icon, title) {
		const b = mk('button', 'mdn-src-icon-btn')
		b.type = 'button'
		b.title = title
		b.setAttribute('aria-label', title)
		b.appendChild(mk('i', 'icon icon-sm icon-' + icon))
		return b
	}
	function shortSha(sha) {
		const s = String(sha || '').replace(/^sha256-/, '')
		return s ? s.slice(0, 12) : ''
	}

	function build(body, s) {
		body.classList.add('mdn-src-panel', 'mdn-plg-panel')
		body.appendChild(mk('p', 'mdn-src-intro',
			'插件从 GitHub Release 下载并经 SHA-256 校验，在独立沙箱 iframe 中隔离运行，只能按授予的能力调用宿主接口。更新版本或能力变化时须重新确认。'))

		// 插件根目录 / 锁失败时整个子系统不可用：顶部说明原因，客户端仍照常运行
		s.statusEl = mk('div', 'mdn-src-err mdn-plg-status')
		s.statusEl.hidden = true
		body.appendChild(s.statusEl)
		// 顶部常显：安装事务恢复失败 / 停用或卸载后仍未释放的资源（即使插件已卸载也在）
		s.issuesEl = mk('div', 'mdn-plg-issues')
		s.issuesEl.hidden = true
		body.appendChild(s.issuesEl)

		// 1. 从 GitHub 仓库安装
		const addRow = mk('div', 'mdn-src-add')
		s.repoInput = mk('input', 'form-control form-control-sm')
		s.repoInput.type = 'text'
		s.repoInput.placeholder = 'https://github.com/组织/仓库（可加 @v1.0.0 指定标签）'
		s.repoInput.setAttribute('aria-label', '插件 GitHub 仓库地址')
		s.repoInput.setAttribute('autocomplete', 'off')
		s.repoInput.setAttribute('spellcheck', 'false')
		s.inspectBtn = mk('button', 'btn btn-sm btn-primary')
		s.inspectBtn.type = 'button'
		s.inspectBtn.appendChild(mk('i', 'icon icon-sm icon-download'))
		s.inspectBtn.appendChild(mk('span', '', '从仓库安装…'))
		addRow.appendChild(s.repoInput)
		addRow.appendChild(s.inspectBtn)
		body.appendChild(addRow)

		s.addErr = mk('div', 'mdn-src-err')
		s.addErr.hidden = true
		body.appendChild(s.addErr)

		// 安装 / 更新前的确认区（单模态面板内展开）
		s.confirmBox = mk('div', 'mdn-plg-confirm-host')
		s.confirmBox.hidden = true
		body.appendChild(s.confirmBox)

		// 2. 已安装插件列表
		s.listEl = mk('div', 'mdn-src-list')
		body.appendChild(s.listEl)

		s.inspectBtn.addEventListener('click', function () { inspectRepo(s) })
		s.repoInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter' && !e.isComposing) {
				e.preventDefault()
				inspectRepo(s)
			}
		})
	}

	function inspectRepo(s) {
		if (s.inspecting || s.installing) return
		const raw = s.repoInput.value.trim()
		if (!raw) {
			s.addError = '请填写插件 GitHub 仓库地址'
			render(s)
			return
		}
		s.inspecting = true
		s.addError = ''
		s.pendingConfirm = null
		render(s)
		Promise.resolve(svc.inspect(raw)).then(function (info) {
			s.pendingConfirm = {
				mode: info.currentVersion ? 'update' : 'install',
				info: info,
			}
		}, function (e) {
			s.addError = String((e && e.message) || e)
		}).then(function () {
			s.inspecting = false
			render(s)
		})
	}

	function confirmInstall(s) {
		if (!s.pendingConfirm || s.installing) return
		const info = s.pendingConfirm.info
		s.installing = true
		s.addError = ''
		render(s)
		Promise.resolve(svc.install(
			info.repo, info.tag || null, info.packageSha256,
			info.currentVersion || null, info.currentPackageSha256 || null
		)).then(function () {
			s.pendingConfirm = null
			s.repoInput.value = ''
			return refreshList(s)
		}, function (e) {
			s.addError = String((e && e.message) || e)
		}).then(function () {
			s.installing = false
			render(s)
		})
	}

	function renderConfirmCard(s) {
		s.confirmBox.textContent = ''
		const pending = s.pendingConfirm
		if (!pending || !pending.info) {
			s.confirmBox.hidden = true
			return
		}
		s.confirmBox.hidden = false
		const info = pending.info
		const isUpdate = pending.mode === 'update' || !!info.currentVersion
		const card = mk('div', 'mdn-src-card mdn-plg-confirm')

		const head = mk('div', 'mdn-src-head')
		const title = mk('div', 'mdn-src-title')
		title.appendChild(mk('i', 'icon icon-sm icon-shield-check'))
		title.appendChild(mk('span', 'mdn-src-name', (isUpdate ? '确认安装更新：' : '确认安装插件：') + (info.name || info.id)))
		const verText = info.currentVersion ? ('v' + info.currentVersion + ' → v' + info.version) : ('v' + info.version)
		title.appendChild(mk('span', 'mdn-src-ver', verText))
		if (info.packageSha256) {
			const sha = mk('span', 'mdn-src-digest', shortSha(info.packageSha256))
			sha.title = '包文件 SHA-256：' + info.packageSha256
			title.appendChild(sha)
		}
		head.appendChild(title)
		card.appendChild(head)

		const meta = mk('div', 'mdn-src-url', '来源：' + info.repo + (info.tag ? ' @ ' + info.tag : '') + ' · ID：' + info.id)
		card.appendChild(meta)

		if (info.supported === false) {
			card.appendChild(mk('div', 'mdn-src-err', '该插件声明的 platforms 不包含当前系统，安装后将无法加载。'))
		}

		const caps = Rpc.capabilitySummary(info.capabilities || [])
		const added = Array.isArray(info.added) ? info.added : []
		const removed = Array.isArray(info.removed) ? info.removed : []
		const capBox = mk('div', 'mdn-plg-caps')
		capBox.appendChild(mk('div', 'mdn-plg-caps-title', caps.length ? '申请的宿主能力（请确认授权）：' : '该插件未申请任何宿主特权能力'))
		caps.forEach(function (c) {
			const item = mk('div', 'mdn-plg-cap-item')
			const badge = mk('code', 'mdn-src-chip', c.id)
			item.appendChild(badge)
			if (isUpdate && added.indexOf(c.id) !== -1) {
				item.appendChild(mk('span', 'mdn-plg-cap-added', '新增'))
			}
			item.appendChild(mk('span', 'mdn-plg-cap-desc', c.text))
			capBox.appendChild(item)
		})
		if (isUpdate && removed.length) {
			capBox.appendChild(mk('div', 'mdn-src-note', '本次更新移除了能力：' + removed.join('、')))
		}
		card.appendChild(capBox)

		if (info.notes) {
			card.appendChild(mk('div', 'mdn-plg-notes', info.notes))
		}

		const actions = mk('div', 'mdn-src-actions')
		const okBtn = mk('button', 'btn btn-sm btn-primary')
		okBtn.type = 'button'
		okBtn.disabled = !!s.installing
		okBtn.appendChild(mk('i', 'icon icon-sm icon-check'))
		okBtn.appendChild(mk('span', '', s.installing ? '正在安装…' : (isUpdate ? '授权并更新' : '授权并安装')))
		okBtn.addEventListener('click', function () { confirmInstall(s) })

		const cancelBtn = mk('button', 'btn btn-sm btn-outline-secondary', '取消')
		cancelBtn.type = 'button'
		cancelBtn.disabled = !!s.installing
		cancelBtn.addEventListener('click', function () {
			s.pendingConfirm = null
			render(s)
		})
		actions.appendChild(okBtn)
		actions.appendChild(cancelBtn)
		card.appendChild(actions)
		s.confirmBox.appendChild(card)
	}

	function runPluginAction(s, key, fn, busyText) {
		if (s.busy[key]) return
		s.busy[key] = busyText || '处理中'
		s.errors[key] = ''
		render(s)
		Promise.resolve().then(fn).then(function () {
			s.errors[key] = ''
		}, function (e) {
			s.errors[key] = String((e && e.message) || e)
		}).then(function () {
			delete s.busy[key]
			render(s)
		})
	}

	function pluginCard(s, p) {
		const card = mk('div', 'mdn-src-card mdn-plg-card')
		card.dataset.pluginId = p.id
		const head = mk('div', 'mdn-src-head')
		const title = mk('div', 'mdn-src-title')
		const iconName = p.icon && /^[a-z0-9-]+$/.test(p.icon) ? p.icon : 'layout-grid'
		title.appendChild(mk('i', 'icon icon-sm icon-' + iconName))
		title.appendChild(mk('span', 'mdn-src-name', p.name || p.id))
		if (p.version) title.appendChild(mk('span', 'mdn-src-ver', 'v' + p.version))
		if (p.packageSha256) {
			const sha = mk('span', 'mdn-src-digest', shortSha(p.packageSha256))
			sha.title = '包文件 SHA-256：' + p.packageSha256
			title.appendChild(sha)
		}
		if (s.busy['check:' + p.id]) title.appendChild(mk('span', 'mdn-src-busy', s.busy['check:' + p.id]))
		head.appendChild(title)

		const actions = mk('div', 'mdn-src-head-actions')
		const checkBtn = iconBtn('refresh-cw', '检查更新')
		checkBtn.disabled = !p.repo || !!s.busy['check:' + p.id]
		checkBtn.addEventListener('click', function () {
			s.notes[p.id] = ''
			runPluginAction(s, 'check:' + p.id, function () {
				return Promise.resolve(svc.checkUpdate(p.id)).then(function (upd) {
							if (!upd) {
						s.notes[p.id] = '已是最新版本（v' + p.version + '）'
						return
					}
					s.pendingConfirm = { mode: 'update', info: upd }
				})
			}, '检查中…')
		})
		const removeBtn = iconBtn('trash-2', s.confirmRemove === p.id ? '确认卸载这个插件' : '卸载插件')
		if (s.confirmRemove === p.id) removeBtn.classList.add('is-danger')
		removeBtn.disabled = !!s.busy['remove:' + p.id]
		removeBtn.addEventListener('click', function () {
			if (s.confirmRemove !== p.id) {
				s.confirmRemove = p.id
				clearTimeout(s.confirmTimer)
				s.confirmTimer = setTimeout(function () {
							s.confirmRemove = ''
					render(s)
				}, 5000)
				render(s)
				return
			}
			clearTimeout(s.confirmTimer)
			s.confirmRemove = ''
			runPluginAction(s, 'remove:' + p.id, function () {
				return Promise.resolve(svc.uninstall(p.id)).then(function (list) {
					if (root.PluginHost && root.PluginHost.close) root.PluginHost.close(p.id)
					if (Array.isArray(list)) s.plugins = list
					else return refreshList(s)
				})
			}, '卸载中…')
		})
		actions.appendChild(checkBtn)
		actions.appendChild(removeBtn)
		head.appendChild(actions)
		card.appendChild(head)

		card.appendChild(mk('div', 'mdn-src-url', (p.repo || '本地安装') + (p.tag ? ' @ ' + p.tag : '') + ' · ID：' + p.id))

		const caps = Rpc.capabilitySummary(p.capabilities || [])
		if (caps.length) {
			const capList = mk('div', 'mdn-plg-caps')
			caps.forEach(function (c) {
				const row = mk('div', 'mdn-plg-cap-item')
				row.appendChild(mk('code', 'mdn-src-chip', c.id))
				row.appendChild(mk('span', 'mdn-plg-cap-desc', c.text))
				capList.appendChild(row)
			})
			card.appendChild(capList)
		}

		const foot = mk('div', 'mdn-src-actions')
		// 释放失败（串口 / BLE 扫描收尾没成功）时给一个显式重试入口，别让 busy 源永久挡住更新
		if (s.failedReleases.indexOf(p.id) !== -1) {
			const retryBtn = mk('button', 'btn btn-sm btn-outline-warning', '重试释放')
			retryBtn.type = 'button'
			retryBtn.disabled = !!s.busy['retry:' + p.id]
			retryBtn.addEventListener('click', function () {
				runPluginAction(s, 'retry:' + p.id, function () {
					if (!root.PluginHost || !root.PluginHost.retryRelease) return
					return Promise.resolve(root.PluginHost.retryRelease(p.id)).then(function () { return refreshList(s) })
				}, '重试中…')
			})
			foot.appendChild(retryBtn)
			card.appendChild(mk('div', 'mdn-src-err', '资源释放未确认完成，应用更新会被阻止；可在此重试'))
		}
		const enableKey = 'enable:' + p.id
		const enableWrap = mk('label', 'form-check form-switch ctl-switch')
		const enableInput = mk('input', 'form-check-input')
		enableInput.type = 'checkbox'
		enableInput.checked = !!p.enabled
		enableInput.disabled = !!p.error || !p.supported || !!p.repair || !!p.installing || !!s.busy[enableKey]
		enableInput.id = 'mdn-plg-en-' + p.id
		enableInput.addEventListener('change', function () {
			const on = enableInput.checked
			enableInput.disabled = true
			runPluginAction(s, enableKey, function () {
				return Promise.resolve(svc.setEnabled(p.id, on)).then(function (list) {
					if (!on && root.PluginHost && root.PluginHost.close) root.PluginHost.close(p.id)
					if (Array.isArray(list)) s.plugins = list
					else return refreshList(s)
				})
			}, on ? '启用中' : '停用中')
		})
		const enableLabel = mk('label', 'form-check-label', p.enabled ? '已启用' : '已停用')
		enableLabel.setAttribute('for', enableInput.id)
		enableWrap.appendChild(enableInput)
		enableWrap.appendChild(enableLabel)
		foot.appendChild(enableWrap)
		card.appendChild(foot)

		if (!p.supported) card.appendChild(mk('div', 'mdn-src-note', '该插件不支持当前操作系统'))
		if (s.notes[p.id]) card.appendChild(mk('div', 'mdn-src-note', s.notes[p.id]))
		if (p.error) card.appendChild(mk('div', 'mdn-src-err', p.error))
		if (p.repair) card.appendChild(mk('div', 'mdn-src-err', '安装事务恢复失败：' + p.repair + '（见面板顶部的重试恢复 / 移除）'))
		if (p.installing) card.appendChild(mk('div', 'mdn-src-note', '安装 / 卸载事务进行中，暂不提供启用视图'))
		if (s.errors['check:' + p.id]) card.appendChild(mk('div', 'mdn-src-err', s.errors['check:' + p.id]))
		if (s.errors['remove:' + p.id]) card.appendChild(mk('div', 'mdn-src-err', s.errors['remove:' + p.id]))
		if (s.errors[enableKey]) card.appendChild(mk('div', 'mdn-src-err', s.errors[enableKey]))
		if (s.errors['retry:' + p.id]) card.appendChild(mk('div', 'mdn-src-err', s.errors['retry:' + p.id]))
		return card
	}

	// 宿主级待处理项：修复失败的插件（Rust）与未释放的资源（页面侧），插件卸载后仍保留
	function renderIssues(s) {
		s.issuesEl.textContent = ''
		const repairs = (s.issues && s.issues.repairs) || []
		const resources = (s.issues && s.issues.resources) || []
		const rows = []
		repairs.forEach(function (r) {
			rows.push({ kind: 'repair', id: r.id, resource: '安装事务 ' + (r.stage || ''), reason: r.reason })
		})
		resources.forEach(function (r) {
			rows.push({ kind: 'release', id: r.id, resource: r.resource, reason: r.reason })
		})
		s.issuesEl.hidden = rows.length === 0
		if (!rows.length) return
		rows.forEach(function (row) {
			const card = mk('div', 'mdn-src-card mdn-plg-issue')
			const head = mk('div', 'mdn-src-head')
			const title = mk('div', 'mdn-src-title')
			title.appendChild(mk('i', 'icon icon-sm icon-triangle-alert'))
			title.appendChild(mk('span', 'mdn-src-name', row.id))
			title.appendChild(mk('span', 'mdn-src-ver', row.resource))
			head.appendChild(title)
			const actions = mk('div', 'mdn-src-head-actions')
			if (row.kind === 'release') {
				const retry = mk('button', 'btn btn-sm btn-outline-warning', '重试释放')
				retry.type = 'button'
				retry.disabled = !!s.busy['issue:' + row.kind + ':' + row.id]
				retry.addEventListener('click', function () {
					runPluginAction(s, 'issue:' + row.kind + ':' + row.id, function () {
						if (!root.PluginHost || !root.PluginHost.retryRelease) return
						return Promise.resolve(root.PluginHost.retryRelease(row.id)).then(function () { return refreshList(s) })
					}, '重试中…')
				})
				actions.appendChild(retry)
			} else {
				const retry = mk('button', 'btn btn-sm btn-outline-warning', '重试恢复')
				retry.type = 'button'
				retry.disabled = !!s.busy['issue:' + row.kind + ':' + row.id]
				retry.addEventListener('click', function () {
					runPluginAction(s, 'issue:' + row.kind + ':' + row.id, function () {
						return Promise.resolve(svc.retryRecovery(row.id)).then(function () { return refreshList(s) }, function (e) {
							s.errors['issue:' + row.kind + ':' + row.id] = String((e && e.message) || e)
						})
					}, '恢复中…')
				})
				const remove = mk('button', 'btn btn-sm btn-outline-danger', '移除')
				remove.type = 'button'
				remove.addEventListener('click', function () {
					runPluginAction(s, 'issue:' + row.kind + ':' + row.id, function () {
						return Promise.resolve(svc.removeRepair(row.id)).then(function () {
							if (root.PluginHost && root.PluginHost.close) root.PluginHost.close(row.id)
							return refreshList(s)
						})
					}, '移除中…')
				})
				actions.appendChild(retry)
				actions.appendChild(remove)
			}
			head.appendChild(actions)
			card.appendChild(head)
			card.appendChild(mk('div', 'mdn-src-err', row.reason))
			if (s.errors['issue:' + row.kind + ':' + row.id]) {
				card.appendChild(mk('div', 'mdn-src-err', s.errors['issue:' + row.kind + ':' + row.id]))
			}
			s.issuesEl.appendChild(card)
		})
	}

	function render(s) {
		if (!s) return
		s.inspectBtn.disabled = !!s.inspecting || !!s.installing
		s.inspectBtn.querySelector('span').textContent = s.inspecting ? '正在检查…' : '从仓库安装…'
		s.repoInput.disabled = !!s.inspecting || !!s.installing
		s.addErr.hidden = !s.addError
		s.addErr.textContent = s.addError || ''

		renderConfirmCard(s)
		renderIssues(s)
		const st = s.status || {}
		s.statusEl.hidden = st.available !== false
		s.statusEl.textContent = st.available === false ? ('插件子系统不可用：' + (st.reason || '未知原因') + '。客户端其它功能不受影响。') : ''

		const list = s.plugins || []
		s.listEl.textContent = ''
		if (!list.length) {
			const empty = mk('div', 'mdn-src-empty-block')
			empty.appendChild(mk('div', 'mdn-src-empty-title', '还没有安装插件'))
			empty.appendChild(mk('div', 'mdn-src-empty',
				'输入插件的 GitHub 仓库地址即可从 Release 下载并校验安装。启用后插件会出现在左侧导航栏「插件」分组中，支持拖拽或 Alt+↑/↓ 调整顺序。'))
			s.listEl.appendChild(empty)
			return
		}
		list.forEach(function (p) { s.listEl.appendChild(pluginCard(s, p)) })
	}

	function refreshList(s) {
		return Promise.all([
			Promise.resolve(svc.list ? svc.list() : []).catch(function () { return [] }),
			Promise.resolve(svc.repairList ? svc.repairList() : []).catch(function () { return [] }),
			Promise.resolve(root.PluginHost && root.PluginHost.failedResources ? root.PluginHost.failedResources() : []).catch(function () { return [] }),
			Promise.resolve(svc.status ? svc.status() : { available: true }).catch(function () { return { available: true } }),
		]).then(function (res) {
			s.plugins = Array.isArray(res[0]) ? res[0] : []
			s.issues = { repairs: Array.isArray(res[1]) ? res[1] : [], resources: Array.isArray(res[2]) ? res[2] : [] }
			s.status = res[3] || { available: true }
			s.failedReleases = root.PluginHost && root.PluginHost.failedReleases ? root.PluginHost.failedReleases() : []
			if (root.PluginHost && root.PluginHost.reload) root.PluginHost.reload()
			render(s)
		})
	}

	// 内容只建一次，之后常驻配置页：插件列表由 plugins-changed 与操作结果驱动重画
	function mount(host) {
		if (session || !host) return
		const s = {
			inspecting: false,
			installing: false,
			pendingConfirm: null,
			plugins: [],
			busy: {},
			errors: {},
			notes: {},
			addError: '',
			confirmRemove: '',
			confirmTimer: 0,
			failedReleases: [],
			issues: { repairs: [], resources: [] },
			status: { available: true },
		}
		session = s
		if (svc.listen) {
			Promise.resolve(svc.listen('plugins-changed', function () { refreshList(s) })).catch(function () {})
		}
		build(host, s)
		refreshList(s)
	}

	function openPanel() {
		if (root.SettingsView) root.SettingsView.plugins()
	}

	root.PluginManagePanel = { open: openPanel }
	// settings-view.js 在本文件之前加载：分组第一次显示时把内容建进它的容器
	if (root.SettingsView) root.SettingsView.onMount('plugins', mount)
})(typeof window !== 'undefined' ? window : globalThis)
