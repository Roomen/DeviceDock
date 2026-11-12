// 启动期的两处页面装饰：左侧导航的版本号、首次访问的反馈提示。
// 在版本号与功能模块之前加载（脚本位于 body 末尾，DOM 已就绪），不做任何权限判断。
;(function () {
	'use strict'

	var verEl = document.getElementById('app-version')
	if (verEl && window.APP_VERSION) {
		verEl.textContent = 'v' + window.APP_VERSION
		verEl.title = '应用版本 v' + window.APP_VERSION
	}

	var tip = document.getElementById('issue-tip')
	var closeBtn = document.getElementById('issue-tip-close')
	if (!tip || !closeBtn) return
	if (localStorage.getItem('issueTipDismissed')) return
	// 提示是状态栏右端的一条单行（css 的 .issue-tip），插进 #serial-statusbar 后不遮任何内容；
	// workbench 建好外壳后才插入（状态栏节点由它在 DOMContentLoaded 时搬进 #app-statusbar），
	// 模式切换重建状态栏时由 workbench 原样保留。一次性语义与 shell.browser 门控（data-feature）不变
	function mount() {
		var bar = document.getElementById('serial-statusbar')
		if (!bar) return false
		bar.appendChild(tip)
		tip.hidden = false
		return true
	}
	function bind() {
		closeBtn.addEventListener('click', function () {
			tip.hidden = true
			localStorage.setItem('issueTipDismissed', '1')
		})
	}
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', function () {
			if (mount()) bind()
		})
	} else if (mount()) {
		bind()
	}
})()
