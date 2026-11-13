// 配置页「语言」分组：跟随系统 / 中文 / English。选择经 I18n.setChoice 存进 localStorage，界面语言真的变了才整页重载
// （会话、日志、重连意图走既有的 sessionStorage 恢复路径）；有进行中的固件升级、测试流程或协议事务时先用 AppDialog 确认。
;(function (root) {
	'use strict'
	const doc = root.document
	const I18n = root.I18n
	if (!doc || !I18n) return

	// 重载会打断的后台工作：工作台后台任务（固件升级、测试流程等，循环发送与 MCP 服务不算）+ 协议事务
	function busyReasons() {
		const wb = root.Workbench
		const reasons = wb && wb.updateBlockers ? wb.updateBlockers().slice() : []
		const api = root.serialApi
		if (api && api.isPinned && api.isPinned()) reasons.push(I18n.t('lang.transaction'))
		return Array.from(new Set(reasons))
	}

	function render(box) {
		box.querySelectorAll('[data-locale-choice]').forEach(function (btn) {
			const on = btn.dataset.localeChoice === I18n.choice
			btn.classList.toggle('active', on)
			btn.setAttribute('aria-checked', String(on))
		})
	}

	async function choose(choice, opts) {
		const o = opts || {}
		if (!I18n.CHOICES.includes(choice) || choice === I18n.choice) return false
		const next = I18n.resolve(choice)
		if (next === I18n.locale) {
			// 界面语言不变（例如系统就是中文时从「中文」改回「跟随系统」）：只存选择，不重载
			I18n.setChoice(choice)
			if (o.box) render(o.box)
			return false
		}
		const reasons = busyReasons()
		if (reasons.length && root.AppDialog) {
			const ok = await root.AppDialog.confirm(I18n.t('lang.busyConfirm', { reasons: reasons.join(I18n.t('lang.listSep')) }), {
				title: I18n.t('lang.switchTitle'),
				okText: I18n.t('lang.reloadNow'),
				cancelText: I18n.t('lang.cancel'),
			})
			if (!ok) return false
		}
		I18n.setChoice(choice)
		root.location.reload()
		return true
	}

	const box = doc.getElementById('language-switch')
	if (box) {
		render(box)
		box.addEventListener('click', function (e) {
			const btn = e.target.closest('[data-locale-choice]')
			if (btn) choose(btn.dataset.localeChoice, { box: box })
		})
	}

	root.LanguageSwitch = { choose: choose, busyReasons: busyReasons }
})(window)
