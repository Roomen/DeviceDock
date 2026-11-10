export function normalizeSource(kind, input) {
 if (!['protocol', 'plugin'].includes(kind)) throw Error('来源类型无效')
 const u = new URL(input.trim())
 if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.port) throw Error('仅支持无凭据的 HTTPS 仓库地址')
 const parts = u.pathname.replace(/\/+$/, '').replace(/\.git$/, '').split('/').filter(Boolean)
 if (parts.length !== 2 || parts.some(p => !/^[a-zA-Z0-9_.-]+$/.test(p) || p === '.' || p === '..')) throw Error('请输入组织/仓库地址')
 u.pathname = '/' + (u.hostname === 'github.com' ? parts.join('/').toLowerCase() : parts.join('/')); return { kind, url: u.href.replace(/\/$/, '') }
}
export class SourceStore {
 constructor(storage, {defaults=[]}={}) {this.storage=storage;this.defaults=defaults.map(s=>normalizeSource(s.kind,s.url))}
 read(key, fallback) { try { return JSON.parse(this.storage.getItem('devicedock.' + key)) ?? fallback } catch { return fallback } }
 list() { const v = this.read('sources', this.defaults); return Array.isArray(v) ? v.filter(s => { try { return normalizeSource(s.kind, s.url).url === s.url } catch { return false } }) : [] }
 add(kind, url) { const source = normalizeSource(kind, url), list = this.list(); if (list.some(s => s.kind === source.kind && s.url.toLowerCase() === source.url.toLowerCase())) throw Error('来源已存在'); list.push(source); this.save(list); return source }
 save(list) { this.storage.setItem('devicedock.sources', JSON.stringify(list)) }
 remove(source) { this.save(this.list().filter(s => s.kind !== source.kind || s.url !== source.url)) }
 cached(source) { const v = this.read('catalog.' + source.kind + '.' + source.url, null); try { return validateCatalog(v, source.kind) } catch { return null } }
 async refresh(source, fetcher = fetch) {
  // Discover the public default-branch catalog; bundle URLs may be raw digest-addressed files or release assets.
  const u = new URL(source.url)
  if (u.hostname !== 'github.com') throw Error('此来源暂不支持自动目录发现，可保留配置')
  const response = await fetcher(`https://raw.githubusercontent.com${u.pathname}/HEAD/catalog.json`, { credentials: 'omit', referrerPolicy: 'no-referrer' })
  if (!response.ok) throw Error(`目录获取失败 (${response.status})，保留离线缓存`)
  const raw = await response.text(); if (raw.length > 1024 * 1024) throw Error('目录过大')
  const catalog = validateCatalog(JSON.parse(raw), source.kind)
  this.storage.setItem('devicedock.catalog.' + source.kind + '.' + source.url, JSON.stringify(catalog)); return catalog
 }
}
export function validateCatalog(value, kind) {
 if (!value || value.schemaVersion !== 1 || !Array.isArray(value.packages) || value.packages.length > 1000) throw Error('目录格式无效')
 const identities=new Set()
 for (const p of value.packages) {
  if (!/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/.test(p.id) || !/^\d+\.\d+\.\d+$/.test(p.version) || p.apiVersion !== 1 || !/^[a-f0-9]{64}$/.test(p.sha256) || !Array.isArray(p.platforms) || !p.platforms.length || p.platforms.some(v => !['web','desktop','mobile'].includes(v)) || (kind === 'protocol' ? p.kind !== 'protocol' : !['plugin','firmware','transport'].includes(p.kind))) throw Error('目录包版本、兼容性或完整性字段无效')
  const identity=p.id+'@'+p.version;if(identities.has(identity))throw Error('目录存在重复版本');identities.add(identity)
  if(p.webUrl!==undefined)validateWebUrl(p.webUrl)
  const url = new URL(p.url); if (url.protocol !== 'https:' || url.username || url.password) throw Error('包地址无效')
 }
 return value
}

export function validateWebUrl(value){
 if(typeof value!=='string'||value.length>2048||value.includes('\\'))throw Error('浏览器镜像地址无效')
 let url;try{url=new URL(value)}catch{throw Error('浏览器镜像地址无效')}
 const parts=url.pathname.split('/').slice(1)
 if(url.protocol!=='https:'||url.hostname!=='raw.githubusercontent.com'||url.port||url.username||url.password||url.search||url.hash||url.href!==value||parts.length<5||!parts.every(p=>/^[a-zA-Z0-9_.-]+$/.test(p)&&p!=='.'&&p!=='..')||!/^[a-f0-9]{40}$/.test(parts[2])||!parts.at(-1).endsWith('.json'))throw Error('浏览器镜像必须是无凭据、固定提交的 HTTPS raw 包地址')
 return url.href
}
