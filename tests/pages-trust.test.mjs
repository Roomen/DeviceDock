import test from 'node:test'
import assert from 'node:assert/strict'
import { parseHTML } from 'linkedom'
import { PageController, pageTitle, pluginPageKey } from '../src/pages.js'
import { TrustStore, EnableState, restoreDecision, grantKey, normalizeGrant } from '../src/trust.js'
import { ExtensionHost } from '../src/extensions.js'
import { Session } from '../src/session.js'

const memory = () => { const map = new Map(); return { map, getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) } }
const broken = () => ({ getItem: () => null, setItem: () => { throw Error('quota') } })
const hash = n => String(n).repeat(64).slice(0, 64)
const grant = (patch = {}) => ({ source: 'bundled', id: 'org.test.plugin', version: '1.0.0', hash: hash(1), ...patch })

function fixturePages() {
 const { document } = parseHTML('<nav id="nav"></nav><div id="a"></div><div id="b"></div><div id="c"></div>')
 const changes = []
 const pages = new PageController({ document, nav: document.querySelector('#nav'), onChange: key => changes.push(key) })
 pages.register('workbench', { title: '通信调试', section: document.querySelector('#a'), order: 0, kind: 'core' })
 pages.register('extensions', { title: '扩展管理', section: document.querySelector('#b'), order: 10, kind: 'core' })
 pages.register('settings', { title: '设置', section: document.querySelector('#c'), order: 1000, kind: 'core' })
 return { document, pages, changes }
}

test('page navigation notifies on every real switch and only toggles visibility', () => {
 const { document, pages, changes } = fixturePages()
 const a = document.querySelector('#a'), b = document.querySelector('#b')
 assert.equal(a.hidden, false); assert.equal(b.hidden, true)
 assert.equal(pages.show('extensions'), true)
 assert.deepEqual(changes, ['extensions'], 'navigating must reach onChange')
 assert.equal(a.hidden, true); assert.equal(b.hidden, false)
 assert.equal(document.querySelector('#nav button[data-page=extensions]').getAttribute('aria-pressed'), 'true')
 // Re-selecting the current page is not a change and must not re-render it.
 assert.equal(pages.show('extensions'), true)
 assert.deepEqual(changes, ['extensions'])
 // Unknown keys never navigate.
 assert.equal(pages.show('missing'), false)
 assert.deepEqual(changes, ['extensions'])
})

test('removing the current plugin page falls back to the workbench page and notifies once', () => {
 const { document, pages, changes } = fixturePages()
 const section = document.createElement('section')
 pages.register(pluginPageKey('org.test.one'), { title: 'One', section, order: 20, kind: 'plugin' })
 pages.show(pluginPageKey('org.test.one'))
 assert.deepEqual(changes, [pluginPageKey('org.test.one')])
 assert.equal(section.hidden, false)
 pages.remove(pluginPageKey('org.test.one'))
 assert.equal(pages.current, 'workbench', 'closing the active plugin page returns to the serial page')
 assert.deepEqual(changes, [pluginPageKey('org.test.one'), 'workbench'])
 assert.equal(section.hidden, false, 'the removed section is owned by the extension, not the controller')
 assert.equal(document.querySelector('#a').hidden, false)
 assert.equal(document.querySelector('#nav button[data-page="plugin:org.test.one"]'), null)
})

test('page show/hide events drive re-measurement and sync reuses existing sections', () => {
 const { document, pages } = fixturePages()
 const section = document.createElement('section')
 section.hidden = true // extension pages start hidden until navigation shows them
 const events = []
 const view = document.defaultView
 const listener = () => events.push('resize')
 view.addEventListener('devicedock:page-resize', listener)
 section.addEventListener('devicedock:page-show', () => events.push('show'))
 section.addEventListener('devicedock:page-hide', () => events.push('hide'))
 const entries = [{ id: 'org.test.power', title: 'Power', section }]
 pages.sync(entries)
 pages.show(pluginPageKey('org.test.power'))
 pages.sync(entries) // identical entry list must not rebuild or re-register
 pages.show('workbench')
 pages.sync(entries)
 assert.deepEqual(events, ['show', 'resize', 'resize', 'hide'], 'identical sync must not re-fire show; returning to the workbench re-measures it')
 assert.equal(pages.current, 'workbench')
 view.removeEventListener('devicedock:page-resize', listener)
})

