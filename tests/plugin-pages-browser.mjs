// Browser regression for the plugin page model, persisted trust and safe restore.
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import assert from 'node:assert/strict'

const port = Number(process.env.TEST_PORT || 18097)
const server = spawn(process.execPath, ['tools/serve.mjs'], { env: { ...process.env, PORT: String(port), SERVE_DIST: process.env.SERVE_DIST || 'dist' }, stdio: ['ignore', 'pipe', 'pipe'] })
let browser
const POWER = 'org.devicedock.power'
const POWER_NAME = 'Power instrument and analysis'
const PROTOCOL_ONLY = 'org.devicedock.cjt188'
const navTexts = page => page.locator('#main-nav button').allTextContents()

try {
 await once(server.stdout, 'data')
 browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
 const page = await browser.newPage(), errors = []
 page.on('pageerror', error => errors.push(error.message))
 await page.addInitScript(() => { Object.defineProperty(navigator, 'serial', { value: { getPorts: async () => [], addEventListener() {}, async requestPort() { throw Error('no hardware in tests') } } }) })
 const open = async () => { await page.goto(`http://127.0.0.1:${port}`); await page.waitForFunction(() => document.querySelector('.transport option')) }
 const row = id => page.locator(`.package-row[data-extension="${id}"]`)
 const enable = async id => {
  await page.locator('[data-page="extensions"]').click()
  const target = row(id)
  await target.locator('.trust-toggle').check()
  await target.getByRole('button', { name: '启用此版本', exact: true }).click()
  await page.waitForFunction(extensionId => {
   const application = window.__application
   return application?.host.extensions.get(extensionId)?.status === 'enabled'
  }, id)
 }
 const hostState = () => page.evaluate(() => ({
  enabled: [...window.__application.host.extensions].filter(([, state]) => state.status === 'enabled').map(([id]) => id),
  pages: window.__application.host.pages().map(entry => ({ id: entry.id, title: entry.title })),
  current: window.__application.pages.current,
  nav: [...document.querySelectorAll('#main-nav button')].map(button => button.textContent),
  trust: window.__application.trust.all().map(grant => `${grant.id}@${grant.version}`),
  records: window.__application.enableState.all().map(record => `${record.id}@${record.version}:${record.failed ? 'failed' : 'ok'}`)
 }))

 await open()
 await page.evaluate(async () => { window.__application = (await import('./src/app.js')).application })
 assert.deepEqual(await navTexts(page), ['通信调试', '扩展管理', '设置'], 'zero-plugin navigation has no empty plugin pages and no separate client/source tabs')
 assert.equal(await page.locator('#main-nav button[data-page="shell"], #main-nav button[data-page="sources"]').count(), 0, 'client services and sources moved out of top-level navigation')
 assert.equal(await page.locator('#native-plugin-list').textContent().then(text => /未包含|不使用|不启动/.test(text)), true, 'native plugins show a clearly unavailable panel without inventing a backend')
 // A native-process page must be able to occupy #native-plugin-pages: the host
 // container has to stay in flow, the page must appear in the main navigation and
 // extension-page sync must never drop it.
 assert.equal(await page.locator('#native-plugin-pages').getAttribute('hidden'), null, 'native page container is not permanently hidden')
 const nativeHost = await page.evaluate(() => {
  const app = window.__application
  const section = document.createElement('section')
  section.dataset.nativePlugin = 'qa'
  document.querySelector('#native-plugin-pages').append(section)
  app.pages.register('native-qa', { title: 'QA native page', section, order: 900, kind: 'native' })
  const navText = [...document.querySelectorAll('#main-nav button')].map(button => button.textContent)
  app.host.changed() // extension-host sync path, must not delete native pages
  const keptAfterSync = app.pages.has('native-qa')
  app.pages.show('native-qa')
  const box = section.getBoundingClientRect()
  const result = { navText, keptAfterSync, visible: !section.hidden && box.height > 0, containerHidden: section.parentElement.hidden, canvas: null }
  app.pages.remove('native-qa'); section.remove()
  return result
 })
 assert.deepEqual(nativeHost.navText, ['通信调试', '扩展管理', 'QA native page', '设置'], 'native page is reachable from the main navigation, ahead of settings')
 assert.equal(nativeHost.keptAfterSync, true, 'extension sync kept the native page')
 assert.equal(nativeHost.visible, true, 'navigating to the native page reveals a measurable container')
 assert.equal(nativeHost.containerHidden, false, 'native page container is visible when its page is shown')

 // Enabling a plugin with UI adds exactly one page named after the manifest.
 await enable(POWER)
 let state = await hostState()
 assert.deepEqual(state.pages.map(entry => entry.id), [POWER])
 assert.ok(state.nav.includes(POWER_NAME), 'the navigation entry uses the manifest name')
 assert.ok(!state.nav.includes('cjt188') && !state.pages.some(entry => entry.id === PROTOCOL_ONLY), 'protocol-only packages create no page yet')

 // Switching pages only hides/shows: same section node, no re-activation.
 await page.evaluate(() => { window.__section = document.querySelector(`[data-plugin-page="${CSS.escape('org.devicedock.power')}"]`) })
 await page.locator(`#main-nav button:text-is("${POWER_NAME}")`).click()
 await page.waitForFunction(() => document.querySelector('#workbench').hidden)
 assert.equal(await page.locator('#workbench').isHidden(), true)
 assert.equal(await page.locator('#extensions').isHidden(), true, 'management is hidden while a plugin page is shown')
 const pageShown = await page.evaluate(() => {
  const section = document.querySelector('[data-plugin-page="org.devicedock.power"]')
  return { same: section === window.__section, hidden: section.hidden, status: window.__application.host.extensions.get('org.devicedock.power').status, shows: (window.__pageEvents ||= []).length }
 })
 assert.deepEqual(pageShown, { same: true, hidden: false, status: 'enabled', shows: 0 })
 await page.locator('[data-page="workbench"]').click()
 assert.equal(await page.locator('#workbench').isHidden(), false)
 assert.equal(await page.evaluate(() => document.querySelector('[data-plugin-page="org.devicedock.power"]').hidden), true, 'leaving a plugin page hides but keeps it alive')
 assert.equal(await page.evaluate(() => document.querySelector('[data-plugin-page="org.devicedock.power"]') === window.__section), true, 'navigation never re-creates the activated plugin section')

 // Hidden panes must re-measure on show: the terminal refits when it returns.
 await page.locator('[data-page="workbench"]').click()
 await page.evaluate(() => { const lane = document.querySelector('.lane'); const display = lane.querySelector('.display'); display.value = 'term'; display.dispatchEvent(new Event('change')) })
 // The terminal must occupy the real pane width, not a default-sized buffer.
 await page.waitForFunction(() => {
  const terminal = document.querySelector('.terminal'), screen = terminal.querySelector('.xterm-screen')
  return !!screen && terminal.clientWidth > 0 && screen.getBoundingClientRect().width > terminal.clientWidth * 0.9
 })
 const beforeHide = await page.evaluate(() => document.querySelector('.terminal .xterm-screen').getBoundingClientRect().width)
 await page.locator(`#main-nav button:text-is("${POWER_NAME}")`).click()
 assert.equal(await page.evaluate(() => document.querySelector('.terminal .xterm-screen').getBoundingClientRect().width), 0, 'the hidden page collapses its terminal instead of keeping a stale size')
 await page.locator('[data-page="workbench"]').click()
 await page.waitForFunction(width => {
  const screen = document.querySelector('.terminal .xterm-screen')
  return !!screen && Math.abs(screen.getBoundingClientRect().width - width) < 2
 }, beforeHide)
 assert.ok(await page.evaluate(width => Math.abs(document.querySelector('.terminal .xterm-screen').getBoundingClientRect().width - width) < 12, beforeHide), 'xterm re-fits to the real pane width after returning to the workbench page')
 await page.evaluate(() => { const display = document.querySelector('.lane .display'); display.value = 'hex'; display.dispatchEvent(new Event('change')) })

 // Enabled + trusted survives a reload and restores the same authorized bytes.
 await open()
 await page.evaluate(async () => { window.__application = (await import('./src/app.js')).application })
 await page.waitForFunction(seed => window.__application.host.extensions.get(seed)?.status === 'enabled', POWER)
 state = await hostState()
 assert.deepEqual(state.pages.map(entry => entry.id), [POWER], 'restored plugin exposes its page again without re-authorizing')
 assert.ok(state.nav.includes(POWER_NAME))
 assert.deepEqual(state.trust, [`${POWER}@1.0.0`], 'trust decisions are persisted per version')
 assert.deepEqual(state.records, [`${POWER}@1.0.0:ok`])
 await page.locator('[data-page="extensions"]').click()
 assert.equal(await row(POWER).locator('.trust-toggle').isChecked(), true, 'the user does not have to re-check trust after a restart')
 assert.equal(await row(POWER).getByRole('button', { name: '停用', exact: true }).count(), 1, 'restored plugin is shown as running')

 // Disabling removes the entry, drops the restore record and falls back when active.
 await page.locator(`#main-nav button:text-is("${POWER_NAME}")`).click()
 await page.locator('[data-page="extensions"]').click()
 await row(POWER).getByRole('button', { name: '停用', exact: true }).click()
 await page.waitForFunction(() => !window.__application.host.extensions.has('org.devicedock.power'))
 state = await hostState()
 assert.deepEqual(state.pages, [])
 assert.ok(!state.nav.includes(POWER_NAME), 'disabling removes the navigation entry')
 assert.deepEqual(state.records, [], 'a disabled plugin is not restored later')
 assert.equal(state.current, 'extensions')
 await open()
 await page.evaluate(async () => { window.__application = (await import('./src/app.js')).application })
 await page.waitForTimeout(300)
 state = await hostState()
 assert.deepEqual(state.enabled, [], 'a disabled plugin stays disabled after a restart')
 assert.deepEqual(await navTexts(page), ['通信调试', '扩展管理', '设置'])
 assert.deepEqual(state.trust, [`${POWER}@1.0.0`], 'disabling keeps the trust decision for this version')

 // Revoking trust stops the plugin, removes the record and prevents restore.
 await enable(POWER)
 await page.locator('[data-page="extensions"]').click()
 await row(POWER).locator('.trust-toggle').uncheck()
 await page.waitForFunction(() => !window.__application.host.extensions.has('org.devicedock.power'))
 state = await hostState()
 assert.deepEqual(state.trust, [])
 assert.deepEqual(state.records, [])
 assert.ok(!state.nav.includes(POWER_NAME))
 await open()
 await page.evaluate(async () => { window.__application = (await import('./src/app.js')).application })
 await page.waitForTimeout(300)
 assert.deepEqual((await hostState()).enabled, [], 'a revoked grant is never restored')

 // A stale/hand-edited restore record fails closed with a visible state.
 await enable(POWER)
 await page.evaluate(() => {
  const records = JSON.parse(localStorage.getItem('devicedock.enabled'))
  records[0].hash = 'f'.repeat(64)
  localStorage.setItem('devicedock.enabled', JSON.stringify(records))
 })
 await open()
 await page.evaluate(async () => { window.__application = (await import('./src/app.js')).application })
 await page.waitForTimeout(400)
 state = await hostState()
 assert.deepEqual(state.enabled, [], 'an unknown digest is not auto-enabled')
 assert.ok(state.records[0].endsWith('failed'), 'the failed restore is recorded')
 await page.locator('[data-page="extensions"]').click()
 assert.match(await row(POWER).textContent(), /恢复失败|启用失败/, 'the failed restore is visible to the user')

 // Corrupt trust storage is repaired instead of authorizing anything.
 await page.evaluate(() => { localStorage.setItem('devicedock.trust', '{broken'); localStorage.setItem('devicedock.enabled', '[]') })
 await open()
 await page.evaluate(async () => { window.__application = (await import('./src/app.js')).application })
 assert.deepEqual((await hostState()).trust, [])
 assert.deepEqual((await hostState()).enabled, [])
 assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('devicedock.trust')).length), 0)

 // Settings groups host the moved surfaces.
 await page.locator('[data-page="settings"]').click()
 assert.deepEqual((await page.locator('#settings-nav button').allTextContents()).join('|'), '界面|参数与备份|插件与来源|客户端服务|原生插件')
 for (const group of ['appearance', 'presets', 'sources', 'services', 'native']) {
  await page.locator(`[data-settings="${group}"]`).click()
  assert.equal(await page.locator(`[data-settings-panel="${group}"]`).isVisible(), true, `settings group ${group} is reachable`)
  assert.equal(await page.locator('[data-settings-panel]:not([hidden])').count(), 1, 'only one settings group is open')
 }
 await page.locator('[data-settings="presets"]').click()
 assert.equal(await page.locator('#preset-list').isVisible(), true, 'parameter presets moved into settings')
 await page.locator('[data-settings="sources"]').click()
 assert.equal(await page.locator('#source-form').isVisible(), true, 'repository sources moved into settings')
 await page.locator('[data-settings="services"]').click()
 assert.equal(await page.locator('#mcp-start').isVisible(), true, 'MCP controls moved into settings')
 assert.deepEqual(errors, [])
 console.log(JSON.stringify({ status: 'PASS', coverage: ['plugin page per enabled manifest UI', 'protocol-only packages have no page', 'navigation never re-activates', 'xterm re-fits after page return', 'persisted per-version trust', 'restore of same authorized bytes', 'disable removes entry and record', 'revoke stops and blocks restore', 'unknown digest fails closed visibly', 'corrupt storage repaired', 'settings groups host services/sources/presets', 'native page container visible and survives extension sync'], browserErrors: errors.length }))
} finally {
 await browser?.close(); server.kill()
}
