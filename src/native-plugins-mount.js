// Adapter between the shell's native-process plugin module and the host page
// controller. The native module owns its settings panel and iframe pages; the
// host only lends navigation and the status line.
//
// Contract (native-interface.md): mountNativePlugins({platform,panel,pagesContainer,registerPage,status})
// returns {refresh(), dispose()}. registerPage({id,title,element}) returns a disposer.
const SPECIFIER = './shell/native-plugins.js'

export const unavailableNote = '当前构建未包含原生插件支持（需要桌面客户端与宿主后台模块）。'

function disposer(value) {
 if (typeof value === 'function') return value
 if (value && typeof value.dispose === 'function') return () => value.dispose()
 return () => {}
}

export function nativePageRegistrar(pages, { status = () => {}, prefix = 'native-' } = {}) {
 return ({ id, title, element } = {}) => {
  if (typeof id !== 'string' || !id) throw Error('原生插件页面缺少标识')
  if (!element || typeof element !== 'object') throw Error('原生插件页面缺少容器')
  const key = prefix + id
  pages.register(key, { title, section: element, order: 900, kind: 'native' })
  return () => { pages.remove(key) }
 }
}

export function showUnavailable(panel, note = unavailableNote) {
 if (!panel) return
 const doc = panel.ownerDocument
 const p = doc.createElement('p')
 p.className = 'muted'
 p.textContent = note
 panel.replaceChildren(p)
}

export async function mountNativeSettings({
 platform,
 panel,
 pagesContainer,
 pages,
 status = () => {},
 importer = specifier => import(specifier),
 specifier = SPECIFIER,
 note = unavailableNote
} = {}) {
 if (!platform?.native || !panel) { showUnavailable(panel, note); return { available: false, refresh: () => {}, dispose: () => {} } }
 let module
 try { module = await importer(specifier) } catch { showUnavailable(panel, note); return { available: false, refresh: () => {}, dispose: () => {} } }
 const mount = module?.mountNativePlugins
 if (typeof mount !== 'function') { showUnavailable(panel, note); return { available: false, refresh: () => {}, dispose: () => {} } }
 const registerPage = nativePageRegistrar(pages, { status })
 try {
  const mounted = await mount({ platform, panel, pagesContainer, registerPage, status })
  const refresh = typeof mounted?.refresh === 'function' ? () => mounted.refresh() : () => {}
  const stop = disposer(mounted)
  return { available: true, refresh, dispose: stop }
 } catch (error) {
  showUnavailable(panel, `原生插件界面不可用：${error?.message || error}`)
  status(`原生插件界面不可用：${error?.message || error}`)
  return { available: false, refresh: () => {}, dispose: () => {} }
 }
}
