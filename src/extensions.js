import { validateSchema, validateArguments } from './schema.js'
import { Session } from './session.js'
import { packageAssets } from './assets.js'
import { validateManifest } from './manifest.js'
import { pageTitle } from './pages.js'
export class ExtensionHost {
 constructor({ sessions, mount, pageHost = null, storage, platform = 'web', capabilities = {}, native, changed = () => {} }) {
  Object.assign(this, { sessions, mount, pageHost, storage, platform, native, changed }); this.capabilities = Object.freeze({ ...capabilities }); this.protocols = new Map(); this.transports = new Map(); this.services = new Map(); this.mcpTools = new Map(); this.mcpAliases = new Map(); this.nativeTransportBindings = new WeakMap(); this.extensions = new Map(); this.resources = new Map(); this.diagnostics = []; this.shellLifecycle = []; this.portProviders = new WeakMap(); this.updating = false
 }
 allSessions() { return [...Object.values(this.sessions), ...this.resources.values()] }
 register(map, id, value) { if (map.has(id)) throw Error(`重复注册：${id}`); map.set(id, value); this.changed(); let registered = true; return () => { if (!registered) return; registered = false; if(map.get(id) === value) map.delete(id); this.changed() } }
 async enable(manifest, url, trusted, importer = value => import(value), sourceIdentity = 'local') {
  validateManifest(manifest, this.platform)
  if (url.includes('/__extensions/') && !globalThis.navigator?.serviceWorker?.controller) throw Error('扩展缓存尚未受 Service Worker 控制，请刷新页面')
  if (!trusted) throw Error('必须明确授权执行此扩展代码')
  if (this.updating || this.extensions.has(manifest.id)) throw Error('扩展正在使用，切换版本前请停用并重载')
  if (manifest.capabilities.some(c => !this.capabilities[c])) throw Error('缺少所需原生或平台能力')
  const id = manifest.id, controller = new AbortController(), disposers = [], preflight = [], used = new Set(), ownResources = new Map(), owner = `extension:${sourceIdentity}:${id}`
  const element = this.mount.ownerDocument.createElement('section')
  // With a dedicated page host each extension owns a page section. Older hosts
  // keep appending into one shared mount element.
  const pageSection = this.pageHost ? element : null
  if (pageSection) { element.className = 'plugin-page'; pageSection.dataset.pluginPage = id; pageSection.hidden = true; this.pageHost.append(element) }
  else this.mount.append(element)
  const state = { manifest, url, importer, sourceIdentity, controller, disposers, preflight, used, ownResources, nativeBindings:new Set(), owner, element, page: { title: pageTitle(manifest.name, id), explicit: false, hasContent: false, observer: null }, status: 'enabling', cleanup: null, cleanupDone: false }; this.extensions.set(id, state)
  const activeIO = () => { if (!state.cleanupRunning) active() }
  const active = () => { if (this.updating) throw Error('应用正在准备更新'); if (state.status !== 'enabled' && state.status !== 'enabling') throw Error('扩展正在停止') }
  const register = (map, key, value) => { active(); const off = this.register(map,key,value); disposers.push(off); return off }
  const sessionFacade = session => {
   used.add(session)
   return {
    get messageBoundary() { return session.messageBoundary }, get generation() { return session.generation }, get state() { return session.state }, get connected() { return session.connected }, get deviceInfo() { return session.deviceInfo }, get busy() { return session.busy },
    open: (...args) => { active(); if (!ownResources.has(session)) throw Error('通信路由核心打开；插件请创建专属资源'); return session.open(...args) },
    close: () => { activeIO(); if (!ownResources.has(session)) throw Error('插件不可关闭通信路'); return session.close() },
    setSignals: (signals,options={}) => {activeIO();if(!ownResources.has(session))throw Error('插件不可控制通信路信号');return session.setSignals(signals,{owner,beforeWrite:async()=>{activeIO();await options.beforeWrite?.();activeIO()}})},
    subscribe: fn => { active(); const off = session.subscribe(fn); disposers.push(off); return off },
    claim: () => { active(); const off = session.claim(owner); disposers.push(off); return off },
    send: (bytes, options = {}) => { activeIO(); return session.send(bytes, { ...options, owner }) },
    transaction: (_requestedOwner, run, options = {}) => { activeIO(); const combined = AbortSignal.any([...(state.cleanupRunning ? [] : [controller.signal]), ...(options.signal ? [options.signal] : [])]); return session.transaction(owner, run, { ...options, signal: combined }) }
   }
  }
  const api = {
   assets: packageAssets(manifest,url,{native:this.native,active:activeIO,dispose:off=>{disposers.push(off);return ()=>{const index=disposers.indexOf(off);if(index>=0)disposers.splice(index,1)}}}),
   apiVersion: 1, capabilities: this.capabilities, mount: element, signal: controller.signal,
   registerProtocol: definition => { const off = register(this.protocols, definition.id, definition); disposers.push(() => { for (const session of this.allSessions()) if (session.protocol === definition) session.setProtocol(null) }); return off },
   registerTransport: provider => {
    const offTransport=register(this.transports,provider.id,{...provider,requestPort:async(...args)=>{active();const port=await provider.requestPort(...args);this.portProviders.set(port,owner);return port}})
    const binding=this.nativeTransportBindings.get(provider),offs=[]
    if(binding?.kind==='classic'){
     const allowed=new Set(['classic_state','classic_devices','classic_discover','classic_pair','classic_connect','classic_close','classic_read','classic_write'])
     state.nativeBindings.add(binding);preflight.push(binding.preflight)
     for(const tool of binding.tools){if(!allowed.has(tool.definition.name))throw Error('Unknown native Classic tool');const target=id+'.'+tool.definition.name;offs.push(api.registerMcpTool({...tool.definition,name:target},tool.call));offs.push(register(this.mcpAliases,tool.definition.name,{target,owner}))}
    }
    return ()=>{binding?.preflight();for(const off of offs.reverse())off();offTransport()}
   },
   registerPage: options => {
    active()
    state.page.explicit = true
    state.page.title = pageTitle(options?.title, pageTitle(manifest.name, id))
    state.page.hasContent = true
    if (state.page.observer) { state.page.observer.disconnect(); state.page.observer = null }
    this.changed()
    return { get title() { return state.page.title }, setTitle: value => { active(); state.page.title = pageTitle(value, pageTitle(manifest.name, id)); this.changed() }, section: element, show: () => this.changed() }
   },
   registerMcpTool: (definition, handler) => {
    if (!definition || !definition.name?.startsWith(id + '.') || !/^[a-zA-Z0-9_.-]{1,128}$/.test(definition.name) || typeof definition.description !== 'string' || definition.inputSchema?.type !== 'object' || typeof handler !== 'function') throw Error('无效 MCP 工具契约')
    if(definition.timeoutMs !== undefined && (!Number.isInteger(definition.timeoutMs) || definition.timeoutMs < 1000 || definition.timeoutMs > 1800000)) throw Error('无效 MCP 超时')
    validateSchema(definition.inputSchema)
    const frozen = JSON.parse(JSON.stringify(definition))
    return register(this.mcpTools,definition.name,{definition:frozen,call:async (args,context) => {
     active(); validateArguments(args,frozen.inputSchema); const signal=AbortSignal.any([controller.signal,context.signal]); const check=()=>{active();if(signal.aborted)throw Error('Request cancelled')}; const commit=async()=>{check();await context.commit();check()}; const work = Promise.resolve().then(() => {check();return handler(args,{...context,signal,commit})}); work.owner=owner
     state.toolCalls ||= new Set(); state.toolCalls.add(work)
     try { return await work } finally { state.toolCalls.delete(work) }
    }})
   },
   registerService: (key, value) => { if (!/^org\.devicedock\.[a-z0-9.-]+\.v[1-9][0-9]*$/.test(key) && !key.startsWith(`plugin.${id}.`)) throw Error('业务服务必须使用版本化命名空间'); return register(this.services,key,value) },
   getService: key => key.startsWith('protocol.') ? this.protocols.get(key.slice(9)) : this.services.get(key),
   session: lane => { active(); if (!this.sessions[lane]) throw Error('通信路不存在'); return sessionFacade(this.sessions[lane]) },
   resources: {
    requestPort: async (providerId = 'serial', options) => { active(); const provider = this.transports.get(providerId); if (!provider) throw Error('传输能力不可用'); return provider.requestPort(options) },
    createSession: key => { active(); if (!/^[a-zA-Z0-9_-]{1,60}$/.test(key) || this.resources.has(`${id}.${key}`)) throw Error('资源标识无效或重复'); const s = new Session(`${id}.${key}`); this.resources.set(`${id}.${key}`,s); ownResources.set(s,key); return sessionFacade(s) },
    releaseSession: async key => { const s = this.resources.get(`${id}.${key}`); if (!s) return; await s.close(); this.resources.delete(`${id}.${key}`); ownResources.delete(s) }
   },
   prepareDeactivate: fn => { active(); preflight.push(fn); return () => { const n = preflight.indexOf(fn); if (n >= 0) preflight.splice(n,1) } },
   storage: {
    get: key => { try { return JSON.parse(this.storage.getItem(`devicedock.ext.${encodeURIComponent(sourceIdentity)}.${id}.${key}`)) } catch { return null } },
    set: (key,value) => { active(); this.storage.setItem(`devicedock.ext.${encodeURIComponent(sourceIdentity)}.${id}.${key}`,JSON.stringify(value)) }
   }, log: text => { this.diagnostics.push({ extension:id, time:Date.now(), text:String(text) }); if (this.diagnostics.length > 500) this.diagnostics.shift() }
  }
  try { const module = await importer(url); if (typeof module.activate !== 'function') throw Error('扩展未导出 activate'); state.cleanup = await module.activate(api); state.status = 'enabled'; this.observePage(state); this.changed() }
  catch (error) { try { await this.disable(id, true) } catch {} throw error }
 }
 observePage(state) {
  const detect = () => {
   if (state.page.explicit || state.page.hasContent) return true
   const element = state.element
   if (element.querySelector?.('*') || String(element.textContent || '').trim()) {
    state.page.hasContent = true; state.page.observer?.disconnect(); state.page.observer = null; this.changed(); return true
   }
   return false
  }
  if (detect()) return
  // Legacy host.mount plugins may build their UI after an async step; promote the
  // page as soon as content appears instead of showing an empty tab.
  const Observer = this.mount.ownerDocument?.defaultView?.MutationObserver || globalThis.MutationObserver
  if (typeof Observer !== 'function') return
  const observer = new Observer(() => { detect() })
  observer.observe(state.element, { childList: true, subtree: true, characterData: true })
  state.page.observer = observer
 }
 pages() {
  const list = []
  for (const [id, state] of this.extensions) {
   if (state.status !== 'enabled' || !state.page) continue
   // Protocol-only packages register parsers without UI; they must not create
   // an empty page. An explicit registerPage() always counts.
   if (!state.page.explicit && !state.page.hasContent) continue
   list.push({ id, title: state.page.title, section: state.element })
  }
  return list
 }
 async disable(id, failedActivation = false) {
  const state = this.extensions.get(id); if (!state) return
  if (state.status === 'enabling' && !failedActivation) throw Error('扩展启用中，请等待完成后再停用')
  if (state.stopping) return state.stopping
  state.stopping = Promise.resolve().then(async () => {
   state.status = 'stopping'; this.changed()
   try {
    if (!failedActivation) {
     try {
      if (this.allSessions().some(s => s.port && s.state !== 'closed' && this.portProviders.get(s.port) === state.owner)) throw Error('请先断开此扩展提供的传输连接')
      for (const check of state.preflight) await check()
     }
     catch (e) { state.status = 'enabled'; this.changed(); throw Object.assign(e, { preflightRejected: true }) }
    }
    state.controller.abort()
    for (const s of state.used) { for (const task of s.transactions) if (task.owner === state.owner) task.abort() }
    await Promise.allSettled([...(state.toolCalls || [])]);
    await Promise.all([...state.used].map(s => s.drainOwner(state.owner)))
    if (!state.cleanupDone) { state.cleanupRunning = true; try { await state.cleanup?.(); state.cleanupDone = true } finally { state.cleanupRunning = false } }
    for(const binding of state.nativeBindings)await binding.release()
    for (const s of state.ownResources.keys()) { await s.close(); this.resources.delete(`${id}.${state.ownResources.get(s)}`) }
    for (const off of [...state.disposers].reverse()) off()
    state.page.observer?.disconnect(); state.page.observer = null
    state.element.remove(); this.extensions.delete(id); this.changed()
   } catch (e) { if (!e.preflightRejected) state.status = 'cleanup-error'; this.changed(); throw e }
   finally { state.stopping = null }
  }); return state.stopping
 }
 async replace(manifest, url, trusted, importer = value => import(value), sourceIdentity = 'local') {
  if (!trusted) throw Error('切换版本需要明确授权信任')
  const previous = this.extensions.get(manifest.id)
  if (!previous) return this.enable(manifest,url,trusted,importer,sourceIdentity)
  await this.disable(manifest.id)
  try { await this.enable(manifest,url,trusted,importer,sourceIdentity) }
  catch (e) {
   if (this.extensions.has(manifest.id)) throw Error(`切换失败且清理未完成：${e.message}`)
   try { await this.enable(previous.manifest,previous.url,true,previous.importer,previous.sourceIdentity) }
   catch (rollback) { throw Error(`切换失败，旧版本恢复失败：${rollback.message}`) }
   throw Error(`切换失败，已恢复旧版本：${e.message}`)
  }
 }
 async prepareForUpdate() {
  if (this.updating) throw Error('应用已在准备更新')
  if (this.allSessions().some(s=>s.busy)) throw Error('设备任务尚未完成')
  if (this.shellLifecycle.some(service => service.isBusy?.())) throw Error('原生设备操作或系统选择器仍在使用中')
  this.updating = true; for (const s of this.allSessions()) s.frozen = true
  try {
   for (const state of this.extensions.values()) {if (state.status !== 'enabled') throw Error('扩展仍在启停或清理');for(const check of state.preflight) await check()}
   for (const id of [...this.extensions.keys()]) await this.disable(id)
   for (const s of this.allSessions()) await s.close()
   for (const service of this.shellLifecycle) await service.release()
   if (this.allSessions().some(s => s.busy)) throw Error('设备任务尚未释放')
  } catch (e) { this.updating = false; for(const s of this.allSessions()) s.frozen = false; throw e }
 }
}
