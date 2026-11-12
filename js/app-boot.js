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
	tip.hidden = false
	closeBtn.addEventListener('click', function () {
		tip.hidden = true
		localStorage.setItem('issueTipDismissed', '1')
	})
})()
