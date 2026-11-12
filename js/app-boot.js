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
	// 挂到左栏「反馈」项旁边的小气泡：默认位置（固定左下）会在窄窗口时离反馈项太远，
	// 但都不落在右侧面板区，不再挡住面板标题与工具条
	var anchor = document.querySelector('#activity-rail .rail-item[href*="issues/new"]')
	if (anchor) {
		var rect = anchor.getBoundingClientRect()
		var top = Math.max(8, Math.min(rect.top - 6, window.innerHeight - 130))
		tip.style.left = Math.round(rect.right + 10) + 'px'
		tip.style.top = Math.round(top) + 'px'
		tip.style.bottom = 'auto'
	}
	tip.hidden = false
	closeBtn.addEventListener('click', function () {
		tip.hidden = true
		localStorage.setItem('issueTipDismissed', '1')
	})
})()
