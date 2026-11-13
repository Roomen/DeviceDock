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
	// 会话钩子：协议自己的连通检查与空闲保活，都只返回 { bytes, request }，引擎不认识帧格式
	const SESSION_HOOKS = ['prepare', 'keepalive']
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
	// 协议函数按同步契约在宿主按路隔离的会话里调用：async 实现在 await 之后仍会访问
	// 已经恢复的全局状态，注册层就拦掉。
	function isAsyncFunction(v) {
		if (!isFunction(v)) return false
		const ctor = v.constructor
		return (ctor && ctor.name === 'AsyncFunction') || Object.prototype.toString.call(v) === '[object AsyncFunction]'
	}

	// ---------- SemVer / 摘要 ----------
	function normalizeVersion(value) {
		const s = String(value == null ? '' : value).trim()
		if (!VERSION_RE.test(s)) fail(I18n.t('contract.versionMustBeExactSemverMajor', { v: (s || I18n.t('contract.empty')) }))
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
		if (!subtle) fail(I18n.t('contract.sha256VerificationIsnTAvailable'), 'no-subtle-crypto')
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
		if (!isSafePath(value)) fail(I18n.t('contract.isInvalid', { v: (what || I18n.t('contract.packagePath')), String: String(value) }))
		return value
	}
	// 把包内相对路径接到某个绝对 URL 的目录后面。rel 已经排除 ..，所以不会逃出该目录
	function resolveUrl(baseUrl, rel) {
		safePath(rel)
		const base = String(baseUrl || '').replace(/[?#].*$/, '')
		const cut = base.lastIndexOf('/')
		if (cut < 0) fail(I18n.t('contract.invalidBaseUrl', { base }))
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
		if (!Array.isArray(value) || !value.length) fail(I18n.t('contract.platformsMustBeANonEmpty'))
		const out = []
		value.forEach(function (p) {
			if (PLATFORM_TAGS.indexOf(p) === -1) fail(I18n.t('contract.platformsHasAnUnknownPlatformOnly', { String: String(p) }))
			if (out.indexOf(p) === -1) out.push(p)
		})
		return out
	}
	function normalizeProvides(value) {
		if (!Array.isArray(value) || !value.length) fail(I18n.t('contract.manifestProvidesMustBeANon'))
		if (value.length > MAX_PROVIDES) fail(I18n.t('contract.providesHasMoreThanEntries', { MAX_PROVIDES }))
		const seen = {}
		return value.map(function (p) {
			if (!isObject(p)) fail(I18n.t('contract.providesEntriesMustBeObjects'))
			const id = String(p.id == null ? '' : p.id)
			if (!ID_RE.test(id)) fail(I18n.t('contract.invalidProtocolIdInProvides', { v: (id || I18n.t('contract.empty')) }))
			if (seen[id]) fail(I18n.t('contract.duplicateProtocolIdInProvides', { id }))
			seen[id] = true
			const name = str(p.name, 80)
			if (!name) fail(I18n.t('contract.protocolInProvidesHasNoName', { id }))
			const out = { id: id, name: name }
			if (p.description != null) out.description = str(p.description, 200)
			return out
		})
	}
	function normalizeIntegrity(value, entry) {
		if (!isObject(value)) fail(I18n.t('contract.manifestIntegrityMustBeAnObject'))
		const keys = Object.keys(value)
		if (!keys.length) fail(I18n.t('contract.manifestIntegrityMustNotBeEmpty'))
		if (keys.length > 200) fail(I18n.t('contract.manifestIntegrityHasTooManyEntries'))
		const out = {}
		keys.forEach(function (k) {
			safePath(k, I18n.t('contract.integrityPath'))
			if (!INTEGRITY_RE.test(String(value[k]))) fail(I18n.t('contract.malformedIntegrityDigestExpectedSha25664', { k }))
			out[k] = value[k]
		})
		if (!Object.prototype.hasOwnProperty.call(out, entry)) fail(I18n.t('contract.manifestIntegrityDoesnTListThe', { entry }))
		return out
	}
	// 只校验、不改写函数体；返回规范化副本（未知顶层键丢弃，避免清单偷偷塞运行参数）
	function validateManifest(raw) {
		if (!isObject(raw)) fail(I18n.t('contract.theProtocolManifestIsnTAn'))
		if (raw.schemaVersion !== SCHEMA_VERSION) fail(I18n.t('contract.unsupportedManifestSchemaversionV1OnlySupports', { String: String(raw.schemaVersion) }))
		if (raw.kind !== 'protocol') fail(I18n.t('contract.manifestKindMustBeProtocolGot', { String: String(raw.kind) }))
		const runtime = String(raw.runtime == null ? '' : raw.runtime)
		if (RUNTIMES.indexOf(runtime) === -1) fail(I18n.t('contract.unsupportedRuntimeV1OnlySupportsJs', { v: (runtime || I18n.t('contract.empty')) }), 'runtime')
		if (raw.apiVersion !== API_VERSION) fail(I18n.t('contract.unsupportedApiversionV1OnlySupports1', { String: String(raw.apiVersion) }), 'apiVersion')
		const id = String(raw.id == null ? '' : raw.id)
		if (!ID_RE.test(id)) fail(I18n.t('contract.invalidPackageId', { v: (id || I18n.t('contract.empty')) }))
		const name = str(raw.name, 80)
		if (!name) fail(I18n.t('contract.theManifestHasNoName'))
		const version = normalizeVersion(raw.version)
		const entry = safePath(raw.entry, I18n.t('contract.entryPath'))
		if (!/\.m?js$/.test(entry)) fail(I18n.t('contract.theEntryMustBeAJs', { entry }))
		const integrity = normalizeIntegrity(raw.integrity, entry)
		const provides = normalizeProvides(raw.provides)
		const license = str(raw.license, 120)
		if (!license) fail(I18n.t('contract.theManifestHasNoLicense'))
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
		if (!isObject(raw)) fail(I18n.t('contract.theCatalogIsnTAnObject'))
		if (raw.schemaVersion !== SCHEMA_VERSION) fail(I18n.t('contract.unsupportedCatalogSchemaversionV1OnlySupports', { String: String(raw.schemaVersion) }))
		const name = str(raw.name, 80)
		if (!name) fail(I18n.t('contract.theCatalogHasNoName'))
		if (!Array.isArray(raw.packages) || !raw.packages.length) fail(I18n.t('contract.catalogPackagesMustBeANon'))
		if (raw.packages.length > MAX_CATALOG_PACKAGES) fail(I18n.t('contract.theCatalogHasMoreThanPackages', { MAX_CATALOG_PACKAGES }))
		const seen = {}
		const packages = raw.packages.map(function (p) {
			if (!isObject(p)) fail(I18n.t('contract.catalogPackageEntriesMustBeObjects'))
			const manifest = safePath(p.manifest, I18n.t('contract.manifestPath'))
			if (!/manifest\.json$/.test(manifest)) fail(I18n.t('contract.catalogManifestMustPointToManifest', { manifest }))
			if (seen[manifest]) fail(I18n.t('contract.duplicateManifestPathInTheCatalog', { manifest }))
			seen[manifest] = true
			const sha256 = String(p.sha256 == null ? '' : p.sha256)
			if (!isHex64(sha256)) fail(I18n.t('contract.catalogManifestDigestsMustBe64', { manifest }))
			return { manifest: manifest, sha256: sha256 }
		})
		return { schemaVersion: SCHEMA_VERSION, name: name, packages: packages }
	}

	// ---------- 来源 URL ----------
	function isLocalHost(host) {
		return LOCAL_HOSTS.indexOf(String(host || '').toLowerCase()) !== -1
	}
	function checkRemoteUrl(u, what) {
		if (u.username || u.password) fail(I18n.t('contract.mustNotIncludeAUsernameOr', { v: (what || I18n.t('contract.url')) }))
		if (u.search || u.hash) fail(I18n.t('contract.mustNotIncludeAQueryOr', { v: (what || I18n.t('contract.url')) }))
		if (u.protocol === 'https:') return
		// 只给本地开发放行 http：示例仓库用 python3 -m http.server 托管
		if (u.protocol === 'http:' && isLocalHost(u.hostname)) return
		fail(I18n.t('contract.mustUseHttpsHttpIsAllowed', { v: (what || I18n.t('contract.url')) }))
	}
	function segOk(s) { return /^[A-Za-z0-9_.-]+$/.test(s) && s !== '.' && s !== '..' }
	// 支持：github 仓库地址（可带 @ref 或 /tree/<ref>[/<子目录>]）、catalog.json 或 manifest.json 的直连 URL
	function resolveSourceUrl(input) {
		const text = String(input == null ? '' : input).trim()
		if (!text) fail(I18n.t('contract.enterAProtocolSourceUrl'))
		let u
		try { u = new URL(text) } catch (e) { fail(I18n.t('contract.malformedUrl', { text })) }
		checkRemoteUrl(u)
		const host = u.hostname.toLowerCase()
		if (host === 'github.com' || host === 'www.github.com') {
			const parts = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
			if (parts.length < 2) fail(I18n.t('contract.aGithubUrlNeedsOrgRepo', { text }))
			let owner = parts[0]
			let repo = parts[1]
			if (/\.git$/.test(repo)) repo = repo.slice(0, -4)
			let ref = ''
			let subpath = ''
			if (parts.length > 2) {
				if (parts[2] !== 'tree' || parts.length < 4) fail(I18n.t('contract.githubUrlsOnlySupportTheTree', { text }))
				ref = parts[3]
				if (parts.length > 4) subpath = parts.slice(4).join('/')
			} else if (repo.indexOf('@') !== -1) {
				const at = repo.lastIndexOf('@')
				ref = repo.slice(at + 1)
				repo = repo.slice(0, at)
			}
			if (!segOk(owner) || !segOk(repo)) fail(I18n.t('contract.invalidGithubOrgOrRepositoryName', { text }))
			if (ref && !/^[A-Za-z0-9._-]{1,100}$/.test(ref)) fail(I18n.t('contract.aGithubRefMayOnlyContain', { ref }))
			if (subpath) safePath(subpath, I18n.t('contract.repositorySubdirectory'))
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
		if (!/\/(catalog|manifest)\.json$/.test(path)) fail(I18n.t('contract.aDirectUrlMustPointTo', { text }))
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
		if (!isSha40(sha)) fail(I18n.t('contract.aGithubCommitShaMustBe'))
		return 'https://raw.githubusercontent.com/' + desc.owner + '/' + desc.repo + '/' + sha + '/' + (desc.subpath ? desc.subpath + '/' : '')
	}
	function catalogUrlFor(desc, sha) {
		if (!desc) fail(I18n.t('contract.missingSourceDescriptor'))
		if (desc.kind === 'github') return githubRawBase(desc, sha) + 'catalog.json'
		return desc.url
	}

	// ---------- 命名空间 / provides / 信任 ----------
	function namespaceId(sourceKey, protocolId) {
		const key = String(sourceKey == null ? '' : sourceKey).trim()
		if (!key || /[\s\u0000-\u001f]/.test(key)) fail(I18n.t('contract.invalidSourceKey', { key }))
		if (!ID_RE.test(String(protocolId || ''))) fail(I18n.t('contract.invalidProtocolId', { String: String(protocolId) }))
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
		if (!isObject(record)) fail(I18n.t('contract.invalidTrustRecord'))
		const source = String(record.source == null ? '' : record.source)
		if (!source) fail(I18n.t('contract.trustRecordHasNoSource'))
		const id = String(record.id == null ? '' : record.id)
		if (!ID_RE.test(id)) fail(I18n.t('contract.invalidPackageIdInTrustRecord'))
		const version = normalizeVersion(record.version)
		const hash = String(record.hash == null ? '' : record.hash)
		if (!isHex64(hash)) fail(I18n.t('contract.theEntryDigestInATrust'))
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
		if (!Array.isArray(value) || !value.length) fail(I18n.t('contract.enumMustBeANonEmpty'))
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
			if (typeof v !== 'number' && typeof v !== 'string') fail(I18n.t('contract.enumValuesMustBeNumbersOr'))
			const k = String(v)
			if (seen[k]) fail(I18n.t('contract.duplicateEnumValue', { k }))
			seen[k] = true
			return { value: v, label: label == null ? k : String(label) }
		})
	}
	function normalizeFields(value) {
		if (value == null) return []
		if (!Array.isArray(value)) fail(I18n.t('contract.fieldsMustBeAnArray'))
		if (value.length > MAX_FIELDS) fail(I18n.t('contract.theFieldCatalogHasMoreThan', { MAX_FIELDS }))
		const seen = {}
		return value.map(function (raw) {
			if (!isObject(raw)) fail(I18n.t('contract.fieldDefinitionsMustBeObjects'))
			const key = String(raw.key == null ? '' : raw.key)
			if (!FIELD_KEY_RE.test(key)) fail(I18n.t('contract.invalidFieldKey', { v: (key || I18n.t('contract.empty')) }))
			if (seen[key]) fail(I18n.t('contract.duplicateFieldKey', { key }))
			seen[key] = true
			const name = str(raw.name, 80)
			if (!name) fail(I18n.t('contract.fieldHasNoName', { key }))
			const type = String(raw.type == null ? '' : raw.type)
			if (FIELD_TYPES.indexOf(type) === -1) fail(I18n.t('contract.fieldHasAnUnsupportedType', { key, v: (type || I18n.t('contract.empty')) }))
			// 保留协议自己的附加属性（例如 SEK 的 tag / fid / step），宿主只认下面这些
			const out = Object.assign({}, raw)
			out.key = key
			out.name = name
			out.type = type
			out.read = raw.read !== false
			out.write = raw.write !== false
			// random 是随机读写的**显式许可**：只有 true 才进随机，缺省 / 任何非布尔值都不进（危险字段靠协议目录自己排除）；
			// 批量配置不受影响。非布尔值直接拒绝注册，避免 'false' / 0 这类 truthy 误用
			if (raw.random != null && typeof raw.random !== 'boolean') fail(I18n.t('contract.fieldRandomMustBeABoolean', { key }))
			out.random = raw.random === true
			if (raw.unit != null) out.unit = str(raw.unit, 16)
			if (raw.group != null) out.group = str(raw.group, 60)
			;['min', 'max', 'step'].forEach(function (k) {
				if (raw[k] == null) { delete out[k]; return }
				if (typeof raw[k] !== 'number' || !isFinite(raw[k])) fail(I18n.t('contract.fieldMustBeANumber', { key, k }))
			})
			if (raw.min != null && raw.max != null && raw.min > raw.max) fail(I18n.t('contract.fieldMinIsGreaterThanMax', { key }))
			if (raw.step != null && !(raw.step > 0)) fail(I18n.t('contract.fieldStepMustBeGreaterThan', { key }))
			out.enum = normalizeEnum(raw.enum)
			return out
		})
	}
	function normalizeQueries(value) {
		if (value == null) return []
		if (!Array.isArray(value)) fail(I18n.t('contract.queriesMustBeAnArray'))
		if (value.length > MAX_FIELDS) fail(I18n.t('contract.theQueryCatalogHasMoreThan', { MAX_FIELDS }))
		const seen = {}
		return value.map(function (raw) {
			if (!isObject(raw)) fail(I18n.t('contract.queriesMustBeObjects'))
			const key = String(raw.key == null ? '' : raw.key)
			if (!FIELD_KEY_RE.test(key)) fail(I18n.t('contract.invalidQueryKey', { v: (key || I18n.t('contract.empty')) }))
			if (seen[key]) fail(I18n.t('contract.duplicateQueryKey', { key }))
			seen[key] = true
			const name = str(raw.name, 80)
			if (!name) fail(I18n.t('contract.queryHasNoName', { key }))
			return Object.assign({}, raw, { key: key, name: name })
		})
	}
	function normalizeSession(value) {
		if (value == null) return null
		if (!isObject(value)) fail(I18n.t('contract.sessionMustBeAnObject'))
		const out = {}
		SESSION_HOOKS.forEach(function (k) {
			const v = value[k]
			if (v == null) return
			if (!isFunction(v)) fail(I18n.t('contract.sessionMustBeAFunction', { k }))
			out[k] = v
		})
		;['idleMs', 'keepaliveTimeoutMs'].forEach(function (k) {
			if (value[k] == null) return
			if (typeof value[k] !== 'number' || !isFinite(value[k]) || value[k] <= 0) fail(I18n.t('contract.sessionMustBeAPositiveNumber', { k }))
			out[k] = value[k]
		})
		return out
	}
	function normalizeProtocolDef(def) {
		if (!isObject(def)) fail(I18n.t('contract.invalidProtocolObject'))
		const name = str(def.name, 80)
		if (!name) fail(I18n.t('contract.theProtocolHasNoName'))
		if (!isFunction(def.parseFrame)) fail(I18n.t('contract.theProtocolHasNoParseframe'))
		if (isAsyncFunction(def.parseFrame)) fail(I18n.t('contract.protocolParseframeCanTBeAsync'))
		const out = { name: name, parseFrame: def.parseFrame }
		;['formatFrame', 'logView', 'findFrame', 'byteMap', 'buildDownFrame', 'metrics', 'buildRead', 'buildWrite', 'buildQuery', 'matchResponse', 'readField', 'mountPanel'].forEach(function (k) {
			const v = def[k]
			if (v == null) { out[k] = null; return }
			if (!isFunction(v)) fail(I18n.t('contract.protocolMustBeAFunction', { name, k }))
			if (isAsyncFunction(v)) fail(I18n.t('contract.protocolCanTBeAsyncThe', { name, k }))
			out[k] = v
		})
		out.presets = Array.isArray(def.presets) ? def.presets.slice() : []
		out.fields = normalizeFields(def.fields)
		out.queries = normalizeQueries(def.queries)
		out.session = normalizeSession(def.session)
		return out
	}

	const api = {
		SCHEMA_VERSION: SCHEMA_VERSION,
		API_VERSION: API_VERSION,
		RUNTIMES: RUNTIMES,
		PLATFORM_TAGS: PLATFORM_TAGS,
		FIELD_TYPES: FIELD_TYPES,
		ContractError: ContractError,
		isAsyncFunction: isAsyncFunction,
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
		normalizeSession: normalizeSession,
	}

	root.DeviceDockContract = api
	if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