test('page titles come from the manifest name and are bounded/escaped as text', () => {
 assert.equal(pageTitle('Power instrument and analysis'), 'Power instrument and analysis')
 assert.equal(pageTitle('  a\n\tb  '), 'a b')
 assert.equal(pageTitle(''), '插件')
 assert.equal(pageTitle(undefined, 'org.test.id'), 'org.test.id')
 assert.equal(pageTitle('x'.repeat(200), 'fallback').length, 40)
})

test('trust is keyed by source, id, version and content digest', () => {
 const storage = memory(), trust = new TrustStore(storage)
 assert.equal(trust.has(grant()), false)
 trust.grant(grant())
 assert.equal(trust.has(grant()), true)
 assert.equal(trust.has(grant({ version: '1.0.1' })), false, 'a new version needs its own decision')
 assert.equal(trust.has(grant({ hash: hash(2) })), false, 'different bytes need their own decision')
 assert.equal(trust.has(grant({ source: 'plugin:https://github.com/a/b' })), false, 'a different repository needs its own decision')
 // Reload from the same storage keeps the decision without any global checkbox.
 const reloaded = new TrustStore(storage)
 assert.equal(reloaded.has(grant()), true)
 assert.equal(reloaded.all().length, 1)
 assert.equal(reloaded.revoke(grant()), true)
 assert.equal(reloaded.has(grant()), false)
 assert.equal(new TrustStore(storage).has(grant()), false)
})

test('corrupt trust storage is sanitized and never silently authorizes anything', () => {
 const storage = memory()
 storage.setItem('devicedock.trust', '{not json')
 const trust = new TrustStore(storage)
 assert.deepEqual(trust.all(), [])
 assert.equal(trust.has(grant()), false)
 assert.equal(JSON.parse(storage.getItem('devicedock.trust')).length, 0, 'corrupt storage is repaired to an empty list')
 storage.setItem('devicedock.trust', JSON.stringify([grant(), { id: 'not a valid id' }, { ...grant({ hash: 'nope' }) }, 'string']))
 const mixed = new TrustStore(storage)
 assert.equal(mixed.all().length, 1)
 assert.equal(mixed.has(grant()), true)
 assert.equal(grantKey(normalizeGrant(grant())), JSON.stringify(['bundled', 'org.test.plugin', '1.0.0', hash(1)]))
})

test('a failed trust write leaves the session matching a restart instead of claiming success', () => {
 const trust = new TrustStore(broken())
 assert.throws(() => trust.grant(grant()), /无法写入/)
 assert.equal(trust.has(grant()), false, 'memory must not report a grant that was not stored')
 const storage = memory(), revoking = new TrustStore(storage)
 revoking.grant(grant())
 revoking.storage = broken()
 assert.throws(() => revoking.revoke(grant()), /无法写入/)
 assert.equal(revoking.has(grant()), true, 'a failed revoke keeps the stored decision in force')
 assert.equal(new TrustStore(storage).has(grant()), true)
})

test('enabled records are per package id, version aware and persist a visible failure', () => {
 const storage = memory(), enabled = new EnableState(storage)
 enabled.record({ ...grant(), url: './extensions/x/index.js' })
 assert.equal(enabled.get('org.test.plugin').version, '1.0.0')
 enabled.fail('org.test.plugin', 'activation exploded')
 const reloaded = new EnableState(storage)
 assert.equal(reloaded.get('org.test.plugin').failed, true)
 assert.equal(reloaded.get('org.test.plugin').error, 'activation exploded')
 assert.equal(restoreDecision(reloaded.get('org.test.plugin'), { trust: new TrustStore(storage), installed: [{ manifest: { id: 'org.test.plugin' }, source: 'bundled', hash: hash(1) }] }).reason, 'failed')
 reloaded.retry('org.test.plugin')
 assert.equal(reloaded.get('org.test.plugin').failed, false)
 assert.equal(reloaded.remove('org.test.plugin'), true)
 assert.equal(reloaded.get('org.test.plugin'), null)
 assert.equal(new EnableState(storage).all().length, 0)
})

test('a failed enable-state write never fakes durability', () => {
 const enabled = new EnableState(broken())
 assert.throws(() => enabled.record(grant()), /无法写入/)
 assert.equal(enabled.get('org.test.plugin'), null)
 const storage = memory(), state = new EnableState(storage)
 state.record(grant())
 state.storage = broken()
 assert.throws(() => state.remove('org.test.plugin'), /无法写入/)
 assert.ok(state.get('org.test.plugin'), 'failed removal keeps the record that will actually be restored')
})

