// 外部协议来源：添加 / 刷新 / 信任 / 启用 / 缓存。
// 边界：读目录与清单不执行代码；只有用户逐包勾选「信任此版本」并启用后，才把已校验的入口字节经 Blob URL
// 动态 import 并调用 activate(host)。它是同源执行 = 页面权限，信任只是用户确认，不是沙箱（见 docs/protocol-contract.md）。
// 已校验的字节按 sha256 存 IndexedDB，离线可直接从缓存启用；来源、信任、启用状态存 localStorage。
;(function (root) {
	'use strict'

	const Contract = root.DeviceDockContract
	const Protocols = root.DeviceDockProtocols
	const P = root.AppPlatform
	if (!Contract || !Protocols || !P) return
	const doc = root.document

	const SOURCES_KEY = 'protocolSourcesV1'
	const TRUST_KEY = 'protocolTrustV1'
	const ENABLED_KEY = 'protocolEnabledV1'
	const DB_NAME = 'devicedock-protocols'
	const DB_STORE = 'files'
	const MAX_ENTRY_BYTES = 4 * 1024 * 1024
	const MAX_MANIFEST_BYTES = 256 * 1024
	const MAX_CATALOG_BYTES = 1024 * 1024
	const CACHE_MAX_FILES = 32
	const CACHE_MAX_BYTES = 16 * 1024 * 1024
	const TRUST_LIMIT = 200
	const FETCH_TIMEOUT = 20000
	const ACTIVATE_TIMEOUT = 15000

	const state = {
		sources: [],
		trust: [],
		enabled: [],
		busy: {},
		bootErrors: [],
		booted: false,
	}
	const listeners = []

	// 启用操作的代次：删除来源 / 刷新 / 停用 / 撤销信任都会作废在飞的启用，
	// 免得慢下载或慢 activate 在来源已经没了之后还注册协议、写回启用记录。
	let opSeq = 0
	const opTokens = Object.create(null)
	function opKey(kind, sourceKey, packageId) {
		return kind + '\u0000' + sourceKey + '\u0000' + (packageId || '')
	}
	function bumpOp(kind, sourceKey, packageId) { opTokens[opKey(kind, sourceKey, packageId)] = ++opSeq }
	function readOp(kind, sourceKey, packageId) { return opTokens[opKey(kind, sourceKey, packageId)] || 0 }

	function message(e) { return String((e && e.message) || e || '未知错误') }
	function notify() {
		listeners.slice().forEach(function (fn) {
			try { fn() } catch (e) { console.warn('protocol-sources 监听器出错', e) }
		})
		if (doc && doc.dispatchEvent) doc.dispatchEvent(new CustomEvent('protocol-sources-change'))
	}
	function onChange(fn) {
		if (typeof fn !== 'function') return function () {}
		listeners.push(fn)
		return function () {
			const i = listeners.indexOf(fn)
			if (i !== -1) listeners.splice(i, 1)
		}
	}

	// ---------- 存储 ----------
	function readJson(key) {
		try {
			const raw = root.localStorage.getItem(key)
			if (!raw) return null
			return JSON.parse(raw)
		} catch (e) { return null }
	}
	function writeJson(key, value) {
		try { root.localStorage.setItem(key, JSON.stringify(value)); return true } catch (e) { return false }
	}
	function hexOf(digest) { return String(digest || '').replace(/^sha256-/, '') }
	function sanitizeSource(raw) {
		if (!raw || typeof raw !== 'object') return null
		const input = typeof raw.input === 'string' ? raw.input.trim() : ''
		if (!input) return null
		let desc
		try { desc = Contract.resolveSourceUrl(input) } catch (e) { return null }
		const packages = Array.isArray(raw.packages) ? raw.packages.map(sanitizePackage).filter(Boolean).slice(0, 200) : []
		return {
			input: input,
			key: desc.sourceKey,
			name: typeof raw.name === 'string' ? raw.name.slice(0, 80) : '',
			sha: typeof raw.sha === 'string' && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(raw.sha) ? raw.sha : '',
			fetchedAt: Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : 0,
			packages: packages,
			error: typeof raw.error === 'string' ? raw.error : '',
			notice: typeof raw.notice === 'string' ? raw.notice : '',
		}
	}
	function sanitizePackage(raw) {
		if (!raw || typeof raw !== 'object') return null
		const provides = Array.isArray(raw.provides) ? raw.provides.map(function (p) {
			if (!p || typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(p.id)) return null
			return { id: p.id, name: typeof p.name === 'string' ? p.name.slice(0, 80) : p.id }
		}).filter(Boolean) : []
		return {
			manifest: typeof raw.manifest === 'string' ? raw.manifest : '',
			manifestUrl: typeof raw.manifestUrl === 'string' ? raw.manifestUrl : '',
			manifestSha: typeof raw.manifestSha === 'string' ? raw.manifestSha : '',
			id: typeof raw.id === 'string' ? raw.id : '',
			name: typeof raw.name === 'string' ? raw.name.slice(0, 80) : '',
			version: typeof raw.version === 'string' ? raw.version : '',
			entry: typeof raw.entry === 'string' ? raw.entry : '',
			entryDigest: typeof raw.entryDigest === 'string' ? raw.entryDigest : '',
			provides: provides,
			platforms: Array.isArray(raw.platforms) ? raw.platforms.slice(0, 3) : null,
			platformOk: raw.platformOk !== false,
			error: typeof raw.error === 'string' ? raw.error : '',
		}
	}
	function sanitizeGrant(raw) {
		if (!raw || typeof raw !== 'object') return null
		try {
			Contract.trustKey(raw)
		} catch (e) { return null }
		return {
			source: String(raw.source),
			id: String(raw.id),
			version: Contract.normalizeVersion(raw.version),
			hash: hexOf(raw.hash),
			grantedAt: Number.isFinite(raw.grantedAt) ? raw.grantedAt : Date.now(),
		}
	}
	function readSources() {
		const raw = readJson(SOURCES_KEY)
		const list = raw && Array.isArray(raw.list) ? raw.list : []
		const out = []
		const seen = {}
		list.forEach(function (item) {
			const s = sanitizeSource(item)
			if (!s || seen[s.key]) return
			seen[s.key] = true
			out.push(s)
		})
		return out
	}
	function readTrust() {
		const raw = readJson(TRUST_KEY)
		const list = raw && Array.isArray(raw.list) ? raw.list : []
		const out = []
		const seen = {}
		list.forEach(function (item) {
			const g = sanitizeGrant(item)
			if (!g) return
			const key = Contract.trustKey(g)
			if (seen[key]) return
			seen[key] = true
			out.push(g)
		})
		return out.slice(-TRUST_LIMIT)
	}
	function readEnabled() {
		const raw = readJson(ENABLED_KEY)
		const list = raw && Array.isArray(raw.list) ? raw.list : []
		const out = []
		list.forEach(function (item) {
			const g = sanitizeGrant(item)
			if (!g) return
			out.push({ source: g.source, id: g.id, version: g.version, hash: g.hash })
		})
		return out
	}
	function saveSources() { writeJson(SOURCES_KEY, { v: 1, list: state.sources }) }
	function saveTrust() { writeJson(TRUST_KEY, { v: 1, list: state.trust }) }
	function saveEnabled() { writeJson(ENABLED_KEY, { v: 1, list: state.enabled }) }

	// ---------- 查询 ----------
	function findSource(key) {
		return state.sources.filter(function (s) { return s.key === key })[0] || null
	}
	function findPackage(source, id) {
		if (!source) return null
		return (source.packages || []).filter(function (p) { return p.id === id })[0] || null
	}
	function findEnabled(sourceKey, packageId) {
		return state.enabled.filter(function (r) { return r.source === sourceKey && r.id === packageId })[0] || null
	}
	function isTrusted(sourceKey, pkg) {
		if (!pkg || !pkg.id || !pkg.entryDigest) return false
		const rec = { source: sourceKey, id: pkg.id, version: pkg.version, hash: hexOf(pkg.entryDigest) }
		let key
		try { key = Contract.trustKey(rec) } catch (e) { return false }
		return state.trust.some(function (g) {
			try { return Contract.trustKey(g) === key } catch (e) { return false }
		})
	}
	function isEnabled(sourceKey, packageId) { return !!findEnabled(sourceKey, packageId) }
	function platformCtx() { return { profile: P.profile, runtime: P.runtime } }
	function bootErrorFor(sourceKey, packageId) {
		const hit = state.bootErrors.filter(function (e) { return e.source === sourceKey && e.id === packageId })[0]
		return hit ? hit.message : ''
	}

	// ---------- IndexedDB 字节缓存（按 sha256 内容寻址） ----------
	let dbPromise = null
	function openDb() {
		if (dbPromise) return dbPromise
		dbPromise = new Promise(function (resolve, reject) {
			const idb = root.indexedDB
			if (!idb) { reject(new Error('当前环境没有 IndexedDB，无法缓存协议包')); return }
			let req
			try { req = idb.open(DB_NAME, 1) } catch (e) { reject(e); return }
			req.onupgradeneeded = function () {
				const db = req.result
				if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'digest' })
			}
			req.onsuccess = function () { resolve(req.result) }
			req.onerror = function () { reject(req.error || new Error('打开协议缓存失败')) }
		}).catch(function (e) {
			dbPromise = null
			throw e
		})
		return dbPromise
	}
	function withStore(mode, fn) {
		return openDb().then(function (db) {
			return new Promise(function (resolve, reject) {
				let tx
				try { tx = db.transaction(DB_STORE, mode) } catch (e) { reject(e); return }
				let out
				try { out = fn(tx.objectStore(DB_STORE)) } catch (e) { reject(e); return }
				tx.oncomplete = function () { resolve(out) }
				tx.onerror = function () { reject(tx.error || new Error('协议缓存读写失败')) }
				tx.onabort = function () { reject(tx.error || new Error('协议缓存事务中止')) }
			})
		})
	}
	async function cacheGet(digestHexValue) {
		try {
			const req = await withStore('readonly', function (store) { return store.get(digestHexValue) })
			const rec = req && req.result
			return rec && rec.bytes ? new Uint8Array(rec.bytes) : null
		} catch (e) { return null }
	}
	async function cachePut(digestHexValue, bytes) {
		try {
			const copy = bytes.slice()
			await withStore('readwrite', function (store) {
				return store.put({ digest: digestHexValue, bytes: copy.buffer, savedAt: Date.now() })
			})
			await evictCache()
		} catch (e) { /* 缓存失败不影响本次启用，下次重新下载 */ }
	}
	async function cacheDelete(digestHexValue) {
		try {
			await withStore('readwrite', function (store) { return store.delete(digestHexValue) })
		} catch (e) { /* 删除失败下次仍会复核 */ }
	}
	async function evictCache() {
		try {
			const req = await withStore('readonly', function (store) { return store.getAll() })
			const all = (req && req.result) || []
			let total = 0
			all.forEach(function (r) { total += r.bytes ? r.bytes.byteLength : 0 })
			if (all.length <= CACHE_MAX_FILES && total <= CACHE_MAX_BYTES) return
			const byAge = all.slice().sort(function (a, b) { return (a.savedAt || 0) - (b.savedAt || 0) })
			const doomed = []
			while (byAge.length && (all.length - doomed.length > CACHE_MAX_FILES || total > CACHE_MAX_BYTES)) {
				const rec = byAge.shift()
				doomed.push(rec.digest)
				total -= rec.bytes ? rec.bytes.byteLength : 0
			}
			if (!doomed.length) return
			await withStore('readwrite', function (store) {
				doomed.forEach(function (d) { store.delete(d) })
				return null
			})
		} catch (e) { /* 淘汰失败下次再试 */ }
	}

	// ---------- 网络 ----------
	async function request(url) {
		if (typeof root.fetch !== 'function') throw new Error('当前环境不支持网络请求')
		const ctrl = typeof root.AbortController === 'function' ? new root.AbortController() : null
		const timer = ctrl ? setTimeout(function () { ctrl.abort() }, FETCH_TIMEOUT) : 0
		let res
		try {
			res = await root.fetch(url, {
				credentials: 'omit',
				referrerPolicy: 'no-referrer',
				cache: 'no-store',
				signal: ctrl ? ctrl.signal : undefined,
			})
		} catch (e) {
			if (e && e.name === 'AbortError') throw new Error('请求超时：' + url)
			throw new Error('无法获取 ' + url + '：网络请求失败（可能是 CORS 限制或网络不可达）')
		} finally {
			if (timer) clearTimeout(timer)
		}
		return res
	}
	function checkOk(res, url) {
		if (res.status === 404) throw new Error('地址不存在（404）：' + url)
		if (!res.ok) throw new Error('请求失败（HTTP ' + res.status + '）：' + url)
		return res
	}
	async function fetchBytes(url, maxBytes) {
		const res = await request(url)
		checkOk(res, url)
		const declared = Number(res.headers.get('content-length') || 0)
		if (declared && declared > maxBytes) throw new Error('文件超过上限 ' + Math.round(maxBytes / 1024) + ' KiB：' + url)
		if (!res.body || typeof res.body.getReader !== 'function') {
			const buf = new Uint8Array(await res.arrayBuffer())
			if (buf.length > maxBytes) throw new Error('文件超过上限 ' + Math.round(maxBytes / 1024) + ' KiB：' + url)
			return buf
		}
		const reader = res.body.getReader()
		const chunks = []
		let size = 0
		try {
			while (true) {
				const step = await reader.read()
				if (step.done) break
				size += step.value.length
				if (size > maxBytes) throw new Error('文件超过上限 ' + Math.round(maxBytes / 1024) + ' KiB：' + url)
				chunks.push(step.value)
			}
		} finally {
			try { await reader.cancel() } catch (e) { /* 已读完 */ }
			try { reader.releaseLock() } catch (e) { /* 忽略 */ }
		}
		const out = new Uint8Array(size)
		let offset = 0
		chunks.forEach(function (c) { out.set(c, offset); offset += c.length })
		return out
	}
	function decodeJson(bytes, url) {
		let text
		try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch (e) {
			throw new Error('文件不是合法 UTF-8：' + url)
		}
		try { return JSON.parse(text) } catch (e) {
			throw new Error('JSON 解析失败：' + url)
		}
	}

	// ---------- GitHub 提交 SHA ----------
	async function resolveGithubSha(desc) {
		if (desc.ref && Contract.isSha40(desc.ref)) return desc.ref
		const apiUrl = Contract.githubCommitApi(desc, desc.ref)
		const res = await request(apiUrl)
		if (res.status === 403 || res.status === 429) {
			const remaining = res.headers.get('x-ratelimit-remaining')
			const reset = Number(res.headers.get('x-ratelimit-reset') || 0)
			if (remaining === '0' || res.status === 429) {
				const when = reset ? new Date(reset * 1000).toLocaleTimeString() : ''
				throw new Error('GitHub API 未认证限额已用完（每小时 60 次）' + (when ? '，' + when + ' 后恢复' : '') +
					'。可在地址后加 @<40 位提交 SHA> 直接固定版本，跳过 API')
			}
		}
		checkOk(res, apiUrl)
		let json
		try { json = await res.json() } catch (e) { throw new Error('GitHub 返回的不是 JSON：' + apiUrl) }
		const sha = json && json.sha
		if (!Contract.isSha40(sha)) throw new Error('GitHub 没有返回有效的提交 SHA：' + apiUrl)
		return sha
	}

	// ---------- 读目录与清单（不执行代码） ----------
	async function summarizeManifest(source, desc, manifestRel, manifestUrl, manifestSha, bytes) {
		const raw = decodeJson(bytes, manifestUrl)
		const m = Contract.validateManifest(raw)
		return {
			manifest: manifestRel,
			manifestUrl: manifestUrl,
			manifestSha: manifestSha,
			id: m.id,
			name: m.name,
			version: m.version,
			entry: m.entry,
			entryDigest: Contract.entryDigest(m),
			provides: m.provides,
			platforms: m.platforms,
			platformOk: Contract.platformMatches(m.platforms, platformCtx()),
			error: '',
		}
	}
	async function loadCatalog(source) {
		const desc = Contract.resolveSourceUrl(source.input)
		const out = { name: '', sha: '', fetchedAt: Date.now(), packages: [] }
		if (desc.kind === 'github') {
			out.sha = await resolveGithubSha(desc)
			const base = Contract.githubRawBase(desc, out.sha)
			const catalogUrl = base + 'catalog.json'
			const bytes = await fetchBytes(catalogUrl, MAX_CATALOG_BYTES)
			const catalog = Contract.validateCatalog(decodeJson(bytes, catalogUrl))
			out.name = catalog.name
			for (let i = 0; i < catalog.packages.length; i++) {
				const p = catalog.packages[i]
				const manifestUrl = base + p.manifest
				try {
					const mbytes = await fetchBytes(manifestUrl, MAX_MANIFEST_BYTES)
					const actual = await Contract.digestHex(mbytes)
					if (actual !== p.sha256) throw new Error('清单摘要不符：' + p.manifest)
					out.packages.push(await summarizeManifest(source, desc, p.manifest, manifestUrl, p.sha256, mbytes))
				} catch (e) {
					out.packages.push({
						manifest: p.manifest, manifestUrl: manifestUrl, manifestSha: p.sha256,
						id: '', name: p.manifest, version: '', entry: '', entryDigest: '',
						provides: [], platforms: null, platformOk: true, error: message(e),
					})
				}
			}
			return out
		}
		if (desc.form === 'manifest') {
			const bytes = await fetchBytes(desc.url, MAX_MANIFEST_BYTES)
			const sha = await Contract.digestHex(bytes)
			const pkg = await summarizeManifest(source, desc, desc.url, desc.url, sha, bytes)
			out.name = pkg.name
			out.sha = sha
			out.packages.push(pkg)
			return out
		}
		const bytes = await fetchBytes(desc.url, MAX_CATALOG_BYTES)
		out.sha = await Contract.digestHex(bytes)
		const catalog = Contract.validateCatalog(decodeJson(bytes, desc.url))
		out.name = catalog.name
		for (let i = 0; i < catalog.packages.length; i++) {
			const p = catalog.packages[i]
			const manifestUrl = Contract.resolveUrl(desc.url, p.manifest)
			try {
				const mbytes = await fetchBytes(manifestUrl, MAX_MANIFEST_BYTES)
				const actual = await Contract.digestHex(mbytes)
				if (actual !== p.sha256) throw new Error('清单摘要不符：' + p.manifest)
				out.packages.push(await summarizeManifest(source, desc, p.manifest, manifestUrl, p.sha256, mbytes))
			} catch (e) {
				out.packages.push({
					manifest: p.manifest, manifestUrl: manifestUrl, manifestSha: p.sha256,
					id: '', name: p.manifest, version: '', entry: '', entryDigest: '',
					provides: [], platforms: null, platformOk: true, error: message(e),
				})
			}
		}
		return out
	}

	// ---------- 启用 ----------
	function entryUrlFor(pkg) {
		// 一律相对 manifest 解析：GitHub 上清单常在自己的子目录里（仓库根 + entry 会 404）
		return Contract.entryUrl(pkg.manifestUrl, pkg.entry)
	}
	async function entryBytes(pkg, cacheOnly) {
		const want = hexOf(pkg.entryDigest)
		const cached = await cacheGet(want)
		if (cached) {
			// 缓存键只是键：内容被换过时按摘要复核，不符就丢弃，离线也不能执行未校验字节
			const cachedHex = await Contract.digestHex(cached)
			if (cachedHex === want) return cached
			await cacheDelete(want)
			if (cacheOnly) throw new Error('本机缓存的协议包摘要不符，已丢弃缓存；请刷新来源后重新启用')
		}
		if (cacheOnly) throw new Error('本机没有该版本的缓存，请刷新来源后重新启用')
		const bytes = await fetchBytes(entryUrlFor(pkg), MAX_ENTRY_BYTES)
		const actual = await Contract.digestHex(bytes)
		if (actual !== want) throw new Error('入口文件摘要不符（可能被篡改）：' + pkg.entry)
		await cachePut(actual, bytes)
		return bytes
	}
	function unregisterPackage(sourceKey, packageId) {
		Protocols.ids().forEach(function (id) {
			const meta = Protocols.meta(id)
			if (meta && !meta.builtin && meta.source === sourceKey && meta.packageId === packageId) Protocols.unregister(id)
		})
	}
	async function activate(source, pkg, bytes, stillValid) {
		// 注册只进暂存区：activate 返回、provides 核对通过后由 enable 一次性发布。
		// 窗口在成功返回 / 抛错 / 超时后立即关闭，包再用定时器调 registerProtocol 会被拒绝，
		// 未声明的协议不会因为「晚注册」混进注册表。
		const staged = []
		let open = true
		const blobUrl = root.URL.createObjectURL(new root.Blob([bytes], { type: 'text/javascript' }))
		const meta = {
			source: source.key,
			sourceName: source.name || source.key,
			packageId: pkg.id,
			version: pkg.version,
			digest: hexOf(pkg.entryDigest),
		}
		const host = {
			apiVersion: Contract.API_VERSION,
			registerProtocol: function (def) {
				if (!open) throw new Error('协议包的注册窗口已关闭（activate 已返回或已失败）')
				if (!def || typeof def !== 'object') throw new Error('registerProtocol 需要协议对象')
				const plain = String(def.id || '')
				if (!plain) throw new Error('协议对象缺少 id')
				if (staged.some(function (r) { return r.id === plain })) throw new Error('协议 id 重复注册：' + plain)
				const fullId = Contract.namespaceId(source.key, plain)
				if (!P.allowsProtocol(fullId)) throw new Error('当前平台不支持外部协议')
				staged.push({ id: plain, fullId: fullId, def: Contract.normalizeProtocolDef(def), meta: meta })
				return fullId
			},
			source: { key: source.key, name: source.name, input: source.input, sha: source.sha },
			package: { id: pkg.id, name: pkg.name, version: pkg.version },
			appVersion: root.APP_VERSION || '',
			platform: { os: P.os, runtime: P.runtime, profile: P.profile, mobile: P.mobile },
		}
		try {
			const mod = await Promise.race([
				import(blobUrl),
				new Promise(function (_, reject) {
					setTimeout(function () { reject(new Error('协议包加载超时')) }, ACTIVATE_TIMEOUT)
				}),
			])
			// 顶层 await 可能让 import 等很久：等它回来、调用 activate 之前再确认一次，
			// 来源被删 / 版本变了就不再执行包里的副作用（已开始求值的模块代码无法撤回）。
			if (typeof stillValid === 'function') stillValid()
			if (!mod || typeof mod.activate !== 'function') throw new Error('协议包必须导出 activate(host)')
			await Promise.race([
				Promise.resolve(mod.activate(host)),
				new Promise(function (_, reject) {
					setTimeout(function () { reject(new Error('协议包 activate 超时')) }, ACTIVATE_TIMEOUT)
				}),
			])
		} finally {
			open = false
			setTimeout(function () { try { root.URL.revokeObjectURL(blobUrl) } catch (e) { /* 忽略 */ } }, 0)
		}
		return staged
	}
	function describeMismatch(check) {
		const parts = []
		if (check.extra.length) parts.push('多出 ' + check.extra.join('、'))
		if (check.missing.length) parts.push('缺少 ' + check.missing.join('、'))
		return parts.length ? '：' + parts.join('；') : ''
	}
	function enableTag(sourceKey, packageId) {
		return 'enable:' + sourceKey + '\u0000' + packageId
	}
	function failEnable(sourceKey, packageId) {
		unregisterPackage(sourceKey, packageId)
		state.bootErrors = state.bootErrors.filter(function (e) { return !(e.source === sourceKey && e.id === packageId) })
		saveEnabled()
		if (typeof root.normalizeProtocolSelection === 'function') root.normalizeProtocolSelection()
		notify()
	}
	async function enable(sourceKey, packageId, opts) {
		opts = opts || {}
		const source = findSource(sourceKey)
		if (!source) throw new Error('来源不存在')
		if (state.busy[sourceKey]) throw new Error('这个来源正在刷新，请等刷新完成后再启用')
		const pkg = findPackage(source, packageId)
		if (!pkg) throw new Error('来源里没有这个协议包，请刷新来源')
		if (pkg.error) throw new Error(pkg.error)
		if (pkg.platformOk === false) throw new Error('该协议包不支持当前平台')
		if (P.mobile) throw new Error('移动端只提供内置 SEK 协议，不支持外部协议')
		if (!isTrusted(sourceKey, pkg)) throw new Error('需要先勾选「信任此版本」')
		const tag = enableTag(sourceKey, packageId)
		if (state.busy[tag]) throw new Error('这个协议包正在启用')
		const sourceToken = readOp('source', sourceKey)
		const pkgToken = readOp('pkg', sourceKey, packageId)
		function ensureValid() {
			if (readOp('source', sourceKey) !== sourceToken || readOp('pkg', sourceKey, packageId) !== pkgToken) {
				throw new Error('启用已取消（来源或版本已变化）')
			}
			const src = findSource(sourceKey)
			if (!src) throw new Error('来源已删除，启用已取消')
			const current = findPackage(src, packageId)
			if (!current) throw new Error('协议包已不在来源里，请刷新来源')
			// 只比 id 不够：刷新可能换掉同 id 的包，最终提交前要核对本次用的身份
			if (current.version !== pkg.version || current.entryDigest !== pkg.entryDigest ||
				current.manifestUrl !== pkg.manifestUrl || current.manifestSha !== pkg.manifestSha) {
				throw new Error('协议包已更新，请重新信任后再启用')
			}
		}
		state.busy[tag] = '启用中'
		try {
			// 同一包旧版本 / 旧 id 先清掉，避免 provides 变化后留下孤儿协议；
			// 先把「已停用」落盘，失败时不会留下内存与存储不一致的启用记录
			unregisterPackage(sourceKey, packageId)
			state.enabled = state.enabled.filter(function (r) { return !(r.source === sourceKey && r.id === packageId) })
			saveEnabled()
			const bytes = await entryBytes(pkg, !!opts.cacheOnly)
			ensureValid()
			const staged = await activate(source, pkg, bytes, ensureValid)
			ensureValid()
			const check = Contract.checkProvides({ provides: pkg.provides }, staged.map(function (s) { return s.id }))
			if (!check.ok) {
				failEnable(sourceKey, packageId)
				throw new Error('协议包注册的 id 与 provides 不一致' + describeMismatch(check))
			}
			// 暂存区通过核对后才发布；跨包同 id 冲突由 registerExternal 拒绝，
			// 发布到一半失败只回滚本次注册，不碰别的包。
			const published = []
			try {
				staged.forEach(function (s) {
					Protocols.registerExternal(sourceKey, s.id, s.def, s.meta)
					published.push(s.fullId)
				})
			} catch (e) {
				published.forEach(function (id) { Protocols.unregister(id) })
				failEnable(sourceKey, packageId)
				throw e
			}
			state.enabled.push({ source: sourceKey, id: packageId, version: pkg.version, hash: hexOf(pkg.entryDigest) })
			state.bootErrors = state.bootErrors.filter(function (e) { return !(e.source === sourceKey && e.id === packageId) })
			source.notice = ''
			saveSources()
			saveEnabled()
			notify()
			return staged.map(function (s) { return s.id })
		} catch (e) {
			// 失败 / 取消后没有活着的注册：归一化各路选择，运行态不能停在已不存在的 id
			if (typeof root.normalizeProtocolSelection === 'function') root.normalizeProtocolSelection()
			notify()
			throw e
		} finally {
			delete state.busy[tag]
			notify()
		}
	}
	function disable(sourceKey, packageId, silent) {
		const rec = findEnabled(sourceKey, packageId)
		bumpOp('pkg', sourceKey, packageId)
		unregisterPackage(sourceKey, packageId)
		if (!rec) return false
		state.enabled = state.enabled.filter(function (r) { return !(r.source === sourceKey && r.id === packageId) })
		saveEnabled()
		if (typeof root.normalizeProtocolSelection === 'function') root.normalizeProtocolSelection()
		if (!silent) notify()
		return true
	}

	// ---------- 对外动作 ----------
	function add(input) {
		let desc
		try { desc = Contract.resolveSourceUrl(input) } catch (e) { return Promise.reject(e) }
		if (findSource(desc.sourceKey)) return Promise.reject(new Error('来源已存在：' + desc.sourceKey))
		const source = {
			input: String(input).trim(),
			key: desc.sourceKey,
			name: '',
			sha: '',
			fetchedAt: 0,
			packages: [],
			error: '',
			notice: '',
		}
		state.sources.push(source)
		saveSources()
		notify()
		return refresh(desc.sourceKey).then(function () { return findSource(desc.sourceKey) }, function (e) {
			// 来源保留在列表里，错误就地显示，用户可以改地址或删除
			throw e
		})
	}
	function remove(key) {
		const source = findSource(key)
		if (!source) return Promise.resolve(false)
		bumpOp('source', key)
		state.enabled.filter(function (r) { return r.source === key }).forEach(function (r) { disable(key, r.id, true) })
		state.trust = state.trust.filter(function (g) { return g.source !== key })
		state.sources = state.sources.filter(function (s) { return s.key !== key })
		state.bootErrors = state.bootErrors.filter(function (e) { return e.source !== key })
		saveSources()
		saveTrust()
		if (typeof root.normalizeProtocolSelection === 'function') root.normalizeProtocolSelection()
		notify()
		return Promise.resolve(true)
	}
	async function refresh(key) {
		const source = findSource(key)
		if (!source) throw new Error('来源不存在')
		if (state.busy[key]) throw new Error('这个来源正在刷新')
		// 刷新会让目录 / 版本变化：在飞的启用全部作废，不能让旧版本在刷新后落地
		bumpOp('source', key)
		source.error = ''
		source.notice = ''
		state.busy[key] = '刷新中'
		notify()
		try {
			const cat = await loadCatalog(source)
			source.sha = cat.sha
			source.fetchedAt = cat.fetchedAt
			source.packages = cat.packages
			// 目录换完了再作废一次：刷新期间不该有能落地的旧操作（启用本身在刷新期间已被拒）
			bumpOp('source', key)
			if (cat.name) source.name = cat.name
			const stale = []
			state.enabled.filter(function (r) { return r.source === key }).forEach(function (r) {
				const pkg = findPackage(source, r.id)
				if (!pkg || pkg.error || hexOf(pkg.entryDigest) !== r.hash || pkg.version !== r.version) {
					disable(key, r.id, true)
					stale.push(r.id)
				}
			})
			if (stale.length) source.notice = '来源版本已变化，已停用：' + stale.join('、') + '（需要重新信任）'
			saveSources()
			return findSource(key)
		} catch (e) {
			source.error = message(e)
			saveSources()
			throw e
		} finally {
			delete state.busy[key]
			notify()
		}
	}
	function trust(sourceKey, packageId) {
		const source = findSource(sourceKey)
		const pkg = findPackage(source, packageId)
		if (!pkg || pkg.error) throw new Error('协议包不可用，无法信任')
		const rec = {
			source: sourceKey,
			id: pkg.id,
			version: pkg.version,
			hash: hexOf(pkg.entryDigest),
			grantedAt: Date.now(),
		}
		const key = Contract.trustKey(rec)
		state.trust = state.trust.filter(function (g) { return Contract.trustKey(g) !== key })
		state.trust.push(rec)
		if (state.trust.length > TRUST_LIMIT) state.trust = state.trust.slice(-TRUST_LIMIT)
		saveTrust()
		notify()
	}
	function revokeTrust(sourceKey, packageId) {
		const pkg = findPackage(findSource(sourceKey), packageId)
		if (!pkg) return
		disable(sourceKey, packageId, true)
		state.trust = state.trust.filter(function (g) {
			return !(g.source === sourceKey && g.id === packageId)
		})
		saveTrust()
		notify()
	}

	function list() {
		return state.sources.map(function (s) {
			return {
				key: s.key,
				input: s.input,
				name: s.name,
				sha: s.sha,
				fetchedAt: s.fetchedAt,
				error: s.error,
				notice: s.notice,
				busy: state.busy[s.key] || '',
				packages: (s.packages || []).map(function (p) {
					return {
						id: p.id,
						name: p.name,
						version: p.version,
						provides: p.provides.map(function (x) { return { id: x.id, name: x.name } }),
						digest: p.entryDigest,
						error: p.error,
						platformOk: p.platformOk !== false,
						trusted: !!p.id && isTrusted(s.key, p),
						enabled: !!p.id && isEnabled(s.key, p.id),
						bootError: bootErrorFor(s.key, p.id),
					}
				}),
			}
		})
	}

	const api = {
		list: list,
		add: add,
		remove: remove,
		refresh: refresh,
		trust: trust,
		revokeTrust: revokeTrust,
		enable: enable,
		disable: disable,
		isTrusted: isTrusted,
		isEnabled: isEnabled,
		onChange: onChange,
		isBusy: function (key) { return !!state.busy[key] },
		booted: function () { return state.booted },
	}

	root.DeviceDockProtocolSources = api

	// ---------- 启动：先登记 pending id，再从缓存启用已勾选的包 ----------
	state.sources = readSources()
	state.trust = readTrust()
	state.enabled = readEnabled()
	// 启动时先按「当时的 provides」登记 pending，并把完整 id 列表留在这份计划里：
	// 来源若在启动加载期间被删除，失败清理不能再靠 findSource 找包（那时已经找不到，pending 会永久残留）。
	const bootPlan = state.enabled.map(function (rec) {
		const src = findSource(rec.source)
		const pkg = findPackage(src, rec.id)
		const ids = pkg ? pkg.provides.map(function (p) { return Contract.namespaceId(rec.source, p.id) }) : []
		ids.forEach(function (id) { Protocols.expect(id) })
		return { rec: rec, ids: ids }
	})
	const bootTasks = bootPlan.map(function (plan) {
		return enable(plan.rec.source, plan.rec.id, { cacheOnly: true }).catch(function (e) {
			state.bootErrors.push({ source: plan.rec.source, id: plan.rec.id, message: message(e) })
		}).then(function () {
			// 成功时注册会清掉 pending；失败 / 取消时按启动时记下的列表清
			plan.ids.forEach(function (id) { Protocols.settle(id) })
		})
	})
	Promise.all(bootTasks).then(function () {
		state.booted = true
		if (typeof root.normalizeProtocolSelection === 'function') root.normalizeProtocolSelection()
		notify()
	})
})(typeof window !== 'undefined' ? window : globalThis)
