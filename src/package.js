import { parse } from '../vendor/lexer.js'
import { validateManifest, safePath, digest } from './manifest.js'
export async function verifyPackage(bundle, platform) {
 const m = validateManifest(bundle?.manifest, platform), files = bundle.files
 if (!files || typeof files !== 'object' || Object.keys(files).length > 500) throw Error('包文件列表无效')
 let total = 0; const decoded = new Map()
 for (const [path, base64] of Object.entries(files)) {
  if (!safePath(path) || typeof base64 !== 'string') throw Error('包路径无效')
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)); total += bytes.length
  if (total > 32 * 1024 * 1024) throw Error('扩展超过 32 MiB 上限')
  if (!['LICENSE','NOTICE'].includes(path) && !Object.hasOwn(m.integrity,path)) throw Error(`未声明文件：${path}`)
  if (Object.hasOwn(m.integrity,path) && await digest(bytes) !== m.integrity[path]) throw Error(`完整性验证失败：${path}`)
  decoded.set(path,bytes)
 }
 for (const path of Object.keys(m.integrity)) if (!decoded.has(path)) throw Error(`缺少包文件：${path}`)
 for (const [path,bytes] of decoded) {
  if (!/\.(?:m?js)$/.test(path)) continue
  const [imports] = parse(new TextDecoder('utf-8',{ fatal: true }).decode(bytes))
  for (const entry of imports) {
   if (entry.d === -2) continue // import.meta (asset paths remain inside verified package URL)
   if (!entry.n || !entry.n.startsWith('./') && !entry.n.startsWith('../')) throw Error('仅支持静态可发现的相对模块依赖')
   const resolved = new URL(entry.n, `https://package.invalid/package-root/${path}`)
   if (!resolved.pathname.startsWith('/package-root/')) throw Error('模块依赖逃逸包目录')
   const target = resolved.pathname.slice('/package-root/'.length)
   if (resolved.search || resolved.hash || !decoded.has(target) || !Object.hasOwn(m.integrity,target)) throw Error(`模块依赖不在包中：${entry.n}`)
  }
 }
 const canonical = JSON.stringify({ manifest: m, files: Object.fromEntries(Object.entries(files).sort(([a],[b]) => a.localeCompare(b))) })
 const hash = (await digest(new TextEncoder().encode(canonical))).slice(7)
 return { manifest: m, files: decoded, hash, canonical }
}
export const mime = path => /\.m?js$/.test(path) ? 'text/javascript' : path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.json') ? 'application/json' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream'