test('restore only happens for the same installed bytes that are still trusted', () => {
 const storage = memory(), trust = new TrustStore(storage)
 const installed = [{ manifest: { id: 'org.test.plugin' }, source: 'bundled', hash: hash(1), url: './extensions/a/index.js' }]
 const record = { ...grant(), url: './extensions/a/index.js' }
 assert.equal(restoreDecision(record, { trust, installed }).reason, 'untrusted')
 trust.grant(record)
 assert.equal(restoreDecision(record, { trust, installed }).restore, true)
 assert.equal(restoreDecision(record, { trust, installed }).item.url, './extensions/a/index.js')
 assert.equal(restoreDecision(record, { trust, installed: [] }).reason, 'missing-package')
 assert.equal(restoreDecision({ ...record, hash: hash(9) }, { trust, installed }).reason, 'missing-package', 'the newer bytes are not installed yet')
 assert.equal(restoreDecision({ ...record, hash: hash(9) }, { trust, installed: [{ manifest: { id: 'org.test.plugin' }, source: 'bundled', hash: hash(9) }] }).reason, 'untrusted', 'installing a new version never inherits the old grant')
 assert.equal(restoreDecision({ ...record, source: 'plugin:https://github.com/x/y' }, { trust, installed }).reason, 'missing-package')
 assert.equal(restoreDecision(null, { trust, installed }).reason, 'missing')
})

function fixtureHost(document) {
 const sessions = { A: new Session('A') }
 const host = new ExtensionHost({ sessions, mount: document.querySelector('#shared'), pageHost: document.querySelector('#pages'), storage: memory() })
 return { sessions, host }
}
const manifest = (patch = {}) => ({ schemaVersion: 1, id: 'org.test.ui', name: 'Test UI', version: '1.0.0', apiVersion: 1, kind: 'plugin', entry: 'index.js', platforms: ['web'], capabilities: [], license: 'MIT', integrity: { 'index.js': 'sha256-' + '0'.repeat(64) }, ...patch })

test('protocol-only packages get no page while plugins with UI get exactly one page each', async () => {
 const { document } = parseHTML('<div id="shared"></div><div id="pages"></div>')
 const { host } = fixtureHost(document)
 await host.enable(manifest({ id: 'org.test.protocol', kind: 'protocol' }), 'p', true, async () => ({ activate(h) { h.registerProtocol({ id: 'p', title: 'p', create: () => ({ feed: () => [], reset() {} }) }) } }))
 assert.deepEqual(host.pages(), [], 'a parser-only package must not create an empty page')
 await host.enable(manifest(), 'ui', true, async () => ({ activate(h) { const head = h.mount.ownerDocument.createElement('h2'); head.textContent = 'Power'; h.mount.append(head) } }))
 const pages = host.pages()
 assert.equal(pages.length, 1)
 assert.equal(pages[0].id, 'org.test.ui')
 assert.equal(pages[0].title, 'Test UI', 'the page title comes from the manifest')
 assert.equal(pages[0].section.dataset.pluginPage, 'org.test.ui')
 assert.equal(pages[0].section.hidden, true, 'a plugin page starts hidden until navigation shows it')
 // Legacy host.mount UI built after an async step must still be promoted.
 await host.enable(manifest({ id: 'org.test.late' }), 'late', true, async () => ({ activate(h) { setTimeout(() => { const b = h.mount.ownerDocument.createElement('button'); b.textContent = 'go'; h.mount.append(b) }, 0) } }))
 await new Promise(resolve => setTimeout(resolve, 20))
 assert.ok(host.pages().some(page => page.id === 'org.test.late'), 'late legacy UI is promoted without a manual refresh')
 await host.disable('org.test.ui')
 assert.equal(host.pages().some(page => page.id === 'org.test.ui'), false, 'disabling removes the navigation entry')
 await host.disable('org.test.late')
 await host.disable('org.test.protocol')
})

test('registerPage marks a page explicitly and can retitle it from package code', async () => {
 const { document } = parseHTML('<div id="shared"></div><div id="pages"></div>')
 const { host } = fixtureHost(document)
 let api
 await host.enable(manifest({ id: 'org.test.explicit', name: 'Manifest name' }), 'x', true, async () => ({ activate(h) { api = h.registerPage({ title: 'Custom page' }) } }))
 const page = host.pages().find(entry => entry.id === 'org.test.explicit')
 assert.equal(page.title, 'Custom page')
 api.setTitle('Renamed page')
 assert.equal(host.pages().find(entry => entry.id === 'org.test.explicit').title, 'Renamed page')
 await host.disable('org.test.explicit')
 assert.deepEqual(host.pages(), [])
})

