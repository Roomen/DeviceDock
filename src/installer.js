import {validateWebUrl} from './sources.js'
import { verifyPackage } from './package.js'
import { digest } from './manifest.js'
export class Installer {
 constructor(storage, platform, native) { this.storage = storage; this.platform = platform; this.native = native }
 list() { try { const v = JSON.parse(this.storage.getItem('devicedock.installed') || '[]'); return Array.isArray(v) ? v : [] } catch { return [] } }
 async install(bundle, source = 'local') {
  const verified = await verifyPackage(bundle,this.platform)
  let result
  if (this.native) result = await this.native.invoke('extension_install',{ bundleJson:verified.canonical, expectedHash:verified.hash })
  else {
  if (!navigator.serviceWorker?.controller) throw Error('运行时安装需 HTTPS/localhost 和受控 Service Worker；桌面请用打包集成工具')
  result = await new Promise((resolve,reject) => {
   const channel = new MessageChannel(), timer = setTimeout(() => reject(Error('包缓存安装超时')),30000)
   channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); event.data.error ? reject(Error(event.data.error)) : resolve(event.data) }
   navigator.serviceWorker.controller.postMessage({ type:'install', bundle },[channel.port2])
  })
  }
  if (result.hash !== verified.hash) throw Error('包缓存摘要不一致')
  const list = this.list(), item = { manifest: verified.manifest, source, hash: verified.hash, url: result.baseUrl ? result.baseUrl + verified.manifest.entry : new URL(`../__extensions/${verified.hash}/${verified.manifest.entry}`,import.meta.url).href }
  if (!list.some(p => p.hash === item.hash && p.source === source)) { list.push(item); this.storage.setItem('devicedock.installed',JSON.stringify(list)) }
  return item
 }
 async fromCatalog(source, entry) {
  if(!entry.platforms?.includes(this.platform))throw Error('目录版本不支持当前平台')
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(),30000)
  try {
   if (this.native) {
    const text = await this.native.invoke('extension_download',{ url:entry.url, sha256:entry.sha256 }); const bundle = JSON.parse(text)
    if(bundle.manifest.id !== entry.id || bundle.manifest.version !== entry.version || bundle.manifest.kind !== entry.kind || bundle.manifest.apiVersion !== entry.apiVersion || JSON.stringify([...bundle.manifest.platforms].sort()) !== JSON.stringify([...entry.platforms].sort())) throw Error('目录与包身份不一致')
    return this.install(bundle,`${source.kind}:${source.url}`)
   }
   const response = await fetch(entry.webUrl===undefined?entry.url:validateWebUrl(entry.webUrl),{ credentials:'omit', referrerPolicy:'no-referrer', signal:controller.signal })
   if (!response.ok || !response.url.startsWith('https://')) throw Error('扩展下载失败')
   const reader = response.body.getReader(), chunks = []; let size = 0
   try { while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > 44 * 1024 * 1024) throw Error('下载超过上限'); chunks.push(value) } } finally { await reader.cancel(); reader.releaseLock() }
   const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length }
   if ((await digest(bytes)).slice(7) !== entry.sha256) throw Error('目录产物摘要不一致')
   const bundle = JSON.parse(new TextDecoder().decode(bytes)), m = bundle.manifest
   if (m.id !== entry.id || m.version !== entry.version || m.apiVersion !== entry.apiVersion || m.kind !== entry.kind || JSON.stringify([...m.platforms].sort()) !== JSON.stringify([...entry.platforms].sort())) throw Error('目录与包身份不一致')
   return this.install(bundle,`${source.kind}:${source.url}`)
  } finally { clearTimeout(timer) }
 }
 remove(item) { this.storage.setItem('devicedock.installed',JSON.stringify(this.list().filter(p => p.hash !== item.hash || p.source !== item.source))) }
}
