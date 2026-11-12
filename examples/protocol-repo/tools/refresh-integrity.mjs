#!/usr/bin/env node
// 重算示例仓库的摘要（无依赖）：入口文件 → manifest.integrity，manifest 字节 → catalog.packages[].sha256。
// 改过 index.js / manifest.json 后跑一次：node examples/protocol-repo/tools/refresh-integrity.mjs
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const catalogPath = join(root, 'catalog.json')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const text = (obj) => JSON.stringify(obj, null, 2) + '\n'

const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
for (const pkg of catalog.packages) {
  const manifestPath = join(root, pkg.manifest)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const entryPath = join(dirname(manifestPath), manifest.entry)
  manifest.integrity[manifest.entry] = 'sha256-' + sha256(await readFile(entryPath))
  const manifestText = text(manifest)
  await writeFile(manifestPath, manifestText)
  pkg.sha256 = sha256(Buffer.from(manifestText, 'utf8'))
}
await writeFile(catalogPath, text(catalog))
console.log('refreshed ' + catalog.packages.length + ' package(s)')
