// Explicit artifact roots, supplied by user/coordinator. Never run a producer build here.
import { readFile, readdir } from 'node:fs/promises'
import { resolve,join,dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { validateCatalog } from '../src/sources.js'
import { verifyPackage } from '../src/package.js'
import { integrate } from './integrate.mjs'
const [kind,directory] = process.argv.slice(2)
if (!kind || !directory) throw Error('Usage: node tools/integrate-release.mjs protocol|plugin <artifact-directory>')
const root=resolve(directory), catalog=validateCatalog(JSON.parse(await readFile(join(root,'catalog.json'),'utf8')),kind), files=await readdir(root)
for (const entry of catalog.packages) {
 const candidates=files.filter(f => f.endsWith('.json') && f !== 'catalog.json' && f.startsWith(entry.id + '-'))
 let exact
 for (const name of candidates) {const bytes=await readFile(join(root,name));if(createHash('sha256').update(bytes).digest('hex')===entry.sha256) exact={name,bytes}}
 if (!exact) throw Error(`Missing pinned artifact: ${entry.id}@${entry.version}`)
 const bundle=JSON.parse(exact.bytes), verified=await verifyPackage(bundle)
 if (bundle.manifest.id !== entry.id || bundle.manifest.version !== entry.version) throw Error('Catalog identity mismatch')
 const packageDir = kind === 'protocol' ? join(root,entry.id,entry.version) : join(root,entry.id)
 const installed=await integrate(packageDir)
 if(installed.hash !== verified.hash) throw Error('Directory and pinned bundle differ')
 console.log(`${entry.id}@${entry.version} ${verified.hash}`)
}
