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
			'添加来源只读取目录与清单，不会执行代码。每个协议包要先勾选「信任此版本」才能启用；' +
			'启用后协议在页面内以同源权限运行，只应添加你信任的仓库。'))

		const addRow = mk('div', 'mdn-src-add')
		s.urlInput = mk('input', 'form-control form-control-sm')
		s.urlInput.type = 'text'
		s.urlInput.placeholder = 'https://github.com/组织/仓库 或 catalog.json 地址'
		s.urlInput.setAttribute('aria-label', '协议来源地址')
		s.urlInput.setAttribute('autocomplete', 'off')
		s.urlInput.setAttribute('spellcheck', 'false')
		s.addBtn = mk('button', 'btn btn-sm btn-primary')
		s.addBtn.type = 'button'
		s.addBtn.appendChild(mk('i', 'icon icon-sm icon-plus'))
		s.addBtn.appendChild(mk('span', '', '添加来源'))
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
			s.addError = '请输入来源地址'
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
		s.busy[tag] = label || '处理中'
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
			sha.title = '已固定到这个版本：' + src.sha
			title.appendChild(sha)
		}
		if (src.busy) title.appendChild(mk('span', 'mdn-src-busy', src.busy))
		head.appendChild(title)

		const actions = mk('div', 'mdn-src-head-actions')
		const refreshBtn = iconBtn('refresh-cw', '刷新来源')
		refreshBtn.disabled = !!src.busy || !!s.busy['refresh:' + src.key]
		refreshBtn.addEventListener('click', function () {
			runAction(s, 'refresh:' + src.key, function () { return S.refresh(src.key) }, '刷新中')
		})
		const removeBtn = iconBtn('trash-2', s.confirmRemove === src.key ? '确认删除这个来源' : '删除来源')
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
			runAction(s, 'remove:' + src.key, function () { return S.remove(src.key) }, '删除中')
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
			if (!src.busy && !src.error) card.appendChild(mk('div', 'mdn-src-empty', '来源里没有可用的协议包'))
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
		head.appendChild(mk('span', 'mdn-src-pkg-name', pkg.name || pkg.id || '（无效包）'))
		if (pkg.version) head.appendChild(mk('span', 'mdn-src-ver', 'v' + pkg.version))
		if (pkg.digest) {
			const d = mk('span', 'mdn-src-digest', shortDigest(pkg.digest))
			d.title = '入口文件摘要：' + pkg.digest
			head.appendChild(d)
		}
		row.appendChild(head)

		if (pkg.provides.length) {
			const prov = mk('div', 'mdn-src-provides')
			prov.appendChild(mk('span', 'mdn-src-provides-label', '提供协议'))
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
		trustBtn.appendChild(mk('span', '', pkg.trusted ? '已信任此版本' : '信任此版本'))
		trustBtn.title = pkg.trusted ? '点击撤销信任（会同时停用这个版本）' : '确认这个版本的代码可以运行'
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
			}, on ? '启用中' : '停用中')
		})
		const enableLabel = mk('label', 'form-check-label', pkg.enabled ? '已启用' : '启用')
		enableLabel.setAttribute('for', enableInput.id)
		enableWrap.appendChild(enableInput)
		enableWrap.appendChild(enableLabel)
		actions.appendChild(enableWrap)
		row.appendChild(actions)

		if (!pkg.platformOk) row.appendChild(mk('div', 'mdn-src-note', '这个协议包没有声明支持当前平台，不能启用'))
		if (pkg.error) row.appendChild(mk('div', 'mdn-src-err', pkg.error))
		if (pkg.bootError) row.appendChild(mk('div', 'mdn-src-err', '启动时启用失败：' + pkg.bootError))
		if (s.errors[trustTag]) row.appendChild(mk('div', 'mdn-src-err', s.errors[trustTag]))
		if (s.errors[enableTag]) row.appendChild(mk('div', 'mdn-src-err', s.errors[enableTag]))
		return row
	}

	function render(s) {
		if (!s) return
		s.addBtn.disabled = !!s.adding
		s.addBtn.querySelector('span').textContent = s.adding ? '读取中…' : '添加来源'
		s.urlInput.disabled = !!s.adding
		s.addErr.hidden = !s.addError
		s.addErr.textContent = s.addError || ''
		const list = S.list()
		s.listEl.textContent = ''
		if (!list.length) {
			const empty = mk('div', 'mdn-src-empty-block')
			empty.appendChild(mk('div', 'mdn-src-empty-title', '还没有添加来源'))
			empty.appendChild(mk('div', 'mdn-src-empty',
				'仓库根目录放 catalog.json 与各包的 manifest.json 即可。本地示例：在仓库根目录运行 ' +
				'python3 -m http.server 8000，然后添加 http://localhost:8000/examples/protocol-repo/catalog.json'))
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
