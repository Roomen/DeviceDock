// Single navigation controller for shell pages, plugin pages and reserved
// external (native-process) pages. Switching only toggles visibility: enabled
// extensions are never re-activated or torn down by navigation.
const PLUGIN_PREFIX = 'plugin:'

export const pluginPageKey = id => PLUGIN_PREFIX + id
export const isPluginPageKey = key => typeof key === 'string' && key.startsWith(PLUGIN_PREFIX)

export function pageTitle(value, fallback = '插件') {
 const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : ''
 return (text || fallback).slice(0, 40)
}

export class PageController {
 constructor({ document, nav, onChange = () => {} }) {
  this.document = document; this.nav = nav; this.onChange = onChange
  this.pages = new Map(); this.current = null; this.buttons = new Map()
 }
 register(key, { title, section, order = 100, hidden = false, kind = 'core' }) {
  if (typeof key !== 'string' || !key) throw Error('页面标识无效')
  if (!section) throw Error('页面容器无效')
  this.pages.set(key, { key, title: pageTitle(title, key), section, order, hidden: !!hidden, kind })
  this.render()
  return key
 }
 remove(key) {
  if (!this.pages.delete(key)) return false
  this.buttons.get(key)?.remove(); this.buttons.delete(key)
  // Deleting the current page falls back inside apply() and reports the change.
  this.render()
  return true
 }
 setTitle(key, title) {
  const page = this.pages.get(key); if (!page) return
  page.title = pageTitle(title, page.key); this.render()
 }
 has(key) { return this.pages.has(key) }
 keys() { return [...this.pages.keys()] }
 fallbackKey() {
  for (const page of this.pages.values()) if (page.kind === 'core' && page.key !== 'extensions' && page.key !== 'settings') return page.key
  return this.pages.keys().next().value || null
 }
 render() {
  const nav = this.nav
  if (!nav) return
  const ordered = [...this.pages.values()].sort((a, b) => a.order - b.order)
  for (const page of ordered) {
   let button = this.buttons.get(page.key)
   if (!button) {
    button = this.document.createElement('button')
    button.type = 'button'
    button.dataset.page = page.key
    button.addEventListener('click', () => this.show(page.key))
    this.buttons.set(page.key, button)
   }
   if (button.textContent !== page.title) button.textContent = page.title
   if (button.title !== page.title) button.title = page.title
   button.hidden = page.hidden
   button.setAttribute('aria-pressed', String(this.current === page.key))
  }
  // Keep DOM order in sync with the logical order without recreating buttons.
  const fragment = this.document.createDocumentFragment()
  for (const page of ordered) fragment.append(this.buttons.get(page.key))
  nav.append(fragment)
  this.apply()
 }
 // Reconcile visibility with the requested page. The target is passed in
 // explicitly so a navigation is always observed as a state change.
 apply(target = this.current) {
  const next = this.pages.has(target) ? target : this.fallbackKey()
  // The very first reconciliation is implicit (no previous page to leave), so
  // it must not look like a user navigation.
  const changed = this.current !== null && next !== this.current
  this.current = next
  for (const page of this.pages.values()) {
   const visible = page.key === next && !page.hidden
   const was = page.section.hidden === false
   page.section.hidden = !visible
   if (visible && !was) this.notify(page, 'show')
   else if (!visible && was) this.notify(page, 'hide')
  }
  for (const [key, button] of this.buttons) button.setAttribute('aria-pressed', String(key === next))
  if (changed) this.onChange(next)
 }
 notify(page, action) {
  const view = this.document.defaultView
  const EventClass = view?.CustomEvent || globalThis.CustomEvent
  if (typeof EventClass !== 'function' || typeof page.section.dispatchEvent !== 'function') return
  page.section.dispatchEvent(new EventClass(`devicedock:page-${action}`, { bubbles: false }))
  // Hidden panes keep their pre-hide layout; ask plugins to re-measure now that
  // they are visible again (xterm FitAddon, canvases, iframes, native webviews).
  if (action === 'show' && typeof view?.dispatchEvent === 'function') view.dispatchEvent(new EventClass('devicedock:page-resize'))
 }
 show(key) {
  if (!this.pages.has(key)) return false
  this.apply(key)
  return true
 }
 sync(entries) {
  // entries: [{id,title,section}] from the extension host.
  const wanted = new Map(entries.map(entry => [pluginPageKey(entry.id), entry]))
  let changed = false
  for (const key of [...this.pages.keys()]) {
   if (!isPluginPageKey(key)) continue
   if (!wanted.has(key)) { this.pages.delete(key); this.buttons.get(key)?.remove(); this.buttons.delete(key); changed = true }
  }
  let index = 0
  for (const [key, entry] of wanted) {
   const existing = this.pages.get(key)
   const page = { key, title: pageTitle(entry.title, entry.id), section: entry.section, order: 20 + index++, hidden: false }
   if (!existing || existing.section !== entry.section || existing.title !== page.title || existing.order !== page.order) { this.pages.set(key, { ...page, kind: 'plugin' }); changed = true }
  }
  if (changed || !this.current || !this.pages.has(this.current)) this.render()
 }
}
