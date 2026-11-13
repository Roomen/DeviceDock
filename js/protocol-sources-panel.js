// 协议来源管理：配置页「协议来源」分组的内容。
// 来源是应用级设置（和导入 / 导出 / 重置同一类），不属于某一路串口，所以放在配置页里而不是独立视图；
// 内容原样构建进配置页的分组容器（构建、事件、状态与两步确认都不变，只是宿主从 AppDialog.panel 换成页内容器）。
// 移动端只提供内置 SEK，本文件在移动画像下不挂载（功能 id panel.protocol-sources 目录外默认桌面开）。
;(function (root) {
	'use strict'

	const P = root.AppPlatform
	const S = root.DeviceDockProtocolSources
	if (!P || !S) return
	if (typeof P.has === 'function' && !P.has('panel.protocol-sources')) return
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
		const s = String(sha || '')
		return s ? s.slice(0, 12) : ''
	}
	function shortDigest(digest) {
		return shortSha(String(digest || '').replace(/^sha256-/, ''))
	}

	function build(body, s) {
		body.classList.add('mdn-src-panel')
		body.appendChild(mk('p', 'mdn-src-intro',
			I18n.t('protoPanel.addingASourceOnlyReadsIts')))

		const addRow = mk('div', 'mdn-src-add')
		s.urlInput = mk('input', 'form-control form-control-sm')
		s.urlInput.type = 'text'
		s.urlInput.placeholder = I18n.t('protoPanel.httpsGithubComOrgRepoOr')
		s.urlInput.setAttribute('aria-label', I18n.t('protoPanel.protocolSourceUrl'))
		s.urlInput.setAttribute('autocomplete', 'off')
		s.urlInput.setAttribute('spellcheck', 'false')
		s.addBtn = mk('button', 'btn btn-sm btn-primary')
		s.addBtn.type = 'button'
		s.addBtn.appendChild(mk('i', 'icon icon-sm icon-plus'))
		s.addBtn.appendChild(mk('span', '', I18n.t('protoPanel.addSource')))
		addRow.appendChild(s.urlInput)
		addRow.appendChild(s.addBtn)
		body.appendChild(addRow)
		s.addErr = mk('div', 'mdn-src-err')
		s.addErr.hidden = true
		body.appendChild(s.addErr)
		s.listEl = mk('div', 'mdn-src-list')
		body.appendChild(s.listEl)

		s.addBtn.addEventListener('click', function () { addSource(s) })
		s.urlInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter' && !e.isComposing) {
				e.preventDefault()
				addSource(s)
			}
		})
	}

	function addSource(s) {
		if (s.adding) return
		const value = s.urlInput.value.trim()
		if (!value) {
			s.addError = I18n.t('protoPanel.enterASourceUrl')
			render(s)
			return
		}
		s.adding = true
		s.addError = ''
		render(s)
		S.add(value).then(function () {
			s.urlInput.value = ''
		}, function (e) {
			s.addError = String((e && e.message) || e)
		}).then(function () {
			s.adding = false
			render(s)
		})
	}

	function runAction(s, tag, fn, label) {
		if (s.busy[tag]) return
		s.busy[tag] = label || I18n.t('protoPanel.working')
		s.errors[tag] = ''
		render(s)
		Promise.resolve().then(fn).then(function () {
			s.errors[tag] = ''
		}, function (e) {
			s.errors[tag] = String((e && e.message) || e)
		}).then(function () {
			delete s.busy[tag]
			render(s)
		})
	}

	function sourceCard(s, src) {
		const card = mk('div', 'mdn-src-card')
		const head = mk('div', 'mdn-src-head')
		const title = mk('div', 'mdn-src-title')
		title.appendChild(mk('i', 'icon icon-sm icon-globe'))
		title.appendChild(mk('span', 'mdn-src-name', src.name || src.key))
		if (src.sha) {
			const sha = mk('span', 'mdn-src-sha', shortSha(src.sha))
			sha.title = I18n.t('protoPanel.pinnedToThisVersion', { sha: src.sha })
			title.appendChild(sha)
		}
		if (src.busy) title.appendChild(mk('span', 'mdn-src-busy', src.busy))
		head.appendChild(title)

		const actions = mk('div', 'mdn-src-head-actions')
		const refreshBtn = iconBtn('refresh-cw', I18n.t('protoPanel.refreshSource'))
		refreshBtn.disabled = !!src.busy || !!s.busy['refresh:' + src.key]
		refreshBtn.addEventListener('click', function () {
			runAction(s, 'refresh:' + src.key, function () { return S.refresh(src.key) }, I18n.t('protoPanel.refreshing'))
		})
		const removeBtn = iconBtn('trash-2', s.confirmRemove === src.key ? I18n.t('protoPanel.confirmRemovingThisSource') : I18n.t('protoPanel.removeSource'))
		if (s.confirmRemove === src.key) removeBtn.classList.add('is-danger')
		removeBtn.disabled = !!s.busy['remove:' + src.key]
		removeBtn.addEventListener('click', function () {
			if (s.confirmRemove !== src.key) {
				s.confirmRemove = src.key
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
			runAction(s, 'remove:' + src.key, function () { return S.remove(src.key) }, I18n.t('protoPanel.removing'))
		})
		actions.appendChild(refreshBtn)
		actions.appendChild(removeBtn)
		head.appendChild(actions)
		card.appendChild(head)
		card.appendChild(mk('div', 'mdn-src-url', src.input))

		if (src.notice) card.appendChild(mk('div', 'mdn-src-note', src.notice))
		if (src.error) card.appendChild(mk('div', 'mdn-src-err', src.error))
		if (s.errors['refresh:' + src.key]) card.appendChild(mk('div', 'mdn-src-err', s.errors['refresh:' + src.key]))
		if (s.errors['remove:' + src.key]) card.appendChild(mk('div', 'mdn-src-err', s.errors['remove:' + src.key]))

		if (!src.packages.length) {
			if (!src.busy && !src.error) card.appendChild(mk('div', 'mdn-src-empty', I18n.t('protoPanel.thisSourceHasNoUsableProtocol')))
			return card
		}
		const list = mk('div', 'mdn-src-pkgs')
		src.packages.forEach(function (pkg) { list.appendChild(packageRow(s, src, pkg)) })
		card.appendChild(list)
		return card
	}

	function packageRow(s, src, pkg) {
		const row = mk('div', 'mdn-src-pkg')
		const head = mk('div', 'mdn-src-pkg-head')
		head.appendChild(mk('span', 'mdn-src-pkg-name', pkg.name || pkg.id || I18n.t('protoPanel.invalidPackage')))
		if (pkg.version) head.appendChild(mk('span', 'mdn-src-ver', 'v' + pkg.version))
		if (pkg.digest) {
			const d = mk('span', 'mdn-src-digest', shortDigest(pkg.digest))
			d.title = I18n.t('protoPanel.entryFileDigest', { digest: pkg.digest })
			head.appendChild(d)
		}
		row.appendChild(head)

		if (pkg.provides.length) {
			const prov = mk('div', 'mdn-src-provides')
			prov.appendChild(mk('span', 'mdn-src-provides-label', I18n.t('protoPanel.provides')))
			pkg.provides.forEach(function (p) {
				const chip = mk('span', 'mdn-src-chip', p.name)
				chip.title = p.id
				prov.appendChild(chip)
			})
			row.appendChild(prov)
		}

		const actions = mk('div', 'mdn-src-actions')
		const trustTag = 'trust:' + src.key + '/' + pkg.id
		const enableTag = 'enable:' + src.key + '/' + pkg.id
		const trustBtn = mk('button', 'btn btn-sm ' + (pkg.trusted ? 'btn-outline-secondary' : 'btn-outline-primary'))
		trustBtn.type = 'button'
		trustBtn.appendChild(mk('i', 'icon icon-sm icon-' + (pkg.trusted ? 'shield-check' : 'lock-open')))
		trustBtn.appendChild(mk('span', '', pkg.trusted ? I18n.t('protoPanel.versionTrusted') : I18n.t('protoPanel.trustThisVersion')))
		trustBtn.title = pkg.trusted ? I18n.t('protoPanel.clickToRevokeTrustAlsoDisables') : I18n.t('protoPanel.confirmThisVersionSCodeMay')
		trustBtn.disabled = !!pkg.error || !!src.busy || !!s.busy[trustTag] || !!s.busy[enableTag] || !pkg.id
		trustBtn.addEventListener('click', function () {
			try {
				if (pkg.trusted) S.revokeTrust(src.key, pkg.id)
				else S.trust(src.key, pkg.id)
				s.errors[trustTag] = ''
			} catch (e) {
				s.errors[trustTag] = String((e && e.message) || e)
			}
			render(s)
		})
		actions.appendChild(trustBtn)

		const enableWrap = mk('label', 'form-check form-switch ctl-switch')
		const enableInput = mk('input', 'form-check-input')
		enableInput.type = 'checkbox'
		enableInput.checked = pkg.enabled
		enableInput.disabled = !!pkg.error || !!src.busy || !pkg.trusted || !!s.busy[enableTag]
		enableInput.id = 'mdn-src-en-' + encodeURIComponent(src.key + '/' + pkg.id).replace(/%/g, '_')
		enableInput.addEventListener('change', function () {
			const on = enableInput.checked
			enableInput.disabled = true
			runAction(s, enableTag, function () {
				return on ? S.enable(src.key, pkg.id) : S.disable(src.key, pkg.id)
			}, on ? I18n.t('protoPanel.enabling') : I18n.t('protoPanel.disabling'))
		})
		const enableLabel = mk('label', 'form-check-label', pkg.enabled ? I18n.t('protoPanel.enabled') : I18n.t('protoPanel.enable'))
		enableLabel.setAttribute('for', enableInput.id)
		enableWrap.appendChild(enableInput)
		enableWrap.appendChild(enableLabel)
		actions.appendChild(enableWrap)
		row.appendChild(actions)

		if (!pkg.platformOk) row.appendChild(mk('div', 'mdn-src-note', I18n.t('protoPanel.thisPackageDoesnTDeclareSupport')))
		if (pkg.error) row.appendChild(mk('div', 'mdn-src-err', pkg.error))
		if (pkg.bootError) row.appendChild(mk('div', 'mdn-src-err', I18n.t('protoPanel.failedToEnableAtStartup', { bootError: pkg.bootError })))
		if (s.errors[trustTag]) row.appendChild(mk('div', 'mdn-src-err', s.errors[trustTag]))
		if (s.errors[enableTag]) row.appendChild(mk('div', 'mdn-src-err', s.errors[enableTag]))
		return row
	}

	function render(s) {
		if (!s) return
		s.addBtn.disabled = !!s.adding
		s.addBtn.querySelector('span').textContent = s.adding ? I18n.t('protoPanel.loading') : I18n.t('protoPanel.addSource')
		s.urlInput.disabled = !!s.adding
		s.addErr.hidden = !s.addError
		s.addErr.textContent = s.addError || ''
		const list = S.list()
		s.listEl.textContent = ''
		if (!list.length) {
			const empty = mk('div', 'mdn-src-empty-block')
			empty.appendChild(mk('div', 'mdn-src-empty-title', I18n.t('protoPanel.noSourcesAdded')))
			empty.appendChild(mk('div', 'mdn-src-empty',
				I18n.t('protoPanel.putCatalogJsonAndEachPackage')))
			s.listEl.appendChild(empty)
			return
		}
		list.forEach(function (src) { s.listEl.appendChild(sourceCard(s, src)) })
	}

	// 内容只建一次，之后常驻配置页：来源变化时按订阅重画，不再有打开 / 关闭的生命周期
	function mount(host) {
		if (session || !host) return
		const s = {
			adding: false,
			busy: {},
			errors: {},
			addError: '',
			confirmRemove: '',
			confirmTimer: 0,
		}
		session = s
		S.onChange(function () { render(s) })
		build(host, s)
		render(s)
	}

	function openPanel() {
		if (root.SettingsView) root.SettingsView.protocols()
	}

	root.ProtocolSourcesPanel = { open: openPanel }
	// settings-view.js 在本文件之前加载：分组第一次显示时把内容建进它的容器
	if (root.SettingsView) root.SettingsView.onMount('protocols', mount)
})(typeof window !== 'undefined' ? window : globalThis)
