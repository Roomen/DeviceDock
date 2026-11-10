import { Session } from './session.js'
import { ExtensionHost } from './extensions.js'
import { SourceStore } from './sources.js'
import { Installer } from './installer.js'
import { platformServices, serialProvider } from './platform.js'
import { renderView, parseSend } from './view.js'
import { validateManifest } from './manifest.js'
const $ = selector => document.querySelector(selector), platform = await platformServices(), laneUI = new Map(), sources = new SourceStore(localStorage), installer = new Installer(localStorage,platform.platform,platform.native)
const status = message => { $('#status').textContent = String(message) }
const action = fn => async event => { try { await fn(event) } catch (e) { status(e.message || e) } }
$('#platform').textContent = platform.platform === 'desktop' ? '桌面客户端' : platform.mobile ? '移动端 · 单路' : 'Web Serial'
const sessions = { A: new Session('A', () => scheduleLane('A')) }
if (!platform.mobile) sessions.B = new Session('B', () => scheduleLane('B'))
const host = new ExtensionHost({ sessions, mount: $('#extension-mounts'), storage: localStorage, platform: platform.platform, capabilities: platform.capabilities, native:platform.native, changed: () => { updateRegistries(); renderPackages() } })
async function chooseNative(ports) {
 const select = $('#native-port'); select.replaceChildren()
 for (const item of ports) { const o = document.createElement('option'); o.value = item.path; o.textContent = item.name || item.path; select.append(o) }
 if (!ports.length) throw Error('未发现串口')
 const dialog = $('#port-dialog'); dialog.showModal()
 return new Promise(resolve => dialog.addEventListener('close',() => resolve(dialog.returnValue === 'open' ? select.value : null),{ once:true }))
}
const serial = serialProvider(platform,chooseNative); host.transports.set('serial',serial)
// The provider selects a port only; all access continues through host-owned session/claims.
host.services.set('org.devicedock.serial.v1',serial)
if (platform.native) {
 const {nativeProviders} = await import('./shell/native-services.js')
 for (const [id,provider] of nativeProviders(platform,host)) { host.services.set(id,provider); host.shellLifecycle.push(provider) }
}
function setting(id) { try { return JSON.parse(localStorage.getItem(`devicedock.lane.${id}`)) || {} } catch { return {} } }
function createLane(id) {
 const fragment = $('#lane-template').content.cloneNode(true), root = fragment.querySelector('article'), s = sessions[id], pref = setting(id)
 root.querySelector('h2').textContent = `${id} 路`
 const q = selector => root.querySelector(selector), ui = { root,q,pending:false }; laneUI.set(id,ui)
 for (const [key,selector] of Object.entries({ baudRate:'.baud',dataBits:'.data-bits',stopBits:'.stop-bits',parity:'.parity',flowControl:'.flow-control' })) if (pref[key] !== undefined) q(selector).value = pref[key]
 const options = () => ({ baudRate:Number(q('.baud').value),dataBits:Number(q('.data-bits').value),stopBits:Number(q('.stop-bits').value),parity:q('.parity').value,flowControl:q('.flow-control').value })
 root.querySelectorAll('.settings select,.settings input').forEach(input => input.addEventListener('change',() => { localStorage.setItem(`devicedock.lane.${id}`,JSON.stringify(options())) }))
 q('.connect').onclick = action(async () => {
  q('.connect').disabled = true
  try {
   if (s.state !== 'closed') await s.close()
   else {
    const opts = options(); if (!Number.isInteger(opts.baudRate) || opts.baudRate < 1 || opts.baudRate > 4000000) throw Error('波特率无效')
    const provider = host.transports.get(q('.transport').value); if (!provider) throw Error('传输不可用')
    const port = await provider.requestPort(); await s.open(port,opts)
   }
   status(`${id} 路：${s.connected ? '已连接' : '已断开'}`)
  } finally { q('.connect').disabled = false; refreshState(id) }
 })
 q('.send-form').onsubmit = action(async event => { event.preventDefault(); await s.send(parseSend(q('.send-input').value,q('.send-format').value,q('.crlf').checked)); status(`${id} 路发送完成`) })
 q('.protocol').onchange = action(() => { s.setProtocol(host.protocols.get(q('.protocol').value)); renderLane(id) })
 q('.replay').onclick = action(() => renderLane(id,s.replay()))
 q('.display').onchange = () => renderLane(id)
 q('.clear').onclick = () => { s.clear(); renderLane(id) }
 q('.export').onclick = () => {
  const text = s.logs.map(row => JSON.stringify({...row,bytes:Array.from(row.bytes)})).join('\n'), a = document.createElement('a'), url = URL.createObjectURL(new Blob([text],{type:'application/x-ndjson'}))
  a.href = url; a.download = `devicedock-${id}.ndjson`; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000)
 }
 $('#lanes').append(fragment)
}
for (const id of Object.keys(sessions)) createLane(id)
function refreshState(id) {
 const {q} = laneUI.get(id), s = sessions[id]
 q('.connection-state').textContent = ({closed:'未连接',opening:'打开中',open:'已连接',closing:'关闭中','cleanup-needed':'清理失败 · 请重试'})[s.state]
 q('.connect').textContent = s.state === 'closed' ? '连接设备' : '断开 / 释放'
 q('.transport').disabled = s.state !== 'closed'
 q('.settings').querySelectorAll('input,select').forEach(input => { input.disabled = s.state !== 'closed' && !input.matches('.protocol') })
}
function scheduleLane(id) { const ui = laneUI.get(id); if (!ui || ui.pending) return; ui.pending = true; requestAnimationFrame(() => { ui.pending = false; renderLane(id); refreshState(id) }) }
function renderLane(id, rows = sessions[id].logs) {
 const {q} = laneUI.get(id), box = q('.logs'), stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30, fragment = document.createDocumentFragment(), mode = q('.display').value
 for (const row of rows.slice(-800)) {
  const div = document.createElement('div'); div.className = 'log-row ' + row.direction
  const meta = document.createElement('span'); meta.className = 'log-meta'; meta.textContent = `${new Date(row.time).toLocaleTimeString()} ${row.direction.toUpperCase()}`; div.append(meta)
  const body = document.createElement('span'), text = new TextDecoder().decode(row.bytes), hex = [...row.bytes].map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ')
  body.textContent = row.text || (mode === 'text' ? text : mode === 'both' ? hex + '  │ ' + text : hex); div.append(body)
  for (const view of row.views || []) div.append(renderView(view,document)); fragment.append(div)
 }
 box.replaceChildren(fragment); if (stick) box.scrollTop = box.scrollHeight
}
function updateRegistries() {
 for (const [id,{q}] of laneUI) {
  for (const [selector,entries,empty] of [['.protocol',host.protocols,'原始数据'],['.transport',host.transports,null]]) {
   const select = q(selector), selected = select.value; select.replaceChildren()
   if (empty) { const option = document.createElement('option'); option.value = ''; option.textContent = empty; select.append(option) }
   for (const [key,value] of entries) { const option = document.createElement('option'); option.value = key; option.textContent = value.title; select.append(option) }
   if ([...select.options].some(o => o.value === selected)) select.value = selected
  }
  refreshState(id)
 }
}
$('#dual-label').hidden = platform.mobile
if (sessions.B) laneUI.get('B').root.hidden = true
$('#dual').onchange = action(async () => {
 if (!$('#dual').checked && sessions.B?.state !== 'closed') { $('#dual').checked = true; throw Error('先断开 B 路，再关闭双路') }
 laneUI.get('B').root.hidden = !$('#dual').checked; $('#lanes').classList.toggle('dual',$('#dual').checked)
})
for (const button of document.querySelectorAll('nav button')) button.onclick = () => {
 for (const b of document.querySelectorAll('nav button')) { b.setAttribute('aria-pressed',String(b === button)); $('#' + b.dataset.page).hidden = b !== button }
}
let bundled = []
try { let response = await fetch('./extensions/installed.json'); if (!response.ok) response = await fetch('./extensions/index.json'); if (response.ok) { const data = await response.json(); if (Array.isArray(data)) bundled = data.filter(p => { try { validateManifest(p.manifest); return /^\.\/extensions\/[a-f0-9]{64}\//.test(p.url) } catch { return false } }) } } catch {}
function button(label, fn) { const b = document.createElement('button'); b.textContent = label; b.onclick = action(fn); return b }
function renderPackages() {
 const box = $('#package-list'); if (!box) return; box.replaceChildren()
 const list = [...bundled,...installer.list()]
 if (!list.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = '尚未安装扩展。核心串口与原始日志可独立使用。'; box.append(p) }
 for (const item of list) {
  const m = item.manifest, state = host.extensions.get(m.id), absoluteURL = new URL(item.url,document.baseURI).href, isActive = state?.url === absoluteURL, row = document.createElement('div'); row.className = 'package-row'
  const title = document.createElement('strong'); title.textContent = `${m.name} · ${m.version}`; row.append(title)
  const detail = document.createElement('p'); detail.textContent = `${m.id} · ${item.source} · ${isActive ? state.status : '已安装，未启用'} · ${m.license}`; row.append(detail)
  const actions = document.createElement('div'); actions.className = 'actions'
  actions.append(button(isActive ? '停用' : state ? '切换此版本' : '启用此版本',async () => {
   if (isActive) await host.disable(m.id)
   else if (state) await host.replace(m,absoluteURL,$('#trust').checked,undefined,item.source)
   else { await host.enable(m,new URL(item.url,document.baseURI).href,$('#trust').checked,undefined,item.source); status(`已启用 ${m.name}`) }
   renderPackages()
  }))
  if (item.source !== 'bundled') actions.append(button('移除安装记录',() => { if (host.extensions.has(m.id)) throw Error('请先停用扩展'); installer.remove(item); renderPackages() }))
  row.append(actions); box.append(row)
 }
}
$('#package-file').onchange = action(async () => {
 const file = $('#package-file').files[0]; if (!file) return; if (file.size > 44 * 1024 * 1024) throw Error('包超过大小限制')
 await installer.install(JSON.parse(await file.text())); renderPackages(); status('已安装，本地代码尚未执行')
})
function renderSources() {
 const box = $('#source-list'); box.replaceChildren()
 for (const source of sources.list()) {
  const row = document.createElement('section'); row.className = 'panel source-row'; const title = document.createElement('strong'); title.textContent = `${source.kind === 'protocol' ? '协议' : '插件'} · ${source.url}`; row.append(title)
  const actions = document.createElement('div'); actions.className = 'actions'
  actions.append(button('刷新目录',async () => { await sources.refresh(source); renderSources(); status('目录已验证并缓存') }),button('移除来源',() => { sources.remove(source); renderSources() })); row.append(actions)
  const catalog = sources.cached(source)
  if (!catalog) { const p = document.createElement('p'); p.textContent = '暂无已验证目录。GitHub 来源需在默认分支提供 catalog.json。'; row.append(p) }
  for (const entry of catalog?.packages || []) {
   const item = document.createElement('div'); item.className = 'actions'; const label = document.createElement('span'); label.textContent = `${entry.id} @ ${entry.version}`; item.append(label,button('下载并安装',async () => { await installer.fromCatalog(source,entry); renderPackages(); status('已安装，启用前需明确授权信任') })); row.append(item)
  }
  box.append(row)
 }
}
$('#source-form').onsubmit = action(event => { event.preventDefault(); sources.add($('#source-kind').value,$('#source-url').value); $('#source-url').value = ''; renderSources(); status('来源已添加，未执行代码') })
if ('serviceWorker' in navigator && ['https:','http:'].includes(location.protocol)) navigator.serviceWorker.register('./extension-sw.js',{type:'module'}).catch(() => status('扩展运行时缓存不可用，仍可使用预打包扩展'))
updateRegistries(); renderPackages(); renderSources()
// A shell/MCP bridge may invoke this same host registry after its own authorization.
export const application = { host, sessions, serial }
