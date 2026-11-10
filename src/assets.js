import { safePath, digest } from './manifest.js'
import { parse } from '../vendor/lexer.js'
export function packageAssets(manifest, entryUrl, { native, active = () => {}, dispose = () => {}, fetcher = fetch, WorkerClass = globalThis.Worker, URLClass = URL } = {}) {
 // Resolve root robustly from the exact declared entry suffix.
 const absolute = new URL(entryUrl,globalThis.location?.href || 'http://localhost/').href
 const base = absolute.endsWith(manifest.entry) ? absolute.slice(0,-manifest.entry.length) : absolute + '/'
 const nativeHash = /^(?:devicedock-extension:\/\/localhost\/|http:\/\/devicedock-extension\.localhost\/)([a-f0-9]{64})\//.exec(base)?.[1]
 const read = async path => {
  active()
  if(!safePath(path) || !Object.hasOwn(manifest.integrity,path)) throw Error('资源不在扩展完整性表中')
  let bytes
  if(nativeHash && native) bytes=Uint8Array.from(await native.invoke('extension_read_asset',{hash:nativeHash,path}))
  else {const response=await fetcher(new URL(path,base));if(!response.ok)throw Error('扩展资源读取失败');bytes=new Uint8Array(await response.arrayBuffer())}
  if(await digest(bytes)!==manifest.integrity[path])throw Error('扩展资源摘要不一致')
  return bytes
 }
 return {read,url(path){if(!safePath(path)||!Object.hasOwn(manifest.integrity,path))throw Error('未声明资源');return new URL(path,base).href},async createWorker(path,options={}) {
  const bytes=await read(path),source=new TextDecoder('utf-8',{fatal:true}).decode(bytes),[imports]=parse(source)
  if(imports.length || /\bimportScripts\s*\(/.test(source))throw Error('Worker 入口必须自包含；通过消息传入已验证 WASM 字节')
  active();if(!WorkerClass)throw Error('当前平台不支持 Worker')
  const url=URLClass.createObjectURL(new Blob([bytes],{type:'text/javascript'}));let worker
  try {worker=new WorkerClass(url,options)}catch(e){URLClass.revokeObjectURL(url);throw e}
  const terminate=worker.terminate.bind(worker);let live=true,remove=()=>{}
  const release=()=>{if(!live)return;live=false;try{terminate()}finally{URLClass.revokeObjectURL(url);remove()}}
  worker.terminate=release;const unregister=dispose(release);remove=typeof unregister==='function'?unregister:()=>{};return worker
 }}
}
