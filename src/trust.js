// Persisted, per-version code-execution trust and "user enabled this" memory.
// Identity is source + manifest id + version + package content digest: a new
// version (or a different repository) never inherits an earlier decision.
const TRUST_KEY = 'devicedock.trust'
const ENABLED_KEY = 'devicedock.enabled'
const LIMIT = 500

const idPattern = /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/
const versionPattern = /^\d+\.\d+\.\d+$/
const hashPattern = /^[a-f0-9]{64}$/

export const isValidHash = value => typeof value === 'string' && hashPattern.test(value)
const source = value => typeof value === 'string' && value.length > 0 && value.length <= 400 && !/[\u0000-\u001f]/.test(value)

export function normalizeGrant(value) {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return null
 const { id, version, hash } = value, origin = value.source
 if (!source(origin) || typeof id !== 'string' || !idPattern.test(id) || typeof version !== 'string' || !versionPattern.test(version) || !isValidHash(hash)) return null
 const grantedAt = Number.isSafeInteger(value.grantedAt) && value.grantedAt > 0 ? value.grantedAt : Date.now()
 return { source: origin, id, version, hash, grantedAt }
}

export function grantKey({ source, id, version, hash }) { return JSON.stringify([String(source), String(id), String(version), String(hash)]) }

function readList(storage, key) {
 let raw
 try { raw = storage.getItem(key) } catch { return { rows: [], corrupt: false } }
 if (raw === null || raw === undefined || raw === '') return { rows: [], corrupt: false }
 let parsed
 try { parsed = JSON.parse(raw) } catch { return { rows: [], corrupt: true } }
 if (!Array.isArray(parsed)) return { rows: [], corrupt: true }
 return { rows: parsed, corrupt: false }
}

function writeList(storage, key, rows) {
 const text = JSON.stringify(rows)
 try { storage.setItem(key, text); return true } catch { return false }
}

function persist(storage, key, rows, label) {
 try { storage.setItem(key, JSON.stringify(rows)) }
 catch (error) { throw Error(`${label}无法写入浏览器存储，未更改当前状态：${error?.message || error}`) }
}

export class TrustStore {
 constructor(storage, { limit = LIMIT } = {}) {
  this.storage = storage; this.limit = limit; let rows = []
  const stored = readList(storage, TRUST_KEY)
  const seen = new Set()
  for (const raw of stored.rows) {
   const grant = normalizeGrant(raw)
   if (!grant) continue
   const key = grantKey(grant); if (seen.has(key)) continue
   seen.add(key); rows.push(grant)
  }
  this.rows = rows.slice(-this.limit)
  // Corrupt or partly invalid storage is repaired to the sanitized list so it
  // cannot keep influencing future decisions. A failed repair stays in memory
  // only; the next write reports the error instead of pretending to persist.
  if (stored.corrupt || JSON.stringify(this.rows) !== JSON.stringify(stored.rows)) writeList(storage, TRUST_KEY, this.rows)
 }
 all() { return this.rows.map(row => ({ ...row })) }
 has(record) {
  const grant = normalizeGrant(record); if (!grant) return false
  const key = grantKey(grant)
  return this.rows.some(row => grantKey(row) === key)
 }
 // Persistence is copy-on-write: memory only moves forward when the write
 // succeeded, so the live session can never show a decision a restart loses.
 grant(record) {
  const grant = normalizeGrant(record); if (!grant) throw Error('信任记录无效')
  const key = grantKey(grant)
  let rows = this.rows.filter(row => grantKey(row) !== key)
  rows.push(grant)
  if (rows.length > this.limit) rows = rows.slice(-this.limit)
  persist(this.storage, TRUST_KEY, rows, '信任记录')
  this.rows = rows
  return grant
 }
 revoke(record) {
  const grant = typeof record === 'string' ? normalizeGrant(JSON.parse(record)) : normalizeGrant(record)
  const key = typeof record === 'string' ? record : grantKey(grant || {})
  const rows = this.rows.filter(row => grantKey(row) !== key)
  if (rows.length === this.rows.length) return false
  persist(this.storage, TRUST_KEY, rows, '撤销信任')
  this.rows = rows
  return true
 }
 revokeAll() {
  if (!this.rows.length) return false
  persist(this.storage, TRUST_KEY, [], '撤销信任')
  this.rows = []; return true
 }
}

export function normalizeEnabled(value) {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return null
 const { id, version, hash } = value, origin = value.source
 if (!source(origin) || typeof id !== 'string' || !idPattern.test(id) || typeof version !== 'string' || !versionPattern.test(version) || !isValidHash(hash)) return null
 const url = typeof value.url === 'string' && value.url.length > 0 && value.url.length <= 2048 ? value.url : null
 const error = typeof value.error === 'string' && value.error ? value.error.slice(0, 300) : null
 return { source: origin, id, version, hash, ...(url ? { url } : {}), error, failed: !!value.failed }
}

// One active version per manifest id mirrors the host rule that two versions
// of the same package cannot be enabled at once.
export class EnableState {
 constructor(storage) {
  this.storage = storage; const stored = readList(storage, ENABLED_KEY), rows = new Map()
  for (const raw of stored.rows) {
   const entry = normalizeEnabled(raw)
   if (!entry) continue
   rows.set(entry.id, entry)
  }
  this.rows = rows
  if (stored.corrupt || JSON.stringify([...this.rows.values()]) !== JSON.stringify(stored.rows)) writeList(storage, ENABLED_KEY, [...this.rows.values()])
 }
 all() { return [...this.rows.values()].map(row => ({ ...row })) }
 get(id) { const row = this.rows.get(id); return row ? { ...row } : null }
 // Copy-on-write for the same reason as TrustStore: a failed write must not
 // leave the session claiming a restore that will not happen.
 write(rows, label) {
  persist(this.storage, ENABLED_KEY, [...rows.values()], label)
  this.rows = rows
 }
 record(record) {
  const entry = normalizeEnabled(record); if (!entry) throw Error('启用记录无效')
  const rows = new Map(this.rows); rows.set(entry.id, entry)
  this.write(rows, '启用记录'); return entry
 }
 fail(id, message) {
  const row = this.rows.get(id); if (!row) return null
  const next = { ...row, error: String(message || '启用失败').slice(0, 300), failed: true }
  const rows = new Map(this.rows); rows.set(id, next)
  this.write(rows, '启用失败状态'); return next
 }
 retry(id) {
  const row = this.rows.get(id); if (!row) return null
  const next = { ...row, error: null, failed: false }
  const rows = new Map(this.rows); rows.set(id, next)
  this.write(rows, '启用记录'); return next
 }
 remove(id) {
  if (!this.rows.has(id)) return false
  const rows = new Map(this.rows); rows.delete(id)
  this.write(rows, '启用记录'); return true
 }
 clear() {
  if (!this.rows.size) return false
  this.write(new Map(), '启用记录'); return true
 }
}

// A stored "enabled" entry may only be restored when the user still trusts the
// exact same bytes that are installed. Everything else stays visible but off.
export function restoreDecision(record, { trust, installed }) {
 if (!record) return { restore: false, reason: 'missing' }
 if (record.failed || record.error) return { restore: false, reason: 'failed' }
 const item = installed.find(candidate => candidate.manifest.id === record.id && candidate.source === record.source && candidate.hash === record.hash)
 if (!item) return { restore: false, reason: 'missing-package' }
 if (!trust.has(record)) return { restore: false, reason: 'untrusted' }
 return { restore: true, item }
}

export const trustKeys = { trust: TRUST_KEY, enabled: ENABLED_KEY }
