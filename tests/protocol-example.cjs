// Run: node tests/protocol-example.cjs
// 示例协议仓库（examples/protocol-repo）的摘要自洽：catalog → manifest → entry，以及 provides 覆盖两个协议。
// 改过示例的入口 / 清单 / 目录后，先跑 node examples/protocol-repo/tools/refresh-integrity.mjs，再跑本测试。
require('./i18n-env.cjs')
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const C = require('../js/protocol-contract.js')

	// ---- 示例仓库自洽：目录 → 清单 → 入口摘要 ----
const root = path.join(__dirname, '../examples/protocol-repo')
	const catalogRaw = fs.readFileSync(path.join(root, 'catalog.json'), 'utf8')
	const cat = C.validateCatalog(JSON.parse(catalogRaw))
	assert.ok(cat.packages.length >= 1)
	const manifestBytes = fs.readFileSync(path.join(root, cat.packages[0].manifest))
	assert.equal(crypto.createHash('sha256').update(manifestBytes).digest('hex'), cat.packages[0].sha256, 'catalog 里的清单摘要必须与文件一致')
	const man = C.validateManifest(JSON.parse(manifestBytes.toString('utf8')))
	assert.ok(man.provides.length >= 2, '示例包要演示多协议')
	const entryBytes = fs.readFileSync(path.join(path.dirname(path.join(root, cat.packages[0].manifest)), man.entry))
	assert.equal('sha256-' + crypto.createHash('sha256').update(entryBytes).digest('hex'), C.entryDigest(man), 'manifest 里的入口摘要必须与文件一致')
	assert.equal(C.checkProvides(man, man.provides.map(function (p) { return p.id })).ok, true)


console.log('protocol-example: ok')
