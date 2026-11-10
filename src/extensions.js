import { Session } from './session.js'
import { packageAssets } from './assets.js'
import { validateManifest } from './manifest.js'
export class ExtensionHost {
 constructor({ sessions, mount, storage, platform = 'web', capabilities = {}, native, changed = () => {} }) {
  Object.assign(this, { sessions, mount, storage, platform, native, changed }); this.capabilities = Object.freeze({ ...capabilities }); this.protocols = new Map(); this.transports = new Map(); this.services = new Map(); this.extensions = new Map(); this.resources = new Map(); this.diagnostics = []; this.shellLifecycle = []; this.portProviders = new WeakMap(); this.updating = false
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
  const element = this.mount.ownerDocument.createElement('section'); this.mount.append(element)
  const state = { manifest, url, importer, sourceIdentity, controller, disposers, preflight, used, ownResources, owner, element, status: 'enabling', cleanup: null, cleanupDone: false }; this.extensions.set(id, state)
  const activeIO = () => { if (!state.cleanupRunning) active() }
  const active = () => { if (this.updating) throw Error('应用正在准备更新'); if (state.status !== 'enabled' && state.status !== 'enabling') throw Error('扩展正在停止') }
  const register = (map, key, value) => { active(); const off = this.register(map,key,value); disposers.push(off); return off }
  const sessionFacade = session => {
   used.add(session)
   return {
    get generation() { return session.generation }, get state() { return session.state }, get connected() { return session.connected }, get deviceInfo() { return session.deviceInfo }, get busy() { return session.busy },
    open: (...args) => { active(); if (!ownResources.has(session)) throw Error('通信路由核心打开；插件请创建专属资源'); return session.open(...args) },
    close: () => { activeIO(); if (!ownResources.has(session)) throw Error('插件不可关闭通信路'); return session.close() },
    subscribe: fn => { active(); const off = session.subscribe(fn); disposers.push(off); return off },
    claim: () => { active(); const off = session.claim(owner); disposers.push(off); return off },
    send: (bytes, options = {}) => { activeIO(); return session.send(bytes, { ...options, owner }) },
    transaction: (_requestedOwner, run, options = {}) => { activeIO(); const combined = AbortSignal.any([...(state.cleanupRunning ? [] : [controller.signal]), ...(options.signal ? [options.signal] : [])]); return session.transaction(owner, run, { ...options, signal: combined }) }
   }
  }
  const api = {
   assets: packageAssets(manifest,url,{native:this.native,active:activeIO,dispose:off=>disposers.push(off)}),
   apiVersion: 1, capabilities: this.capabilities, mount: element, signal: controller.signal,
   registerProtocol: definition => { const off = register(this.protocols, definition.id, definition); disposers.push(() => { for (const session of this.allSessions()) if (session.protocol === definition) session.setProtocol(null) }); return off },
   registerTransport: provider => register(this.transports, provider.id, {...provider, requestPort: async (...args) => {active();const port=await provider.requestPort(...args);this.portProviders.set(port,owner);return port}}),
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
  try { const module = await importer(url); if (typeof module.activate !== 'function') throw Error('扩展未导出 activate'); state.cleanup = await module.activate(api); state.status = 'enabled'; this.changed() }
  catch (error) { try { await this.disable(id, true) } catch {} throw error }
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
    await Promise.all([...state.used].map(s => s.drainOwner(state.owner)))
    if (!state.cleanupDone) { state.cleanupRunning = true; try { await state.cleanup?.(); state.cleanupDone = true } finally { state.cleanupRunning = false } }
    for (const s of state.ownResources.keys()) { await s.close(); this.resources.delete(`${id}.${state.ownResources.get(s)}`) }
    for (const off of state.disposers.reverse()) off()
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
