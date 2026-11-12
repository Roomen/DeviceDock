// 插件管理面板（仅桌面客户端）：左栏「配置 → 插件…」。
// 与协议来源面板共用 AppDialog.panel 模态外壳和 .mdn-src-* 卡片视觉，面板内不嵌套第二个 AppDialog：
// 安装 / 更新确认与卸载确认都在面板内完成，列出能力（人话描述）、来源仓库、版本差异与 sha256 前 12 位。
// GitHub 令牌只写进系统钥匙串，面板永远不回显明文，只显示「已设置 / 未设置」。
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
	let opening = false

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

		// 2. GitHub 令牌（系统钥匙串）
		const tokenCard = mk('div', 'mdn-plg-token')
		const tokenHead = mk('div', 'mdn-plg-token-head')
		const tokenTitle = mk('div', 'mdn-plg-token-title')
		tokenTitle.appendChild(mk('i', 'icon icon-sm icon-lock'))
		tokenTitle.appendChild(mk('span', '', 'GitHub 令牌'))
		s.tokenBadge = mk('span', 'mdn-src-ver', '未设置')
		tokenTitle.appendChild(s.tokenBadge)
		tokenHead.appendChild(tokenTitle)
		tokenCard.appendChild(tokenHead)

		const tokenRow = mk('div', 'mdn-plg-token-row')
		s.tokenInput = mk('input', 'form-control form-control-sm')
		s.tokenInput.type = 'password'
		s.tokenInput.placeholder = '公开仓库免填；私有仓库或遇 API 限额时填写 Personal Access Token'
		s.tokenInput.setAttribute('aria-label', 'GitHub 令牌')
		s.tokenInput.setAttribute('autocomplete', 'off')
		s.tokenSaveBtn = mk('button', 'btn btn-sm btn-outline-primary', '保存令牌')
		s.tokenSaveBtn.type = 'button'
		s.tokenClearBtn = mk('button', 'btn btn-sm btn-outline-secondary', '清除')
		s.tokenClearBtn.type = 'button'
		tokenRow.appendChild(s.tokenInput)
		tokenRow.appendChild(s.tokenSaveBtn)
		tokenRow.appendChild(s.tokenClearBtn)
		tokenCard.appendChild(tokenRow)
		s.tokenMsg = mk('div', 'mdn-src-note')
		s.tokenMsg.hidden = true
		tokenCard.appendChild(s.tokenMsg)
		body.appendChild(tokenCard)

		// 3. 已安装插件列表
		s.listEl = mk('div', 'mdn-src-list')
		body.appendChild(s.listEl)

		s.inspectBtn.addEventListener('click', function () { inspectRepo(s) })
		s.repoInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter' && !e.isComposing) {
				e.preventDefault()
				inspectRepo(s)
			}
		})
		s.tokenSaveBtn.addEventListener('click', function () { saveToken(s) })
		s.tokenClearBtn.addEventListener('click', function () { clearToken(s) })
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
			if (s.closed) return
			s.pendingConfirm = {
				mode: info.currentVersion ? 'update' : 'install',
				info: info,
			}
		}, function (e) {
			if (!s.closed) s.addError = String((e && e.message) || e)
		}).then(function () {
			if (s.closed) return
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
		Promise.resolve(svc.install(info.repo, info.tag || null, info.packageSha256)).then(function () {
			if (s.closed) return
			s.pendingConfirm = null
			s.repoInput.value = ''
			return refreshList(s)
		}, function (e) {
			if (!s.closed) s.addError = String((e && e.message) || e)
		}).then(function () {
			if (s.closed) return
			s.installing = false
			render(s)
		})
	}

	function saveToken(s) {
		if (s.tokenBusy) return
		const val = s.tokenInput.value.trim()
		if (!val) {
			s.tokenNote = '请输入要保存的 GitHub 令牌'
			s.tokenErr = true
			render(s)
			return
		}
		s.tokenBusy = true
		s.tokenNote = ''
		render(s)
		Promise.resolve(svc.tokenSet(val)).then(function (st) {
			if (s.closed) return
			s.tokenInput.value = ''
			s.tokenSet = !!(st && st.set)
			s.tokenNote = '令牌已写入系统钥匙串'
			s.tokenErr = false
		}, function (e) {
			if (!s.closed) {
				s.tokenNote = String((e && e.message) || e)
				s.tokenErr = true
			}
		}).then(function () {
			if (s.closed) return
			s.tokenBusy = false
			render(s)
		})
	}

	function clearToken(s) {
		if (s.tokenBusy) return
		s.tokenBusy = true
		s.tokenNote = ''
		render(s)
		Promise.resolve(svc.tokenClear()).then(function (st) {
			if (s.closed) return
			s.tokenInput.value = ''
			s.tokenSet = !!(st && st.set)
			s.tokenNote = '已清除系统钥匙串中的令牌'
			s.tokenErr = false
		}, function (e) {
			if (!s.closed) {
				s.tokenNote = String((e && e.message) || e)
				s.tokenErr = true
			}
		}).then(function () {
			if (s.closed) return
			s.tokenBusy = false
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
			if (!s.closed) render(s)
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
					if (s.closed) return
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
					if (s.closed) return
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
		const enableKey = 'enable:' + p.id
		const enableWrap = mk('label', 'form-check form-switch ctl-switch')
		const enableInput = mk('input', 'form-check-input')
		enableInput.type = 'checkbox'
		enableInput.checked = !!p.enabled
		enableInput.disabled = !!p.error || !p.supported || !!s.busy[enableKey]
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
		if (s.errors['check:' + p.id]) card.appendChild(mk('div', 'mdn-src-err', s.errors['check:' + p.id]))
		if (s.errors['remove:' + p.id]) card.appendChild(mk('div', 'mdn-src-err', s.errors['remove:' + p.id]))
		if (s.errors[enableKey]) card.appendChild(mk('div', 'mdn-src-err', s.errors[enableKey]))
		return card
	}

	function render(s) {
		if (!s || s.closed) return
		s.inspectBtn.disabled = !!s.inspecting || !!s.installing
		s.inspectBtn.querySelector('span').textContent = s.inspecting ? '正在检查…' : '从仓库安装…'
		s.repoInput.disabled = !!s.inspecting || !!s.installing
		s.addErr.hidden = !s.addError
		s.addErr.textContent = s.addError || ''

		renderConfirmCard(s)

		s.tokenBadge.textContent = s.tokenSet ? '已设置' : '未设置'
		s.tokenSaveBtn.disabled = !!s.tokenBusy
		s.tokenClearBtn.disabled = !!s.tokenBusy || !s.tokenSet
		s.tokenMsg.hidden = !s.tokenNote
		s.tokenMsg.className = s.tokenErr ? 'mdn-src-err' : 'mdn-src-note'
		s.tokenMsg.textContent = s.tokenNote || ''

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
			Promise.resolve(svc.tokenStatus ? svc.tokenStatus() : { set: false }).catch(function () { return { set: false } }),
		]).then(function (res) {
			if (s.closed) return
			s.plugins = Array.isArray(res[0]) ? res[0] : []
			s.tokenSet = !!(res[1] && res[1].set)
			if (root.PluginHost && root.PluginHost.reload) root.PluginHost.reload()
			render(s)
		})
	}

	function openPanel() {
		if (opening || session) return
		opening = true
		const s = {
			closed: false,
			inspecting: false,
			installing: false,
			pendingConfirm: null,
			tokenSet: false,
			tokenBusy: false,
			tokenNote: '',
			tokenErr: false,
			plugins: [],
			busy: {},
			errors: {},
			notes: {},
			addError: '',
			confirmRemove: '',
			confirmTimer: 0,
		}
		session = s
		opening = false
		let unlisten = null
		if (svc.listen) {
			Promise.resolve(svc.listen('plugins-changed', function () { refreshList(s) })).then(function (fn) {
				if (typeof fn === 'function') unlisten = fn
			}).catch(function () {})
		}
		root.AppDialog.panel({
			title: '插件管理',
			wide: true,
			closeText: '关闭',
			build: function (body) { build(body, s) },
		}).then(function () {
			s.closed = true
			clearTimeout(s.confirmTimer)
			if (unlisten) try { unlisten() } catch (e) {}
			if (session === s) session = null
		})
		refreshList(s)
	}

	function mount() {
		const btn = doc.getElementById('serial-plugins-manage')
		if (!btn) return
		btn.addEventListener('click', function (e) {
			e.preventDefault()
			openPanel()
		})
	}

	root.PluginManagePanel = { open: openPanel }
	if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount)
	else mount()
})(typeof window !== 'undefined' ? window : globalThis)
