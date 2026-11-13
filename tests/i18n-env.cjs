// 测试用的界面语言环境：在独立上下文里加载 js/i18n.js 与两份字典，返回 I18n 对象（默认 zh-CN，现有断言按中文文案写）。
// 用法：const { install } = require('./i18n-env.cjs'); install(ctx) —— 把 I18n 挂到 vm 上下文（及其 window）上。
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const files = ['i18n.js', 'i18n-zh-CN.js', 'i18n-en.js'].map((f) => fs.readFileSync(path.join(__dirname, '../js', f), 'utf8'))

function load(locale) {
	const ctx = vm.createContext({})
	ctx.window = ctx
	files.forEach((src) => vm.runInContext(src, ctx))
	if (locale) ctx.I18n._setLocaleForTest(locale)
	return ctx.I18n
}

const shared = load('zh-CN')

function install(target, i18n) {
	const api = i18n || shared
	if (!target) return api
	target.I18n = api
	if (target.window && typeof target.window === 'object' && target.window !== target) target.window.I18n = api
	return api
}

// 让本进程里直接 new Function / vm.runInThisContext 执行的代码也能找到 I18n
globalThis.I18n = shared

// 测试里按模块截取源码、在新建的 vm 上下文里执行：被测代码直接引用全局 I18n，这里给每个新上下文默认挂上 zh-CN 实例
// （上下文对象自己已经带 I18n 时不覆盖，便于个别用例换成 en）。
const createContext = vm.createContext
vm.createContext = function (obj, opts) {
	const o = obj || {}
	if (!vm.isContext(o) && !('I18n' in o)) o.I18n = shared
	return createContext.call(vm, o, opts)
}
const runInNewContext = vm.runInNewContext
vm.runInNewContext = function (code, obj, opts) {
	const o = obj || {}
	if (!vm.isContext(o) && !('I18n' in o)) o.I18n = shared
	return runInNewContext.call(vm, code, o, opts)
}

module.exports = { load, install, I18n: shared }
