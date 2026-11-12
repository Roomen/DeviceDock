// 协议契约 v1：清单 / 目录校验、来源 URL 解析、命名空间、信任键与协议对象规范化。
// 纯逻辑：不碰 DOM、不发请求、不执行代码。浏览器挂 window.DeviceDockContract，node 里可 require
// (tests/protocol-contract.cjs 就是直接读这个文件)。契约全文与禁止项见 docs/protocol-contract.md。
;(function (root) {
	'use strict'

	const SCHEMA_VERSION = 1
	const API_VERSION = 1
	// v1 只跑 js；lua 是预留值，现在遇到就明确报不支持，不要静默忽略
	const RUNTIMES = ['js']
	const PLATFORM_TAGS = ['web', 'desktop', 'mobile']
	const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
	const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
	const HEX64_RE = /^[0-9a-f]{64}$/
	const INTEGRITY_RE = /^sha256-[0-9a-f]{64}$/
	const FIELD_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/
	const FIELD_TYPES = ['uint8', 'uint16le', 'uint32le', 'int8', 'int16le', 'int32le', 'float32le', 'float64le', 'bcd', 'ascii', 'enum', 'bool']
	const TEST_EXECUTOR_METHODS = ['queryById', 'readTag', 'writeRaw', 'readItem', 'bytesEqual', 'hasTag', 'reset', 'cancel']
	const MAX_CATALOG_PACKAGES = 200
	const MAX_PROVIDES = 64
	const MAX_FIELDS = 512
	const MAX_PATH = 240
	const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1']

	class ContractError extends Error {
		constructor(message, code) {
			super(message)
			this.name = 'ContractError'
			this.code = code || 'invalid'
		}
	}
	function fail(message, code) { throw new ContractError(message, code) }
	function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }
	function str(v, max) {
		if (typeof v !== 'string') return ''
		const s = v.trim()
		return s.length > max ? s.slice(0, max) : s
	}
	function isFunction(v) { return typeof v === 'function' }

	// ---------- SemVer / 摘要 ----------
	function normalizeVersion(value) {
		const s = String(value == null ? '' : value).trim()
		if (!VERSION_RE.test(s)) fail('版本号必须是精确 SemVer（MAJOR.MINOR.PATCH，不带预发布与构建后缀）：' + (s || '(空)'))
		return s
	}
	function compareVersions(a, b) {
		const pa = String(a).split('.').map(function (n) { return parseInt(n, 10) || 0 })
		const pb = String(b).split('.').map(function (n) { return parseInt(n, 10) || 0 })
		for (let i = 0; i < 3; i++) {
			const d = (pa[i] || 0) - (pb[i] || 0)
			if (d) return d > 0 ? 1 : -1
		}
		return 0
	}
	function isHex64(v) { return typeof v === 'string' && HEX64_RE.test(v) }
	function isSha40(v) { return typeof v === 'string' && /^[0-9a-f]{40}$/.test(v) }
	function digestLabel(hex) { return 'sha256-' + hex }
	function shortDigest(hex, n) {
		const s = String(hex || '')
		return s.slice(0, n || 12)
	}
	async function digestHex(bytes) {
		const subtle = (root.crypto && root.crypto.subtle) || (typeof crypto !== 'undefined' ? crypto.subtle : null)
		if (!subtle) fail('当前环境不支持 SHA-256 校验（需要 HTTPS 或 localhost）', 'no-subtle-crypto')
		const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
		const out = await subtle.digest('SHA-256', buf)
		return Array.prototype.map.call(new Uint8Array(out), function (b) { return b.toString(16).padStart(2, '0') }).join('')
	}

	// ---------- 包内路径 ----------
	// 只允许包内相对路径：不允许绝对路径、反斜杠、协议前缀、查询串 / 锚点、. 与 ..、百分号编码
	function isSafePath(value) {
		if (typeof value !== 'string' || !value || value.length > MAX_PATH) return false
		if (value.charAt(0) === '/' || value.indexOf('\\') !== -1) return false
		if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false
		if (/[?#\u0000-\u001f]/.test(value)) return false
		const segs = value.split('/')
		if (!segs.length) return false
		return segs.every(function (s) {
			return !!s && s !== '.' && s !== '..' && /^[A-Za-z0-9_@.+~-]+$/.test(s)
		})
	}
	function safePath(value, what) {
		if (!isSafePath(value)) fail((what || '包内路径') + '不合法：' + String(value))
		return value
	}
	// 把包内相对路径接到某个绝对 URL 的目录后面。rel 已经排除 ..，所以不会逃出该目录
	function resolveUrl(baseUrl, rel) {
		safePath(rel)
		const base = String(baseUrl || '').replace(/[?#].*$/, '')
		const cut = base.lastIndexOf('/')
		if (cut < 0) fail('基准地址不合法：' + base)
		return base.slice(0, cut + 1) + rel
	}
	// 包入口一律相对 manifest 文件解析（GitHub 上 manifest 常在子目录里，相对仓库根会 404）
	function entryUrl(manifestUrl, entry) {
		return resolveUrl(manifestUrl, entry)
	}
	function dirOf(url) {
		const s = String(url || '').replace(/[?#].*$/, '')
		const cut = s.lastIndexOf('/')
		return cut < 0 ? s : s.slice(0, cut + 1)
	}

	// ---------- 清单 ----------
	function normalizePlatforms(value) {
		if (value == null) return null
		if (!Array.isArray(value) || !value.length) fail('platforms 必须是非空数组')
		const out = []
		value.forEach(function (p) {
			if (PLATFORM_TAGS.indexOf(p) === -1) fail('platforms 含未知平台：' + String(p) + '（只接受 web / desktop / mobile）')
			if (out.indexOf(p) === -1) out.push(p)
		})
		return out
	}
	function normalizeProvides(value) {
		if (!Array.isArray(value) || !value.length) fail('manifest.provides 必须是非空数组')
		if (value.length > MAX_PROVIDES) fail('provides 超过 ' + MAX_PROVIDES + ' 项')
		const seen = {}
		return value.map(function (p) {
			if (!isObject(p)) fail('provides 项必须是对象')
			const id = String(p.id == null ? '' : p.id)
			if (!ID_RE.test(id)) fail('provides 里的协议 id 不合法：' + (id || '(空)'))
			if (seen[id]) fail('provides 里的协议 id 重复：' + id)
			seen[id] = true
			const name = str(p.name, 80)
			if (!name) fail('provides 里的协议 ' + id + ' 缺少名称')
			const out = { id: id, name: name }
			if (p.description != null) out.description = str(p.description, 200)
			return out
		})
	}
	function normalizeIntegrity(value, entry) {
		if (!isObject(value)) fail('manifest.integrity 必须是对象')
		const keys = Object.keys(value)
		if (!keys.length) fail('manifest.integrity 不能为空')
		if (keys.length > 200) fail('manifest.integrity 条目过多')
		const out = {}
		keys.forEach(function (k) {
			safePath(k, 'integrity 路径')
			if (!INTEGRITY_RE.test(String(value[k]))) fail('integrity 摘要格式不对（应为 sha256-<64 位小写十六进制>）：' + k)
			out[k] = value[k]
		})
		if (!Object.prototype.hasOwnProperty.call(out, entry)) fail('manifest.integrity 没有声明入口文件：' + entry)
		return out
	}
	// 只校验、不改写函数体；返回规范化副本（未知顶层键丢弃，避免清单偷偷塞运行参数）
	function validateManifest(raw) {
		if (!isObject(raw)) fail('协议清单不是对象')
		if (raw.schemaVersion !== SCHEMA_VERSION) fail('不支持的清单 schemaVersion：' + String(raw.schemaVersion) + '（v1 只支持 1）')
		if (raw.kind !== 'protocol') fail('清单 kind 必须是 protocol，实际：' + String(raw.kind))
		const runtime = String(raw.runtime == null ? '' : raw.runtime)
		if (RUNTIMES.indexOf(runtime) === -1) fail('不支持的 runtime：' + (runtime || '(空)') + '（v1 只支持 js）', 'runtime')
		if (raw.apiVersion !== API_VERSION) fail('不支持的 apiVersion：' + String(raw.apiVersion) + '（v1 只支持 1）', 'apiVersion')
		const id = String(raw.id == null ? '' : raw.id)
		if (!ID_RE.test(id)) fail('包 id 不合法：' + (id || '(空)'))
		const name = str(raw.name, 80)
		if (!name) fail('清单缺少名称')
		const version = normalizeVersion(raw.version)
		const entry = safePath(raw.entry, '入口路径')
		if (!/\.m?js$/.test(entry)) fail('入口必须是 .js / .mjs 文件：' + entry)
		const integrity = normalizeIntegrity(raw.integrity, entry)
		const provides = normalizeProvides(raw.provides)
		const license = str(raw.license, 120)
		if (!license) fail('清单缺少 license')
		const platforms = normalizePlatforms(raw.platforms)
		return {
			schemaVersion: SCHEMA_VERSION,
			kind: 'protocol',
			runtime: runtime,
			apiVersion: API_VERSION,
			id: id,
			name: name,
			version: version,
			entry: entry,
			integrity: integrity,
			provides: provides,
			license: license,
			platforms: platforms,
		}
	}
	function entryDigest(manifest) {
		return manifest && manifest.integrity ? manifest.integrity[manifest.entry] : null
	}

	// ---------- 目录 ----------
	function validateCatalog(raw) {
		if (!isObject(raw)) fail('目录不是对象')
		if (raw.schemaVersion !== SCHEMA_VERSION) fail('不支持的目录 schemaVersion：' + String(raw.schemaVersion) + '（v1 只支持 1）')
		const name = str(raw.name, 80)
		if (!name) fail('目录缺少名称')
		if (!Array.isArray(raw.packages) || !raw.packages.length) fail('目录 packages 必须是非空数组')
		if (raw.packages.length > MAX_CATALOG_PACKAGES) fail('目录包数量超过 ' + MAX_CATALOG_PACKAGES)
		const seen = {}
		const packages = raw.packages.map(function (p) {
			if (!isObject(p)) fail('目录包项必须是对象')
			const manifest = safePath(p.manifest, '清单路径')
			if (!/manifest\.json$/.test(manifest)) fail('目录里的 manifest 必须指向 manifest.json：' + manifest)
			if (seen[manifest]) fail('目录里有重复的清单路径：' + manifest)
			seen[manifest] = true
			const sha256 = String(p.sha256 == null ? '' : p.sha256)
			if (!isHex64(sha256)) fail('目录里的清单摘要必须是 64 位小写十六进制：' + manifest)
			return { manifest: manifest, sha256: sha256 }
		})
		return { schemaVersion: SCHEMA_VERSION, name: name, packages: packages }
	}

	// ---------- 来源 URL ----------
	function isLocalHost(host) {
		return LOCAL_HOSTS.indexOf(String(host || '').toLowerCase()) !== -1
	}
	function checkRemoteUrl(u, what) {
		if (u.username || u.password) fail((what || '地址') + '不能带用户名或密码')
		if (u.search || u.hash) fail((what || '地址') + '不能带查询串或锚点')
		if (u.protocol === 'https:') return
		// 只给本地开发放行 http：示例仓库用 python3 -m http.server 托管
		if (u.protocol === 'http:' && isLocalHost(u.hostname)) return
		fail((what || '地址') + '必须是 HTTPS（本机 localhost 可用 http）')
	}
	function segOk(s) { return /^[A-Za-z0-9_.-]+$/.test(s) && s !== '.' && s !== '..' }
	// 支持：github 仓库地址（可带 @ref 或 /tree/<ref>[/<子目录>]）、catalog.json 或 manifest.json 的直连 URL
	function resolveSourceUrl(input) {
		const text = String(input == null ? '' : input).trim()
		if (!text) fail('请输入协议来源地址')
		let u
		try { u = new URL(text) } catch (e) { fail('地址格式不对：' + text) }
		checkRemoteUrl(u)
		const host = u.hostname.toLowerCase()
		if (host === 'github.com' || host === 'www.github.com') {
			const parts = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
			if (parts.length < 2) fail('GitHub 地址需要 组织/仓库：' + text)
			let owner = parts[0]
			let repo = parts[1]
			if (/\.git$/.test(repo)) repo = repo.slice(0, -4)
			let ref = ''
			let subpath = ''
			if (parts.length > 2) {
				if (parts[2] !== 'tree' || parts.length < 4) fail('GitHub 地址只支持 /tree/<ref> 形式：' + text)
				ref = parts[3]
				if (parts.length > 4) subpath = parts.slice(4).join('/')
			} else if (repo.indexOf('@') !== -1) {
				const at = repo.lastIndexOf('@')
				ref = repo.slice(at + 1)
				repo = repo.slice(0, at)
			}
			if (!segOk(owner) || !segOk(repo)) fail('GitHub 组织或仓库名不合法：' + text)
			if (ref && !/^[A-Za-z0-9._-]{1,100}$/.test(ref)) fail('GitHub 的 ref 只接受字母、数字、点、下划线与连字符（含斜杠的分支请先换成提交 SHA）：' + ref)
			if (subpath) safePath(subpath, '仓库子目录')
			return {
				kind: 'github',
				owner: owner,
				repo: repo,
				ref: ref,
				subpath: subpath,
				url: 'https://github.com/' + owner + '/' + repo,
				sourceKey: 'github.com/' + owner.toLowerCase() + '/' + repo.toLowerCase(),
			}
		}
		const path = u.pathname
		if (!/\/(catalog|manifest)\.json$/.test(path)) fail('直连地址必须指向 catalog.json 或 manifest.json：' + text)
		const form = /\/catalog\.json$/.test(path) ? 'catalog' : 'manifest'
		const baseUrl = u.origin + path.slice(0, path.lastIndexOf('/') + 1)
		return {
			kind: 'direct',
			form: form,
			url: u.origin + path,
			baseUrl: baseUrl,
			sourceKey: u.origin + path.slice(0, path.lastIndexOf('/') + 1).replace(/\/$/, ''),
		}
	}
	function githubCommitApi(desc, ref) {
		const r = String(ref == null ? '' : ref).trim()
		return 'https://api.github.com/repos/' + desc.owner + '/' + desc.repo + '/commits/' + encodeURIComponent(r || 'HEAD')
	}
	function githubRawBase(desc, sha) {
		if (!isSha40(sha)) fail('GitHub 提交 SHA 必须是 40 位小写十六进制')
		return 'https://raw.githubusercontent.com/' + desc.owner + '/' + desc.repo + '/' + sha + '/' + (desc.subpath ? desc.subpath + '/' : '')
	}
	function catalogUrlFor(desc, sha) {
		if (!desc) fail('缺少来源描述')
		if (desc.kind === 'github') return githubRawBase(desc, sha) + 'catalog.json'
		return desc.url
	}

	// ---------- 命名空间 / provides / 信任 ----------
	function namespaceId(sourceKey, protocolId) {
		const key = String(sourceKey == null ? '' : sourceKey).trim()
		if (!key || /[\s\u0000-\u001f]/.test(key)) fail('来源键不合法：' + key)
		if (!ID_RE.test(String(protocolId || ''))) fail('协议 id 不合法：' + String(protocolId))
		return key + '/' + protocolId
	}
	function splitNamespaced(id) {
		const s = String(id == null ? '' : id)
		const cut = s.lastIndexOf('/')
		if (cut <= 0) return null
		return { sourceKey: s.slice(0, cut), protocolId: s.slice(cut + 1) }
	}
	// 实际注册的 id 集合必须与 provides 严格相等：多一个少一个都算包有问题
	function checkProvides(manifest, registeredIds) {
		const declared = (manifest && manifest.provides ? manifest.provides : []).map(function (p) { return p.id })
		const actual = Array.from(new Set((registeredIds || []).map(String)))
		const missing = declared.filter(function (id) { return actual.indexOf(id) === -1 })
		const extra = actual.filter(function (id) { return declared.indexOf(id) === -1 })
		return { ok: !missing.length && !extra.length, declared: declared, actual: actual, missing: missing, extra: extra }
	}
	function trustKey(record) {
		if (!isObject(record)) fail('信任记录无效')
		const source = String(record.source == null ? '' : record.source)
		if (!source) fail('信任记录缺少来源')
		const id = String(record.id == null ? '' : record.id)
		if (!ID_RE.test(id)) fail('信任记录里的包 id 不合法')
		const version = normalizeVersion(record.version)
		const hash = String(record.hash == null ? '' : record.hash)
		if (!isHex64(hash)) fail('信任记录里的入口摘要必须是 64 位小写十六进制')
		return JSON.stringify([source, id, version, hash])
	}
	function platformTags(ctx) {
		const c = ctx || {}
		if (c.profile === 'mobile') return ['mobile']
		return c.runtime === 'tauri' ? ['desktop'] : ['web']
	}
	function platformMatches(platforms, ctx) {
		if (!platforms || !platforms.length) return true
		const tags = platformTags(ctx)
		return platforms.some(function (p) { return tags.indexOf(p) !== -1 })
	}

	// ---------- 协议对象规范化 ----------
	function normalizeEnum(value) {
		if (value == null) return null
		if (!Array.isArray(value) || !value.length) fail('enum 必须是非空数组')
		const seen = {}
		return value.map(function (item) {
			let v
			let label
			if (isObject(item)) {
				v = item.value
				label = item.label
			} else {
				v = item
				label = item
			}
			if (typeof v !== 'number' && typeof v !== 'string') fail('enum 值只能是数字或字符串')
			const k = String(v)
			if (seen[k]) fail('enum 值重复：' + k)
			seen[k] = true
			return { value: v, label: label == null ? k : String(label) }
		})
	}
	function normalizeFields(value) {
		if (value == null) return []
		if (!Array.isArray(value)) fail('fields 必须是数组')
		if (value.length > MAX_FIELDS) fail('字段目录超过 ' + MAX_FIELDS + ' 项')
		const seen = {}
		return value.map(function (raw) {
			if (!isObject(raw)) fail('字段定义必须是对象')
			const key = String(raw.key == null ? '' : raw.key)
			if (!FIELD_KEY_RE.test(key)) fail('字段 key 不合法：' + (key || '(空)'))
			if (seen[key]) fail('字段 key 重复：' + key)
			seen[key] = true
			const name = str(raw.name, 80)
			if (!name) fail('字段 ' + key + ' 缺少名称')
			const type = String(raw.type == null ? '' : raw.type)
			if (FIELD_TYPES.indexOf(type) === -1) fail('字段 ' + key + ' 的类型不支持：' + (type || '(空)'))
			// 保留协议自己的附加属性（例如 SEK 的 tag / fid / step），宿主只认下面这些
			const out = Object.assign({}, raw)
			out.key = key
			out.name = name
			out.type = type
			out.read = raw.read !== false
			out.write = raw.write !== false
			if (raw.unit != null) out.unit = str(raw.unit, 16)
			if (raw.group != null) out.group = str(raw.group, 60)
			;['min', 'max', 'step'].forEach(function (k) {
				if (raw[k] == null) { delete out[k]; return }
				if (typeof raw[k] !== 'number' || !isFinite(raw[k])) fail('字段 ' + key + ' 的 ' + k + ' 必须是数字')
			})
			if (raw.min != null && raw.max != null && raw.min > raw.max) fail('字段 ' + key + ' 的 min 大于 max')
			if (raw.step != null && !(raw.step > 0)) fail('字段 ' + key + ' 的 step 必须大于 0')
			out.enum = normalizeEnum(raw.enum)
			return out
		})
	}
	function normalizeQueries(value) {
		if (value == null) return []
		if (!Array.isArray(value)) fail('queries 必须是数组')
		if (value.length > MAX_FIELDS) fail('查询目录超过 ' + MAX_FIELDS + ' 项')
		const seen = {}
		return value.map(function (raw) {
			if (!isObject(raw)) fail('查询用例必须是对象')
			const key = String(raw.key == null ? '' : raw.key)
			if (!FIELD_KEY_RE.test(key)) fail('查询用例 key 不合法：' + (key || '(空)'))
			if (seen[key]) fail('查询用例 key 重复：' + key)
			seen[key] = true
			const name = str(raw.name, 80)
			if (!name) fail('查询用例 ' + key + ' 缺少名称')
			return Object.assign({}, raw, { key: key, name: name })
		})
	}
	function normalizeTestExecutor(tx) {
		if (tx == null) return null
		if (!isObject(tx)) fail('tx 必须是对象')
		TEST_EXECUTOR_METHODS.forEach(function (m) {
			if (!isFunction(tx[m])) fail('tx 缺少方法：' + m)
		})
		return tx
	}
	function normalizeProtocolDef(def) {
		if (!isObject(def)) fail('协议对象无效')
		const name = str(def.name, 80)
		if (!name) fail('协议缺少名称')
		if (!isFunction(def.parseFrame)) fail('协议缺少 parseFrame')
		const out = { name: name, parseFrame: def.parseFrame }
		;['formatFrame', 'logView', 'findFrame', 'byteMap', 'buildDownFrame', 'metrics', 'buildRead', 'buildWrite', 'matchResponse', 'mountPanel'].forEach(function (k) {
			const v = def[k]
			if (v == null) { out[k] = null; return }
			if (!isFunction(v)) fail('协议 ' + name + ' 的 ' + k + ' 必须是函数')
			out[k] = v
		})
		out.presets = Array.isArray(def.presets) ? def.presets.slice() : []
		out.fields = normalizeFields(def.fields)
		out.queries = normalizeQueries(def.queries)
		out.tx = normalizeTestExecutor(def.tx)
		return out
	}

	const api = {
		SCHEMA_VERSION: SCHEMA_VERSION,
		API_VERSION: API_VERSION,
		RUNTIMES: RUNTIMES,
		PLATFORM_TAGS: PLATFORM_TAGS,
		FIELD_TYPES: FIELD_TYPES,
		ContractError: ContractError,
		isSafePath: isSafePath,
		safePath: safePath,
		resolveUrl: resolveUrl,
		entryUrl: entryUrl,
		dirOf: dirOf,
		normalizeVersion: normalizeVersion,
		compareVersions: compareVersions,
		isHex64: isHex64,
		isSha40: isSha40,
		digestLabel: digestLabel,
		shortDigest: shortDigest,
		digestHex: digestHex,
		validateManifest: validateManifest,
		entryDigest: entryDigest,
		validateCatalog: validateCatalog,
		resolveSourceUrl: resolveSourceUrl,
		githubCommitApi: githubCommitApi,
		githubRawBase: githubRawBase,
		catalogUrlFor: catalogUrlFor,
		isLocalHost: isLocalHost,
		namespaceId: namespaceId,
		splitNamespaced: splitNamespaced,
		checkProvides: checkProvides,
		trustKey: trustKey,
		platformTags: platformTags,
		platformMatches: platformMatches,
		normalizeProtocolDef: normalizeProtocolDef,
		normalizeFields: normalizeFields,
	}

	root.DeviceDockContract = api
	if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
