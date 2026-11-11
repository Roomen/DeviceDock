// Minimal, self-contained example of an independent plugin page.
// It only uses the public SDK v1 surface from sdk/index.d.ts:
//   host.registerPage({title}) -> page handle
//   host.signal               -> AbortSignal disposed on disable
//   host.mount                -> the page section element
// Package it with `node tools/integrate.mjs pack examples/page-plugin out.json`.
export function activate(host) {
 const doc = host.mount.ownerDocument
 const root = doc.createElement('section')
 host.mount.append(root)
 const make = (tag, text) => { const el = doc.createElement(tag); if (text != null) el.textContent = text; root.append(el); return el }
 const button = (text, fn) => { const b = make('button', text); b.type = 'button'; b.addEventListener('click', () => { try { fn() } catch (e) { status.textContent = e.message } }, { signal: host.signal }); return b }

 // An explicit page entry is required when the package renders a non-trivial
 // UI; without it a page is only created once host.mount receives content.
 const page = typeof host.registerPage === 'function' ? host.registerPage({ title: 'Example page' }) : { setTitle() {} }

 const heading = make('p', 'This page is a plugin. It keeps its state while other pages are shown.')
 const counter = make('output', 'clicks: 0')
 const status = make('output', 'Ready')
 let clicks = 0
 button('Count one click', () => { clicks += 1; counter.textContent = `clicks: ${clicks}` })
 const input = make('input')
 input.placeholder = 'Rename this page from here'
 input.setAttribute('aria-label', 'Page title')
 input.addEventListener('input', () => page.setTitle(input.value.trim() || 'Example page'), { signal: host.signal })
 root.addEventListener('devicedock:page-show', () => { status.textContent = `shown at ${new Date().toLocaleTimeString()}` }, { signal: host.signal })
 root.addEventListener('devicedock:page-hide', () => { status.textContent = 'hidden (state kept)' }, { signal: host.signal })
 heading.dataset.demo = 'page-plugin'
 return () => { root.remove() }
}