test('the shipped example package packs, verifies and registers a real page', async () => {
 const { pack } = await import('../tools/integrate.mjs')
 const { verifyPackage } = await import('../src/package.js')
 const { pathToFileURL, fileURLToPath } = await import('node:url')
 const { join } = await import('node:path')
 const root = fileURLToPath(new URL('..', import.meta.url))
 const directory = join(root, 'examples/page-plugin')
 const bundle = await pack(directory), verified = await verifyPackage(bundle, 'web')
 assert.equal(verified.manifest.id, 'org.example.page-demo')
 const { document } = parseHTML('<div id="shared"></div><div id="pages"></div>')
 const { host } = fixtureHost(document)
 await host.enable(bundle.manifest, pathToFileURL(join(directory, bundle.manifest.entry)).href, true)
 const pages = host.pages()
 assert.equal(pages.length, 1, 'the example declares exactly one page')
 assert.equal(pages[0].title, 'Example page', 'registerPage title wins over the manifest name')
 const section = pages[0].section
 assert.equal(section.hidden, true)
 const button = [...section.querySelectorAll('button')].find(node => node.textContent === 'Count one click')
 assert.ok(button, 'the example renders its controls into its own section')
 button.dispatchEvent(new document.defaultView.Event('click'))
 assert.match(section.textContent, /clicks: 1/, 'page interactions run inside the plugin section')
 // Retitling through the public handle updates the entry.
 const input = section.querySelector('input')
 input.value = 'Renamed by test'
 input.dispatchEvent(new document.defaultView.Event('input'))
 assert.equal(host.pages()[0].title, 'Renamed by test')
 await host.disable(bundle.manifest.id)
 assert.deepEqual(host.pages(), [], 'disabling the example removes its page')
})

test('native-process pages stay registered across extension-page sync and are navigable', async () => {
 const { nativePageRegistrar } = await import('../src/native-plugins-mount.js')
 const { document } = parseHTML('<nav id="nav"></nav><div id="a"></div><div id="b"></div><div id="c"></div><div id="native"></div>')
 const changes = []
 const pages = new PageController({ document, nav: document.querySelector('#nav'), onChange: key => changes.push(key) })
 pages.register('workbench', { title: '通信调试', section: document.querySelector('#a'), order: 0, kind: 'core' })
 pages.register('extensions', { title: '扩展管理', section: document.querySelector('#b'), order: 10, kind: 'core' })
 pages.register('settings', { title: '设置', section: document.querySelector('#c'), order: 1000, kind: 'core' })
 // A native backend registers one page per running, trusted package.
 const registerPage = nativePageRegistrar(pages)
 const section = document.createElement('section')
 section.dataset.nativePlugin = hash(9)
 document.querySelector('#native').append(section)
 const dispose = registerPage({ id: `native-${hash(9)}`, title: 'Synthetic native', element: section })
 const key = `native-native-${hash(9)}`
 assert.equal(pages.has(key), true, 'native page is registered with the page controller')
 // Extension-host sync only reconciles plugin: pages; it must not delete native pages.
 pages.sync([])
 assert.equal(pages.has(key), true, 'extension sync with zero plugin pages kept the native page')
 pages.sync([{ id: 'org.test.one', title: 'One', section: document.createElement('section') }])
 assert.equal(pages.has(key), true, 'adding a plugin page kept the native page')
 pages.sync([{ id: 'org.test.one', title: 'One', section: document.createElement('section') }])
 assert.equal(pages.has(key), true, 're-syncing kept the native page')
 // The native page is reachable from the navigation and only toggles visibility.
 assert.equal(pages.show(key), true)
 assert.equal(section.hidden, false, 'navigating to the native page shows its section')
 assert.equal(document.querySelector('#a').hidden, true)
 assert.equal(document.querySelector('#nav button[data-page="' + key + '"]').textContent, 'Synthetic native')
 // Removing the page (plugin stopped/uninstalled) falls back to the serial page.
 dispose()
 assert.equal(pages.has(key), false)
 assert.equal(pages.current, 'workbench')
 assert.equal(document.querySelector('#a').hidden, false)
})
